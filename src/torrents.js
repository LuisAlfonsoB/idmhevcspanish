'use strict';
// BitTorrent support through aria2c (JSON-RPC, see aria2.js) — the same engine as the Android app.
//
// Features:
//   * peek(): read the file list of a magnet / .torrent *before* downloading, so the picker can choose files
//   * selective downloads, per-torrent "keep seeding" (aria2 stops by itself at the ratio / time goal), stall timeout
//   * openStream(): get one file of a torrent for the Restream page. aria2 cannot hand out a half-downloaded file, so this
//     downloads the chosen file first (progress is reported) and then returns its path on disk.
const fs = require('fs');
const path = require('path');
const { shell, Notification } = require('electron');
const { L } = require('./i18n');
const { parseTorrent } = require('./bencode');
const { Aria2 } = require('./aria2');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function magnetHash(uri) {
  const m = /xt=urn:btih:([a-z0-9]+)/i.exec(uri || '');
  if (!m) return null;
  const h = m[1];
  if (/^[0-9a-f]{40}$/i.test(h)) return h.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(h)) {
    let bits = '';
    for (const c of h.toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
    let hex = ''; for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex.slice(0, 40);
  }
  return null;
}
const VIDEO_EXT = new Set(['mp4', 'mkv', 'mov', 'avi', 'webm', 'ts', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg', 'm2ts', '3gp', 'ogv']);
const isVideo = n => VIDEO_EXT.has(path.extname(n || '').slice(1).toLowerCase());
const META_TTL = 30 * 60 * 1000;
const SEED_CAP_MIN = 525600;   // "seed forever" = one year
// Public trackers added to magnet links (same idea as the Android app's `--bt-tracker`): many magnets carry only one or two
// trackers, and DHT alone can be slow or blocked on some networks. Refreshed daily from the ngosang list when reachable.
const FALLBACK_TRACKERS = [
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'http://tracker.mywaifu.best:6969/announce',
  'udp://tracker.qu.ax:6969/announce',
  'udp://evan.im:6969/announce',
  'udp://martin-gebhardt.eu:25/announce',
  'udp://torrent.tracker.durukanbal.com:6969/announce',
  'udp://tr4ck3r.duckdns.org:6969/announce',
  'http://tracker.waaa.moe:6969/announce',
  'http://wegkxfcivgx.ydns.eu:80/announce',
  'http://tracker.renfei.net:8080/announce',
  'http://tracker.dhitechnical.com:6969/announce',
  'https://t.213891.xyz:443/announce',
  'udp://ns575949.ip-51-222-82.net:6969/announce',
  'https://tracker.7471.top:443/announce',
  'udp://tracker.wildkat.net:6969/announce',
  'udp://tracker.nyaa.vc:6969/announce',
  'udp://tracker.opentrackr.com:6969/announce',
  'udp://tracker.cn.nyaa.net:6969/announce',
  'https://1.tracker.eu.org:443/announce',
  'udp://tracker.torrents.observer:80/announce',
  'https://tracker.yume-hatsuyuki.moe:443/announce',
  'udp://tracker.transfur.org:6969/announce',
  'udp://discover.curiousfacts.blog:6969/announce',
  'udp://tracker.evergarden.uk:1914/announce',
  'https://tracker.augrains.com:443/announce',
  'udp://stairs.lat:6969/announce',
  'udp://tracker.corpscorp.online:80/announce',
  'http://bt2.archive.org:6969/announce',
  'udp://mail.segso.net:6969/announce',
  'udp://tracker.peerfect.org:6969/announce',
  'udp://tracker.ilibr.org:6969/announce',
  'udp://tracker.ducks.party:1984/announce',
  'udp://tracker.okade.pro:1337/announce',
  'udp://announce.augrains.com:6969/announce',
  'https://tracker.nekomi.cn:443/announce',
  'https://004430.xyz:443/announce',
  'http://bt1.archive.org:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.willy.pro:6969/announce',
  'udp://kolankoalastree.newtrackon.co.nz:1337/announce',
  'https://tracker.qingwapt.org:443/announce',
  'udp://tracker-udp.gbitt.info:80/announce',
  'https://tracker.foreverpirates.co:443/announce',
  'udp://open.ftorrent.com:443/announce',
  'udp://tracker.nyaa.net:6969/announce',
  'udp://tracker.dler.com:6969/announce',
  'udp://tracker.alt.cx:6969/announce',
  'udp://bittorrent-tracker.e-n-c-r-y-p-t.net:1337/announce',
  'udp://v2.iperson.xyz:6969/announce',
  'http://tracker.internetwarriors.net:1337/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://tracker.filemail.com:6969/announce',
  'https://tracker.tamersunion.org:443/announce',
  'https://tracker1.520.jp:443/announce'
];
const TRACKERS_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt';

const STATUS_KEYS = ['status', 'totalLength', 'completedLength', 'uploadLength', 'downloadSpeed', 'uploadSpeed', 'connections', 'numSeeders',
  'seeder', 'errorMessage', 'files', 'infoHash'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

class TorrentManager {
  /** aria: optional engine object with call(method, ...params) (tests pass a fake one). */
  constructor({ store, dir, tmpDir, getSettings, getDownloadDir, onChange, aria }) {
    this.store = store;                    // array of persisted records
    this.dir = dir;                        // where .torrent files, trackers and DHT state are cached
    this.tmpDir = tmpDir;                  // temporary data (metadata fetches, streams that are not kept); wiped on start
    this.getSettings = getSettings; this.getDownloadDir = getDownloadDir; this.onChange = onChange;
    this.aria = aria || new Aria2({ filesDir: dir, getOptions: () => {
      const s = this.getSettings();
      return { dht: s.torrentDht !== false, maxPeers: s.torrentMaxPeers || 80, trackers: this.trackers || FALLBACK_TRACKERS, downKB: +s.torrentDownKB || 0, upKB: +s.torrentUpKB || 0 };
    } });
    this.recs = new Map();                 // infoHash -> record (temp stream records have temp:true and are never listed or saved)
    this.gids = new Map();                 // infoHash -> aria2 gid of the running download
    this.live = new Map();                 // infoHash -> last tellStatus
    this.holds = new Map();                // infoHash -> number of restreams reading from it
    this.metaCache = new Map();            // infoHash -> { buf, meta, at }  (.torrent bytes fetched by peek())
    this.beat = new Map();                 // infoHash -> { bytes, time }    (stall watchdog)
    this.timer = null; this.polling = false; this.trackers = null;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
    for (const r of store.get()) this.recs.set(r.infoHash, r);
  }

  /** Extra trackers for magnet links: cached list (refreshed daily, best effort), merged with the built-in one. */
  async _loadTrackers() {
    if (this.trackers) return this.trackers;
    const f = path.join(this.dir, 'trackers.txt');
    const parse = t => t.split(/\r?\n/).map(x => x.trim()).filter(x => /^(udp|https?):\/\//i.test(x));
    let list = [];
    try { list = parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
    let fresh = false; try { fresh = Date.now() - fs.statSync(f).mtimeMs < 24 * 3600 * 1000; } catch (_) {}
    if (!list.length || !fresh) {
      try {
        const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 6000);
        const r = await fetch(TRACKERS_URL, { signal: ctl.signal }); clearTimeout(timer);
        const got = r.ok ? parse(await r.text()) : [];
        if (got.length) { list = got; try { fs.writeFileSync(f, got.join('\n')); } catch (_) {} }
      } catch (_) {}
    }
    return (this.trackers = [...new Set([...FALLBACK_TRACKERS, ...list])]);
  }
  async _call(method, ...params) {
    if (!this.trackers) await this._loadTrackers();
    return this.aria.call(method, ...params);
  }
  /** Settings changed: speed limits apply immediately (the rest needs a restart). */
  applyLimits() {
    if (!this.aria.running || !this.aria.running()) return;
    const s = this.getSettings(), k = v => (v > 0 ? v + 'K' : '0');
    this.aria.call('aria2.changeGlobalOption', { 'max-overall-download-limit': k(+s.torrentDownKB), 'max-overall-upload-limit': k(+s.torrentUpKB) }).catch(() => {});
  }

  /** Re-add unfinished (and seeding, if enabled) torrents saved from the last session. */
  async restore() {
    for (const [k, r] of [...this.recs]) {
      if (r.temp) { this.recs.delete(k); continue; }
      if (r.state === 'error') continue;
      if (r.paused) { r.state = 'paused'; continue; }
      if (r.done && !this._wantsSeed(r)) { r.state = 'completed'; continue; }
      this._start(r).catch(() => {});
    }
    this.changed();
  }
  _torrentFile(key) { return path.join(this.dir, key + '.torrent'); }
  /** per-torrent choice wins; otherwise the Settings default */
  _wantsSeed(r) { return typeof r.seed === 'boolean' ? r.seed : !!this.getSettings().torrentSeed; }
  _hashOf(input) {
    if (Buffer.isBuffer(input)) { try { return parseTorrent(input).hash; } catch (_) { return null; } }
    if (typeof input === 'string') return /^[0-9a-f]{40}$/i.test(input.trim()) ? input.trim().toLowerCase() : magnetHash(input);
    return null;
  }
  _norm(input) { return typeof input === 'string' && /^[0-9a-f]{40}$/i.test(input.trim()) ? 'magnet:?xt=urn:btih:' + input.trim().toLowerCase() : input; }

  // ------------------------------------------------------------------ peek (file list before downloading)
  _pruneMeta() {
    const now = Date.now();
    for (const [k, v] of this.metaCache) if (now - v.at > META_TTL) this.metaCache.delete(k);
    while (this.metaCache.size > 20) this.metaCache.delete(this.metaCache.keys().next().value);
  }
  /** parsed metadata of a torrent we have seen before (cache, or the .torrent saved next to its record) */
  _metaFor(key) {
    const c = this.metaCache.get(key); if (c) return c.meta;
    try { return parseTorrent(fs.readFileSync(this._torrentFile(key))); } catch (_) { return null; }
  }
  _publicMeta(meta, extra = {}) {
    return { key: meta.hash, name: meta.name, length: meta.length, files: meta.files.map(f => ({ ...f, video: isVideo(f.name) })), ...extra };
  }
  /** Ask aria2 for a magnet's metadata only; resolves the .torrent bytes. */
  async _fetchMetadata(magnet, { timeout = 120000, onStatus } = {}) {
    const hash = magnetHash(magnet) || 'x';
    const mdir = path.join(this.tmpDir, 'meta-' + hash.slice(0, 8) + '-' + Date.now().toString(36));
    fs.mkdirSync(mdir, { recursive: true });
    let gid, found = null;
    const t0 = Date.now();
    try {
      gid = await this._call('aria2.addUri', [magnet], { dir: mdir, 'bt-metadata-only': 'true', 'bt-save-metadata': 'true', 'follow-torrent': 'false' });
      let lastSize = -1, peers = 0;
      while (Date.now() - t0 < timeout) {
        const st = await this._call('aria2.tellStatus', gid, ['status', 'errorMessage', 'connections']).catch(() => null);
        if (st) peers = +st.connections || 0;
        if (onStatus) onStatus(Math.round((Date.now() - t0) / 1000), peers);
        let names = []; try { names = fs.readdirSync(mdir); } catch (_) {}
        for (const n of names) if (n.endsWith('.torrent')) found = path.join(mdir, n);
        if (st && st.status === 'error' && !found) throw new Error('aria2 could not fetch the magnet: ' + (st.errorMessage || 'unknown error'));
        if (found) {
          const size = fs.statSync(found).size;           // aria2 writes the file when the metadata is complete; wait until it stops growing
          if ((st && (st.status === 'complete' || st.status === 'removed')) || (size > 0 && size === lastSize)) break;
          lastSize = size;
        }
        await sleep(1000);
      }
      if (!found) {
        const n = peers;
        throw new Error('Could not get the file list from peers in ' + Math.round(timeout / 1000) + ' s. ' + (n
          ? `Found ${n} peer${n === 1 ? '' : 's'} but none sent the file list. Try again or use a .torrent file.`
          : 'No peers were reachable: DHT and trackers may be blocked (check Windows Firewall for aria2c, and turn off any VPN), or the magnet is dead. You can also use a .torrent file.'));
      }
      return fs.readFileSync(found);
    } finally {
      if (gid) for (const m of ['aria2.forceRemove', 'aria2.removeDownloadResult']) { try { await this._call(m, gid); } catch (_) {} }
      try { fs.rmSync(mdir, { recursive: true, force: true }); } catch (_) {}
    }
  }
  /**
   * input: magnet URI, 40-char info-hash, Buffer of a .torrent. Resolves { key, name, length, files } (key = info-hash).
   * A magnet link needs the peers' help (up to `timeout` ms); a .torrent is read instantly.
   */
  async peek(input, { timeout = 120000 } = {}) {
    input = this._norm(input);
    if (Buffer.isBuffer(input)) {
      const meta = parseTorrent(input);
      this.metaCache.set(meta.hash, { buf: input, meta, at: Date.now() });
      return this._publicMeta(meta, { known: this.recs.has(meta.hash) });
    }
    const hash = magnetHash(input);
    if (!hash) throw new Error('Enter a magnet link, a torrent info-hash, or a link to a .torrent file');
    this._pruneMeta();
    const cached = this.metaCache.get(hash);
    if (cached) return this._publicMeta(cached.meta, { known: this.recs.has(hash) });
    const cf = this._torrentFile(hash);
    if (fs.existsSync(cf)) return this.peek(fs.readFileSync(cf));
    const buf = await this._fetchMetadata(input, { timeout });
    const meta = parseTorrent(buf);
    this.metaCache.set(hash, { buf, meta, at: Date.now() });
    return this._publicMeta(meta, { known: this.recs.has(hash) });
  }

  // ------------------------------------------------------------------ add
  /**
   * input: magnet URI, Buffer of a .torrent, or a 40-char info-hash.
   * opts: paused, files (array of indexes to download, default all), seed (true/false/undefined = Settings), dir
   * Resolves as soon as the torrent is in the list; a magnet's metadata and the download continue in the background
   * (failures show up as the torrent's error state).
   */
  async add(input, { paused = false, files = null, seed, dir, temp = false } = {}) {
    if (!this.aria.available()) throw new Error(require('./aria2').MISSING);
    input = this._norm(input);
    const infoHash = this._hashOf(input);
    if (!infoHash) throw new Error('Not a valid torrent, magnet link or info-hash');
    if (this.gids.has(infoHash)) return { infoHash, duplicate: true };
    const old = this.recs.get(infoHash);
    if (old && !temp && old.state === 'completed') this.recs.delete(infoHash);      // re-adding a completed torrent: verify & seed again
    let deselected = [], name = infoHash, length = 0;
    const meta = Buffer.isBuffer(input) ? parseTorrent(input) : (this.metaCache.get(infoHash) || {}).meta;
    if (Buffer.isBuffer(input)) this.metaCache.set(infoHash, { buf: input, meta, at: Date.now() });
    if (meta) {
      name = meta.name; length = meta.length;
      if (Array.isArray(files)) { const keep = new Set(files); deselected = meta.files.filter(f => !keep.has(f.index)).map(f => f.index); }
    }
    const rec = { infoHash, magnet: typeof input === 'string' ? input : '', name, path: dir || (temp ? path.join(this.tmpDir, 'stream-' + infoHash.slice(0, 8)) : this.getDownloadDir()),
      state: 'metadata', done: false, paused, added: Date.now(), deselected, length, error: '' };
    if (temp) rec.temp = true;
    if (typeof seed === 'boolean') rec.seed = seed;
    this.recs.set(infoHash, rec);
    this._save(rec);
    this.changed();
    this._start(rec).catch(() => {});
    return { infoHash };
  }
  /** Add what peek() loaded, with the picker's choices. */
  async addPeeked(key, opts) {
    const c = this.metaCache.get(key);
    if (!c) throw new Error('That torrent is no longer loaded. Open it again.');
    return this.add(c.buf, opts);
  }

  _addOptions(rec, meta) {
    const s = this.getSettings();
    const o = { dir: rec.path, 'seed-time': '0', 'bt-stop-timeout': '0', 'check-integrity': 'true', continue: 'true', 'bt-save-metadata': 'false' };
    if (this._wantsSeed(rec) && !rec.temp) {    // keep sharing: aria2 stops by itself at the ratio or after the minutes
      const ratio = +s.torrentSeedRatio || 0, mins = +s.torrentSeedMinutes || 0;
      o['seed-ratio'] = ratio.toFixed(2); o['seed-time'] = String(mins || SEED_CAP_MIN);
    }
    const dsel = new Set(rec.deselected || []);
    if (dsel.size && meta) {
      const idx = meta.files.filter(f => !dsel.has(f.index)).map(f => f.index + 1);
      if (!idx.length) throw new Error('No files selected');
      if (idx.length !== meta.files.length) o['select-file'] = idx.join(',');
    }
    return o;
  }
  /** Hand a record to aria2 (fetching the magnet's metadata first if needed). */
  async _start(rec) {
    const key = rec.infoHash;
    try {
      rec.state = 'metadata'; rec.error = ''; this.changed();
      let buf = null;
      try { buf = fs.readFileSync(this._torrentFile(key)); } catch (_) {}
      if (!buf) { const c = this.metaCache.get(key); if (c) buf = c.buf; }
      if (!buf) {
        const limit = Math.min(Math.max(60, +this.getSettings().torrentTimeout || 600) * 1000, 300000);
        buf = await this._fetchMetadata(rec.magnet || 'magnet:?xt=urn:btih:' + key, { timeout: limit });
        if (!this.recs.has(key) || this.recs.get(key) !== rec) return;      // removed meanwhile
      }
      const meta = parseTorrent(buf);
      this.metaCache.set(key, { buf, meta, at: Date.now() });
      if (!rec.temp) { try { fs.writeFileSync(this._torrentFile(key), buf); } catch (_) {} }
      rec.name = meta.name; rec.length = meta.length;
      try { fs.mkdirSync(rec.path, { recursive: true }); } catch (_) {}
      const gid = await this._call('aria2.addTorrent', buf.toString('base64'), [], this._addOptions(rec, meta));
      this.gids.set(key, gid);
      if (rec.paused) { await this._call('aria2.pause', gid).catch(() => {}); rec.state = 'paused'; }
      else rec.state = 'downloading';
      this.beat.set(key, { bytes: -1, time: Date.now() });
      this._save(rec); this._startTimer(); this.changed();
    } catch (e) {
      if (this.recs.get(key) !== rec) return;
      rec.state = 'error'; rec.error = e.message || String(e);
      this._save(rec); this.changed();
    }
  }
  _fail(key, msg) {
    const r = this.recs.get(key); if (!r) return;
    this._drop(key);
    r.state = 'error'; r.error = msg; this._save(r); this.changed();
  }
  /** remove from aria2 (files stay on disk) */
  async _drop(key) {
    const gid = this.gids.get(key);
    this.gids.delete(key); this.live.delete(key); this.beat.delete(key);
    if (!gid) return;
    for (const m of ['aria2.forceRemove', 'aria2.removeDownloadResult']) { try { await this._call(m, gid); } catch (_) {} }
  }

  _save(rec) { if (rec.infoHash && !rec.temp) { this.recs.set(rec.infoHash, rec); this.store.set([...this.recs.values()].filter(r => !r.temp).map(r => ({ ...r }))); } }
  _startTimer() { if (!this.timer) this.timer = setInterval(() => { this._poll(); }, 1000); }

  /** Once a second: read every running download from aria2, update states, abandon stalled ones. */
  async _poll() {
    if (this.polling) return; this.polling = true;
    try {
      const s = this.getSettings(), now = Date.now();
      const limit = Math.max(60, +s.torrentTimeout || 600) * 1000;
      for (const [key, gid] of [...this.gids]) {
        const r = this.recs.get(key); if (!r) { this._drop(key); continue; }
        let st; try { st = await this._call('aria2.tellStatus', gid, STATUS_KEYS); } catch (e) { if (/not found/i.test(e.message)) { this.gids.delete(key); } continue; }
        if (this.gids.get(key) !== gid) continue;
        this.live.set(key, st);
        const total = +st.totalLength || 0, done = +st.completedLength || 0;
        r.uploaded = +st.uploadLength || r.uploaded || 0;
        if (st.status === 'error') { this._fail(key, 'aria2: ' + (st.errorMessage || 'download failed')); continue; }
        if (st.status === 'removed') { this.gids.delete(key); this.live.delete(key); continue; }
        const finished = st.status === 'complete' || (total > 0 && done >= total);
        if (finished && !r.done) {
          r.done = true; r.downloaded = r.length || total;
          if (!r.temp) { try { new Notification({ title: L('Torrent complete'), body: r.name }).on('click', () => this.action(key, 'show')).show(); } catch (_) {} }
        }
        if (st.status === 'complete') {            // aria2 is finished with it (no seeding, or the seed goal was reached)
          r.state = 'completed'; r.downloaded = r.length || total; r.uploaded = +st.uploadLength || r.uploaded || 0;
          this.gids.delete(key); this.live.delete(key); this.beat.delete(key);
          this._call('aria2.removeDownloadResult', gid).catch(() => {});
          this._cleanControlFiles(r);
          this._save(r); continue;
        }
        if (finished) { if (r.state !== 'seeding') { r.state = 'seeding'; r.seedStart = now; this._save(r); } continue; }
        if (st.status === 'paused') { r.state = 'paused'; continue; }
        if (r.state === 'metadata' || r.state === 'paused') r.state = 'downloading';
        if (r.paused) { this.beat.delete(key); continue; }
        const b = this.beat.get(key) || { bytes: -1, time: now };
        if (done !== b.bytes) { b.bytes = done; b.time = now; }
        this.beat.set(key, b);
        if (now - b.time > limit) this._fail(key, `Stalled: no progress for ${Math.round(limit / 60000)} min. Use Retry to try again.`);
      }
      if (!this.gids.size) { clearInterval(this.timer); this.timer = null; }
      this.changed();
    } finally { this.polling = false; }
  }
  _cleanControlFiles(rec) {
    const meta = this._metaFor(rec.infoHash); if (!meta) return;
    const roots = new Set(meta.files.map(f => path.join(rec.path, f.path)));
    for (const f of roots) { try { fs.rmSync(f + '.aria2', { force: true }); } catch (_) {} }
    try { fs.rmSync(path.join(rec.path, meta.name + '.aria2'), { force: true }); } catch (_) {}
  }
  changed() { this.onChange(this.list()); }

  list() {
    return [...this.recs.values()].filter(r => !r.temp).sort((a, b) => b.added - a.added).map(r => {
      const st = this.live.get(r.infoHash);
      const o = { infoHash: r.infoHash, name: r.name, path: r.path, state: r.state, done: !!r.done, error: r.error || '', added: r.added, deselected: r.deselected || [], length: r.length || 0, magnet: r.magnet, seed: this._wantsSeed(r) };
      if (st && this.gids.has(r.infoHash)) {
        const total = +st.totalLength || 0, got = +st.completedLength || 0, speed = +st.downloadSpeed || 0;
        o.length = r.length || total; o.downloaded = got; o.uploaded = +st.uploadLength || r.uploaded || 0; o.progress = total ? Math.min(1, got / total) : 0;
        o.down = speed; o.up = +st.uploadSpeed || 0; o.peers = +st.connections || 0; o.eta = speed > 0 && total > got ? Math.round((total - got) / speed) : 0;
        o.ratio = got ? o.uploaded / got : 0;
        o.files = (st.files || []).map(f => { const i = (+f.index || 1) - 1, len = +f.length || 0; return { i, name: path.basename(f.path || ''), path: f.path, length: len, progress: len ? (+f.completedLength || 0) / len : 0, selected: f.selected !== 'false', video: isVideo(f.path) }; });
      } else {
        o.progress = r.state === 'completed' ? 1 : 0; o.downloaded = r.downloaded || 0; o.uploaded = r.uploaded || 0; o.down = 0; o.up = 0; o.peers = 0; o.eta = 0; o.ratio = 0;
        const meta = this._metaFor(r.infoHash);
        o.files = meta ? meta.files.map(f => ({ i: f.index, name: f.name, path: f.path, length: f.length, progress: r.state === 'completed' && !(r.deselected || []).includes(f.index) ? 1 : 0, selected: !(r.deselected || []).includes(f.index), video: isVideo(f.name) })) : [];
      }
      return o;
    });
  }

  async action(infoHash, act, arg) {
    if (act === 'clear-finished') {
      for (const [k, x] of [...this.recs]) if (!x.temp && !this.gids.has(k) && (x.state === 'completed' || x.state === 'error')) this.recs.delete(k);
      this.store.set([...this.recs.values()].filter(x => !x.temp).map(x => ({ ...x }))); this.changed(); return;
    }
    const r = this.recs.get(infoHash); if (!r) return;
    const gid = this.gids.get(infoHash);
    switch (act) {
      case 'pause': r.paused = true; r.state = 'paused'; if (gid) await this._call('aria2.pause', gid).catch(() => {}); break;
      case 'resume': case 'retry':
        r.paused = false; this.beat.delete(infoHash);
        if (gid && act === 'resume') { await this._call('aria2.unpause', gid).catch(() => {}); r.state = r.done ? 'seeding' : 'downloading'; }
        else { await this._drop(infoHash); r.error = ''; if (r.done && !this._wantsSeed(r)) r.done = false; this._start(r).catch(() => {}); }
        break;
      case 'seed': if (!gid) { r.paused = false; r.seed = true; r.state = 'seeding'; r.seedStart = Date.now(); this._start(r).catch(() => {}); } break;
      case 'stop-seeding': if (gid && r.state === 'seeding') { r.state = 'completed'; r.seed = false; await this._drop(infoHash); this._cleanControlFiles(r); } break;
      case 'remove': case 'delete':
        await this._drop(infoHash); this.recs.delete(infoHash);
        try { fs.rmSync(this._torrentFile(infoHash), { force: true }); } catch (_) {}
        if (act === 'delete' && r.name) { try { await shell.trashItem(path.join(r.path, r.name)); } catch (_) {} }
        this.store.set([...this.recs.values()].filter(x => !x.temp).map(x => ({ ...x })));
        this.changed(); return;
      case 'open': { const p = path.join(r.path, r.name || ''); const e = await shell.openPath(fs.existsSync(p) ? p : r.path); if (e) return e; break; }
      case 'show': { const p = path.join(r.path, r.name || ''); fs.existsSync(p) ? shell.showItemInFolder(p) : shell.openPath(r.path); break; }
      case 'files': { // arg: array of selected file indexes. aria2 cannot change select-file on the fly, so restart it (the data on disk is kept and verified)
        const meta = this._metaFor(infoHash); if (!meta) break;
        const sel = new Set((arg || []).map(Number));
        if (!sel.size) break;
        r.deselected = meta.files.filter(f => !sel.has(f.index)).map(f => f.index);
        if (gid) { await this._drop(infoHash); r.done = false; if (r.state !== 'paused') this._start(r).catch(() => {}); }
        break;
      }
    }
    this._save(r); this.changed();
  }

  // ------------------------------------------------------------------ one file for Restream
  /**
   * Get one file of a peeked torrent as a local file. aria2 downloads it completely first (onProgress({ progress, peers, down }) is
   * called meanwhile; isCancelled() aborts and returns null). keep: the torrent stays in the list and the folder; otherwise the data is temporary.
   * Resolves { url (a file path), name, length, stats(), release() }.
   */
  async openStream(key, index, { keep = false, onProgress, isCancelled } = {}) {
    let rec = this.recs.get(key), meta = this._metaFor(key);
    if (!meta) throw new Error('That torrent is no longer loaded. Load it again.');
    const f = meta.files[index]; if (!f) throw new Error('That file is not in the torrent.');
    let temporary = false;
    if (!rec) {
      if (!this.metaCache.get(key)) { const c = this._metaFor(key); this.metaCache.set(key, { buf: fs.readFileSync(this._torrentFile(key)), meta: c, at: Date.now() }); }
      const c = this.metaCache.get(key);
      const r = await this.add(c.buf, { files: [index], seed: false, temp: !keep });
      if (r && r.error) throw new Error(r.error);
      rec = this.recs.get(key); temporary = !keep;
    } else if (!rec.temp) {
      // a torrent of the user's: make sure this file is wanted
      if ((rec.deselected || []).includes(index)) await this.action(key, 'files', meta.files.map(x => x.index).filter(i => i === index || !(rec.deselected || []).includes(i)));
      if (rec.paused) await this.action(key, 'resume');
    }
    const local = () => path.join(rec.path, f.path);
    this.holds.set(key, (this.holds.get(key) || 0) + 1);
    let released = false;
    const release = async () => {
      if (released) return; released = true;
      const n = (this.holds.get(key) || 1) - 1;
      if (n > 0) this.holds.set(key, n); else this.holds.delete(key);
      if (n > 0 || !temporary) return;
      await this._drop(key); this.recs.delete(key);
      try { fs.rmSync(rec.path, { recursive: true, force: true }); } catch (_) {}
    };
    // wait until the file is complete
    for (;;) {
      if (isCancelled && isCancelled()) { await release(); return null; }
      const cur = this.recs.get(key);
      if (!cur || cur.state === 'error') { const msg = cur ? cur.error : 'The torrent was removed.'; await release(); throw new Error(msg || 'The torrent failed.'); }
      const st = this.live.get(key);
      const sf = st && (st.files || [])[index];
      const complete = (cur.state === 'completed' || cur.state === 'seeding' || cur.done) || (sf && +sf.length > 0 && +sf.completedLength >= +sf.length);
      if (onProgress) onProgress({ progress: sf && +sf.length ? (+sf.completedLength || 0) / +sf.length : (complete ? 1 : 0), peers: st ? +st.connections || 0 : 0, down: st ? +st.downloadSpeed || 0 : 0, state: cur.state });
      if (complete && fs.existsSync(local())) break;
      if (complete && !this.gids.has(key)) { await release(); throw new Error('The downloaded file is no longer on disk: ' + local()); }
      await sleep(1000);
    }
    return { url: local(), name: f.name, length: f.length, stats: () => ({ peers: 0, down: 0, progress: 1 }), release };
  }

  async destroy() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.aria.stop && this.aria.stop(); } catch (_) {}
    try { fs.rmSync(this.tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}
module.exports = { TorrentManager, magnetHash, isVideo };
