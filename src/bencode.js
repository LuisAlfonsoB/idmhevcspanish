'use strict';
// Minimal .torrent reader: just enough to list the files and compute the info-hash without starting
// a download (port of the Android app's bencode.py). Used by the torrent picker and the restream page.
const crypto = require('crypto');

function decode(buf) {
  let i = 0, infoSpan = null;
  const fail = () => { throw new Error('Not a valid .torrent file'); };
  function int() {
    const e = buf.indexOf(0x65, i); if (e < 0) fail();
    const n = parseInt(buf.toString('latin1', i + 1, e), 10); if (!Number.isFinite(n)) fail();
    i = e + 1; return n;
  }
  function bytes() {
    const c = buf.indexOf(0x3a, i); if (c < 0) fail();
    const len = parseInt(buf.toString('latin1', i, c), 10); if (!(len >= 0) || c + 1 + len > buf.length) fail();
    const out = buf.subarray(c + 1, c + 1 + len); i = c + 1 + len; return out;
  }
  function value(depth, topKey) {
    if (depth > 32 || i >= buf.length) fail();
    const ch = buf[i];
    if (ch === 0x69) return int();                                   // i123e
    if (ch === 0x6c) { i++; const a = []; while (buf[i] !== 0x65) { if (i >= buf.length) fail(); a.push(value(depth + 1)); } i++; return a; }
    if (ch === 0x64) {
      i++; const o = {};
      while (buf[i] !== 0x65) {
        if (i >= buf.length) fail();
        const k = bytes().toString('latin1');
        const start = i;
        o[k] = value(depth + 1, depth === 0 ? k : undefined);
        if (depth === 0 && k === 'info') infoSpan = [start, i];
      }
      i++; return o;
    }
    if (ch >= 0x30 && ch <= 0x39) return bytes();
    return fail();
  }
  const root = value(0);
  return { root, infoSpan };
}

const str = b => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b == null ? '' : b));
const clean = s => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');

/** -> { hash, name, length, files: [{ index, path, name, length }] } */
function parseTorrent(buf) {
  const { root, infoSpan } = decode(buf);
  const info = root && root.info;
  if (!info || !infoSpan || typeof info !== 'object') throw new Error('Not a valid .torrent file (no info section)');
  const hash = crypto.createHash('sha1').update(buf.subarray(infoSpan[0], infoSpan[1])).digest('hex');
  const name = clean(str(info['name.utf-8'] || info.name)) || hash;
  const files = [];
  if (Array.isArray(info.files)) {
    info.files.forEach((f, index) => {
      const parts = (f['path.utf-8'] || f.path || []).map(p => clean(str(p)));
      const p = parts.join('/');
      files.push({ index, path: name + '/' + p, name: parts[parts.length - 1] || p, length: +f.length || 0 });
    });
  } else {
    files.push({ index: 0, path: name, name, length: +info.length || 0 });
  }
  return { hash, name, length: files.reduce((a, f) => a + f.length, 0), files };
}
module.exports = { parseTorrent };
