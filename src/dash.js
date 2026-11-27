'use strict';
// MPEG-DASH (.mpd) support: parses the manifest (SegmentTemplate / SegmentTimeline / SegmentList / BaseURL),
// picks the best video + audio representation, downloads their segments and muxes them with ffmpeg.
// DRM-protected (ContentProtection) and live manifests are rejected.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { getBuffer, sleep } = require('./net');
const ffmpeg = require('./ffmpeg');

// ---------- tiny XML parser ----------
function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const dec = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
  let m;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) { stack[stack.length - 1].text += m[1]; continue; }
    if (m[3] !== undefined) {
      const name = m[3].replace(/^.*:/, '');
      if (m[2] === '/') { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {}; const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let a;
      while ((a = ar.exec(m[4] || ''))) attrs[a[1].replace(/^.*:/, '')] = dec(a[2] !== undefined ? a[2] : a[3]);
      const node = { name, attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (m[5] !== '/') stack.push(node);
    } else if (m[6] !== undefined) stack[stack.length - 1].text += dec(m[6]);
  }
  return root.children[0];
}
const kids = (n, name) => (n ? n.children.filter(c => c.name === name) : []);
const kid = (n, name) => kids(n, name)[0];

function isoDuration(s) {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(s || '');
  if (!m) return 0;
  return (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (parseFloat(m[6]) || 0);
}
function fill(tpl, v) {
  return tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$/g, (m, k, w) => {
    const val = String(v[k] !== undefined ? v[k] : '');
    return w ? val.padStart(+w, '0') : val;
  }).replace(/\$\$/g, '$');
}
const withBase = (base, n) => { const b = kid(n, 'BaseURL'); return b && b.text.trim() ? new URL(b.text.trim(), base).toString() : base; };
const rangeOf = s => { const m = /^(\d+)-(\d+)$/.exec(s || ''); return m ? { start: +m[1], end: +m[2] } : null; };

function repSegments(mpd, period, aset, rep, base, periodDuration) {
  const id = rep.attrs.id, bandwidth = rep.attrs.bandwidth;
  const tpl = kid(rep, 'SegmentTemplate') || kid(aset, 'SegmentTemplate') || kid(period, 'SegmentTemplate');
  const list = kid(rep, 'SegmentList') || kid(aset, 'SegmentList');
  const abs = u => new URL(u, base).toString();
  if (tpl) {
    const a = tpl.attrs, timescale = +a.timescale || 1, start = a.startNumber !== undefined ? +a.startNumber : 1;
    const initial = a.initialization ? { url: abs(fill(a.initialization, { RepresentationID: id, Bandwidth: bandwidth })) } : null;
    const segs = [];
    const tl = kid(tpl, 'SegmentTimeline');
    if (tl) {
      let time = 0, number = start, first = true;
      for (const s of kids(tl, 'S')) {
        if (s.attrs.t !== undefined) time = +s.attrs.t; else if (first) time = 0;
        first = false;
        const d = +s.attrs.d; let r = s.attrs.r !== undefined ? +s.attrs.r : 0;
        if (r < 0) r = Math.max(0, Math.ceil((periodDuration * timescale - time) / d) - 1);
        for (let i = 0; i <= r; i++) { segs.push({ url: abs(fill(a.media, { RepresentationID: id, Bandwidth: bandwidth, Number: number, Time: time })) }); time += d; number++; }
      }
    } else {
      const dur = (+a.duration || 0) / timescale;
      if (!dur) throw new Error('Unsupported DASH segment addressing');
      const n = Math.ceil(periodDuration / dur);
      for (let i = 0; i < n; i++) segs.push({ url: abs(fill(a.media, { RepresentationID: id, Bandwidth: bandwidth, Number: start + i, Time: i * dur * timescale })) });
    }
    return { init: initial, segments: segs };
  }
  if (list) {
    const ini = kid(list, 'Initialization');
    return {
      init: ini ? { url: abs(ini.attrs.sourceURL || ''), range: rangeOf(ini.attrs.range) } : null,
      segments: kids(list, 'SegmentURL').map(s => ({ url: abs(s.attrs.media || ''), range: rangeOf(s.attrs.mediaRange) }))
    };
  }
  // single progressive file (BaseURL / SegmentBase)
  if (kid(rep, 'BaseURL') || kid(aset, 'BaseURL')) return { init: null, segments: [{ url: base }] };
  throw new Error('Unsupported DASH manifest layout');
}

