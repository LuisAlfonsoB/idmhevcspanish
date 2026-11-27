'use strict';
// Downloads aria2c.exe (Windows 64-bit) from the official aria2 release into ./bin. Run: npm run get-aria2
// On other systems install aria2 yourself (it is found on PATH) or set ARIA2C_PATH.
const fs = require('fs'), path = require('path'), https = require('https'), { execFileSync } = require('child_process');
const VERSION = '1.37.0', ZIP = `aria2-${VERSION}-win-64bit-build1`;
const URL_ = `https://github.com/aria2/aria2/releases/download/release-${VERSION}/${ZIP}.zip`;
const bin = path.join(__dirname, '..', 'bin'), exe = path.join(bin, 'aria2c.exe');
if (fs.existsSync(exe)) { console.log('aria2c.exe already in bin/'); process.exit(0); }
if (process.platform !== 'win32') { console.log('Not Windows: install aria2 with your package manager (it is found on PATH) or set ARIA2C_PATH.'); process.exit(0); }
fs.mkdirSync(bin, { recursive: true });
const get = (u, n = 0) => new Promise((res, rej) => https.get(u, r => {
  if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && n < 5) { r.resume(); return res(get(r.headers.location, n + 1)); }
  if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode + ' for ' + u));
  const c = []; r.on('data', d => c.push(d)); r.on('end', () => res(Buffer.concat(c)));
}).on('error', rej));
(async () => {
  console.log('Downloading', URL_);
  const zip = path.join(bin, 'aria2.zip'); fs.writeFileSync(zip, await get(URL_));
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${bin}'`], { stdio: 'inherit' });
  fs.copyFileSync(path.join(bin, ZIP, 'aria2c.exe'), exe);
  fs.rmSync(zip, { force: true }); fs.rmSync(path.join(bin, ZIP), { recursive: true, force: true });
  console.log('OK:', exe);
})().catch(e => { console.error('Could not download aria2c:', e.message); process.exit(1); });
