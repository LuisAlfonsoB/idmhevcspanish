'use strict';
// Downloads the official yt-dlp.exe (Windows) into ./bin so it is packaged with the app. Run: npm run get-ytdlp
// Not fatal if it fails: the app also downloads and updates its own copy at run time (into the user-data folder).
// On other systems install yt-dlp yourself (it is found on PATH) or set YTDLP_PATH.
const fs = require('fs'), path = require('path'), https = require('https');
const URL_ = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const bin = path.join(__dirname, '..', 'bin'), exe = path.join(bin, 'yt-dlp.exe');
if (fs.existsSync(exe)) { console.log('yt-dlp.exe already in bin/'); process.exit(0); }
if (process.platform !== 'win32') { console.log('Not Windows: install yt-dlp with your package manager (it is found on PATH) or set YTDLP_PATH.'); process.exit(0); }
fs.mkdirSync(bin, { recursive: true });
const get = (u, n = 0) => new Promise((res, rej) => https.get(u, { headers: { 'User-Agent': '1DM-Browser-build' } }, r => {
  if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && n < 5) { r.resume(); return res(get(r.headers.location, n + 1)); }
  if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode + ' for ' + u));
  const c = []; r.on('data', d => c.push(d)); r.on('end', () => res(Buffer.concat(c)));
}).on('error', rej));
(async () => {
  console.log('Downloading', URL_);
  const buf = await get(URL_);
  if (buf.length < 5 * 1024 * 1024) throw new Error('file is too small (' + buf.length + ' bytes)');
  fs.writeFileSync(exe, buf);
  console.log('OK:', exe, Math.round(buf.length / 1048576) + ' MB');
})().catch(e => { console.warn('Could not download yt-dlp (YouTube downloads will fetch it on first run instead):', e.message); });
