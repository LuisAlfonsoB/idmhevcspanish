'use strict';
// aria2c as the BitTorrent engine: we start one aria2c process with its JSON-RPC server on a random localhost port
// (protected by a random secret) and talk to it over HTTP. Ported from the Android app's aria.py.
//
// Where the binary comes from (first hit wins):
//   $ARIA2C_PATH, <resources>/bin/aria2c(.exe) (packaged build), <project>/bin/aria2c(.exe) (running from source), PATH.
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
// Newer Node versions refuse to spawn .cmd/.bat files directly on Windows (spawn EINVAL), so run those through cmd.exe.
// Real aria2c.exe (and anything non-Windows) is spawned directly.
function launch(bin, args, opts) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const q = a => '"' + String(a).replace(/"/g, '""') + '"';
    const p = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + [bin, ...args].map(q).join(' ') + '"'], { ...opts, windowsVerbatimArguments: true });
    p.__tree = true;   // killing cmd.exe alone would leave the real program running
    return p;
  }
  return spawn(bin, args, opts);
}

const EXE = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c';

let cached;
function binary() {
  if (cached !== undefined) return cached;
  cached = null;
  const cands = [];
  if (process.env.ARIA2C_PATH) cands.push(process.env.ARIA2C_PATH);
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'bin', EXE));
  cands.push(path.join(__dirname, '..', 'bin', EXE));
  cands.push(path.join(path.dirname(process.execPath), EXE), path.join(path.dirname(process.execPath), 'bin', EXE));
  for (const d of (process.env.PATH || '').split(path.delimiter)) if (d) cands.push(path.join(d, EXE));
  for (const c of cands) { try { if (fs.statSync(c).isFile()) { cached = c; break; } } catch (_) {} }
  return cached;
}
const available = () => !!binary();
const MISSING = 'aria2c was not found. Put aria2c.exe in the "bin" folder next to the app (or set ARIA2C_PATH). Download: https://github.com/aria2/aria2/releases';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

class Aria2 {
  /** filesDir: where dht.dat / the log live. getOptions(): { dht, maxPeers, trackers, downKB, upKB } read at start. */
  constructor({ filesDir, getOptions }) {
    this.filesDir = filesDir; this.getOptions = getOptions || (() => ({}));
    this.proc = null; this.port = 0; this.secret = ''; this.starting = null; this.version = '';
    this.logFile = path.join(filesDir, 'aria2.log');
  }
  available() { return available(); }
  _tail() { try { return fs.readFileSync(this.logFile, 'utf8').trim().split('\n').slice(-6).join('\n'); } catch (_) { return ''; } }
  running() { return !!(this.proc && this.proc.exitCode === null && !this.proc.killed); }

  async start() {
    if (this.running()) return;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }
  async _start() {
    const bin = binary(); if (!bin) throw new Error(MISSING);
    try { fs.mkdirSync(this.filesDir, { recursive: true }); } catch (_) {}
    const o = this.getOptions();
    this.port = await freePort(); this.secret = crypto.randomBytes(16).toString('hex');
    const args = [
      '--enable-rpc=true', '--rpc-listen-port=' + this.port, '--rpc-secret=' + this.secret, '--rpc-listen-all=false', '--no-conf=true',
      '--dir=' + this.filesDir, '--async-dns=false', '--disable-ipv6=true', '--file-allocation=none', '--allow-overwrite=true',
      '--auto-file-renaming=false', '--max-concurrent-downloads=8', '--summary-interval=0', '--console-log-level=warn',
      '--seed-time=0', '--bt-enable-lpd=true', '--enable-dht=' + (o.dht === false ? 'false' : 'true'), '--enable-dht6=false', '--enable-peer-exchange=true',
      '--bt-max-peers=' + (o.maxPeers || 80), '--bt-request-peer-speed-limit=2M', '--follow-torrent=true', '--rpc-save-upload-metadata=false',
      '--bt-save-metadata=false', '--dht-file-path=' + path.join(this.filesDir, 'dht.dat'), '--listen-port=51413-51423', '--dht-listen-port=51413-51423',
      '--user-agent=aria2/1.37.0', '--stop-with-process=' + process.pid
    ];
    if (o.trackers && o.trackers.length) args.push('--bt-tracker=' + o.trackers.join(','));
    if (o.downKB > 0) args.push('--max-overall-download-limit=' + o.downKB + 'K');
    if (o.upKB > 0) args.push('--max-overall-upload-limit=' + o.upKB + 'K');
    let log; try { log = fs.openSync(this.logFile, 'w'); } catch (_) { log = 'ignore'; }
    let spawnErr = null;
    const p = launch(bin, args, { windowsHide: true, stdio: ['ignore', log, log], cwd: this.filesDir });
    p.on('error', e => { spawnErr = e; });
    if (typeof log === 'number') { try { fs.closeSync(log); } catch (_) {} }
    this.proc = p;
    p.on('exit', () => { if (this.proc === p) this.proc = null; });
    for (let i = 0; i < 60; i++) {
      if (spawnErr) { this.proc = null; throw new Error('Could not launch aria2c: ' + spawnErr.message); }
      if (p.exitCode !== null) { this.proc = null; throw new Error(`aria2c exited (code ${p.exitCode}): ${this._tail()}`); }
      try { this.version = (await this._rpc('aria2.getVersion')).version; return; } catch (_) { await new Promise(r => setTimeout(r, 200)); }
    }
    this.stop();
    throw new Error('aria2c did not answer: ' + this._tail());
  }
  stop() {
    try {
      if (this.proc) {
        if (this.proc.__tree && this.proc.pid) { try { require('child_process').spawnSync('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true }); } catch (_) {} }
        this.proc.kill();
      }
    } catch (_) {}
    this.proc = null;
  }

  _rpc(method, ...params) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'dm', method, params: ['token:' + this.secret, ...params] });
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: this.port, path: '/jsonrpc', method: 'POST', timeout: 20000, agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        let d = ''; res.setEncoding('utf8'); res.on('data', c => { d += c; });
        res.on('end', () => {
          let j; try { j = JSON.parse(d); } catch (_) { return reject(new Error('aria2: bad answer')); }
          if (j.error) return reject(new Error(j.error.message || 'aria2 error'));
          resolve(j.result);
        });
      });
      req.on('timeout', () => req.destroy(new Error('aria2 did not answer in time')));
      req.on('error', reject); req.end(body);
    });
  }
  /** Calls an aria2 RPC method (starting aria2c first if needed). */
  async call(method, ...params) {
    if (!this.running()) await this.start();
    return this._rpc(method, ...params);
  }
}
module.exports = { Aria2, binary, available, MISSING };