/** Parses the manifest and collects every usable representation per kind (no track is chosen here). */
async function parseMpd(url, opts) {
  const text = (await getBuffer(url, Object.assign({}, opts, { limit: 16 * 1024 * 1024 }))).toString('utf8');
  const mpd = parseXml(text);
  if (!mpd || mpd.name !== 'MPD') throw new Error('Not a DASH manifest');
  if (mpd.attrs.type === 'dynamic') throw new Error('Live DASH streams cannot be downloaded');
  const periods = kids(mpd, 'Period');
  if (!periods.length) throw new Error('Manifest has no periods');
  if (periods.filter(p => kids(p, 'AdaptationSet').some(a => /video/.test((a.attrs.contentType || a.attrs.mimeType || '')) || kids(a, 'Representation').some(r => /video/.test(r.attrs.mimeType || '')))).length > 1)
    throw new Error('Multi-period DASH manifests are not supported');
  const period = periods[0];
  const total = isoDuration(mpd.attrs.mediaPresentationDuration) || 0;
  const periodDuration = isoDuration(period.attrs.duration) || total;
  const mpdBase = withBase(url, mpd), base0 = withBase(mpdBase, period);
  const cands = { video: [], audio: [] };
  for (const aset of kids(period, 'AdaptationSet')) {
    const abase = withBase(base0, aset);
    for (const rep of kids(aset, 'Representation')) {
      const mime = rep.attrs.mimeType || aset.attrs.mimeType || '';
      const kind = (aset.attrs.contentType || rep.attrs.contentType || mime.split('/')[0] || '').toLowerCase();
      if (kind !== 'video' && kind !== 'audio') continue;
      const prot = kids(aset, 'ContentProtection').concat(kids(rep, 'ContentProtection'));
      const bw = +rep.attrs.bandwidth || 0, score = kind === 'video' ? (+rep.attrs.height || 0) * 1e7 + bw : bw;
      cands[kind].push({ score, id: rep.attrs.id || '', aset, rep, base: withBase(abase, rep), prot, mime, kind });
    }
  }
  return { cands, period, periodDuration };
}

/** Downloads one track set: the best audio, and the video given by videoId (or the best video when unset). */
async function loadMpd(url, opts) {
  const { cands, period, periodDuration } = await parseMpd(url, opts);
  const best = list => list.reduce((a, b) => (!a || b.score > a.score ? b : a), null);
  const want = { video: (opts.videoId && cands.video.find(c => c.id === opts.videoId)) || best(cands.video), audio: best(cands.audio) };
  const tracks = [];
  for (const kind of ['video', 'audio']) {
    const w = want[kind]; if (!w) continue;
    if (w.prot.length) throw new Error('This stream is DRM-protected (ContentProtection) and cannot be downloaded');
    const { init, segments } = repSegments(null, period, w.aset, w.rep, w.base, periodDuration);
    if (!segments.length) throw new Error('Manifest lists no segments');
    tracks.push({ kind, mime: w.mime, codecs: w.rep.attrs.codecs || w.aset.attrs.codecs || '', bandwidth: +w.rep.attrs.bandwidth || 0, height: +w.rep.attrs.height || 0, list: init ? [init, ...segments] : segments });
  }
  if (!tracks.length) throw new Error('No audio or video found in manifest');
  return { tracks, duration: periodDuration, url };
}

/** Selectable video qualities of a DASH manifest, best first (DRM-protected ones are left out). */
async function listDashVariants(url, opts) {
  const { cands } = await parseMpd(url, opts);
  const seen = new Set(), out = [];
  for (const c of cands.video.slice().sort((a, b) => b.score - a.score)) {
    if (c.prot.length || seen.has(c.id)) continue;
    seen.add(c.id);
    const r = c.rep.attrs;
    out.push({ id: c.id, url, bandwidth: +r.bandwidth || 0, width: +r.width || 0, height: +r.height || 0, codecs: r.codecs || c.aset.attrs.codecs || '' });
  }
  return out;
}

