'use strict';
// Multi-connection ("accelerated") downloader: splits a file into byte ranges fetched in parallel,
// dynamically re-splits the largest remaining range when a connection finishes early,
// retries failed ranges, and can pause/resume across app restarts.
const fs = require('fs');
const { EventEmitter } = require('events');
const { open, sleep } = require('./net');

const MIN_SPLIT = 512 * 1024;     // never split a range smaller than 2x this
const MAX_RETRIES = 6;

class SegmentedDownload extends EventEmitter {
  /**
   * opts: { url, dest, size, ranges, connections, headersFor, etag, lastModified }
   * Data is written to dest + '.1dmpart' and renamed to dest when finished.
   */
  constructor(opts) {
    super();
    Object.assign(this, { url: opts.url, dest: opts.dest, size: opts.size || 0, ranges: !!opts.ranges, connections: Math.max(1, Math.min(16, opts.connections || 8)), headersFor: opts.headersFor, etag: opts.etag || '', lastModified: opts.lastModified || '' });
    this.part = this.dest + '.1dmpart';
    this.metaFile = this.dest + '.1dmmeta';
    this.state = 'idle';            // idle | running | paused | done | error | cancelled
    this.segs = [];
    this.received = 0;
    this.fd = null;
    this.pending = 0;               // in-flight fs writes
    this.ctls = new Set();
    this.workers = 0;
    this.saveTimer = null;
    this.error = null;
  }

  get activeConnections() { return this.workers; }

  _loadMeta() {
    try {
      const m = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
      const st = fs.statSync(this.part);
      if (m.size === this.size && st.size === this.size && (m.etag || '') === this.etag && (m.lastModified || '') === this.lastModified && Array.isArray(m.segs)) {
        return m.segs.map(s => ({ s: s.s, e: s.e, p: s.p, claimed: false, fails: 0 }));
      }
    } catch (_) {}
    return null;
  }
  _saveMeta() {
    if (!this.ranges) return;
    try {
      fs.writeFileSync(this.metaFile, JSON.stringify({ url: this.url, size: this.size, etag: this.etag, lastModified: this.lastModified, segs: this.segs.map(s => ({ s: s.s, e: s.e, p: s.p })) }));
    } catch (_) {}
  }

  async start() {
    if (this.state === 'running') return;
    this.error = null;
    try {
      if (this.ranges && this.size > 0) {
        if (!this.segs.length) this.segs = this._loadMeta() || [];
        const fresh = !this.segs.length;
        if (fresh) {
          const n = Math.max(1, Math.min(this.connections, Math.ceil(this.size / MIN_SPLIT)));
          const per = Math.ceil(this.size / n);
          for (let i = 0; i < n; i++) { const s = i * per, e = Math.min(this.size, s + per); if (s < e) this.segs.push({ s, e, p: s, claimed: false, fails: 0 }); }
          this.fd = fs.openSync(this.part, 'w+');
          fs.ftruncateSync(this.fd, this.size);
        } else {
          this.fd = fs.openSync(this.part, 'r+');
          for (const s of this.segs) { s.claimed = false; s.fails = 0; }
        }
        this.received = this.segs.reduce((a, s) => a + (s.p - s.s), 0);
      } else {
        // single stream: no resume possible, always restart
        this.fd = fs.openSync(this.part, 'w+');
        this.received = 0; this.segs = [{ s: 0, e: this.size || Infinity, p: 0, claimed: false, fails: 0 }];
      }
    } catch (e) { return this._fail(e); }

    this.state = 'running';
    this.saveTimer = setInterval(() => this._saveMeta(), 2000);
    const n = this.ranges ? this.connections : 1;
    for (let i = 0; i < n; i++) this._worker();
  }

  _claim() {
    let s = this.segs.find(x => !x.claimed && x.p < x.e);
    if (s) { s.claimed = true; return s; }
    if (!this.ranges) return null;
    let best = null;
    for (const x of this.segs) if (x.claimed && x.e - x.p > MIN_SPLIT * 2 && (!best || x.e - x.p > best.e - best.p)) best = x;
    if (!best) return null;
    const mid = best.p + Math.floor((best.e - best.p) / 2);
    const ns = { s: mid, e: best.e, p: mid, claimed: true, fails: 0 };
    best.e = mid;
    this.segs.push(ns);
    return ns;
  }

