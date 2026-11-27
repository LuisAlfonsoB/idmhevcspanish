'use strict';
const fs = require('fs');
const path = require('path');
const { shell, Notification, session } = require('electron');
const { L } = require('./i18n');
const { SegmentedDownload } = require('./accel');
const { HlsDownload } = require('./hls');
const { DashDownload } = require('./dash');
const ffmpeg = require('./ffmpeg');
const { probe } = require('./net');

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name), i = 1;
  while (fs.existsSync(p) || fs.existsSync(p + '.1dmpart')) p = path.join(dir, `${base} (${i++})${ext}`);
  return p;
}
function sanitize(name) {
  name = (name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 150);
  return name || 'download';
}
function nameFromUrl(u) {
  try { const b = decodeURIComponent(path.basename(new URL(u).pathname)); return b && b !== '/' ? b : ''; } catch (_) { return ''; }
}
const isHlsUrl = u => /\.m3u8(\?|#|$)/i.test(u);
const isMpdUrl = u => /\.mpd(\?|#|$)/i.test(u);

class DownloadManager {
  constructor(o) {
    Object.assign(this, { store: o.store, getSettings: o.getSettings, getDefaultDir: o.getDefaultDir, getTmpDir: o.getTmpDir, onChange: o.onChange, onProgress: o.onProgress, askSavePath: o.askSavePath, onTorrent: o.onTorrent });
    this.forceAsk = new Map();   // url -> expiry: "Save … as" requests that must always show the save dialog
    this.items = new Map();      // id -> Electron DownloadItem (browser-engine downloads)
    this.engines = new Map();    // id -> SegmentedDownload | HlsDownload
    this.localCancel = new Map();   // id -> stop function of a running local job (capture, yt-dlp)
    this.records = new Map();
    this.timer = null; this.tickTimer = null;
    for (const r of store(o).get()) {
      if (r.state === 'progressing' || r.state === 'paused') r.state = r.live ? 'interrupted' : (r.kind === 'accel' || r.kind === 'hls' || r.kind === 'dash') ? 'paused' : 'interrupted';
      r.speed = 0;
      this.records.set(r.id, r);
    }
  }

  // ---------- helpers ----------
  headersFor(rec) {
    return async url => {
      const h = { 'User-Agent': rec.ua || 'Mozilla/5.0' };
      if (rec.referrer) h['Referer'] = rec.referrer;
      try {
        const cookies = await session.fromPartition(rec.partition || 'persist:main').cookies.get({ url });
        if (cookies.length) h['Cookie'] = cookies.map(c => c.name + '=' + c.value).join('; ');
      } catch (_) {}
      return h;
    };
  }
  newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  /** Next Chromium download of this URL always asks where to save (used by "Save image/link/media as…"). */
  askNext(url) { this.forceAsk.set(url, Date.now() + 15000); }
  targetDir() { const d = this.getSettings().downloadDir || this.getDefaultDir(); try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} return d; }

  // ---------- Chromium downloads (with automatic acceleration) ----------
  attach(ses, incognito, partition) {
    ses.on('will-download', (event, item, wc) => {
      const settings = this.getSettings();
      const url = item.getURL();
      const referrer = wc && !wc.isDestroyed() ? wc.getURL() : '';
      if (this.onTorrent && (/\.torrent(\?|#|$)/i.test(item.getFilename() || '') || item.getMimeType() === 'application/x-bittorrent')) {
        item.cancel(); this.onTorrent(url, { referrer, partition, ua: ses.getUserAgent() }); return;
      }
      const id = this.newId();
      const name = sanitize(item.getFilename());
      const fa = this.forceAsk.get(url); this.forceAsk.delete(url);
      const ask = !!settings.askDownloadLocation || (fa !== undefined && fa > Date.now());
      const rec = {
        id, kind: 'chromium', url, filename: name, path: '', total: item.getTotalBytes(), received: 0, state: 'progressing',
        startTime: Date.now(), endTime: 0, speed: 0, mime: item.getMimeType(), incognito: !!incognito, referrer, partition, ua: ses.getUserAgent()
      };
      let tmp = null, target = Promise.resolve(null);
      if (!ask) { rec.path = uniquePath(this.targetDir(), name); item.setSavePath(rec.path); }
      else {
        tmp = path.join(this.getTmpDir(), id + '_' + name);
        item.setSavePath(tmp);
        target = this.askSavePath(path.join(this.targetDir(), name)).then(p => { if (!p) item.cancel(); else { rec.path = p; rec.filename = path.basename(p); } return p; });
      }
      this.items.set(id, item); this.records.set(id, rec);
      let lastBytes = 0, lastTime = Date.now();
      item.on('updated', (e, state) => {
        rec.received = item.getReceivedBytes(); rec.total = item.getTotalBytes();
        rec.state = state === 'interrupted' ? 'interrupted' : (item.isPaused() ? 'paused' : 'progressing');
        const now = Date.now();
        if (now - lastTime >= 700) { rec.speed = Math.max(0, (rec.received - lastBytes) / ((now - lastTime) / 1000)); lastBytes = rec.received; lastTime = now; }
        if (rec.state !== 'progressing') rec.speed = 0;
        this.changed();
      });
      item.once('done', async (e, state) => {
        if (rec.hijacked) { this.items.delete(id); return; }
        this.items.delete(id);
        if (state === 'completed' && tmp) {
          const dest = await target;
          try { fs.renameSync(tmp, dest); } catch (_) { try { fs.copyFileSync(tmp, dest); fs.rmSync(tmp, { force: true }); } catch (err) { state = 'interrupted'; } }
        } else if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch (_) {} }
        if (!tmp) { const sp = item.getSavePath(); if (sp) { rec.path = sp; rec.filename = path.basename(sp); } }
        rec.received = item.getReceivedBytes(); rec.state = state; rec.speed = 0; rec.endTime = Date.now();
        if (state === 'completed') this.notifyDone(rec);
        this.persist(); this.changed(true);
      });
      this.changed(true);

      // try to take over with multiple connections
      if (settings.accelerated !== false && /^https?:/i.test(url) && (!rec.total || rec.total >= (settings.accelMinMB || 2) * 1048576)) {
        probe(url, { headersFor: this.headersFor(rec) }).then(async info => {
          if (!this.items.has(id) || rec.state === 'completed' || rec.state === 'cancelled') return;
          if (!info.ranges || info.size < (settings.accelMinMB || 2) * 1048576) return;
          const dest = await target;
          if (!dest && ask) return;
          rec.hijacked = true; item.cancel();
          this.records.delete(id); this.items.delete(id);
          this.beginAccel({ url, referrer, partition, ua: rec.ua, incognito, info, dest: dest || rec.path, filename: path.basename(dest || rec.path), startTime: rec.startTime });
        }).catch(() => { /* leave the browser download running */ });
      }
    });
  }

  // ---------- direct URL downloads (grabber, "Add URL") ----------
  async startUrl({ url, referrer = '', partition = 'persist:main', ua = '', filename = '', incognito = false, kind = 'auto', videoId = '' }) {
    if (!/^https?:/i.test(url)) throw new Error('Only http(s) links can be downloaded');
    const settings = this.getSettings();
    const base = { url, referrer, partition, ua, incognito, videoId };
    if (kind === 'hls' || (kind === 'auto' && isHlsUrl(url))) return this.beginStream('hls', { ...base, filename });
    if (kind === 'dash' || (kind === 'auto' && isMpdUrl(url))) return this.beginStream('dash', { ...base, filename });
    const rec = { id: this.newId(), kind: 'accel', url, filename: sanitize(filename || nameFromUrl(url)), path: '', total: 0, received: 0, state: 'progressing', startTime: Date.now(), endTime: 0, speed: 0, incognito, referrer, partition, ua, connections: 0, probing: true };
    this.records.set(rec.id, rec); this.changed(true);
    try {
      const info = await probe(url, { headersFor: this.headersFor(rec) });
      this.records.delete(rec.id);
      if (/mpegurl/i.test(info.mime) && kind === 'auto') return this.beginStream('hls', { ...base, filename });
      if (/dash\+xml/i.test(info.mime) && kind === 'auto') return this.beginStream('dash', { ...base, filename });
      const name = sanitize(filename || info.filename || nameFromUrl(info.finalUrl) || nameFromUrl(url));
      let dest;
      if (settings.askDownloadLocation) { dest = await this.askSavePath(path.join(this.targetDir(), name)); if (!dest) return null; }
      else dest = uniquePath(this.targetDir(), name);
      return this.beginAccel({ ...base, info, dest, filename: path.basename(dest) });
    } catch (e) {
      rec.state = 'interrupted'; rec.probing = false; rec.error = e.message; rec.filename = rec.filename || 'download'; this.records.set(rec.id, rec); this.persist(); this.changed(true);
      return rec.id;
    }
  }

  beginAccel({ url, referrer, partition, ua, incognito, info, dest, filename, startTime, resume }) {
    const settings = this.getSettings();
    const rec = resume || { id: this.newId(), kind: 'accel', url, filename, path: dest, total: info.size, received: 0, state: 'progressing', startTime: startTime || Date.now(), endTime: 0, speed: 0, mime: info.mime, incognito: !!incognito, referrer, partition, ua };
    rec.path = dest; rec.total = info.size; rec.state = 'progressing'; rec.error = ''; rec.probing = false;
    const conns = info.ranges ? Math.max(1, Math.min(16, settings.connections || 8)) : 1;
    rec.connections = conns;
    const eng = new SegmentedDownload({ url: info.finalUrl || url, dest, size: info.size, ranges: info.ranges, connections: conns, headersFor: this.headersFor(rec), etag: info.etag, lastModified: info.lastModified });
    this.wireEngine(rec, eng);
    this.records.set(rec.id, rec); this.engines.set(rec.id, eng);
    eng.start();
    this.changed(true);
    return rec.id;
  }

  /** HLS or DASH: playlists/manifests are parsed first so the file gets the right extension. */
  async beginStream(type, { url, referrer, partition, ua, incognito, filename, resume, videoId }) {
    const settings = this.getSettings();
    const rec = resume || { id: this.newId(), kind: type, url, filename: sanitize(filename || 'stream'), path: '', total: 0, received: 0, state: 'progressing', startTime: Date.now(), endTime: 0, speed: 0, incognito: !!incognito, referrer, partition, ua, videoId: videoId || '', probing: true };
    rec.state = 'progressing'; rec.probing = true; rec.error = '';
    this.records.set(rec.id, rec); this.changed(true);
    const opts = { url, headersFor: this.headersFor(rec), videoId: rec.videoId || '' };
    const eng = type === 'dash' ? new DashDownload(opts) : new HlsDownload({ ...opts, allowLive: true, remux: settings.hlsToMp4 !== false });
    try {
      const info = await eng.prepare();
      if (!rec.path) {
        let name = sanitize(filename || (nameFromUrl(url).replace(/\.(m3u8|mpd)$/i, '') || 'stream'));
        name = name.replace(/\.(mp4|ts|m3u8|mpd|mkv|webm)$/i, '') + info.ext;
        rec.path = settings.askDownloadLocation ? await this.askSavePath(path.join(this.targetDir(), name)) : uniquePath(this.targetDir(), name);
        if (!rec.path) { this.records.delete(rec.id); this.changed(true); return null; }
        rec.filename = path.basename(rec.path);
      }
      rec.live = !!info.live; rec.height = (info.tracks && info.tracks.find(t => t.kind === 'video') || {}).height || 0;
      eng.dest = rec.path; rec.probing = false;
      this.wireEngine(rec, eng); this.engines.set(rec.id, eng);
      eng.start(); this.changed(true);
    } catch (e) { rec.state = 'interrupted'; rec.probing = false; rec.error = e.message; this.persist(); this.changed(true); }
    return rec.id;
  }

  wireEngine(rec, eng) {
    eng.on('done', () => { rec.state = 'completed'; rec.received = rec.kind === 'accel' ? rec.total : eng.received; rec.total = rec.received; if (eng.dest && rec.kind !== 'accel') { rec.path = eng.dest; rec.filename = path.basename(eng.dest); } if (eng.note) rec.note = eng.note; rec.live = false; rec.stage = ''; rec.speed = 0; rec.endTime = Date.now(); this.engines.delete(rec.id); this.notifyDone(rec); this.persist(); this.changed(true); });
    eng.on('error', e => { rec.state = 'interrupted'; rec.error = e.message; rec.speed = 0; rec.received = eng.received; this.engines.delete(rec.id); this.persist(); this.changed(true); });
    eng.on('paused', () => { rec.state = 'paused'; rec.speed = 0; rec.received = eng.received; this.persist(); this.changed(true); });
    this.startTick();
  }
  startTick() {
    if (this.tickTimer) return;
    let last = Date.now(); const lastBytes = new Map();
    this.tickTimer = setInterval(() => {
      const now = Date.now(), dt = (now - last) / 1000; last = now;
      if (!this.engines.size) { clearInterval(this.tickTimer); this.tickTimer = null; return; }
      for (const [id, eng] of this.engines) {
        const rec = this.records.get(id); if (!rec) continue;
        rec.received = eng.received;
        if (rec.kind === 'hls' || rec.kind === 'dash') {
          rec.stage = eng.stage || 'download'; rec.mergePct = Math.round((eng.mergeFraction || 0) * 100);
          if (rec.live) { rec.total = 0; rec.segments = `${eng.index} segments recorded`; }
          else { const f = eng.fraction; rec.total = f > 0.01 ? Math.round(eng.received / f) : 0; rec.segments = `${eng.index}/${eng.count}`; }
        }
        else { rec.total = eng.size || rec.total; rec.active = eng.activeConnections; }
        const prev = lastBytes.get(id) || eng.received;
        rec.speed = eng.state === 'running' ? Math.max(0, (eng.received - prev) / dt) : 0;
        lastBytes.set(id, eng.received);
      }
      this.changed();
    }, 500);
  }
  notifyDone(rec) { try { new Notification({ title: L('Download complete'), body: rec.filename }).on('click', () => shell.showItemInFolder(rec.path)).show(); } catch (_) {} }

  // ---------- state ----------
  persist() {
    const keep = [...this.records.values()].filter(r => !r.incognito && !r.probing).sort((a, b) => b.startTime - a.startTime).slice(0, 500);
    this.store.set(keep);
  }
  changed(now) {
    const fire = () => {
      this.timer = null;
      this.onChange(this.list());
      let total = 0, got = 0, active = 0;
      for (const [id, r] of this.records) {
        if (r.state === 'progressing' && (this.items.has(id) || this.engines.has(id) || r.probing || this.localCancel.has(id))) { active++; if (r.total > 0) { total += r.total; got += r.received; } }
      }
      this.onProgress(active ? (total ? got / total : 2) : -1, active);
    };
    if (now) { clearTimeout(this.timer); fire(); }
    else if (!this.timer) this.timer = setTimeout(fire, 250);
  }
  list() { return [...this.records.values()].sort((a, b) => b.startTime - a.startTime).map(r => { const { ua, ...rest } = r; return rest; }); }
  hasActive() { return this.items.size > 0 || [...this.engines.values()].some(e => e.state === 'running'); }

  async action(id, act) {
    if (act === 'clear') {
      for (const [k, r] of [...this.records]) if (!this.items.has(k) && !this.engines.has(k) && !this.localCancel.has(k) && !r.probing && r.state !== 'paused') this.records.delete(k);
      this.persist(); this.changed(true); return;
    }
    if (act === 'pause-all') { for (const [, e] of this.engines) e.pause(); for (const [, i] of this.items) if (!i.isPaused()) i.pause(); return; }
    const rec = this.records.get(id); if (!rec) return;
    const item = this.items.get(id), eng = this.engines.get(id);
    const removeFiles = () => { if (rec.kind !== 'chromium' && rec.path) for (const s of ['.1dmpart', '.1dmpart.video', '.1dmpart.audio', '.1dmmeta']) try { fs.rmSync(rec.path + s, { force: true }); } catch (_) {} };
    switch (act) {
      case 'stop': if (eng && rec.live) eng.stop(); break;
      case 'pause': if (eng) await eng.pause(); else if (item && !item.isPaused()) item.pause(); break;
      case 'resume':
        if (eng && eng.state === 'paused') { rec.state = 'progressing'; eng.start(); this.startTick(); }
        else if (item && item.canResume()) item.resume();
        else if (!item && !eng) await this.resumeRecord(rec);
        break;
      case 'cancel':
        if (eng) { await eng.cancel(); this.engines.delete(id); rec.state = 'cancelled'; rec.speed = 0; this.persist(); }
        else if (item) item.cancel();
        else if (this.localCancel.has(id)) { rec.state = 'cancelled'; rec.speed = 0; try { this.localCancel.get(id)(); } catch (_) {} this.persist(); }
        else if (rec.state === 'paused' || rec.state === 'interrupted') { removeFiles(); rec.state = 'cancelled'; this.persist(); }
        break;
      case 'open': if (rec.path) { const r = await shell.openPath(rec.path); if (r) return r; } break;
      case 'show': if (rec.path) shell.showItemInFolder(rec.path); break;
      case 'remove': if (eng) await eng.cancel(); else if (item) item.cancel(); else if (this.localCancel.has(id)) { try { this.localCancel.get(id)(); } catch (_) {} } else removeFiles(); this.engines.delete(id); this.records.delete(id); this.persist(); break;
      case 'delete-file': if (eng) await eng.cancel(); else if (item) item.cancel(); this.engines.delete(id); try { if (rec.path && rec.state === 'completed') await shell.trashItem(rec.path); } catch (_) {} removeFiles(); this.records.delete(id); this.persist(); break;
    }
    this.changed(true);
  }

  /** Run a one-off local job (e.g. building a file from captured streaming video) as a download entry. */
  runLocal({ filename, path: dest, incognito, url, local }, task) {
    const rec = { id: this.newId(), kind: 'capture', url: url || '', filename, path: dest, total: 0, received: 0, state: 'progressing', startTime: Date.now(), endTime: 0, speed: 0, incognito: !!incognito, probing: false, local: !!local };
    this.records.set(rec.id, rec); this.changed(true);
    // the task may report progress and register a way to stop itself: task({ progress({received,total,speed}), onCancel(fn) })
    const job = {
      progress: p => { if (rec.state !== 'progressing') return; rec.received = p.received || 0; rec.total = p.total || 0; rec.speed = p.speed || 0; this.changed(); },
      onCancel: fn => { this.localCancel.set(rec.id, fn); }
    };
    Promise.resolve().then(() => task(job)).then(r => {
      if (rec.state === 'cancelled') return;
      if (r && r.path) { rec.path = r.path; rec.filename = path.basename(r.path); }
      try { rec.received = rec.total = fs.statSync(rec.path).size; } catch (_) {}
      rec.state = 'completed'; rec.endTime = Date.now(); rec.speed = 0; rec.note = (r && r.note) || ''; this.notifyDone(rec);
    }).catch(e => { if (rec.state !== 'cancelled') { rec.state = 'interrupted'; rec.error = e.message; } rec.speed = 0; }).finally(() => { this.localCancel.delete(rec.id); this.persist(); this.changed(true); });
    return rec.id;
  }

  async resumeRecord(rec) {
    if (rec.kind === 'capture') { rec.error = 'Captured videos cannot be resumed. Play the video again and re-capture it.'; this.changed(true); return; }
    if (rec.kind === 'hls' || rec.kind === 'dash') { if (rec.live) { rec.path = ''; } return this.beginStream(rec.kind, { url: rec.url, referrer: rec.referrer, partition: rec.partition, ua: rec.ua, incognito: rec.incognito, filename: rec.filename, resume: rec }); }
    if (rec.kind === 'accel') {
      rec.state = 'progressing'; rec.probing = true; this.changed(true);
      try { const info = await probe(rec.url, { headersFor: this.headersFor(rec) }); this.beginAccel({ url: rec.url, referrer: rec.referrer, partition: rec.partition, ua: rec.ua, incognito: rec.incognito, info, dest: rec.path, filename: rec.filename, resume: rec }); }
      catch (e) { rec.state = 'interrupted'; rec.probing = false; rec.error = e.message; this.persist(); }
      return;
    }
    // browser download that cannot resume: start again through the same pipeline
    this.records.delete(rec.id);
    await this.startUrl({ url: rec.url, referrer: rec.referrer, partition: rec.partition, ua: rec.ua, filename: rec.filename, incognito: rec.incognito });
  }
}
function store(o) { return o.store; }
module.exports = { DownloadManager, sanitize, uniquePath };