class DashDownload extends EventEmitter {
  /** opts: { url, dest, headersFor, concurrency } */
  constructor(opts) {
    super();
    Object.assign(this, { url: opts.url, dest: opts.dest || '', headersFor: opts.headersFor, concurrency: opts.concurrency || 6, videoId: opts.videoId || '' });
    this.stage = 'download'; this.mergeFraction = 0;   // stage: 'download' | 'merge' (ffmpeg muxing)
    this.state = 'idle'; this.received = 0; this.error = null; this.manifest = null; this.ctl = null; this.runId = 0; this.ff = null; this.note = '';
    this.t = 0; this.state2 = [];   // per-track { index, bytes, fd }
    this.live = false;
  }
  get totalSegments() { return this.manifest ? this.manifest.tracks.reduce((a, t) => a + t.list.length, 0) : 0; }
  get doneSegments() { return this.state2.reduce((a, s) => a + s.index, 0); }
  get index() { return this.doneSegments; } get count() { return this.totalSegments; }
  get fraction() { return this.totalSegments ? this.doneSegments / this.totalSegments : 0; }
  get metaFile() { return this.dest + '.1dmmeta'; }
  partOf(i) { return `${this.dest}.1dmpart.${this.manifest.tracks[i].kind}`; }

  async prepare() {
    if (!this.manifest) this.manifest = await loadMpd(this.url, { headersFor: this.headersFor, videoId: this.videoId });
    const v = this.manifest.tracks.find(t => t.kind === 'video'), a = this.manifest.tracks.find(t => t.kind === 'audio');
    const webmV = v && /webm/.test(v.mime), webmA = !a || /webm/.test(a.mime);
    this.ext = !ffmpeg.available() ? (v || a).mime.includes('webm') ? '.webm' : '.mp4' : (v && webmV && webmA) || (!v && webmA) ? '.webm' : (v && webmV) ? '.mkv' : '.mp4';
    return { ext: this.ext, segments: this.totalSegments, duration: this.manifest.duration, live: false, tracks: this.manifest.tracks.map(t => ({ kind: t.kind, mime: t.mime, codecs: t.codecs, height: t.height })) };
  }

  async start() {
    if (this.state === 'running') return;
    this.error = null; this.stage = 'download'; this.mergeFraction = 0;
    try { await this.prepare(); } catch (e) { return this._fail(e); }
    if (!this.dest) return this._fail(new Error('No destination'));
    let saved = null;
    try { const m = JSON.parse(fs.readFileSync(this.metaFile, 'utf8')); if (m.url === this.url && m.tracks && m.tracks.length === this.manifest.tracks.length) saved = m.tracks; } catch (_) {}
    try {
      this.state2 = this.manifest.tracks.map((tr, i) => {
        const s = saved && saved[i] && fs.existsSync(this.partOf(i)) && fs.statSync(this.partOf(i)).size >= saved[i].bytes ? saved[i] : { index: 0, bytes: 0 };
        const fd = fs.openSync(this.partOf(i), s.index ? 'r+' : 'w+'); fs.ftruncateSync(fd, s.bytes);
        return { index: s.index, bytes: s.bytes, fd };
      });
    } catch (e) { return this._fail(e); }
    this.received = this.state2.reduce((a, s) => a + s.bytes, 0);
    this.state = 'running'; this.ctl = new AbortController();
    const run = ++this.runId;
    this._run(run).catch(e => { if (this.runId === run && this.state === 'running') this._fail(e); });
  }

  async _run(run) {
    for (let ti = 0; ti < this.manifest.tracks.length; ti++) {
      const tr = this.manifest.tracks[ti], st = this.state2[ti], inflight = new Map();
      let next = st.index;
      while (st.index < tr.list.length) {
        if (this.state !== 'running' || this.runId !== run) return;
        while (next < tr.list.length && inflight.size < this.concurrency) { const i = next++; const p = this._get(tr.list[i]); p.catch(() => {}); inflight.set(i, p); }
        const buf = await inflight.get(st.index); inflight.delete(st.index);
        if (this.state !== 'running' || this.runId !== run) return;
        await new Promise((res, rej) => fs.write(st.fd, buf, 0, buf.length, st.bytes, e => e ? rej(e) : res()));
        st.bytes += buf.length; st.index++; this.received += buf.length;
        try { fs.writeFileSync(this.metaFile, JSON.stringify({ url: this.url, tracks: this.state2.map(s => ({ index: s.index, bytes: s.bytes })) })); } catch (_) {}
      }
      fs.fsyncSync(st.fd); fs.closeSync(st.fd); st.fd = null;
    }
    await this._finish(run);
  }