  async _worker() {
    this.workers++;
    try {
      while (this.state === 'running') {
        const seg = this._claim();
        if (!seg) break;
        try { await this._fetch(seg); seg.fails = 0; }
        catch (e) {
          if (this.state !== 'running') return;
          seg.claimed = false;
          seg.fails++;
          if (!this.ranges) { seg.p = 0; this.received = 0; try { fs.ftruncateSync(this.fd, 0); } catch (_) {} }
          if (seg.fails > MAX_RETRIES) return this._fail(e);
          await sleep(Math.min(8000, 400 * 2 ** seg.fails));
        }
      }
    } finally {
      this.workers--;
      if (this.state === 'running') this._checkDone();
    }
  }

  async _fetch(seg) {
    const ctl = new AbortController();
    this.ctls.add(ctl);
    try {
      const { res } = await open(this.url, { headersFor: this.headersFor, signal: ctl.signal, range: this.ranges ? `bytes=${seg.p}-${seg.e - 1}` : undefined });
      if (this.ranges ? res.statusCode !== 206 : res.statusCode !== 200) { res.resume(); throw new Error(this.ranges && res.statusCode === 200 ? 'Server ignored the range request' : 'HTTP ' + res.statusCode); }
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = err => { if (settled) return; settled = true; err ? reject(err) : resolve(); };
        res.on('data', chunk => {
          if (seg.p >= seg.e) { res.destroy(); return finish(); }
          let buf = chunk;
          if (seg.e !== Infinity && buf.length > seg.e - seg.p) buf = buf.subarray(0, seg.e - seg.p);
          const pos = seg.p;
          res.pause(); this.pending++;
          fs.write(this.fd, buf, 0, buf.length, pos, err => {
            this.pending--;
            if (err) { res.destroy(); return finish(err); }
            seg.p = pos + buf.length; this.received += buf.length;
            if (seg.e !== Infinity && seg.p >= seg.e) { res.destroy(); return finish(); }
            if (this.state === 'running') res.resume();
          });
        });
        res.on('end', () => finish());
        // 'close' can arrive while buffered data is still being written; only treat it as failure if the body was cut off
        res.on('close', () => { if (!res.complete) finish(new Error('Connection closed early')); else setTimeout(() => finish(new Error('Stream stalled after close')), 10000).unref(); });
        res.on('error', finish);
      });
      await this._drain(); // 'end' can fire before the last queued disk write completes
      if (this.state === 'running' && seg.e !== Infinity && seg.p < seg.e) throw new Error('Connection closed early');
      if (this.state === 'running' && seg.e === Infinity) { seg.e = seg.p; this.size = seg.p; }
    } finally { this.ctls.delete(ctl); }
  }

  _checkDone() {
    if (this.state !== 'running' || this.workers > 0) return;
    if (!this.segs.every(s => s.p >= s.e)) return;
    this._finalize();
  }

  async _finalize() {
    this.state = 'finishing';
    clearInterval(this.saveTimer);
    try {
      await this._drain();
      fs.fsyncSync(this.fd); fs.closeSync(this.fd); this.fd = null;
      if (this.ranges && this.size && fs.statSync(this.part).size !== this.size) throw new Error('Size mismatch after download');
      try { fs.rmSync(this.dest, { force: true }); } catch (_) {}
      fs.renameSync(this.part, this.dest);
      try { fs.rmSync(this.metaFile, { force: true }); } catch (_) {}
      this.state = 'done';
      this.emit('done');
    } catch (e) { this.state = 'running'; this._fail(e); }
  }

  async _drain() { while (this.pending > 0) await sleep(15); }
  _abortAll() { for (const c of this.ctls) c.abort(); this.ctls.clear(); }

  async pause() {
    if (this.state !== 'running') return;
    this.state = 'paused';
    clearInterval(this.saveTimer);
    this._abortAll();
    await this._drain();
    this._saveMeta();
    try { if (this.fd !== null) fs.closeSync(this.fd); } catch (_) {}
    this.fd = null;
    this.emit('paused');
  }

  async cancel() {
    const was = this.state;
    if (was === 'running') await this.pause();
    this.state = 'cancelled';
    clearInterval(this.saveTimer);
    try { if (this.fd !== null) fs.closeSync(this.fd); } catch (_) {}
    this.fd = null;
    for (const f of [this.part, this.metaFile]) try { fs.rmSync(f, { force: true }); } catch (_) {}
  }

  _fail(e) {
    if (this.state === 'error' || this.state === 'cancelled') return;
    this.state = 'error'; this.error = e;
    clearInterval(this.saveTimer); this._abortAll();
    this._drain().then(() => { this._saveMeta(); try { if (this.fd !== null) fs.closeSync(this.fd); } catch (_) {} this.fd = null; });
    this.emit('error', e);
  }
}

module.exports = { SegmentedDownload };
