'use strict';
// Thin wrapper around the bundled ffmpeg binary (ffmpeg-static). Used to mux DASH audio+video,
// remux HLS .ts to .mp4, and to download SAMPLE-AES HLS streams. Everything degrades gracefully without it.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let cached;
function binary() {
  if (cached !== undefined) return cached;
  cached = null;
  const cands = [];
  if (process.env.FFMPEG_PATH) cands.push(process.env.FFMPEG_PATH);
  try {
    let p = require('ffmpeg-static');
    if (p) cands.push(p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`).replace('app.asar/', 'app.asar.unpacked/'));
  } catch (_) {}
  for (const c of cands) { try { if (fs.existsSync(c)) { cached = c; break; } } catch (_) {} }
  return cached;
}
const available = () => !!binary();

/**
 * run(args, { onTime(seconds) }) -> { promise, kill() }.  Rejects with the last stderr lines on failure.
 */
function run(args, { onTime } = {}) {
  const bin = binary();
  let child = null, killed = false;
  const promise = new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('ffmpeg is not available'));
    child = spawn(bin, ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args], { windowsHide: true });
    let err = '';
    child.stderr.on('data', d => { err = (err + d.toString()).slice(-2000); });
    child.stdout.on('data', d => {
      if (!onTime) return;
      const m = /out_time_(?:us|ms)=(\d+)/.exec(d.toString());
      if (m) onTime(parseInt(m[1], 10) / 1e6);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (killed) return reject(new Error('aborted'));
      code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err.trim().split('\n').slice(-3).join(' | ')));
    });
  });
  return { promise, kill() { killed = true; try { child && child.kill('SIGKILL'); } catch (_) {} } };
}
/**
 * Probe a source with `ffmpeg -i` (there is no ffprobe in ffmpeg-static): resolves { duration (s, 0 if unknown/live), audio, video }
 * and never rejects. inputArgs are placed before -i (e.g. -user_agent / -headers for http sources).
 */
function mediaInfo(src, { inputArgs = [], timeout = 25000 } = {}) {
  const none = { duration: 0, audio: '', video: '' };
  return new Promise(resolve => {
    const bin = binary(); if (!bin) return resolve(none);
    let out = '', done = false, child;
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer);
      const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
      const a = /Stream #[^\n]*?: Audio: ([a-z0-9_]+)/i.exec(out), v = /Stream #[^\n]*?: Video: ([a-z0-9_]+)/i.exec(out);
      resolve({ duration: d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : 0, audio: a ? a[1].toLowerCase() : '', video: v ? v[1].toLowerCase() : '' });
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish(); }, timeout);
    try { child = spawn(bin, ['-hide_banner', '-nostdin', ...inputArgs, '-i', src], { windowsHide: true }); } catch (_) { return resolve(none); }
    child.stderr.on('data', d => { if (out.length < 30000) out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); done = true; resolve(none); });
    child.on('close', finish);
  });
}
/**
 * Grab one small JPEG frame from a (remote) source without downloading it all. Resolves a Buffer, or null on any failure.
 * opts: { inputArgs, at (seconds to seek to), width, hls (adds -allowed_extensions for HLS inputs), timeout }
 */
function thumbnail(src, { inputArgs = [], at = 0, width = 240, hls = false, timeout = 20000 } = {}) {
  return new Promise(resolve => {
    const bin = binary(); if (!bin) return resolve(null);
    const chunks = []; let n = 0, done = false, child;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); const b = Buffer.concat(chunks); resolve(b.length > 200 ? b : null); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish(); }, timeout);
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', ...(at > 0 ? ['-ss', String(Math.floor(at))] : []), ...inputArgs, ...(hls ? ['-allowed_extensions', 'ALL'] : []),
      '-i', src, '-frames:v', '1', '-an', '-vf', 'scale=' + width + ':-2', '-q:v', '5', '-f', 'mjpeg', 'pipe:1'];
    try { child = spawn(bin, args, { windowsHide: true }); } catch (_) { return resolve(null); }
    child.stdout.on('data', d => { n += d.length; if (n < 2 * 1024 * 1024) chunks.push(d); });
    child.on('error', () => { clearTimeout(timer); done = true; resolve(null); });
    child.on('close', finish);
  });
}
module.exports = { binary, available, run, mediaInfo, thumbnail };
