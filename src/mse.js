'use strict';
// Captures the data a page feeds to a MediaSource (blob: videos), writes it to temp files and
// builds a playable file from it. DRM-protected (EME) playback is detected and never captured.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_CHUNK = 64 * 1024 * 1024;
const kindOf = mime => {
  const m = (mime || '').toLowerCase();
  const hasV = /avc1|avc3|hev1|hvc1|vp0?9|av01|vp8|theora|dvh1/.test(m), hasA = /mp4a|opus|vorbis|ac-3|ec-3|flac|mp3/.test(m);
  if (/^audio\//.test(m)) return 'audio';
  if (/^video\//.test(m)) return hasV && hasA ? 'av' : 'video';
  return 'other';
};
const extOf = mime => /webm/i.test(mime) ? '.webm' : /mp4|m4a|m4v/i.test(mime) ? '.mp4' : /mpeg|mp3/i.test(mime) ? '.mp3' : /aac/i.test(mime) ? '.aac' : /ogg/i.test(mime) ? '.ogg' : '.bin';
function looksLikeInit(b) {
  if (b.length >= 12 && (b.toString('latin1', 4, 8) === 'ftyp' || b.toString('latin1', 4, 8) === 'moov')) return true;
  return b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
}

class MseCapture {
  constructor(dir, getCapBytes) {
    this.dir = dir; this.getCapBytes = getCapBytes || (() => 4 * 1024 ** 3);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  }
  state(tab) { return tab.mse || (tab.mse = { drm: false, capped: false, total: 0, bufs: new Map(), gen: crypto.randomBytes(4).toString('hex') }); }

  /** Returns true when the visible state changed. */
  onMessage(tab, frameKey, meta, bytes) {
    if (!meta || typeof meta !== 'object') return false;
    const st = this.state(tab);
    if (meta.type === 'drm') { if (!st.drm) { st.drm = true; this._wipe(st); return true; } return false; }
    if (st.drm || st.capped) return false;
    const key = frameKey + ':' + (meta.id | 0);
    let b = st.bufs.get(key);
    if (!b) {
      if (st.bufs.size >= 8) return false;
      b = { key, mime: String(meta.mime || '').slice(0, 200), seen: new Set(), parts: [], bytes: 0 };
      st.bufs.set(key, b);
    }
    if (meta.type !== 'chunk') return false;
    if (!bytes || !(bytes.length > 0) || bytes.length > MAX_CHUNK) return false;
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (st.total + buf.length > this.getCapBytes()) { st.capped = true; return true; }
    const h = crypto.createHash('sha1').update(buf).digest('hex');
    if (b.seen.has(h)) return false;                     // same segment re-appended after a seek
    b.seen.add(h);
    let part = b.parts[b.parts.length - 1];
    if (!part || (looksLikeInit(buf) && part.bytes > 0)) {   // a new init segment = representation switch
      part = { file: path.join(this.dir, `${st.gen}_${b.parts.length}_${crypto.randomBytes(3).toString('hex')}${extOf(b.mime)}`), bytes: 0 };
      b.parts.push(part);
    }
    try { fs.appendFileSync(part.file, buf); } catch (_) { return false; }
    part.bytes += buf.length; b.bytes += buf.length; st.total += buf.length;
    return true;
  }

  summary(tab) {
    const st = tab.mse; if (!st) return null;
    const tracks = [...st.bufs.values()].filter(b => b.bytes > 0).map(b => ({ mime: b.mime, kind: kindOf(b.mime), bytes: b.bytes, parts: b.parts.length }));
    return { drm: st.drm, capped: st.capped, total: st.total, tracks };
  }

  /** Choose the best (largest) part per track kind and the output extension. */
  plan(tab) {
    const st = tab.mse; if (!st || st.drm) return null;
    const best = kind => {
      let r = null;
      for (const b of st.bufs.values()) {
        if (kindOf(b.mime) !== kind) continue;
        for (const p of b.parts) if (p.bytes > 0 && (!r || p.bytes > r.bytes)) r = { file: p.file, bytes: p.bytes, mime: b.mime };
      }
      return r;
    };
    const av = best('av'), video = best('video'), audio = best('audio');
    const tracks = av ? [av] : [video, audio].filter(Boolean);
    if (!tracks.length) return null;
    const exts = new Set(tracks.map(t => extOf(t.mime)));
    const ext = exts.size === 1 ? [...exts][0] : '.mkv';
    return { tracks, ext: ext === '.bin' ? '.mp4' : ext };
  }

  /** Build the final file. ffmpeg: module with available()/run(). Returns { path, note }. */
  async build(tab, dest, ffmpeg, onProgress) {
    const p = this.plan(tab); if (!p) throw new Error('Nothing has been captured yet. Play the video first.');
    if (ffmpeg && ffmpeg.available()) {
      const args = [];
      for (const t of p.tracks) args.push('-i', t.file);
      args.push('-c', 'copy');
      if (p.ext === '.mp4') args.push('-movflags', '+faststart');
      args.push('-f', p.ext === '.webm' ? 'webm' : p.ext === '.mkv' ? 'matroska' : p.ext === '.mp3' ? 'mp3' : p.ext === '.mp4' ? 'mp4' : 'mp4', dest);
      const job = ffmpeg.run(args, { onTime: s => onProgress && onProgress(s) });
      try { await job.promise; return { path: dest, note: '' }; }
      catch (e) { /* fall through to raw copy */ if (!/ffmpeg/.test(e.message)) throw e; }
    }
    if (p.tracks.length === 1) { fs.copyFileSync(p.tracks[0].file, dest); return { path: dest, note: 'Saved without remuxing' }; }
    const base = dest.replace(/\.[^.]+$/, '');
    p.tracks.forEach((t, i) => fs.copyFileSync(t.file, `${base}.${i === 0 ? 'video' : 'audio'}${extOf(t.mime)}`));
    return { path: `${base}.video${extOf(p.tracks[0].mime)}`, note: 'Saved video and audio as separate files (ffmpeg is not available to merge them)' };
  }

  clear(tab) { if (tab.mse) { this._wipe(tab.mse); tab.mse = null; } }
  _wipe(st) { for (const b of st.bufs.values()) for (const p of b.parts) try { fs.rmSync(p.file, { force: true }); } catch (_) {} st.bufs.clear(); st.total = 0; }
  wipeAll() { try { for (const f of fs.readdirSync(this.dir)) fs.rmSync(path.join(this.dir, f), { force: true }); } catch (_) {} }
}
module.exports = { MseCapture, kindOf, extOf };