  async _get(seg) {
    let last;
    for (let a = 0; a < 5; a++) {
      if (this.ctl.signal.aborted) throw new Error('aborted');
      try { return await getBuffer(seg.url, { headersFor: this.headersFor, signal: this.ctl.signal, range: seg.range ? `bytes=${seg.range.start}-${seg.range.end}` : undefined, limit: 1024 * 1024 * 1024 }); }
      catch (e) { last = e; if (this.ctl.signal.aborted) throw e; await sleep(400 * 2 ** a); }
    }
    throw last;
  }

  async _finish(run) {
    const tracks = this.manifest.tracks, parts = tracks.map((_, i) => this.partOf(i));
    try { fs.rmSync(this.dest, { force: true }); } catch (_) {}
    if (ffmpeg.available()) {
      const tmp = this.dest + '.1dmremux' + path.extname(this.dest);
      const args = []; parts.forEach(p => args.push('-i', p)); args.push('-c', 'copy');
      if (/\.mp4$/i.test(this.dest)) args.push('-movflags', '+faststart');
      args.push(tmp);
      this.stage = 'merge'; this.mergeFraction = 0;
      this.ff = ffmpeg.run(args, { onTime: t => { this.mergeFraction = this.manifest.duration ? Math.min(0.99, t / this.manifest.duration) : 0; } });
      await this.ff.promise;
      if (this.state !== 'running' || this.runId !== run) return;
      this.mergeFraction = 1;
      fs.renameSync(tmp, this.dest);
      parts.forEach(p => { try { fs.rmSync(p, { force: true }); } catch (_) {} });
    } else if (parts.length === 1) {
      fs.renameSync(parts[0], this.dest);
    } else {
      // no ffmpeg: keep the two tracks as separate files next to each other
      const stem = this.dest.replace(/\.[^.]+$/, '');
      const ext = i => (/webm/.test(tracks[i].mime) ? (tracks[i].kind === 'audio' ? '.weba' : '.webm') : (tracks[i].kind === 'audio' ? '.m4a' : '.mp4'));
      const vi = tracks.findIndex(t => t.kind === 'video');
      this.dest = `${stem}.video${ext(vi)}`;
      fs.renameSync(parts[vi], this.dest);
      const ai = 1 - vi; fs.renameSync(parts[ai], `${stem}.audio${ext(ai)}`);
      this.note = 'Saved video and audio as separate files (ffmpeg is not available to merge them)';
    }
    try { fs.rmSync(this.metaFile, { force: true }); } catch (_) {}
    this.state = 'done';
    this.emit('done');
  }

  _closeFds() { for (const s of this.state2) { try { if (s.fd !== null && s.fd !== undefined) fs.closeSync(s.fd); } catch (_) {} s.fd = null; } }
  async pause() {
    if (this.state !== 'running') return;
    this.state = 'paused'; this.runId++;
    if (this.ctl) this.ctl.abort(); if (this.ff) this.ff.kill();
    await sleep(30); this._closeFds(); this.emit('paused');
  }
  async cancel() {
    if (this.state === 'running') { this.state = 'paused'; this.runId++; if (this.ctl) this.ctl.abort(); if (this.ff) this.ff.kill(); await sleep(30); this._closeFds(); }
    this.state = 'cancelled';
    if (this.manifest) this.manifest.tracks.forEach((_, i) => { try { fs.rmSync(this.partOf(i), { force: true }); } catch (_) {} });
    for (const f of [this.metaFile]) try { fs.rmSync(f, { force: true }); } catch (_) {}
  }
  stop() {}
  _fail(e) {
    if (this.state === 'error' || this.state === 'cancelled') return;
    this.state = 'error'; this.error = e; this.runId++;
    if (this.ctl) this.ctl.abort(); if (this.ff) this.ff.kill();
    this._closeFds(); this.emit('error', e);
  }
}
module.exports = { DashDownload, loadMpd, parseXml, listDashVariants };
