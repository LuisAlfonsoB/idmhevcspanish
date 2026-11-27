'use strict';
// Run: node test/torrents.test.js   (uses a fake aria2 RPC engine, no network, no aria2c needed)
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...a) { if (req === 'electron') return { shell: { trashItem: async () => {}, openPath: async () => '', showItemInFolder() {} }, Notification: function () { this.on = () => this; this.show = () => {}; } }; return origLoad.call(this, req, ...a); };
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { TorrentManager, magnetHash } = require('../src/torrents');
const { parseTorrent } = require('../src/bencode');

const B = s => Buffer.from(s);
function makeTorrentFile(name, files) {      // files: [[path, length]]
  const entries = files.map(([p, l]) => Buffer.concat([B('d6:lengthi' + l + 'e4:pathl'), ...p.split('/').map(x => B(x.length + ':' + x)), B('ee')]));
  const info = Buffer.concat([B('d5:filesl'), ...entries, B('e4:name' + name.length + ':' + name + '12:piece lengthi16384e6:pieces20:'), Buffer.alloc(20, 7), B('e')]);
  return { buf: Buffer.concat([B('d4:info'), info, B('e')]), hash: crypto.createHash('sha1').update(info).digest('hex') };
}

/** Minimal stand-in for aria2's JSON-RPC: metadata-only magnets, addTorrent with select-file, tellStatus, pause, remove... */
class FakeAria {
  constructor() { this.dl = new Map(); this.n = 0; this.magnets = new Map(); this.calls = []; }
  available() { return true; } running() { return true; } stop() {}
  byHash(h) { return [...this.dl.values()].find(d => d.hash === h && !d.removed); }
  finish(h) {         // all selected files downloaded (and written to disk)
    const d = this.byHash(h);
    for (const f of d.files) if (f.selected === 'true') { f.completedLength = f.length; fs.mkdirSync(path.dirname(f.path), { recursive: true }); fs.writeFileSync(f.path, 'x'); }
    d.status = +d.opts['seed-time'] > 0 ? 'active' : 'complete'; d.seeder = +d.opts['seed-time'] > 0;
  }
  async call(method, ...p) {
    this.calls.push([method, ...p]);
    switch (method) {
      case 'aria2.addUri': {
        const [uris, opts] = p, h = magnetHash(uris[0]), gid = 'g' + (++this.n), d = { gid, meta: true, hash: h, opts, status: 'active', conn: 0 };
        this.dl.set(gid, d);
        const buf = this.magnets.get(h);
        if (buf) { d.conn = 3; setTimeout(() => { fs.writeFileSync(path.join(opts.dir, h + '.torrent'), buf); d.status = 'complete'; }, 50); }
        return gid;
      }
      case 'aria2.addTorrent': {
        const [b64, , opts] = p, m = parseTorrent(Buffer.from(b64, 'base64')), gid = 'g' + (++this.n);
        const sel = opts['select-file'] ? new Set(opts['select-file'].split(',').map(x => +x - 1)) : null;
        this.dl.set(gid, { gid, hash: m.hash, opts, status: 'active', seeder: false, upload: 0, files: m.files.map(f => ({ index: String(f.index + 1), path: path.join(opts.dir, f.path), length: String(f.length), completedLength: '0', selected: String(!sel || sel.has(f.index)) })) });
        return gid;
      }
      case 'aria2.tellStatus': {
        const d = this.dl.get(p[0]); if (!d || d.removed) throw new Error('GID ' + p[0] + ' is not found');
        if (d.meta) return { status: d.status, connections: String(d.conn), errorMessage: '' };
        const sel = d.files.filter(f => f.selected === 'true');
        return { status: d.status, seeder: String(!!d.seeder), totalLength: String(sel.reduce((a, f) => a + +f.length, 0)), completedLength: String(sel.reduce((a, f) => a + +f.completedLength, 0)),
          uploadLength: String(d.upload), downloadSpeed: '1000', uploadSpeed: '0', connections: '5', errorMessage: d.error || '', files: d.files, infoHash: d.hash };
      }
      case 'aria2.pause': this.dl.get(p[0]).status = 'paused'; return 'OK';
      case 'aria2.unpause': this.dl.get(p[0]).status = 'active'; return 'OK';
      case 'aria2.forceRemove': { const d = this.dl.get(p[0]); if (d) d.removed = true; return p[0]; }
      case 'aria2.removeDownloadResult': { const d = this.dl.get(p[0]); if (d && d.status === 'complete') d.removed = true; return 'OK'; }
      case 'aria2.changeGlobalOption': return 'OK';
      default: throw new Error('fake aria2: unsupported ' + method);
    }
  }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
  const settings = { torrentSeed: false, torrentTimeout: 600, torrentSeedRatio: 0, torrentSeedMinutes: 0 };
  let store = [];
  const aria = new FakeAria();
  const mgr = new TorrentManager({ store: { get: () => store, set: v => { store = v; } }, dir: path.join(tmp, 'tor'), tmpDir: path.join(tmp, 'tmp'), getSettings: () => settings, getDownloadDir: () => path.join(tmp, 'dl'), onChange() {}, aria });
  mgr.trackers = ['udp://t.example:1/announce'];           // no network in tests
  const tf = makeTorrentFile('Show', [['ep1.mkv', 100000], ['ep2.mkv', 50000], ['subs/en.srt', 500], ['readme.txt', 10]]);
  const poll = async () => { await mgr._poll(); };

