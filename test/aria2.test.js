'use strict';
// Run: node test/aria2.test.js   (a stub "aria2c" script stands in for the real binary)
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-'));
const stub = path.join(tmp, process.platform === 'win32' ? 'aria2c.cmd' : 'aria2c');
const js = path.join(tmp, 'stub.js');
fs.writeFileSync(js, `
const http = require('http'); const a = process.argv.slice(2);
const arg = n => (a.find(x => x.startsWith('--' + n + '=')) || '').split('=').slice(1).join('=');
require('fs').writeFileSync(process.env.STUB_ARGS, JSON.stringify(a));
http.createServer((q, s) => { let d = ''; q.on('data', c => d += c); q.on('end', () => { const j = JSON.parse(d); s.setHeader('content-type', 'application/json');
  if (j.params[0] !== 'token:' + arg('rpc-secret')) return s.end(JSON.stringify({ id: j.id, error: { message: 'Unauthorized' } }));
  s.end(JSON.stringify({ id: j.id, result: j.method === 'aria2.getVersion' ? { version: '1.37.0' } : j.params.slice(1) })); }); }).listen(+arg('rpc-listen-port'), '127.0.0.1');
`);
fs.writeFileSync(stub, process.platform === 'win32' ? `@node "${js}" %*\r\n` : `#!/bin/sh\nexec node "${js}" "$@"\n`, { mode: 0o755 });
process.env.ARIA2C_PATH = stub; process.env.STUB_ARGS = path.join(tmp, 'args.json');
const { Aria2, available } = require('../src/aria2');
(async () => {
  assert(available());
  const a = new Aria2({ filesDir: path.join(tmp, 'files'), getOptions: () => ({ dht: false, maxPeers: 33, trackers: ['udp://t:1/announce', 'http://u:2/announce'], downKB: 500, upKB: 0 }) });
  assert.deepStrictEqual(await a.call('aria2.addUri', ['magnet:x'], { dir: 'd' }), [['magnet:x'], { dir: 'd' }]);   // started on demand, secret accepted
  assert.strictEqual(a.version, '1.37.0'); assert(a.running());
  const args = JSON.parse(fs.readFileSync(process.env.STUB_ARGS, 'utf8'));
  for (const want of ['--enable-rpc=true', '--rpc-listen-all=false', '--enable-dht=false', '--bt-max-peers=33', '--bt-tracker=udp://t:1/announce,http://u:2/announce', '--max-overall-download-limit=500K', '--stop-with-process=' + process.pid]) assert(args.includes(want), 'missing ' + want + ' in ' + args.join(' '));
  assert(!args.some(x => x.startsWith('--max-overall-upload-limit')));
  a.secret = 'wrong'; await assert.rejects(a.call('aria2.getVersion'), /Unauthorized/); a.secret = args.find(x => x.startsWith('--rpc-secret=')).slice(13);
  a.stop(); await new Promise(r => setTimeout(r, 300)); assert(!a.running());
  console.log('aria2 wrapper ok');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}   // best effort: Windows may still hold the folder for a moment
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
