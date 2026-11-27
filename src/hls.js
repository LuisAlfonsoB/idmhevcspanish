'use strict';
// HLS (.m3u8) downloader: picks the best variant, fetches segments in parallel, decrypts AES-128,
// and writes them in order. Supports resume (VOD), live recording, remuxing to MP4 and (via ffmpeg) SAMPLE-AES.
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { getBuffer, sleep } = require('./net');
const ffmpeg = require('./ffmpeg');

const attr = (line, name) => {
  const m = new RegExp('(?:^|[,:])' + name + '=("([^"]*)"|[^,]*)', 'i').exec(line);
  return m ? (m[2] !== undefined ? m[2] : m[1]) : null;
};

async function loadPlaylist(url, opts, depth = 0) {
  const text = (await getBuffer(url, Object.assign({}, opts, { limit: 8 * 1024 * 1024 }))).toString('utf8');
  if (!/^#EXTM3U/m.test(text)) throw new Error('Not an HLS playlist');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const abs = u => new URL(u, url).toString();

  if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
    if (depth > 2) throw new Error('Playlist nesting too deep');
    let best = null;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const uri = lines.slice(i + 1).find(l => !l.startsWith('#'));
      const bw = parseInt(attr(lines[i], 'BANDWIDTH') || '0', 10);
      if (uri && (!best || bw > best.bw)) best = { bw, uri: abs(uri) };
    }
    if (!best) throw new Error('No playable variant');
    return loadPlaylist(best.uri, opts, depth + 1);
  }

  let seq = 0, key = null, map = null, endlist = false, pendingRange = null, lastEnd = 0, targetDuration = 6, sampleAes = false;
  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(l.split(':')[1], 10) || 0;
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = parseFloat(l.split(':')[1]) || 6;
    else if (l.startsWith('#EXT-X-ENDLIST')) endlist = true;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const method = (attr(l, 'METHOD') || 'NONE').toUpperCase();
      const keyformat = (attr(l, 'KEYFORMAT') || 'identity').toLowerCase();
      const uri = attr(l, 'URI') || '';
      if (method === 'NONE') key = null;
      else if (keyformat !== 'identity' || /^skd:|^data:/i.test(uri)) throw new Error('This stream is DRM-protected (' + (keyformat !== 'identity' ? keyformat : 'FairPlay') + ') and cannot be downloaded');
      else if (method === 'AES-128') key = { uri: abs(uri), iv: attr(l, 'IV') };
      else if (method === 'SAMPLE-AES') sampleAes = true;
      else throw new Error('Unsupported HLS encryption: ' + method);
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const r = attr(l, 'BYTERANGE');
      map = { uri: abs(attr(l, 'URI')), range: r ? parseRange(r, 0) : null };
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = l.split(':')[1];
    } else if (l.startsWith('#EXTINF:')) {
      const duration = parseFloat(l.split(':')[1]) || 0;
      const uri = lines.slice(i + 1).find(x => !x.startsWith('#'));
      if (!uri) continue;
      let range = null;
      if (pendingRange) { range = parseRange(pendingRange, lastEnd); lastEnd = range.end + 1; pendingRange = null; }
      segments.push({ url: abs(uri), duration, key, seq: seq + segments.length, range });
    }
  }
  if (!segments.length) throw new Error('Playlist has no segments');
  return { segments, map, url, endlist, live: !endlist, targetDuration, sampleAes };
}
/** Quality variants of an HLS master playlist, best first. Returns [] for a single-quality playlist. */
async function listHlsVariants(url, opts) {
  const text = (await getBuffer(url, Object.assign({}, opts, { limit: 8 * 1024 * 1024 }))).toString('utf8');
  if (!/^#EXTM3U/m.test(text)) throw new Error('Not an HLS playlist');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const uri = lines.slice(i + 1).find(l => !l.startsWith('#'));
    if (!uri) continue;
    const bandwidth = parseInt(attr(lines[i], 'BANDWIDTH') || '0', 10);
    const res = /^(\d+)x(\d+)$/i.exec(attr(lines[i], 'RESOLUTION') || '');
    out.push({ id: '', url: new URL(uri, url).toString(), bandwidth, width: res ? +res[1] : 0, height: res ? +res[2] : 0, codecs: attr(lines[i], 'CODECS') || '' });
  }
  return out.sort((a, b) => b.bandwidth - a.bandwidth);
}
/** Duration (sum of #EXTINF) of an HLS URL, plus the lowest-bandwidth playlist to use for a cheap preview frame. Never needs the video to play. */
async function probeHls(url, opts) {
  const fetchText = async u => (await getBuffer(u, Object.assign({}, opts, { limit: 8 * 1024 * 1024 }))).toString('utf8');
  let text = await fetchText(url), src = url;
  if (!/^#EXTM3U/m.test(text)) throw new Error('Not an HLS playlist');
  if (/#EXT-X-STREAM-INF/.test(text)) {
    const vs = await listHlsVariants(url, opts);
    if (!vs.length) throw new Error('No variants');
    src = vs[vs.length - 1].url;
    text = await fetchText(src);
  }
  let duration = 0;
  for (const m of text.matchAll(/#EXTINF:([\d.]+)/g)) duration += parseFloat(m[1]) || 0;
  return { duration, live: !/#EXT-X-ENDLIST/.test(text), src };
}
function parseRange(spec, fallbackStart) {
  const [len, off] = spec.split('@');
  const start = off !== undefined ? parseInt(off, 10) : fallbackStart;
  return { start, end: start + parseInt(len, 10) - 1 };
}

class HlsDownload extends EventEmitter {
  /** opts: { url, dest, headersFor, concurrency, allowLive, remux } */
  constructor(opts) {
    super();
    Object.assign(this, { url: opts.url, dest: opts.dest || '', headersFor: opts.headersFor, concurrency: opts.concurrency || 6, allowLive: !!opts.allowLive, remux: !!opts.remux });
    this.state = 'idle'; this.received = 0; this.index = 0; this.count = 0; this.duration = 0; this.live = false; this.bytes = 0;
    this.playlist = null; this.fd = null; this.ctl = null; this.keys = new Map(); this.error = null; this.runId = 0; this.stopRequested = false; this.ff = null; this.ffFraction = 0;
    this.stage = 'download'; this.mergeFraction = 0;   // stage: 'download' | 'merge' (remux to MP4)
  }
  get fraction() { return this.ffFraction || (this.count && !this.live ? this.index / this.count : 0); }
  get part() { return this.dest + '.1dmpart'; }
  get metaFile() { return this.dest + '.1dmmeta'; }

  /** Parse the playlist; returns { ext, segments, duration, live } so the caller can pick a filename. */
  async prepare() {
    if (!this.playlist) this.playlist = await loadPlaylist(this.url, { headersFor: this.headersFor });
    const pl = this.playlist;
    if (pl.live && !this.allowLive) throw new Error('Live streams cannot be downloaded');
    if (pl.sampleAes && !ffmpeg.available()) throw new Error('This stream uses SAMPLE-AES encryption, which needs ffmpeg (not available)');
    this.live = pl.live;
    this.count = pl.segments.length;
    this.duration = pl.segments.reduce((a, s) => a + s.duration, 0);
    const fmp4 = !!pl.map || /\.(m4s|mp4|m4a|m4v)(\?|$)/i.test(pl.segments[0].url);
    this.rawExt = fmp4 ? '.mp4' : '.ts';
    this.ext = (this.remux && ffmpeg.available()) || fmp4 || pl.sampleAes ? '.mp4' : '.ts';
    return { ext: this.ext, segments: this.count, duration: this.duration, live: this.live };
  }

  async start() {
    if (this.state === 'running') return;
    this.error = null; this.stopRequested = false; this.stage = 'download'; this.mergeFraction = 0;
    try { await this.prepare(); } catch (e) { return this._fail(e); }
    if (!this.dest) return this._fail(new Error('No destination'));
    this.state = 'running'; this.ctl = new AbortController();
    const run = ++this.runId;
    if (this.playlist.sampleAes) return this._runFfmpeg(run);

    let startIndex = 0, bytes = 0;
    if (!this.live) {
      try { const m = JSON.parse(fs.readFileSync(this.metaFile, 'utf8')); if (m.url === this.url && m.count === this.count && fs.statSync(this.part).size >= m.bytes) { startIndex = m.index; bytes = m.bytes; } } catch (_) {}
    }
    try { this.fd = fs.openSync(this.part, startIndex ? 'r+' : 'w+'); fs.ftruncateSync(this.fd, bytes); }
    catch (e) { return this._fail(e); }
    this.index = startIndex; this.received = bytes; this.bytes = bytes;
    (this.live ? this._runLive(run) : this._run(run)).catch(e => { if (this.runId === run && this.state === 'running') this._fail(e); });
  }

  async _run(run) {
    const pl = this.playlist, segs = pl.segments;
    if (this.index === 0 && pl.map) await this._write(await this._get(pl.map.uri, pl.map.range));
    const inflight = new Map();
    let nextFetch = this.index;
    while (this.index < segs.length) {
      if (this.state !== 'running' || this.runId !== run) return;
      while (nextFetch < segs.length && inflight.size < this.concurrency) {
        const i = nextFetch++;
        inflight.set(i, this._segment(segs[i]));
        inflight.get(i).catch(() => {});
      }
      const buf = await inflight.get(this.index);
      inflight.delete(this.index);
      if (this.state !== 'running' || this.runId !== run) return;
      await this._write(buf);
      this.index++;
      try { fs.writeFileSync(this.metaFile, JSON.stringify({ url: this.url, count: this.count, index: this.index, bytes: this.bytes })); } catch (_) {}
    }
    await this._finish(run);
  }

  /** Record a live stream until it ends or stop() is called. */
  async _runLive(run) {
    const pl0 = this.playlist; let lastSeq = -1, fails = 0, gotAny = false, mapDone = false, pl = pl0;
    while (this.state === 'running' && this.runId === run) {
      try {
        if (pl !== pl0 || gotAny) pl = await loadPlaylist(pl0.url, { headersFor: this.headersFor });
        fails = 0;
        if (!mapDone && pl.map) { await this._write(await this._get(pl.map.uri, pl.map.range)); mapDone = true; }
        const fresh = pl.segments.filter(s => s.seq > lastSeq);
        for (let i = 0; i < fresh.length && this.state === 'running' && this.runId === run; i += this.concurrency) {
          const batch = fresh.slice(i, i + this.concurrency);
          const bufs = await Promise.all(batch.map(s => this._segment(s)));
          for (let j = 0; j < bufs.length; j++) { await this._write(bufs[j]); lastSeq = batch[j].seq; this.index++; gotAny = true; }
        }
        if (pl.endlist) break;
      } catch (e) {
        if (this.state !== 'running' || this.runId !== run) return;
        if (++fails > 5) { if (gotAny) break; throw e; }
      }
      const wait = Math.max(1000, Math.min(5000, (pl.targetDuration || 6) * 500));
      for (let w = 0; w < wait && !this.stopRequested && this.state === 'running'; w += 200) await sleep(200);
      if (this.stopRequested) break;
    }
    if (this.state === 'running' && this.runId === run) await this._finish(run);
  }

  async _finish(run) {
    fs.fsyncSync(this.fd); fs.closeSync(this.fd); this.fd = null;
    try { fs.rmSync(this.dest, { force: true }); } catch (_) {}
    if (this.remux && ffmpeg.available() && this.rawExt === '.ts') {
      try {
        this.stage = 'merge'; this.mergeFraction = 0;
        this.ff = ffmpeg.run(['-i', this.part, '-c', 'copy', '-f', 'mp4', '-movflags', '+faststart', this.dest + '.1dmremux'], {
          onTime: t => { this.mergeFraction = this.duration ? Math.min(0.99, t / this.duration) : 0; }
        });
        await this.ff.promise;
        this.mergeFraction = 1;
        fs.renameSync(this.dest + '.1dmremux', this.dest); fs.rmSync(this.part, { force: true });
      } catch (e) {
        if (this.state !== 'running' || this.runId !== run) return;
        this.stage = 'download';
        // fall back to the raw transport stream
        try { fs.rmSync(this.dest + '.1dmremux', { force: true }); } catch (_) {}
        const part = this.part;
        this.dest = this.dest.replace(/\.mp4$/i, '.ts');
        fs.renameSync(part, this.dest);
      }
    } else fs.renameSync(this.part, this.dest);
    try { fs.rmSync(this.metaFile, { force: true }); } catch (_) {}
    this.state = 'done';
    this.emit('done');
  }

  /** SAMPLE-AES (non-DRM, key served over HTTP): let ffmpeg fetch, decrypt and remux. */
  async _runFfmpeg(run) {
    try {
      const h = await this.headersFor(this.playlist.url);
      const headers = Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      this.ff = ffmpeg.run(['-headers', headers, '-allowed_extensions', 'ALL', '-i', this.playlist.url, '-c', 'copy', '-f', 'mp4', '-movflags', '+faststart', this.part], {
        onTime: t => { this.ffFraction = this.duration ? Math.min(0.99, t / this.duration) : 0; try { this.received = fs.statSync(this.part).size; } catch (_) {} }
      });
      await this.ff.promise;
      if (this.state !== 'running' || this.runId !== run) return;
      try { fs.rmSync(this.dest, { force: true }); } catch (_) {}
      fs.renameSync(this.part, this.dest);
      this.state = 'done'; this.emit('done');
    } catch (e) { if (this.state === 'running' && this.runId === run) this._fail(e); }
  }

  _write(buf) {
    return new Promise((resolve, reject) => {
      fs.write(this.fd, buf, 0, buf.length, this.bytes, err => { if (err) return reject(err); this.bytes += buf.length; this.received = this.bytes; resolve(); });
    });
  }
  async _get(url, range) {
    let last;
    for (let a = 0; a < 5; a++) {
      if (this.ctl.signal.aborted) throw new Error('aborted');
      try { return await getBuffer(url, { headersFor: this.headersFor, signal: this.ctl.signal, range: range ? `bytes=${range.start}-${range.end}` : undefined, limit: 256 * 1024 * 1024 }); }
      catch (e) { last = e; if (this.ctl.signal.aborted) throw e; await sleep(400 * 2 ** a); }
    }
    throw last;
  }
  async _segment(seg) {
    let buf = await this._get(seg.url, seg.range);
    if (seg.key) {
      let key = this.keys.get(seg.key.uri);
      if (!key) { key = await this._get(seg.key.uri); this.keys.set(seg.key.uri, key); }
      let iv;
      if (seg.key.iv) iv = Buffer.from(seg.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
      else { iv = Buffer.alloc(16); iv.writeUInt32BE(Math.floor(seg.seq / 4294967296) >>> 0, 8); iv.writeUInt32BE(seg.seq >>> 0, 12); }
      const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
      buf = Buffer.concat([d.update(buf), d.final()]);
    }
    return buf;
  }

  /** Live recordings: stop and keep what has been recorded so far. */
  stop() { this.stopRequested = true; }

  async pause() {
    if (this.state !== 'running') return;
    if (this.live) { this.stop(); return; }                 // a live recording cannot be resumed: pausing saves it
    this.state = 'paused'; this.runId++;
    if (this.ctl) this.ctl.abort();
    if (this.ff) this.ff.kill();
    await sleep(30);
    try { if (this.fd !== null) fs.closeSync(this.fd); } catch (_) {}
    this.fd = null;
    this.emit('paused');
  }
  async cancel() {
    if (this.state === 'running') { this.state = 'paused'; this.runId++; if (this.ctl) this.ctl.abort(); if (this.ff) this.ff.kill(); await sleep(30); try { if (this.fd !== null) fs.closeSync(this.fd); } catch (_) {} this.fd = null; }
    this.state = 'cancelled';
    for (const f of [this.part, this.metaFile, this.dest + '.1dmremux']) try { fs.rmSync(f, { force: true }); } catch (_) {}
  }
  _fail(e) {
    if (this.state === 'error' || this.state === 'cancelled') return;
    this.state = 'error'; this.error = e; this.runId++;
    if (this.ctl) this.ctl.abort();
    if (this.ff) this.ff.kill();
    try { if (this.fd !== null) fs.closeSync(this.fd); } catch (_) {}
    this.fd = null;
    this.emit('error', e);
  }
}
module.exports = { HlsDownload, loadPlaylist, listHlsVariants, probeHls };