  // --- peek: .torrent (instant) and magnet (aria2 metadata-only), dead magnet reports why
  let m = await mgr.peek(tf.buf);
  assert.strictEqual(m.key, tf.hash); assert.strictEqual(m.files.length, 4); assert.strictEqual(m.files[0].video, true); assert.strictEqual(m.files[2].video, false);
  mgr.metaCache.clear(); aria.magnets.set(tf.hash, tf.buf);
  m = await mgr.peek('magnet:?xt=urn:btih:' + tf.hash.toUpperCase() + '&dn=Show');
  assert.strictEqual(m.name, 'Show');
  const mc = aria.calls.find(c => c[0] === 'aria2.addUri');
  assert.strictEqual(mc[2]['bt-metadata-only'], 'true');
  assert(aria.calls.some(c => c[0] === 'aria2.forceRemove'), 'metadata download not removed');
  assert(!fs.readdirSync(path.join(tmp, 'tmp')).some(n => n.startsWith('meta-')), 'metadata temp dir left behind');
  const dead = 'f'.repeat(40);
  await assert.rejects(mgr.peek('magnet:?xt=urn:btih:' + dead, { timeout: 150 }), /No peers were reachable/);
  await assert.rejects(mgr.peek('hello'), /magnet/);
  console.log('peek ok');

  // --- add only the chosen files
  let r = await mgr.addPeeked(tf.hash, { files: [0, 2], seed: true });
  assert.strictEqual(r.infoHash, tf.hash);
  await new Promise(res => setTimeout(res, 50));
  const add = aria.calls.filter(c => c[0] === 'aria2.addTorrent').pop();
  assert.strictEqual(add[3]['select-file'], '1,3'); assert.strictEqual(add[3].dir, path.join(tmp, 'dl'));
  assert.strictEqual(add[3]['seed-time'], '525600');                      // seed:true -> keep sharing
  assert.deepStrictEqual(mgr.recs.get(tf.hash).deselected, [1, 3]);
  assert.strictEqual(mgr.recs.get(tf.hash).state, 'downloading');
  let l = mgr.list()[0]; assert.strictEqual(l.seed, true); assert.strictEqual(l.files.length, 4);
  await poll(); l = mgr.list()[0];
  assert.deepStrictEqual(l.files.map(f => f.selected), [true, false, true, false]); assert.strictEqual(l.peers, 5);
  assert((await mgr.add(tf.buf)).duplicate, 'second add should be a duplicate');
  console.log('selective add ok');

  // --- stall watchdog
  const realNow = Date.now; let now = realNow();
  Date.now = () => now;
  await poll();                       // arms the beat
  now += 9 * 60000; await poll(); assert.strictEqual(mgr.recs.get(tf.hash).state, 'downloading');
  aria.byHash(tf.hash).files[0].completedLength = '1000'; await poll(); now += 9 * 60000; await poll();      // progress resets the clock
  assert.strictEqual(mgr.recs.get(tf.hash).state, 'downloading');
  now += 2 * 60000; await poll();
  assert.strictEqual(mgr.recs.get(tf.hash).state, 'error'); assert(/Stalled/.test(mgr.recs.get(tf.hash).error)); assert(!mgr.gids.has(tf.hash));
  console.log('stall watchdog ok');

  // --- retry, finish, keep seeding (per-torrent), then aria2 ends the seeding at its goal
  await mgr.action(tf.hash, 'retry'); await new Promise(res => setTimeout(res, 50));
  assert(mgr.gids.has(tf.hash), 'retry should re-add'); assert.strictEqual(mgr.recs.get(tf.hash).error, '');
  aria.finish(tf.hash); await poll();
  assert.strictEqual(mgr.recs.get(tf.hash).state, 'seeding'); assert.strictEqual(mgr.recs.get(tf.hash).done, true);
  aria.byHash(tf.hash).status = 'complete'; await poll();               // seed goal reached
  assert.strictEqual(mgr.recs.get(tf.hash).state, 'completed'); assert(!mgr.gids.has(tf.hash));
  console.log('seed goal ok');

  // --- pause / resume / file change / remove
  const tfp = makeTorrentFile('Pack', [['a.mkv', 3000], ['b.mkv', 2000]]);
  await mgr.peek(tfp.buf); await mgr.addPeeked(tfp.hash, { seed: false }); await new Promise(res => setTimeout(res, 50));
  await mgr.action(tfp.hash, 'pause'); assert.strictEqual(mgr.recs.get(tfp.hash).state, 'paused'); assert.strictEqual(aria.byHash(tfp.hash).status, 'paused');
  await mgr.action(tfp.hash, 'resume'); assert.strictEqual(aria.byHash(tfp.hash).status, 'active');
  await mgr.action(tfp.hash, 'files', [1]); await new Promise(res => setTimeout(res, 50));
  assert.deepStrictEqual(mgr.recs.get(tfp.hash).deselected, [0]);
  assert.strictEqual(aria.calls.filter(c => c[0] === 'aria2.addTorrent').pop()[3]['select-file'], '2');
  await mgr.action(tfp.hash, 'remove'); assert(!mgr.recs.has(tfp.hash)); assert(!aria.byHash(tfp.hash));
  console.log('pause / resume / files / remove ok');

  // --- restream source: the file is downloaded first (progress reported), then its path is returned
  const tf2 = makeTorrentFile('Movie', [['film.mp4', 100000]]);
  await mgr.peek(tf2.buf);
  const seen = [];
  const p2 = mgr.openStream(tf2.hash, 0, { keep: true, onProgress: p => seen.push(p) });
  await new Promise(res => setTimeout(res, 1200));
  assert(!(await Promise.race([p2, Promise.resolve('pending')]) !== 'pending'), 'resolved before the download finished');
  aria.finish(tf2.hash); await poll();
  const st = await p2;
  assert.strictEqual(st.url, path.join(tmp, 'dl', 'Movie', 'film.mp4')); assert(fs.existsSync(st.url)); assert(seen.length >= 1);
  assert.strictEqual(mgr.recs.get(tf2.hash).state, 'completed'); assert(mgr.list().some(x => x.infoHash === tf2.hash), 'kept torrent should be listed');
  await st.release();
  // already completed on disk: returned at once
  const st2 = await mgr.openStream(tf2.hash, 0, {}); assert.strictEqual(st2.url, st.url);
  console.log('stream (download first) ok');

  // --- temporary stream: not listed, data in the temp folder, wiped on release; cancel works
  const tf3 = makeTorrentFile('Clip', [['a.mkv', 100000], ['b.mkv', 20]]); await mgr.peek(tf3.buf);
  const p3 = mgr.openStream(tf3.hash, 1, {});
  await new Promise(res => setTimeout(res, 300));
  assert(!mgr.list().some(x => x.infoHash === tf3.hash), 'temporary streams must not show up in the list'); assert(!store.some(x => x.infoHash === tf3.hash));
  assert.strictEqual(aria.calls.filter(c => c[0] === 'aria2.addTorrent').pop()[3]['select-file'], '2');
  aria.finish(tf3.hash); await poll();
  const s3 = await p3; assert(fs.existsSync(s3.url));
  await s3.release(); assert(!fs.existsSync(path.dirname(s3.url)) && !mgr.recs.has(tf3.hash) && !aria.byHash(tf3.hash));
  const tf4 = makeTorrentFile('Cancel', [['c.mkv', 5000]]); await mgr.peek(tf4.buf);
  let cancel = false; const p4 = mgr.openStream(tf4.hash, 0, { isCancelled: () => cancel });
  await new Promise(res => setTimeout(res, 300)); cancel = true;
  assert.strictEqual(await p4, null); assert(!mgr.recs.has(tf4.hash) && !aria.byHash(tf4.hash));
  console.log('temporary stream + cancel ok');

  Date.now = realNow;
  await mgr.destroy(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ALL OK');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
