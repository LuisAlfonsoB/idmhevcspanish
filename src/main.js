'use strict';
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, session, protocol, shell, dialog, nativeTheme, net, clipboard, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { Store } = require('./store');
const { ENGINES } = require('./engines');
const { AdBlocker } = require('./adblock');
const { DEFAULT_SETTINGS } = require('./settings');
const { DownloadManager } = require('./downloads');
const { EXTRACT_SCRIPT } = require('./reader');
const { GRAB_SCRIPT } = require('./grabber');
const { listHlsVariants, probeHls } = require('./hls');
const { listDashVariants } = require('./dash');
const { TorrentManager } = require('./torrents');
const { RestreamManager } = require('./restream');
const { MseCapture } = require('./mse');
const { YT_HOST_RE, YT_CSS } = require('./youtube-adblock');
const { components } = require('electron'); // only present in the castLabs (Widevine-enabled) Electron build
const ffmpegMod = require('./ffmpeg');
const ytdlp = require('./ytdlp');
const { wantsPopupWindow, popupSize } = require('./popups');
const { getBuffer, sleep } = require('./net');
const i18n = require('./i18n');
const L = i18n.L;   // L('English text') -> text in the interface language (Settings → Language)

// Match the original app: pages never autoplay media on their own (muted or not) — playback only
// starts from an explicit tap/click. Must be set before the app is ready.
app.commandLine.appendSwitch('autoplay-policy', 'user-gesture-required');

// Native HEVC / H.265 playback (hev1/hvc1 in MP4, HLS fMP4, MSE). Chromium decodes HEVC through the OS/GPU
// decoder (D3D11 on Windows); the feature is off by default in Electron, so switch it on before app ready.
{
  const extra = ['PlatformHEVCDecoderSupport'];
  app.commandLine.appendSwitch('enable-features', extra.join(','));
  app.commandLine.appendSwitch('enable-accelerated-video-decode');
}

// ---------- portable data directory ----------
(function setupPortablePaths() {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (!dir) return;
  const data = path.join(dir, '1DM-Browser-Data');
  try { fs.mkdirSync(data, { recursive: true }); fs.accessSync(data, fs.constants.W_OK); app.setPath('userData', data); }
  catch (_) { /* read-only location: fall back to %APPDATA% */ }
})();

protocol.registerSchemesAsPrivileged([
  { scheme: 'onedm', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

const ROOT = path.join(__dirname, '..');
const PAGES = path.join(ROOT, 'pages');
const ASSETS = path.join(ROOT, 'assets');
const UI_DIR = path.join(ROOT, 'ui');
const MAIN_PART = 'persist:main';
const INCOG_PART = 'incognito';

let win = null, uiView = null;
let chromeH = 120, overlayOpen = false, htmlFullscreen = false;
let stores = {}, settings = null, adblock = null, downloads = null, torrents = null, restream = null, mseCap = null;
const tabs = new Map();      // id -> tab
let tabOrder = [];           // ids in display order
let activeId = null, nextId = 1;
const closedTabs = [];       // for reopen
const readerCache = new Map();
let UA = '';
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{V} Mobile Safari/537.36';

// ---------- helpers ----------
const isInternalUrl = u => /^onedm:\/\//i.test(u || '');
function engine() { return ENGINES[settings.searchEngine] || ENGINES.google; }

function resolveInput(text) {
  text = (text || '').trim();
  if (!text) return settings.homepage || 'onedm://home';
  if (/^about:home$/i.test(text)) return 'onedm://home';
  if (/^about:bookmarks$/i.test(text)) return 'onedm://bookmarks';
  if (/^about:blank$/i.test(text)) return 'about:blank';
  if (/^(https?|file|ftp|onedm|view-source|data|blob|javascript|magnet):/i.test(text)) return text;
  if (/^[a-z]:[\\/]/i.test(text)) return pathToFileURL(text).toString();
  if (/^\\\\[^\\]/.test(text)) return 'file:' + text.replace(/\\/g, '/');
  if (!/\s/.test(text)) {
    if (/^(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(:\d+)?([/?#].*)?$/i.test(text)) return 'http://' + text;
    if (/^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text)) return 'https://' + text;
  }
  return engine().url + encodeURIComponent(text);
}

function sendUI(channel, ...args) {
  if (uiView && !uiView.webContents.isDestroyed()) uiView.webContents.send(channel, ...args);
}
function sendInternalPages(channel, ...args) {
  for (const t of tabs.values()) {
    const wc = t.view.webContents;
    if (!wc.isDestroyed() && isInternalUrl(wc.getURL())) wc.send(channel, ...args);
  }
}
const isBookmarked = url => stores.bookmarks.get('items').some(b => b.url === url);

function tabState(t) {
  const wc = t.view.webContents;
  let url = t.url || '', canBack = false, canFwd = false;
  try {
    const nh = wc.navigationHistory;
    canBack = nh ? nh.canGoBack() : wc.canGoBack();
    canFwd = nh ? nh.canGoForward() : wc.canGoForward();
  } catch (_) {}
  return {
    id: t.id, title: t.title || (url ? url : L('New Tab')), url, favicon: t.favicon || '', loading: !!t.loading,
    canGoBack: canBack, canGoForward: canFwd, audible: !!t.audible, muted: wc.isAudioMuted(), pinned: !!t.pinned,
    incognito: !!t.incognito, zoom: t.zoom || 0, blocked: t.blocked || 0, bookmarked: isBookmarked(url),
    mobile: !!t.mobile, inverted: !!t.inverted, secure: /^https:/i.test(url), media: mediaCount(t)
  };
}
let stateTimer = null;
function pushState(now) {
  const fire = () => {
    stateTimer = null;
    const st = tabOrder.map(id => tabState(tabs.get(id)));
    sendUI('state', { tabs: st, activeId });
    const a = st.find(x => x.id === activeId);
    if (win && !win.isDestroyed()) win.setTitle((a && a.title ? a.title + ' - ' : '') + '1DM Browser' + (a && a.incognito ? ' ' + L('(Incognito)') : ''));
  };
  if (now) { clearTimeout(stateTimer); fire(); }
  else if (!stateTimer) stateTimer = setTimeout(fire, 60);
}

// ---------- layout ----------
function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  if (uiView) {
    uiView.setVisible(!htmlFullscreen);
    uiView.setBounds({ x: 0, y: 0, width: w, height: overlayOpen ? h : chromeH });
  }
  const top = htmlFullscreen ? 0 : chromeH;
  for (const t of tabs.values()) {
    const show = t.id === activeId;
    t.view.setVisible(show);
    if (show) t.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
  }
}
function raiseUI() { if (uiView && win) { win.contentView.removeChildView(uiView); win.contentView.addChildView(uiView); } }

// ---------- sessions ----------
function originOf(u) { try { return new URL(u).origin; } catch (_) { return ''; } }
function baseDomain(h) { return (h || '').split('.').slice(-2).join('.'); }
const permPrompts = new Map();
const AUTO_ALLOW = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock', 'speaker-selection', 'mediaKeySystem', 'window-management', 'storage-access', 'top-level-storage-access']);
const AUTO_DENY = new Set(['openExternal', 'idle-detection', 'fileSystem', 'unknown']);
const PERM_LABEL = { geolocation: 'know your location', notifications: 'show notifications', media: 'use your camera and microphone', midi: 'use MIDI devices', midiSysex: 'use MIDI devices', 'clipboard-read': 'see text and images copied to the clipboard', 'display-capture': 'capture your screen' };

function setupSession(ses, incognito) {
  ses.setUserAgent(settings.userAgent || UA);
  ses.protocol.handle('onedm', handleInternalProtocol);

  ses.webRequest.onBeforeRequest((d, cb) => {
    try {
      if (settings.httpsOnly && d.url.startsWith('http:') && !/^http:\/\/(localhost|127\.|192\.168\.|10\.|\[)/i.test(d.url) && (d.resourceType === 'mainFrame' || d.resourceType === 'subFrame'))
        return cb({ redirectURL: 'https:' + d.url.slice(5) });
      const wc = d.webContents;
      const pageUrl = (wc && !wc.isDestroyed() ? wc.getURL() : '') || d.referrer || '';
      if (adblock.enabled && adblock.shouldBlock(d.url, d.resourceType, pageUrl)) {
        for (const t of tabs.values()) if (wc && t.view.webContents.id === wc.id) { t.blocked = (t.blocked || 0) + 1; pushState(); break; }
        return cb({ cancel: true });
      }
    } catch (e) { /* never break loading */ }
    cb({});
  });
  const thirdParty = d => {
    try {
      const wc = d.webContents;
      const page = (wc && !wc.isDestroyed() ? wc.getURL() : '') || d.referrer || '';
      if (!page || !/^https?:/.test(page)) return false;
      return baseDomain(new URL(page).hostname) !== baseDomain(new URL(d.url).hostname);
    } catch (_) { return false; }
  };
  ses.webRequest.onBeforeSendHeaders((d, cb) => {
    const h = d.requestHeaders;
    if (settings.doNotTrack) { h['DNT'] = '1'; h['Sec-GPC'] = '1'; }
    if (settings.blockThirdPartyCookies && d.resourceType !== 'mainFrame' && thirdParty(d)) delete h['Cookie'];
    cb({ requestHeaders: h });
  });
  ses.webRequest.onHeadersReceived((d, cb) => {
    try { noteMedia(d); } catch (_) {}
    if (settings.blockThirdPartyCookies && d.resourceType !== 'mainFrame' && thirdParty(d)) {
      const h = d.responseHeaders;
      for (const k of Object.keys(h)) if (k.toLowerCase() === 'set-cookie') delete h[k];
      return cb({ responseHeaders: h });
    }
    cb({});
  });

  const perms = stores.permissions;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (AUTO_ALLOW.has(permission)) return callback(true);
    if (AUTO_DENY.has(permission)) return callback(false);
    const origin = originOf(details.requestingUrl || wc.getURL());
    if (!origin) return callback(false);
    const saved = !incognito && perms.get(origin) && perms.get(origin)[permission];
    if (saved) return callback(saved === 'allow');
    const key = origin + '|' + permission;
    if (!permPrompts.has(key)) {
      permPrompts.set(key, dialog.showMessageBox(win, {
        type: 'question', buttons: [L('Allow'), L('Block')], defaultId: 1, cancelId: 1, title: L('Permission request'),
        message: L(`${new URL(origin).host} wants to ${L(PERM_LABEL[permission] || permission)}`),
        checkboxLabel: incognito ? undefined : L('Remember my choice'), checkboxChecked: !incognito
      }).then(r => {
        const allow = r.response === 0;
        if (!incognito && r.checkboxChecked) { const cur = perms.get(origin) || {}; cur[permission] = allow ? 'allow' : 'deny'; perms.set(origin, cur); }
        return allow;
      }).finally(() => permPrompts.delete(key)));
    }
    permPrompts.get(key).then(callback);
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => {
    if (AUTO_ALLOW.has(permission)) return true;
    const p = perms.get(origin);
    return !!(p && p[permission] === 'allow');
  });
  ses.setDevicePermissionHandler(() => false);
  downloads.attach(ses, incognito, incognito ? INCOG_PART : MAIN_PART);
}
function applyProxy() {
  const cfg = settings.proxyMode === 'direct' ? { mode: 'direct' }
    : settings.proxyMode === 'custom' && settings.proxyRules ? { mode: 'fixed_servers', proxyRules: settings.proxyRules }
    : { mode: 'system' };
  for (const part of [MAIN_PART, INCOG_PART]) session.fromPartition(part).setProxy(cfg).catch(() => {});
}
async function refreshAdblock(force) {
  adblock.enabled = !!settings.adblock;
  adblock.whitelist = new Set((settings.adblockWhitelist || []).map(s => s.toLowerCase()));
  if (!adblock.enabled) return 0;
  return adblock.loadLists(settings.filterLists || [], force);
}

function handleInternalProtocol(request) {
  try {
    const u = new URL(request.url);
    let file;
    if (u.hostname === 'assets') file = path.join(ASSETS, decodeURIComponent(u.pathname));
    else if (u.hostname === 'shared') file = path.join(PAGES, 'shared', decodeURIComponent(u.pathname));
    else {
      const name = u.hostname.replace(/[^a-z0-9_-]/gi, '');
      file = path.join(PAGES, name + '.html');
    }
    const base = u.hostname === 'assets' ? ASSETS : PAGES;
    if (!path.resolve(file).startsWith(path.resolve(base))) return new Response('Forbidden', { status: 403 });
    if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  } catch (e) { return new Response('Bad request', { status: 400 }); }
}

// ---------- media sniffing (video / audio / HLS detected while browsing) ----------
const MEDIA_EXT = /\.(mp4|m4v|webm|mkv|mov|flv|avi|3gp|mp3|m4a|aac|ogg|oga|opus|wav|flac|m3u8)(\?|#|$)/i;
function tabByWc(id) { for (const t of tabs.values()) if (t.view.webContents.id === id) return t; return null; }
function noteMedia(d) {
  const wc = d.webContents;
  if (!wc || wc.isDestroyed() || d.statusCode >= 400 || d.resourceType === 'mainFrame') return;
  const t = tabByWc(wc.id); if (!t || !t.media || t.media.size >= 60) return;
  if (/\.(m4s|ts)(\?|#|$)/i.test(d.url)) return;
  const H = {};
  for (const k of Object.keys(d.responseHeaders || {})) H[k.toLowerCase()] = [].concat(d.responseHeaders[k])[0];
  const ct = (H['content-type'] || '').split(';')[0].trim().toLowerCase();
  let kind = null;
  if (/mpegurl/.test(ct) || /\.m3u8(\?|#|$)/i.test(d.url)) kind = 'hls';
  else if (/dash\+xml/.test(ct) || /\.mpd(\?|#|$)/i.test(d.url)) kind = 'dash';
  else if (ct.startsWith('video/') && ct !== 'video/mp2t') kind = 'video';
  else if (ct.startsWith('audio/')) kind = 'audio';
  else if (/octet-stream/.test(ct) && MEDIA_EXT.test(d.url)) kind = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i.test(d.url) ? 'audio' : 'video';
  if (!kind) return;
  let size = +H['content-length'] || 0;
  const cr = /\/(\d+)\s*$/.exec(H['content-range'] || ''); if (cr) size = +cr[1];
  if (kind !== 'hls' && kind !== 'dash' && size && size < 150 * 1024) return;
  const key = d.url.split('#')[0];
  if (t.media.has(key)) return;
  t.media.set(key, { url: d.url, kind, mime: ct, size, time: Date.now() });
  pushState();
}
// YouTube: the page's own streams (signed googlevideo chunks) cannot be saved directly, so the popup offers one card that
// goes through yt-dlp instead and the raw chunk URLs are hidden.
function tabUrlOf(t) { try { return t.view.webContents.getURL(); } catch (_) { return ''; } }
function ytEntry(t) {
  if (settings.ytDownloader === false || !ytdlp.available()) return null;
  const url = tabUrlOf(t); if (!ytdlp.isYoutubeVideoUrl(url)) return null;
  return { kind: 'youtube', url, name: (t.title || '').replace(/\s+-\s+YouTube$/i, '').trim() || 'YouTube video' };
}
const GV_URL = /^https?:\/\/[^/?#]*googlevideo\.com(?:[:/?#]|$)/i;
function visibleMedia(t) { const out = []; for (const m of t.media.values()) if (!GV_URL.test(m.url)) out.push(m); return out; }
function mediaCount(t) {
  let n = t.media ? visibleMedia(t).length : 0;
  if (ytEntry(t)) n++;
  if (t.scan && t.scan.pageUrl === tabUrlOf(t)) n += t.scan.results.length;
  if (t.mse && (t.mse.drm || t.mse.total > 256 * 1024)) n++;
  return n;
}
function mseEntry(t) {
  if (!t.mse) return null;
  if (t.mse.drm) return { kind: 'mse', drm: true, url: '', name: L('DRM-protected video'), size: 0 };
  if (t.mse.total <= 256 * 1024 && !t.capturing) return null;
  return { kind: 'mse', drm: false, url: '', name: L('Streaming video (blob)'), size: t.mse.total, capped: t.mse.capped, capturing: !!t.capturing, progress: t.capturing ? t.capturing.progress || 0 : 0 };
}
// Quality variants of an HLS/DASH stream (empty when the URL is a single quality or can't be read in time).
async function streamVariants(m, t) {
  const ctx = t ? tabNetContext(t) : { partition: MAIN_PART, ua: UA };
  const opts = { headersFor: downloads.headersFor(ctx) };
  let timer;
  const timeout = new Promise(res => { timer = setTimeout(() => res([]), 12000); });
  const list = (m.kind === 'hls' ? listHlsVariants(m.url, opts) : listDashVariants(m.url, opts)).catch(() => []);
  try { return await Promise.race([list, timeout]); } finally { clearTimeout(timer); }
}
// ---- richer info for the media popup: quality list, duration and a thumbnail. None of this needs the video to play:
// everything is read straight from the stream URL the network sniffer already saw.
function infoCache(t) { return t.infoCache || (t.infoCache = new Map()); }
async function ffHttpArgs(url, ctx) {
  try {
    const h = await downloads.headersFor(ctx)(url);
    return ['-headers', Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('')];
  } catch (_) { return []; }
}
// ---- YouTube through yt-dlp
let ytTmp = '';
app.on('will-quit', () => { if (ytTmp) try { fs.rmSync(ytTmp, { recursive: true, force: true }); } catch (_) {} });
async function ytCookieFile(t, pageUrl) {
  if (!settings.ytUseCookies) return '';
  try {
    const ses = session.fromPartition(tabNetContext(t).partition || MAIN_PART);
    ytTmp = ytTmp || fs.mkdtempSync(path.join(os.tmpdir(), '1dm-yt-'));
    return await ytdlp.writeCookieFile(ses, path.join(ytTmp, 'cookies-' + Date.now() + '.txt'), pageUrl);
  } catch (_) { return ''; }
}
function ytInfo(m, t) {
  const c = infoCache(t), key = 'yt|' + m.url;
  if (!c.has(key)) {
    const p = (async () => {
      const cookies = await ytCookieFile(t);
      try { return await ytdlp.lookup(m.url, { cookies }); } finally { if (cookies) try { fs.rmSync(cookies, { force: true }); } catch (_) {} }
    })();
    p.catch(() => c.delete(key));   // a failed lookup (offline, YouTube hiccup) is tried again next time the popup opens
    c.set(key, p);
  }
  return c.get(key);
}
const mb = n => n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : Math.max(1, Math.round(n / 1048576)) + ' MB';
async function ytMediaInfo(m, t) {
  const y = await ytInfo(m, t);
  const variants = y.choices.map(c => ({ id: c.id, kind: c.kind, height: c.height || 0, size: c.size, text: (c.kind === 'audio' ? c.label : 'MP4 · ' + c.label) + (c.size ? ' · ' + mb(c.size) : '') }));
  return { variants, duration: y.duration, live: y.live, thumbSrc: '', title: y.title };
}
async function ytThumb(m, t) {
  const y = await ytInfo(m, t); if (!y.thumbnail) return '';
  const buf = await getBuffer(y.thumbnail, { headersFor: downloads.headersFor(tabNetContext(t)), limit: 3 * 1024 * 1024, timeout: 10000 });
  return 'data:' + (buf.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/jpeg') + ';base64,' + buf.toString('base64');
}
// one download through yt-dlp. y = the summary of the video (see ytdlp.summarize), dlUrl = the URL yt-dlp should fetch
function runYtDownload(m, t, y, dlUrl, playlistItem) {
  const v = m.variant || {};
  const choice = y.choices.find(c => c.id === v.id) || y.choices[0];
  const dir = settings.downloadDir || app.getPath('downloads');
  const sfx = choice.kind === 'video' && choice.height ? ' ' + choice.height + 'p' : '';
  const ext = choice.kind === 'audio' ? choice.ext : 'mp4';
  const name = ytdlp.safeName(y.title) + sfx + '.' + ext;
  downloads.runLocal({ filename: name, path: path.join(dir, name), incognito: !!t.incognito, url: dlUrl, local: true }, async job => {
    const cookies = await ytCookieFile(t, m.kind === 'scan' ? tabUrlOf(t) : '');
    const dl = ytdlp.download(dlUrl, dir, { choice, title: y.title, expectedBytes: choice.size, cookies, referer: m.kind === 'scan' ? tabUrlOf(t) : '', playlistItem, onProgress: job.progress });
    job.onCancel(dl.kill);
    try { return await dl.promise; } finally { if (cookies) try { fs.rmSync(cookies, { force: true }); } catch (_) {} }
  });
  return { ok: true };
}
function ytDownload(m, t) {
  return ytInfo(m, t).then(y => runYtDownload(m, t, y, m.url)).catch(e => ({ ok: false, error: ytdlp.friendlyError(e.message) }));
}

// ---- "Scan page with yt-dlp": videos the network sniffer cannot see (the player never asked for the stream, e.g. autoplay was
// blocked, or the page builds the stream URL on the fly). Runs on demand from the media popup, and once automatically when a
// page has a video player but the sniffer found nothing. Results live on the tab and show up as cards in the popup.
let scanChain = Promise.resolve();   // one yt-dlp page scan at a time
function scanEntry(m, t) { const s = t.scan; return s && s.results[m.idx]; }
function scanPage(t) {
  const url = tabUrlOf(t);
  if (!/^https?:/i.test(url) || !ytdlp.available()) return Promise.resolve({ ok: false, error: L('yt-dlp is not available yet.') });
  if (t.scan && t.scan.state === 'running' && t.scan.pageUrl === url) return t.scan.promise;
  const s = t.scan = { state: 'running', pageUrl: url, results: [], error: '' };
  const send = () => { try { pushState(); } catch (_) {} };
  s.promise = scanChain = scanChain.catch(() => {}).then(async () => {
    const cookies = await ytCookieFile(t, url);
    try {
      const found = await ytdlp.scan(url, { cookies, referer: url });
      if (t.scan !== s) return { ok: false, error: L('page changed') };
      s.results = found.map((y, idx) => ({ kind: 'scan', idx, url, entryUrl: y.url && y.url !== url ? y.url : '', name: y.title, info: y, multi: found.length > 1 }));
      s.state = 'done'; send();
      return { ok: true, count: s.results.length };
    } catch (e) {
      if (t.scan === s) { s.state = 'done'; s.error = ytdlp.friendlyError(e.message); send(); }
      return { ok: false, error: ytdlp.friendlyError(e.message) };
    } finally { if (cookies) try { fs.rmSync(cookies, { force: true }); } catch (_) {} }
  });
  send();
  return s.promise;
}
// automatic fallback: the page shows a player, but nothing was sniffed after it settled
function maybeAutoScan(t) {
  if (settings.ytAutoScan === false || settings.ytDownloader === false || !ytdlp.available()) return;
  const url = tabUrlOf(t); if (!/^https?:/i.test(url) || t.scan || t.scanChecked === url) return;
  try { if (YT_HOST_RE.test(new URL(url).hostname)) return; } catch (_) { return; }
  t.scanChecked = url;   // did-stop-loading fires more than once per page: look once per URL
  setTimeout(async () => {
    try {
      if (tabUrlOf(t) !== url || t.scan || visibleMedia(t).length) return;
      const hasPlayer = await t.view.webContents.executeJavaScript(`!!document.querySelector('video, iframe[src*="embed"], iframe[src*="player"], [class*="video-js"], [class*="jwplayer"], [class*="plyr"]')`, true);
      if (hasPlayer && tabUrlOf(t) === url && !t.scan && !visibleMedia(t).length) scanPage(t);
    } catch (_) {}
  }, 4000);
}
// keep yt-dlp current (YouTube breaks old versions): at most once a day, in the background
async function refreshYtdlp(force) {
  if (!ytdlp.available() && process.platform !== 'win32') return;
  if (!force && Date.now() - (settings.ytdlpUpdated || 0) < 24 * 3600 * 1000) return;
  const r = await ytdlp.installLatest(path.join(app.getPath('userData'), 'yt-dlp'), async url => Buffer.from(await (await net.fetch(url, { headers: { 'User-Agent': '1DM-Browser' } })).arrayBuffer()));
  if (r.ok) updateSettings({ ytdlpUpdated: Date.now() }); else console.warn('yt-dlp', r.status);
}

async function scanMediaInfo(m, t) {
  const e = scanEntry(m, t); if (!e) throw new Error('Scan results expired - scan the page again.');
  const y = e.info;
  return { variants: y.choices.map(c => ({ id: c.id, kind: c.kind, height: c.height || 0, size: c.size, text: (c.kind === 'audio' ? c.label : 'MP4 \u00b7 ' + c.label) + (c.size ? ' \u00b7 ' + mb(c.size) : '') })), duration: y.duration, live: y.live, thumbSrc: '', title: y.title };
}
function mediaInfoFor(m, t) {
  if (m.kind === 'youtube') return ytMediaInfo(m, t);
  if (m.kind === 'scan') return scanMediaInfo(m, t);
  const c = infoCache(t), key = 'i|' + m.kind + '|' + m.url;
  if (!c.has(key)) c.set(key, (async () => {
    const ctx = tabNetContext(t), opts = { headersFor: downloads.headersFor(ctx) };
    const stream = m.kind === 'hls' || m.kind === 'dash';
    const variants = stream ? await streamVariants(m, t) : [];
    let duration = 0, live = false, thumbSrc = m.url;
    if (m.kind === 'hls') {
      try { const p = await probeHls(m.url, opts); duration = p.duration; live = p.live; thumbSrc = p.src; } catch (_) {}
    } else if (ffmpegMod.available() && m.kind !== 'audio') {
      try { duration = (await ffmpegMod.mediaInfo(m.url, { inputArgs: await ffHttpArgs(m.url, ctx), timeout: 12000 })).duration; } catch (_) {}
    }
    return { variants, duration, live, thumbSrc };
  })());
  return c.get(key);
}
// poster / og:image of the page, as a data: URL (the page may block hotlinking, and the UI has a strict CSP)
async function pagePoster(t, ctx) {
  try {
    const u = await t.view.webContents.executeJavaScript(`(function(){var v=document.querySelector('video[poster]');var m=document.querySelector('meta[property="og:image"],meta[name="twitter:image"]');var u=(v&&v.poster)||(m&&m.content)||'';try{return u?new URL(u,location.href).href:''}catch(e){return ''}})()`, true);
    if (!/^https?:/i.test(u || '')) return '';
    const buf = await getBuffer(u, { headersFor: downloads.headersFor(ctx), limit: 3 * 1024 * 1024, timeout: 10000 });
    const mime = buf[0] === 0x89 ? 'image/png' : buf.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/jpeg';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (_) { return ''; }
}
let thumbBusy = 0; const thumbWait = [];
async function withThumbSlot(fn) {
  if (thumbBusy >= 2) await new Promise(r => thumbWait.push(r));
  thumbBusy++;
  try { return await fn(); } finally { thumbBusy--; const next = thumbWait.shift(); if (next) next(); }
}
function mediaThumb(m, t) {
  const c = infoCache(t), key = 't|' + m.kind + '|' + m.url;
  if (!c.has(key)) c.set(key, (async () => {
    if (m.kind === 'audio') return '';
    if (m.kind === 'youtube') return ytThumb(m, t).catch(() => '');
    if (m.kind === 'scan') {
      const e = scanEntry(m, t), u = e && e.info.thumbnail;
      if (u && /^https?:/i.test(u)) {
        try {
          const buf = await getBuffer(u, { headersFor: downloads.headersFor(tabNetContext(t)), limit: 3 * 1024 * 1024, timeout: 10000 });
          return 'data:' + (buf.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : buf[0] === 0x89 ? 'image/png' : 'image/jpeg') + ';base64,' + buf.toString('base64');
        } catch (_) {}
      }
      return pagePoster(t, tabNetContext(t));
    }
    const ctx = tabNetContext(t);
    if (ffmpegMod.available()) {
      const info = await mediaInfoFor(m, t).catch(() => ({}));
      const src = info.thumbSrc || m.url;
      const at = info.duration > 20 ? Math.min(info.duration * 0.1, 90) : 0;   // skip black intro frames
      const buf = await withThumbSlot(async () => ffmpegMod.thumbnail(src, { inputArgs: await ffHttpArgs(src, ctx), at, hls: m.kind === 'hls' }));
      if (buf) return 'data:image/jpeg;base64,' + buf.toString('base64');
    }
    return pagePoster(t, ctx);
  })());
  return c.get(key);
}
function mediaList(t) {
  const list = visibleMedia(t).map(m => ({ ...m, name: baseName(m.url) }));
  const e = mseEntry(t); if (e) list.unshift(e);
  const y = ytEntry(t); if (y) list.unshift(y);
  const sc = t.scan && t.scan.pageUrl === tabUrlOf(t) ? t.scan : null;
  if (sc) for (const r of sc.results) list.push({ kind: 'scan', idx: r.idx, url: r.url, name: r.name });
  if (!y && settings.ytDownloader !== false && ytdlp.available() && /^https?:/i.test(tabUrlOf(t))) list.push({ kind: 'scanrow', state: sc ? sc.state : 'idle', error: sc ? sc.error : '', found: sc ? sc.results.length : 0 });
  return list;
}
// ---- blob: / MediaSource videos
const CAP_START = `(async () => {
  var vs = [].slice.call(document.querySelectorAll('video')).filter(function (v) { return v.currentSrc && /^blob:/.test(v.currentSrc); });
  var v = vs.sort(function (a, b) { return (b.duration || 0) - (a.duration || 0); })[0];
  if (!v) return { error: L('No streaming video found on this page.') };
  if (!isFinite(v.duration) || !v.duration) return { error: L('This looks like a live stream, which cannot be captured this way.') };
  window.__1dmAllowPlay = true;
  window.__1dmCap = { v: v, rate: v.playbackRate, muted: v.muted, t: v.currentTime, paused: v.paused };
  v.muted = true; v.currentTime = 0; v.playbackRate = 16;
  try { await v.play(); } catch (e) {}
  return { duration: v.duration };
})()`;
const CAP_POLL = `(function () { var c = window.__1dmCap; if (!c) return null; var v = c.v; return { t: v.currentTime, d: v.duration, ended: v.ended }; })()`;
const CAP_END = `(function () { var c = window.__1dmCap; if (!c) return; var v = c.v; try { v.playbackRate = c.rate; v.muted = c.muted; v.currentTime = c.t; if (c.paused) v.pause(); } catch (e) {} window.__1dmCap = null; window.__1dmAllowPlay = false; })()`;
function stopCapture(t) { if (t.capturing) t.capturing.cancel = true; }
async function autoCapture(t) {
  if (t.capturing) return { ok: false, error: L('Already capturing this video.') };
  const wc = t.view.webContents;
  const st = await wc.executeJavaScript(CAP_START, true).catch(() => null);
  if (!st || st.error) return { ok: false, error: (st && st.error) || 'Could not start capturing.' };
  const job = t.capturing = { cancel: false, progress: 0 };
  (async () => {
    const t0 = Date.now();
    while (!job.cancel && Date.now() - t0 < 6 * 3600 * 1000) {
      await sleep(1000);
      if (t.view.webContents.isDestroyed()) return;
      const s = await wc.executeJavaScript(CAP_POLL).catch(() => null);
      if (!s) break;
      job.progress = s.d ? Math.min(1, s.t / s.d) : 0; pushState();
      if (s.ended || (s.d && s.t >= s.d - 0.5)) break;
    }
    try { await wc.executeJavaScript(CAP_END); } catch (_) {}
    const done = !job.cancel; t.capturing = null; pushState(true);
    if (done) { try { new Notification({ title: L('Video captured'), body: L((t.title || 'Streaming video') + ' — open the media menu to save it.') }).show(); } catch (_) {} }
  })();
  return { ok: true };
}
async function saveMse(t) {
  const sum = t.mse && mseCap.plan(t);
  if (!t.mse || t.mse.drm) return { ok: false, error: L('This video is DRM-protected and cannot be saved.') };
  if (!sum) return { ok: false, error: L('Nothing has been captured yet. Play the video (or use “Capture whole video”) first.') };
  const base = (t.title || 'video').replace(/\s+[-|–—]\s+[^-|–—]*$/, '').trim() || 'video';
  const name = sanitizeName(base) + sum.ext;
  let dest;
  if (settings.askDownloadLocation) { const r = await dialog.showSaveDialog(win, { defaultPath: path.join(settings.downloadDir || app.getPath('downloads'), name) }); if (r.canceled) return { ok: true }; dest = r.filePath; }
  else dest = uniquePathIn(settings.downloadDir || app.getPath('downloads'), name);
  downloads.runLocal({ filename: path.basename(dest), path: dest, incognito: !!t.incognito, url: t.url }, () => mseCap.build(t, dest, ffmpegMod));
  return { ok: true };
}
function sanitizeName(n) { return (n || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 150) || 'video'; }
function uniquePathIn(dir, name) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} return require('./downloads').uniquePath(dir, name); }

function tabNetContext(t) {
  return { referrer: t.url && /^https?:/.test(t.url) ? t.url : '', partition: t.incognito ? INCOG_PART : MAIN_PART, ua: settings.userAgent || UA, incognito: !!t.incognito };
}
function baseName(u) { try { return decodeURIComponent(path.basename(new URL(u).pathname)); } catch (_) { return ''; } }

// ---------- torrents / magnet links ----------
async function confirmTorrent(label) {
  // 0 = download everything, 1 = pick files first, 2 = cancel
  const r = await dialog.showMessageBox(win, { type: 'question', buttons: [L('Download all'), L('Choose files…'), L('Cancel')], defaultId: 1, cancelId: 2, title: L('Torrent'), message: L('Download this torrent?'), detail: String(label).slice(0, 300) });
  return r.response;
}
function openSingleTab(url) {
  const base = url.split('?')[0];
  for (const t of tabs.values()) if (t.url === url || t.url.split('?')[0] === base) { if (t.url !== url) loadInTab(t, url); activateTab(t.id); return; }
  createTab(url, { openerId: activeId });
}
const torrentLabel = input => {
  if (typeof input === 'string' && /^magnet:/i.test(input)) { const m = /[?&]dn=([^&]+)/i.exec(input); if (m) { try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (_) {} } }
  return Buffer.isBuffer(input) ? 'torrent file' : String(input);
};
/** Open the Torrents page with the file picker for this magnet / .torrent (Buffer). */
function pickTorrentFiles(input) {
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  pendingPicks.set(token, input);
  if (pendingPicks.size > 10) pendingPicks.delete(pendingPicks.keys().next().value);
  openSingleTab('onedm://torrents?pick=' + token);
}
const pendingPicks = new Map();
/** confirm: ask first (Download all / Choose files / Cancel). picker: skip the question and go straight to the file picker. */
async function addTorrentSource(input, { confirm = true, picker = false } = {}) {
  if (confirm) {
    const c = await confirmTorrent(torrentLabel(input));
    if (c === 2) return { cancelled: true };
    if (c === 1) { pickTorrentFiles(input); return { picking: true }; }
  } else if (picker) { pickTorrentFiles(input); return { picking: true }; }
  const p = torrents.add(input);
  p.catch(e => dialog.showErrorBox('Torrent error', e.message));
  const r = await Promise.race([p, sleep(600).then(() => ({ pending: true }))]).catch(e => ({ error: e.message }));
  openSingleTab('onedm://torrents');
  return r;
}
async function addTorrentFromUrl(url, ctx) {
  const c = await confirmTorrent(baseName(url) || url);
  if (c === 2) return;
  const rec = { referrer: ctx.referrer || '', partition: ctx.partition || MAIN_PART, ua: ctx.ua || UA };
  try {
    const buf = await getBuffer(url, { headersFor: downloads.headersFor(rec), limit: 20 * 1024 * 1024 });
    return await addTorrentSource(buf, { confirm: false, picker: c === 1 });
  } catch (e) { dialog.showErrorBox('Could not fetch torrent file', e.message); }
}
// generic "add a download" entry point (Downloads page, address bar)
async function addDownloadInput(text, ctx = {}) {
  text = (text || '').trim();
  let result;
  if (/^magnet:/i.test(text)) result = await addTorrentSource(text, { confirm: false, picker: true });
  else if (/^[0-9a-f]{40}$/i.test(text)) result = await addTorrentSource(text, { confirm: false, picker: true });
  else if (!/^https?:/i.test(text)) throw new Error('Enter an http(s) link, a magnet link or a torrent info-hash');
  else if (/\.torrent(\?|#|$)/i.test(text)) {
    const rec = { referrer: ctx.referrer || '', partition: MAIN_PART, ua: UA };
    result = await addTorrentSource(await getBuffer(text, { headersFor: downloads.headersFor(rec), limit: 20 * 1024 * 1024 }), { confirm: false, picker: true });
  } else {
    return downloads.startUrl({ url: text, partition: ctx.partition || MAIN_PART, ua: UA, referrer: ctx.referrer || '', incognito: !!ctx.incognito });
  }
  // addTorrentSource never throws on failure (it resolves to a plain result object), so check it
  // explicitly here — otherwise a failed add silently reports success to the caller.
  if (result && result.error) throw new Error(result.error);
  return result;
}

// ---------- tabs ----------
function createTab(url, { incognito = false, activate = true, openerId = null, pinned = false, index } = {}) {
  const id = nextId++;
  const view = new WebContentsView({
    webPreferences: {
      partition: incognito ? INCOG_PART : MAIN_PART,
      preload: path.join(__dirname, 'preload-page.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, plugins: true, spellcheck: true
    }
  });
  const t = { id, view, title: '', url: '', favicon: '', loading: false, incognito, pinned, openerId, zoom: 0, blocked: 0, audible: false, media: new Map() };
  tabs.set(id, t);
  if (index !== undefined && index >= 0) tabOrder.splice(index, 0, id);
  else if (openerId && tabs.has(openerId) && !pinned) { const i = tabOrder.indexOf(openerId); tabOrder.splice(i + 1, 0, id); }
  else tabOrder.push(id);
  view.setBackgroundColor('#ffffff');
  win.contentView.addChildView(view);
  raiseUI();
  hookWebContents(t);
  if (activate) activateTab(id); else layout();
  const target = resolveInput(url || settings.homepage || 'onedm://home');
  loadInTab(t, target);
  pushState(true);
  return t;
}

function loadInTab(t, input) {
  const wc = t.view.webContents;
  if (/^magnet:/i.test(input)) { addTorrentSource(input); return; }
  if (/^javascript:/i.test(input)) { wc.executeJavaScript(decodeURIComponent(input.slice(11))).catch(() => {}); return; }
  wc.loadURL(input).catch(() => {});
}

function activateTab(id) {
  if (!tabs.has(id)) return;
  activeId = id;
  layout();
  const wc = tabs.get(id).view.webContents;
  if (!wc.isDestroyed()) wc.focus();
  pushState(true);
}

function closeTab(id, { keepWindow = false } = {}) {
  const t = tabs.get(id);
  if (!t) return;
  const wc = t.view.webContents;
  if (!t.incognito && t.url && !isInternalUrl(t.url) && t.url !== 'about:blank') closedTabs.push({ url: t.url, pinned: t.pinned });
  if (closedTabs.length > 25) closedTabs.shift();
  stopCapture(t); if (mseCap) mseCap.clear(t);
  const idx = tabOrder.indexOf(id);
  tabOrder.splice(idx, 1);
  tabs.delete(id);
  try { win.contentView.removeChildView(t.view); } catch (_) {}
  try { if (!wc.isDestroyed()) wc.close(); } catch (_) {}
  if (!tabs.has(t.openerId)) t.openerId = null;
  if (activeId === id) {
    const next = (t.openerId && tabs.has(t.openerId)) ? t.openerId : tabOrder[Math.min(idx, tabOrder.length - 1)];
    if (next) activateTab(next);
    else if (!keepWindow) createTab(settings.homepage);
  }
  // wipe the in-memory private session once its last tab is gone
  if (t.incognito && ![...tabs.values()].some(x => x.incognito)) {
    const s = session.fromPartition(INCOG_PART);
    s.clearStorageData().catch(() => {}); s.clearCache().catch(() => {}); s.clearAuthCache().catch(() => {});
  }
  pushState(true);
}

function currentTab() { return tabs.get(activeId); }
function currentWC() { const t = currentTab(); return t && !t.view.webContents.isDestroyed() ? t.view.webContents : null; }

function hookWebContents(t) {
  const wc = t.view.webContents;
  const upd = () => pushState();
  // window.open(): sign-in popups ("Continue with Google", Apple, Microsoft...) must stay real child windows so they can hand the
  // result back to the page that opened them (window.opener); a tab has no such link and the login hangs. Everything else -> tab.
  const openHandler = ({ url, disposition, features }) => {
    if (wantsPopupWindow({ url, disposition })) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...popupSize(features), parent: win, autoHideMenuBar: true, minimizable: false, title: '',
          webPreferences: { partition: t.incognito ? INCOG_PART : MAIN_PART, preload: path.join(__dirname, 'preload-page.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: true }
        }
      };
    }
    if (/^(https?|about|file):/i.test(url)) createTab(url, { incognito: t.incognito, openerId: t.id, activate: disposition !== 'background-tab' });
    else if (/^magnet:/i.test(url)) addTorrentSource(url);
    else openExternalSafe(url);
    return { action: 'deny' };
  };
  const hookPopup = child => {   // a popup that opens further windows (some sign-in flows chain two) follows the same rules
    try { child.setMenuBarVisibility(false); } catch (_) {}
    child.webContents.setWindowOpenHandler(openHandler);
    child.webContents.on('did-create-window', hookPopup);
  };
  wc.setWindowOpenHandler(openHandler);
  wc.on('did-create-window', hookPopup);
  wc.on('page-title-updated', (e, title) => { t.title = title; upd(); });
  wc.on('page-favicon-updated', (e, icons) => { t.favicon = icons && icons[0] || ''; upd(); });
  wc.on('did-start-loading', () => { t.loading = true; upd(); });
  wc.on('did-stop-loading', () => { t.loading = false; t.url = wc.getURL(); if (!t.title) t.title = wc.getTitle(); upd(); maybeAutoScan(t); });
  wc.on('did-start-navigation', (e, url, inPlace, isMain) => { if (isMain && !inPlace) { t.blocked = 0; t.favicon = ''; t.media.clear(); t.scan = null; t.scanChecked = ''; if (t.infoCache) t.infoCache.clear(); stopCapture(t); if (mseCap) mseCap.clear(t); } });
  const onNav = (e, url, a, b, c) => {
    t.url = url;
    if (wc.getURL()) t.url = wc.getURL();
    if (!t.incognito && /^https?:/i.test(t.url)) addHistory(t.url, wc.getTitle());
    upd();
  };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', (e, url, isMain) => { if (isMain) { t.url = url; upd(); } });
  wc.on('page-title-updated', (e, title) => { if (!t.incognito && /^https?:/i.test(t.url || '')) updateHistoryTitle(t.url, title); });
  wc.on('audio-state-changed', () => { t.audible = wc.isCurrentlyAudible(); upd(); });
  wc.on('media-started-playing', () => { t.audible = wc.isCurrentlyAudible(); upd(); });
  wc.on('media-paused', () => { t.audible = wc.isCurrentlyAudible(); upd(); });
  wc.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain || code === -3 || code === 0) return;
    const q = new URLSearchParams({ code: String(code), desc, url });
    wc.loadURL('onedm://error?' + q.toString()).catch(() => {});
  });
  wc.on('render-process-gone', (e, d) => {
    const q = new URLSearchParams({ code: 'CRASH', desc: 'The page crashed (' + d.reason + ')', url: t.url || '' });
    wc.loadURL('onedm://error?' + q.toString()).catch(() => {});
  });
  wc.on('will-navigate', (e, url) => {
    if (/^magnet:/i.test(url)) { e.preventDefault(); addTorrentSource(url); return; }
    if (!/^(https?|file|about|onedm|view-source|data|blob|javascript|devtools):/i.test(url)) { e.preventDefault(); openExternalSafe(url); }
  });
  wc.on('found-in-page', (e, r) => sendUI('find-result', { active: r.activeMatchOrdinal, total: r.matches, final: r.finalUpdate }));
  wc.on('enter-html-full-screen', () => { htmlFullscreen = true; win.setFullScreen(true); layout(); });
  wc.on('leave-html-full-screen', () => { htmlFullscreen = false; win.setFullScreen(false); layout(); });
  wc.on('before-input-event', (e, input) => { if (handleShortcut(input)) e.preventDefault(); });
  wc.on('focus', () => { if (overlayOpen) sendUI('overlay-close'); });
  wc.on('context-menu', (e, params) => showContextMenu(t, params));
  wc.on('zoom-changed', (e, dir) => { adjustZoom(dir === 'in' ? 0.5 : -0.5, t); });
  wc.on('did-finish-load', () => {
    if (t.mobile) wc.setUserAgent(MOBILE_UA.replace('{V}', process.versions.chrome));
    if (settings.adblock && settings.ytAdblock) { let h = ''; try { h = new URL(wc.getURL()).hostname; } catch (_) {} if (YT_HOST_RE.test(h)) wc.insertCSS(YT_CSS).catch(() => {}); }
  });
}

function openExternalSafe(url) {
  if (/^(mailto|tel|sms):/i.test(url)) {
    dialog.showMessageBox(win, { type: 'question', buttons: [L('Open'), L('Cancel')], defaultId: 1, cancelId: 1, message: L('Open this link in another app?'), detail: url.slice(0, 200) })
      .then(r => { if (r.response === 0) shell.openExternal(url).catch(() => {}); });
  }
}

// ---------- history ----------
function addHistory(url, title) {
  const list = stores.history.get('items');
  const last = list[0];
  if (last && last.url === url) { last.time = Date.now(); if (title) last.title = title; }
  else list.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), url, title: title || url, time: Date.now() });
  if (list.length > 5000) list.length = 5000;
  stores.history.save();
}
function updateHistoryTitle(url, title) {
  const e = stores.history.get('items').find(x => x.url === url);
  if (e && title) { e.title = title; stores.history.save(); }
}

// ---------- shortcuts ----------
function handleShortcut(input) {
  if (input.type !== 'keyDown') return false;
  const ctrl = input.control || input.meta, shift = input.shift, alt = input.alt, k = input.key;
  const kl = k.length === 1 ? k.toLowerCase() : k;
  if (ctrl && !alt) {
    if (kl === 't' && !shift) { createTab(null); return true; }
    if (kl === 't' && shift) { reopenClosed(); return true; }
    if (kl === 'n' && shift) { createTab(null, { incognito: true }); return true; }
    if (kl === 'w' || (kl === 'F4')) { if (activeId) closeTab(activeId); return true; }
    if (kl === 'l') { sendUI('focus-omnibox'); uiView.webContents.focus(); return true; }
    if (kl === 'f') { sendUI('open-find'); uiView.webContents.focus(); return true; }
    if (kl === 'r' && !shift) { currentWC() && currentWC().reload(); return true; }
    if (kl === 'r' && shift) { currentWC() && currentWC().reloadIgnoringCache(); return true; }
    if (kl === 'd') { toggleBookmark(activeId); return true; }
    if (kl === 'h') { createTab('onedm://history', { openerId: activeId }); return true; }
    if (kl === 'j') { createTab('onedm://downloads', { openerId: activeId }); return true; }
    if (kl === 'b' && shift) { createTab('onedm://bookmarks', { openerId: activeId }); return true; }
    if (kl === 'p') { currentWC() && currentWC().print(); return true; }
    if (kl === 's') { const wc = currentWC(); wc && savePage(wc); return true; }
    if (kl === 'u') { const wc = currentWC(); if (wc) createTab('view-source:' + wc.getURL(), { openerId: activeId }); return true; }
    if (kl === 'Tab') { cycleTab(shift ? -1 : 1); return true; }
    if (kl === 'PageDown') { cycleTab(1); return true; }
    if (kl === 'PageUp') { cycleTab(-1); return true; }
    if (/^[1-9]$/.test(kl)) { const i = kl === '9' ? tabOrder.length - 1 : parseInt(kl, 10) - 1; if (tabOrder[i]) activateTab(tabOrder[i]); return true; }
    if (kl === '=' || kl === '+') { adjustZoom(0.5); return true; }
    if (kl === '-' || kl === '_') { adjustZoom(-0.5); return true; }
    if (kl === '0') { adjustZoom('reset'); return true; }
  }
  if (alt && !ctrl) {
    if (kl === 'ArrowLeft') { const wc = currentWC(); wc && wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack(); return true; }
    if (kl === 'ArrowRight') { const wc = currentWC(); wc && wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward(); return true; }
    if (kl === 'Home') { navigateActive(settings.homepage); return true; }
  }
  if (!ctrl && !alt) {
    if (kl === 'F5') { currentWC() && currentWC().reload(); return true; }
    if (kl === 'F12') { toggleDevTools(); return true; }
    if (kl === 'F11') { win.setFullScreen(!win.isFullScreen()); return true; }
    if (kl === 'F6') { sendUI('focus-omnibox'); uiView.webContents.focus(); return true; }
    if (kl === 'Escape') { if (overlayOpen) sendUI('overlay-close'); return false; }
  }
  return false;
}
function cycleTab(dir) {
  const i = tabOrder.indexOf(activeId);
  activateTab(tabOrder[(i + dir + tabOrder.length) % tabOrder.length]);
}
function reopenClosed() { const c = closedTabs.pop(); if (c) createTab(c.url, { pinned: c.pinned }); }
function toggleDevTools() { const wc = currentWC(); if (wc) wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'right' }); }
function navigateActive(text) { const t = currentTab(); if (t) loadInTab(t, resolveInput(text)); }

function adjustZoom(delta, tab) {
  const t = tab || currentTab(); if (!t) return;
  const wc = t.view.webContents;
  t.zoom = delta === 'reset' ? 0 : Math.max(-3, Math.min(5, (t.zoom || 0) + delta));
  wc.setZoomLevel(t.zoom);
  pushState(true);
}

// ---------- bookmarks ----------
function toggleBookmark(id) {
  const t = tabs.get(id); if (!t || !t.url || /^onedm:\/\/(error|reader)/.test(t.url)) return;
  const items = stores.bookmarks.get('items');
  const i = items.findIndex(b => b.url === t.url);
  if (i >= 0) items.splice(i, 1);
  else items.push({ id: Date.now().toString(36), title: t.title || t.url, url: t.url, folder: '', added: Date.now() });
  stores.bookmarks.save();
  bookmarksChanged();
}
function bookmarksChanged() {
  pushState(true);
  sendUI('bookmarks', stores.bookmarks.get());
  sendInternalPages('bookmarks-changed');
}
function exportBookmarksHtml() {
  const { items, folders } = stores.bookmarks.get();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const a = b => `<DT><A HREF="${esc(b.url)}" ADD_DATE="${Math.floor((b.added || 0) / 1000)}">${esc(b.title)}</A>\n`;
  let out = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n';
  for (const b of items.filter(x => !x.folder)) out += a(b);
  for (const f of folders) { out += `<DT><H3>${esc(f.title)}</H3>\n<DL><p>\n`; for (const b of items.filter(x => x.folder === f.id)) out += a(b); out += '</DL><p>\n'; }
  return out + '</DL><p>\n';
}
function importBookmarksHtml(html) {
  const { items, folders } = stores.bookmarks.get();
  const unesc = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const re = /<(\/?)(DL|H3|A)\b([^>]*)>([^<]*)/gi;
  const stack = []; let pending = null, added = 0, m;
  while ((m = re.exec(html))) {
    const close = m[1] === '/', tag = m[2].toUpperCase();
    if (tag === 'H3' && !close) pending = unesc(m[4].trim());
    else if (tag === 'DL') { if (close) stack.pop(); else stack.push(pending); pending = null; }
    else if (tag === 'A' && !close) {
      const href = /HREF="([^"]*)"/i.exec(m[3]);
      if (!href || !/^https?:/i.test(unesc(href[1]))) continue;
      const url = unesc(href[1]);
      if (items.some(b => b.url === url)) continue;
      let folderName = null;
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) { folderName = stack[i]; break; }
      let folder = '';
      if (folderName) {
        let f = folders.find(x => x.title === folderName);
        if (!f) { f = { id: 'f' + Date.now().toString(36) + folders.length, title: folderName }; folders.push(f); }
        folder = f.id;
      }
      items.push({ id: Date.now().toString(36) + added, title: unesc(m[4].trim()) || url, url, folder, added: Date.now() });
      added++;
    }
  }
  stores.bookmarks.save(); bookmarksChanged();
  return added;
}

// ---------- context menu ----------
function showContextMenu(t, p) {
  const wc = t.view.webContents;
  const T = [];
  const openTab = (u, inc) => () => createTab(u, { incognito: inc === undefined ? t.incognito : inc, openerId: t.id, activate: false });
  if (p.linkURL) {
    T.push({ label: L('Open link in new tab'), click: openTab(p.linkURL) });
    if (!t.incognito) T.push({ label: L('Open link in incognito tab'), click: () => createTab(p.linkURL, { incognito: true, openerId: t.id, activate: false }) });
    T.push({ label: L('Copy link address'), click: () => clipboard.writeText(p.linkURL) });
    T.push({ label: L('Save link as…'), click: () => { downloads.askNext(p.linkURL); wc.downloadURL(p.linkURL); } });
    T.push({ type: 'separator' });
  }
  if (p.mediaType === 'image' && p.srcURL) {
    T.push({ label: L('Open image in new tab'), click: openTab(p.srcURL) });
    T.push({ label: L('Save image as…'), click: () => { downloads.askNext(p.srcURL); wc.downloadURL(p.srcURL); } });
    T.push({ label: L('Copy image'), click: () => wc.copyImageAt(p.x, p.y) });
    T.push({ label: L('Copy image address'), click: () => clipboard.writeText(p.srcURL) });
    T.push({ type: 'separator' });
  }
  if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL && /^https?:/.test(p.srcURL)) {
    T.push({ label: L('Save media as…'), click: () => { downloads.askNext(p.srcURL); wc.downloadURL(p.srcURL); } });
    T.push({ label: L('Copy media address'), click: () => clipboard.writeText(p.srcURL) });
    T.push({ type: 'separator' });
  }
  if (p.isEditable) {
    T.push({ role: 'undo', enabled: p.editFlags.canUndo }, { role: 'redo', enabled: p.editFlags.canRedo }, { type: 'separator' });
    T.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { role: 'selectAll' });
    if (p.misspelledWord && p.dictionarySuggestions.length) {
      T.unshift(...p.dictionarySuggestions.slice(0, 5).map(s => ({ label: s, click: () => wc.replaceMisspelling(s) })), { type: 'separator' });
    }
  } else if (p.selectionText) {
    const sel = p.selectionText.trim();
    T.push({ role: 'copy' });
    T.push({ label: L(`Search ${engine().name} for “${sel.length > 30 ? sel.slice(0, 30) + '…' : sel}”`), click: () => createTab(engine().url + encodeURIComponent(sel), { incognito: t.incognito, openerId: t.id }) });
    if (/^https?:\/\/\S+$/i.test(sel)) T.push({ label: L('Open selected URL in new tab'), click: openTab(sel) });
  } else if (!p.linkURL && p.mediaType === 'none') {
    const nh = wc.navigationHistory;
    T.push({ label: L('Back'), enabled: nh.canGoBack(), click: () => nh.goBack() });
    T.push({ label: L('Forward'), enabled: nh.canGoForward(), click: () => nh.goForward() });
    T.push({ label: L('Reload'), click: () => wc.reload() });
    T.push({ type: 'separator' });
    T.push({ label: L('Save page as…'), click: () => savePage(wc) });
    T.push({ label: L('Print…'), click: () => wc.print() });
    T.push({ label: L('View page source'), click: () => createTab('view-source:' + wc.getURL(), { openerId: t.id }) });
  }
  T.push({ type: 'separator' }, { label: L('Inspect'), click: () => wc.inspectElement(p.x, p.y) });
  while (T.length && T[0].type === 'separator') T.shift();
  Menu.buildFromTemplate(T).popup({ window: win });
}
async function savePage(wc) {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), (wc.getTitle() || 'page').replace(/[\\/:*?"<>|]/g, '_') + '.html'), filters: [{ name: L('Web page, complete'), extensions: ['html'] }, { name: L('MHTML'), extensions: ['mhtml'] }] });
  if (!r.canceled && r.filePath) wc.savePage(r.filePath, r.filePath.endsWith('.mhtml') ? 'MHTML' : 'HTMLComplete').catch(() => {});
}

// ---------- suggestions ----------
async function suggest(text) {
  text = (text || '').trim().toLowerCase();
  if (!text) return [];
  const out = [], seen = new Set();
  const push = (type, title, url) => { if (!seen.has(url) && out.length < 8) { seen.add(url); out.push({ type, title, url }); } };
  for (const b of stores.bookmarks.get('items')) if ((b.title + ' ' + b.url).toLowerCase().includes(text)) push('bookmark', b.title, b.url);
  for (const h of stores.history.get('items')) { if (out.length >= 6) break; if ((h.title + ' ' + h.url).toLowerCase().includes(text)) push('history', h.title, h.url); }
  const e = engine();
  if (settings.searchSuggestions && e.suggest && !/^(https?:|onedm:|file:)/.test(text)) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 900);
      const res = await net.fetch(e.suggest + encodeURIComponent(text), { signal: ctl.signal, headers: { 'User-Agent': UA } });
      clearTimeout(to);
      const j = JSON.parse(await res.text());
      const list = Array.isArray(j) ? j[1] : [];
      let n = 0;
      for (const s of list) { const str = typeof s === 'string' ? s : (s && s.phrase); if (str && n++ < 5) push('search', str, engine().url + encodeURIComponent(str)); }
    } catch (_) { /* offline or slow: local results only */ }
  }
  return out.slice(0, 10);
}

// ---------- window ----------
function createWindow() {
  const st = stores.window.get();
  win = new BrowserWindow({
    width: st.width || 1280, height: st.height || 820, x: st.x, y: st.y, minWidth: 480, minHeight: 360,
    title: '1DM Browser', icon: path.join(ROOT, 'build', 'icon.png'), backgroundColor: '#1e1f22', autoHideMenuBar: true
  });
  Menu.setApplicationMenu(null);
  win.removeMenu();
  if (st.maximized) win.maximize();
  uiView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-ui.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  uiView.setBackgroundColor('#00000000');
  win.contentView.addChildView(uiView);
  uiView.webContents.loadFile(path.join(UI_DIR, 'index.html'));
  uiView.webContents.setVisualZoomLevelLimits(1, 1);
  uiView.webContents.on('before-input-event', (e, input) => { if (handleShortcut(input)) e.preventDefault(); });
  win.on('resize', layout); win.on('maximize', layout); win.on('unmaximize', layout);
  win.on('enter-full-screen', layout); win.on('leave-full-screen', () => { htmlFullscreen = false; layout(); });
  win.on('blur', () => { if (overlayOpen) sendUI('overlay-close'); });
  win.on('close', () => {
    const b = win.getNormalBounds();
    stores.window.set({ ...b, maximized: win.isMaximized() });
    saveSession();
  });
  win.on('closed', () => { win = null; });
}

function saveSession() {
  const list = tabOrder.map(id => tabs.get(id)).filter(t => t && !t.incognito && t.url && !/^onedm:\/\/(error|reader)/.test(t.url));
  stores.session.set({ tabs: list.map(t => ({ url: t.url, pinned: !!t.pinned })), active: Math.max(0, list.findIndex(t => t.id === activeId)) });
}
function restoreSession(argvUrls) {
  const s = stores.session.get();
  let opened = 0;
  if (settings.restoreTabs && s.tabs && s.tabs.length) {
    const ids = s.tabs.map(x => createTab(x.url, { activate: false, pinned: x.pinned }).id);
    activateTab(ids[Math.min(s.active || 0, ids.length - 1)]); opened = ids.length;
  }
  for (const u of argvUrls) { createTab(u); opened++; }
  if (!opened) createTab(settings.homepage);
}
function argvToUrls(argv) {
  return argv.slice(1).filter(a => !a.startsWith('--') && !/\.exe$/i.test(a) && !/[\\/]resources[\\/]/.test(a))
    .map(a => /^[a-z]:[\\/]/i.test(a) && fs.existsSync(a) ? pathToFileURL(a).toString() : a)
    .filter(a => /^(https?|file):/i.test(a));
}

// ---------- auth prompt ----------
function promptAuth(parent, info) {
  return new Promise(resolve => {
    const w = new BrowserWindow({ parent, modal: !!parent, width: 400, height: 270, resizable: false, minimizable: false, maximizable: false, autoHideMenuBar: true, title: L('Sign in'),
      webPreferences: { preload: path.join(__dirname, 'preload-auth.js'), contextIsolation: true, sandbox: true } });
    w.removeMenu();
    let done = false;
    const finish = v => { if (done) return; done = true; ipcMain.removeListener('auth:result', handler); resolve(v); if (!w.isDestroyed()) w.close(); };
    const handler = (e, v) => { if (e.sender === w.webContents) finish(v); };
    ipcMain.on('auth:result', handler);
    w.on('closed', () => finish(null));
    w.loadFile(path.join(UI_DIR, 'auth.html'), { query: { host: info.host + (info.port ? ':' + info.port : ''), realm: info.realm || '', proxy: info.isProxy ? '1' : '' } });
  });
}

// ---------- IPC ----------
function fromInternal(e) {
  try { return /^onedm:\/\//i.test(e.senderFrame ? e.senderFrame.url : e.sender.getURL()); } catch (_) { return false; }
}
function fromUI(e) { return uiView && e.sender === uiView.webContents; }

function registerMseIpc() {
  ipcMain.on('mse', (e, meta, bytes) => {
    if (!settings.mseCapture && settings.mseCapture !== undefined) return;
    const t = tabByWc(e.sender.id); if (!t || !mseCap) return;
    let changed = false;
    try { changed = mseCap.onMessage(t, String(e.frameId || 0), meta, bytes); } catch (_) {}
    if (changed) pushState();
  });
}

function registerIpc() {
  ipcMain.on('i18n', e => { try { e.returnValue = i18n.payload(); } catch (_) { e.returnValue = null; } });
  registerMseIpc();
  // asked synchronously by every page/frame at load: should autoplay be blocked here? (uses the top-level page's host)
  ipcMain.on('autoplay-state', e => {
    let block = !!settings.autoplayBlock;
    try {
      const top = (e.senderFrame && e.senderFrame.top && e.senderFrame.top.url) || e.sender.getURL();
      const host = new URL(top).hostname.toLowerCase();
      if ((settings.autoplayAllowed || []).some(d => host === d || host.endsWith('.' + d))) block = false;
    } catch (_) {}
    e.returnValue = { block };
  });
  const h = (ch, fn, who) => ipcMain.handle(ch, (e, ...a) => {
    if (who === 'ui' ? !fromUI(e) : who === 'page' ? !fromInternal(e) : !(fromUI(e) || fromInternal(e))) throw new Error('forbidden');
    return fn(e, ...a);
  });
  // --- UI (browser chrome)
  h('ui:ready', () => ({ tabs: tabOrder.map(id => tabState(tabs.get(id))), activeId, settings, bookmarks: stores.bookmarks.get(), engines: ENGINES }), 'ui');
  h('ui:layout', (e, hgt) => { chromeH = Math.max(40, Math.round(hgt)); layout(); }, 'ui');
  h('ui:overlay', (e, on) => { overlayOpen = !!on; layout(); if (!on) { const wc = currentWC(); } }, 'ui');
  h('ui:new-tab', (e, url, incognito) => { createTab(url || null, { incognito: !!incognito }); }, 'ui');
  h('ui:close-tab', (e, id) => closeTab(id), 'ui');
  h('ui:activate', (e, id) => activateTab(id), 'ui');
  h('ui:move-tab', (e, id, index) => { const i = tabOrder.indexOf(id); if (i < 0) return; tabOrder.splice(i, 1); tabOrder.splice(Math.max(0, Math.min(index, tabOrder.length)), 0, id); pushState(true); }, 'ui');
  h('ui:navigate', (e, id, text) => { const t = tabs.get(id); if (t) { loadInTab(t, resolveInput(text)); t.view.webContents.focus(); } }, 'ui');
  h('ui:nav', (e, id, what) => {
    const t = tabs.get(id); if (!t) return; const wc = t.view.webContents, nh = wc.navigationHistory;
    if (what === 'back' && nh.canGoBack()) nh.goBack();
    else if (what === 'forward' && nh.canGoForward()) nh.goForward();
    else if (what === 'reload') wc.reload();
    else if (what === 'hard-reload') wc.reloadIgnoringCache();
    else if (what === 'stop') wc.stop();
    else if (what === 'home') loadInTab(t, resolveInput(settings.homepage));
  }, 'ui');
  h('ui:suggest', (e, text) => suggest(text), 'ui');
  h('ui:toggle-bookmark', (e, id) => toggleBookmark(id), 'ui');
  h('ui:find', (e, text, forward, matchCase, next) => {
    const wc = currentWC(); if (!wc) return;
    if (!text) { wc.stopFindInPage('clearSelection'); sendUI('find-result', { active: 0, total: 0, final: true }); return; }
    wc.findInPage(text, { forward: forward !== false, findNext: !!next, matchCase: !!matchCase });
  }, 'ui');
  h('ui:find-stop', () => { const wc = currentWC(); wc && wc.stopFindInPage('clearSelection'); wc && wc.focus(); }, 'ui');
  h('ui:zoom', (e, d) => adjustZoom(d), 'ui');
  h('ui:tab-action', (e, id, act) => {
    const t = tabs.get(id); if (!t) return; const wc = t.view.webContents;
    switch (act) {
      case 'reload': wc.reload(); break;
      case 'duplicate': createTab(t.url, { incognito: t.incognito, openerId: id }); break;
      case 'pin': t.pinned = !t.pinned; if (t.pinned) { tabOrder.splice(tabOrder.indexOf(id), 1); const lastPinned = tabOrder.filter(x => tabs.get(x).pinned).length; tabOrder.splice(lastPinned, 0, id); } pushState(true); break;
      case 'mute': wc.setAudioMuted(!wc.isAudioMuted()); pushState(true); break;
      case 'close-others': for (const x of [...tabOrder]) if (x !== id && !tabs.get(x).pinned) closeTab(x, { keepWindow: true }); activateTab(id); break;
      case 'close-right': { const i = tabOrder.indexOf(id); for (const x of tabOrder.slice(i + 1)) if (!tabs.get(x).pinned) closeTab(x, { keepWindow: true }); break; }
    }
  }, 'ui');
  h('ui:menu-action', async (e, act) => {
    const t = currentTab(), wc = currentWC();
    switch (act) {
      case 'new-tab': createTab(null); break;
      case 'new-incognito': createTab(null, { incognito: true }); break;
      case 'reopen': reopenClosed(); break;
      case 'bookmarks': createTab('onedm://bookmarks', { openerId: activeId }); break;
      case 'history': createTab('onedm://history', { openerId: activeId }); break;
      case 'downloads': createTab('onedm://downloads', { openerId: activeId }); break;
      case 'settings': createTab('onedm://settings', { openerId: activeId }); break;
      case 'torrents': openSingleTab('onedm://torrents'); break;
      case 'restream': openSingleTab('onedm://restream'); break;
      case 'grabber': if (t && /^https?:/.test(t.url)) createTab('onedm://grabber?tab=' + t.id, { openerId: activeId }); break;
      case 'print': wc && wc.print(); break;
      case 'save-page': wc && savePage(wc); break;
      case 'devtools': toggleDevTools(); break;
      case 'view-source': wc && createTab('view-source:' + wc.getURL(), { openerId: activeId }); break;
      case 'fullscreen': win.setFullScreen(!win.isFullScreen()); break;
      case 'bookmark-page': toggleBookmark(activeId); break;
      case 'exit': app.quit(); break;
      case 'invert':
        if (wc && t) {
          t.inverted = !t.inverted;
          const css = 'html{filter:invert(1) hue-rotate(180deg)!important;background:#fff}img,video,picture,canvas,svg image,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}';
          if (t.inverted) t.invertKey = await wc.insertCSS(css); else if (t.invertKey) await wc.removeInsertedCSS(t.invertKey);
          pushState(true);
        } break;
      case 'mobile-site':
        if (wc && t) { t.mobile = !t.mobile; wc.setUserAgent(t.mobile ? MOBILE_UA.replace('{V}', process.versions.chrome) : (settings.userAgent || UA)); wc.reloadIgnoringCache(); pushState(true); } break;
      case 'reader':
        if (wc && t && /^https?:/.test(t.url)) {
          const art = await wc.executeJavaScript(EXTRACT_SCRIPT).catch(() => null);
          if (!art) { dialog.showMessageBox(win, { type: 'info', message: L('Reading mode is not available for this page.') }); break; }
          const rid = Date.now().toString(36); readerCache.set(rid, art);
          createTab('onedm://reader?id=' + rid, { openerId: activeId });
        } break;
      case 'autoplay-site':
        if (t && /^https?:/.test(t.url)) {
          const host = new URL(t.url).hostname.toLowerCase(); const wl = new Set(settings.autoplayAllowed || []);
          wl.has(host) ? wl.delete(host) : wl.add(host);
          updateSettings({ autoplayAllowed: [...wl] }); wc.reload();
        } break;
      case 'adblock-site':
        if (t && /^https?:/.test(t.url)) {
          const host = new URL(t.url).hostname; const wl = new Set(settings.adblockWhitelist || []);
          wl.has(host) ? wl.delete(host) : wl.add(host);
          updateSettings({ adblockWhitelist: [...wl] }); wc.reload();
        } break;
    }
  }, 'ui');
  h('ui:settings-set', (e, patch) => updateSettings(patch), 'ui');
  h('ui:media-list', () => { const t = currentTab(); return t ? mediaList(t) : []; }, 'ui');
  h('ui:mse-action', async (e, act) => {
    const t = currentTab(); if (!t) return { ok: false };
    if (act === 'save') return saveMse(t);
    if (act === 'capture') return autoCapture(t);
    if (act === 'stop') { stopCapture(t); return { ok: true }; }
    return { ok: false };
  }, 'ui');
  h('ui:media-info', async (e, m) => {
    const t = currentTab(); if (!t || !m || !/^https?:/i.test(m.url || '')) return null;
    try { return await mediaInfoFor(m, t); } catch (e) { return m.kind === 'youtube' || m.kind === 'scan' ? { variants: [], error: ytdlp.friendlyError(e && e.message) } : null; }
  }, 'ui');
  h('ui:media-scan', async () => { const t = currentTab(); if (!t) return { ok: false }; return await scanPage(t); }, 'ui');
  h('ui:media-thumb', async (e, m) => {
    const t = currentTab(); if (!t || !m || !/^https?:/i.test(m.url || '')) return '';
    try { return await mediaThumb(m, t); } catch (_) { return ''; }
  }, 'ui');
  h('ui:media-download', (e, m) => {
    const t = currentTab(); if (!t) return;
    if (m.kind === 'youtube') return ytDownload(m, t);
    if (m.kind === 'scan') {
      const e = scanEntry(m, t); if (!e) return { ok: false, error: L('Scan results expired - scan the page again.') };
      return runYtDownload(m, t, e.info, e.entryUrl || e.url, !e.entryUrl && e.multi ? e.idx + 1 : 0);
    }
    const title = (t.title || '').replace(/\s+-\s+.*$/, '').trim();
    const stream = m.kind === 'hls' || m.kind === 'dash';
    // m.variant = the quality picked in the popup: an HLS variant is its own playlist URL, a DASH one is a representation id
    let url = m.url, videoId = '', name = title;
    const v = stream && m.variant;
    if (v) {
      if (m.kind === 'hls' && /^https?:/i.test(v.url || '')) url = v.url;
      if (m.kind === 'dash') videoId = v.id || '';
      if (v.height) name = (title || 'video') + ' ' + v.height + 'p';
    }
    return downloads.startUrl({ url, kind: stream ? m.kind : 'auto', filename: stream ? name : '', videoId, ...tabNetContext(t) });
  }, 'ui');
  h('ui:restream-media', (e, m) => {
    const t = currentTab(); if (!m || !/^https?:/i.test(m.url || '')) return;
    openSingleTab('onedm://restream?url=' + encodeURIComponent(m.url) + (t && /^https?:/i.test(t.url) ? '&ref=' + encodeURIComponent(t.url) : ''));
  }, 'ui');
  h('ui:downloads', () => downloads.list(), 'ui');
  h('ui:copy-text', (e, text) => { clipboard.writeText(String(text || '')); return true; }, 'ui');
  h('ui:download-action', (e, id, act) => downloads.action(id, act), 'ui');
  h('ui:window-state', () => ({ maximized: win.isMaximized() }), 'ui');

  // --- internal pages
  h('page:resolve', (e, text) => resolveInput(text), 'page');
  h('page:home-data', () => {
    const bm = stores.bookmarks.get('items').slice(0, 12).map(b => ({ title: b.title, url: b.url }));
    const counts = new Map();
    for (const x of stores.history.get('items')) { let o; try { o = new URL(x.url); } catch (_) { continue; } const k = o.origin; const c = counts.get(k) || { url: k + '/', title: x.title, n: 0 }; c.n++; counts.set(k, c); }
    const top = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 8).map(c => ({ title: c.title, url: c.url }));
    return { engine: settings.searchEngine, engines: ENGINES, bookmarks: bm, top, incognito: false };
  }, 'page');
  h('page:bookmarks:get', () => stores.bookmarks.get(), 'page');
  h('page:bookmarks:add', (e, b) => { stores.bookmarks.get('items').push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4), title: b.title || b.url, url: resolveInput(b.url), folder: b.folder || '', added: Date.now() }); stores.bookmarks.save(); bookmarksChanged(); }, 'page');
  h('page:bookmarks:update', (e, id, patch) => { const b = stores.bookmarks.get('items').find(x => x.id === id); if (b) { if (patch.title !== undefined) b.title = patch.title; if (patch.url !== undefined) b.url = resolveInput(patch.url); if (patch.folder !== undefined) b.folder = patch.folder; stores.bookmarks.save(); bookmarksChanged(); } }, 'page');
  h('page:bookmarks:delete', (e, id) => { const d = stores.bookmarks.get(); d.items = d.items.filter(x => x.id !== id); stores.bookmarks.save(); bookmarksChanged(); }, 'page');
  h('page:bookmarks:folder-add', (e, title) => { stores.bookmarks.get('folders').push({ id: 'f' + Date.now().toString(36), title: title || L('New folder') }); stores.bookmarks.save(); bookmarksChanged(); }, 'page');
  h('page:bookmarks:folder-rename', (e, id, title) => { const f = stores.bookmarks.get('folders').find(x => x.id === id); if (f) { f.title = title; stores.bookmarks.save(); bookmarksChanged(); } }, 'page');
  h('page:bookmarks:folder-delete', (e, id) => { const d = stores.bookmarks.get(); d.folders = d.folders.filter(f => f.id !== id); d.items = d.items.filter(b => b.folder !== id); stores.bookmarks.save(); bookmarksChanged(); }, 'page');
  h('page:bookmarks:import', async () => {
    const r = await dialog.showOpenDialog(win, { filters: [{ name: L('Bookmarks HTML'), extensions: ['html', 'htm'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return -1;
    return importBookmarksHtml(fs.readFileSync(r.filePaths[0], 'utf8'));
  }, 'page');
  h('page:bookmarks:export', async () => {
    const r = await dialog.showSaveDialog(win, { defaultPath: 'bookmarks.html', filters: [{ name: L('Bookmarks HTML'), extensions: ['html'] }] });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, exportBookmarksHtml()); return true;
  }, 'page');
  h('page:history:get', (e, q, limit) => {
    q = (q || '').toLowerCase();
    return stores.history.get('items').filter(x => !q || (x.title + ' ' + x.url).toLowerCase().includes(q)).slice(0, limit || 500);
  }, 'page');
  h('page:history:delete', (e, id) => { const d = stores.history.get(); d.items = d.items.filter(x => x.id !== id); stores.history.save(); }, 'page');
  h('page:history:clear', () => { stores.history.set('items', []); }, 'page');
  h('page:downloads:add-url', async (e, text) => { try { await addDownloadInput(text); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; } }, 'page');
  h('page:grabber:scan', async (e, tabId) => {
    const t = tabs.get(+tabId); if (!t || t.view.webContents.isDestroyed()) return null;
    let dom = { videos: [], images: [], links: [] };
    try { dom = await t.view.webContents.executeJavaScript(GRAB_SCRIPT); } catch (_) {}
    const media = mediaList(t), videos = dom.videos || [];
    // list the qualities of HLS/DASH streams (in parallel, each capped in time) so the user can choose one
    const streams = new Map();
    for (const m of [...media, ...videos]) if ((m.kind === 'hls' || m.kind === 'dash') && !streams.has(m.url)) streams.set(m.url, m);
    const byUrl = new Map();
    await Promise.all([...streams.values()].slice(0, 12).map(async m => byUrl.set(m.url, await streamVariants(m, t))));
    const attach = list => list.map(m => { const v = byUrl.get(m.url); return v && v.length ? { ...m, variants: v } : m; });
    return { tabId: t.id, title: t.title, url: t.url, blob: !!dom.blob, media: attach(media), videos: attach(videos), images: dom.images, links: dom.links };
  }, 'page');
  h('page:grabber:download', async (e, tabId, items) => {
    const t = tabs.get(+tabId); const ctx = t ? tabNetContext(t) : { partition: MAIN_PART, ua: UA };
    let n = 0;
    for (const it of (items || []).slice(0, 500)) {
      try {
        if (it.kind === 'mse') { if (t) await saveMse(t); }
        else if (it.kind === 'magnet' || it.kind === 'torrent') await addDownloadInput(it.url, ctx);
        else await downloads.startUrl({ url: it.url, kind: (it.kind === 'hls' || it.kind === 'dash') ? it.kind : 'auto', filename: (it.kind === 'hls' || it.kind === 'dash') ? (it.name || (t && t.title) || '') : '', videoId: it.videoId || '', ...ctx });
        n++;
      } catch (_) {}
    }
    return n;
  }, 'page');
  h('page:copy-text', (e, text) => { clipboard.writeText(String(text || '')); return true; }, 'page');
  h('page:torrents:get', () => torrents.list(), 'page');
  // add everything straight away (no picker)
  h('page:torrents:add', async (e, text) => {
    try { const r = await addTorrentSource((text || '').trim(), { confirm: false }); return { ok: !r.error, error: r.error }; }
    catch (err) { return { ok: false, error: err.message }; }
  }, 'page');
  // read the file list of a magnet / info-hash / .torrent URL without downloading it
  h('page:torrents:peek', async (e, text, token) => {
    try {
      let input = token && pendingPicks.has(token) ? pendingPicks.get(token) : (text || '').trim();
      if (typeof input === 'string' && /^https?:/i.test(input)) {
        if (!/\.torrent(\?|#|$)/i.test(input)) throw new Error('That link is not a .torrent file. Paste it into the Downloads page to download it as a normal file.');
        input = await getBuffer(input, { headersFor: downloads.headersFor({ partition: MAIN_PART, ua: UA }), limit: 20 * 1024 * 1024 });
      }
      return { ok: true, meta: await torrents.peek(input) };
    } catch (err) { return { ok: false, error: err.message }; }
  }, 'page');
  h('page:torrents:peek-file', async () => {
    const r = await dialog.showOpenDialog(win, { filters: [{ name: L('Torrent files'), extensions: ['torrent'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
    try { return { ok: true, meta: await torrents.peek(fs.readFileSync(r.filePaths[0])) }; } catch (err) { return { ok: false, error: err.message }; }
  }, 'page');
  h('page:torrents:add-picked', async (e, key, opts) => {
    try {
      opts = opts || {};
      const r = await torrents.addPeeked(key, { files: Array.isArray(opts.files) ? opts.files.map(Number) : null, seed: typeof opts.seed === 'boolean' ? opts.seed : undefined, dir: opts.dir || undefined });
      return { ok: !r.error, error: r.error };
    } catch (err) { return { ok: false, error: err.message }; }
  }, 'page');
  h('page:torrents:add-file', async () => {
    const r = await dialog.showOpenDialog(win, { filters: [{ name: L('Torrent files'), extensions: ['torrent'] }], properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return 0;
    for (const f of r.filePaths) await addTorrentSource(fs.readFileSync(f), { confirm: false });
    return r.filePaths.length;
  }, 'page');
  h('page:torrents:action', (e, ih, act, arg) => torrents.action(ih, act, arg), 'page');
  // --- live restream
  h('page:restream:get', () => ({ jobs: restream.list(), ffmpeg: ffmpegMod.available(), settings: { restreamUrl: settings.restreamUrl || '', restreamKey: settings.restreamKey || '', restreamAudio: settings.restreamAudio || 'copy' } }), 'page');
  h('page:restream:start', async (e, o) => {
    try {
      o = o || {};
      if (o.kind === 'url') o.headers = await downloads.headersFor({ referrer: o.referrer || '', partition: MAIN_PART, ua: UA })((o.url || '').trim()).catch(() => ({ 'User-Agent': UA }));
      const r = await restream.start(o);
      if (o.remember !== false) updateSettings({ restreamUrl: (o.rtmpUrl || '').trim(), restreamKey: (o.streamKey || '').trim() });
      return { ok: true, id: r.id };
    } catch (err) { return { ok: false, error: err.message }; }
  }, 'page');
  h('page:restream:stop', (e, id) => restream.stop(id), 'page');
  h('page:restream:remove', (e, id) => restream.remove(id), 'page');
  h('page:restream:clear', () => restream.clearFinished(), 'page');
  h('page:restream:pick-file', async () => {
    const r = await dialog.showOpenDialog(win, { filters: [{ name: L('Video'), extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'ts', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg', 'm2ts'] }, { name: L('All files'), extensions: ['*'] }], properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  }, 'page');
  h('page:downloads:get', () => downloads.list(), 'page');
  h('page:downloads:action', (e, id, act) => downloads.action(id, act), 'page');
  h('page:settings:get', () => ({ settings, languages: i18n.languages(), engines: ENGINES, defaultDownloadDir: app.getPath('downloads'), blocked: adblock.blockedCount, rules: adblock.count, version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, userData: app.getPath('userData') }), 'page');
  h('page:settings:set', (e, patch) => updateSettings(patch), 'page');
  h('page:settings:pick-dir', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; }, 'page');
  h('page:settings:update-filters', async () => { const n = await refreshAdblock(true); return n; }, 'page');
  h('page:settings:clear-data', async (e, what) => {
    for (const part of [MAIN_PART, INCOG_PART]) {
      const s = session.fromPartition(part);
      if (what.cookies) await s.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql'] });
      if (what.cache) { await s.clearCache(); await s.clearCodeCaches({}); }
      if (what.auth) await s.clearAuthCache();
    }
    if (what.history) stores.history.set('items', []);
    if (what.downloads) await downloads.action('', 'clear');
    if (what.permissions) stores.permissions.set({});
    return true;
  }, 'page');
  h('page:permissions:get', () => stores.permissions.get(), 'page');
  h('page:permissions:reset', (e, origin) => { const d = stores.permissions.get(); if (origin) delete d[origin]; else for (const k of Object.keys(d)) delete d[k]; stores.permissions.save(); }, 'page');
  h('page:reader:get', (e, id) => readerCache.get(id) || null, 'page');
  h('page:open', (e, url, inNewTab) => { const s = e.sender; for (const t of tabs.values()) if (t.view.webContents.id === s.id) { inNewTab ? createTab(url, { openerId: t.id, incognito: t.incognito }) : loadInTab(t, resolveInput(url)); } }, 'page');
}

// Switch the interface language live: the toolbar and every internal page (onedm://…) is reloaded to pick up the new text.
function applyLanguage() {
  const lang = i18n.resolve(settings.language, app.getLocale());
  if (lang === i18n.language()) return;
  i18n.setLanguage(lang);
  setTimeout(() => {
    try { if (uiView && !uiView.webContents.isDestroyed()) uiView.webContents.reload(); } catch (_) {}
    for (const t of tabs.values()) { try { const wc = t.view.webContents; if (!wc.isDestroyed() && isInternalUrl(wc.getURL())) wc.reload(); } catch (_) {} }
    pushState(true);
  }, 50);
}

function updateSettings(patch) {
  const before = { ...settings };
  Object.assign(settings, patch);
  stores.settings.set(settings);
  if ('language' in patch) applyLanguage();
  if ('theme' in patch) nativeTheme.themeSource = settings.theme;
  if ('proxyMode' in patch || 'proxyRules' in patch) applyProxy();
  if ('userAgent' in patch) for (const p of [MAIN_PART, INCOG_PART]) session.fromPartition(p).setUserAgent(settings.userAgent || UA);
  if ('adblock' in patch || 'filterLists' in patch || 'adblockWhitelist' in patch) refreshAdblock(false);
  if ('downloadDir' in patch && !settings.downloadDir) settings.downloadDir = '';
  if (torrents) torrents.applyLimits();
  sendUI('settings', settings);
  sendInternalPages('settings-changed');
  return settings;
}

// ---------- app lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', (e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    for (const u of argvToUrls(argv)) createTab(u);
  });

  app.on('login', (event, wc, request, authInfo, callback) => {
    event.preventDefault();
    promptAuth(win, authInfo).then(c => c ? callback(c.user, c.pass) : callback());
  });

  app.whenReady().then(async () => {
    // Widevine CDM (castLabs build): must finish loading before any page that plays protected video
    if (components && components.whenReady) { try { await components.whenReady(); } catch (e) { console.warn('Widevine unavailable:', e && e.message); } }
    const dir = app.getPath('userData');
    stores = {
      settings: new Store(dir, 'settings', DEFAULT_SETTINGS),
      bookmarks: new Store(dir, 'bookmarks', { items: [], folders: [] }),
      history: new Store(dir, 'history', { items: [] }),
      downloads: new Store(dir, 'downloads', []),
      torrents: new Store(dir, 'torrents', []),
      permissions: new Store(dir, 'permissions', {}),
      session: new Store(dir, 'session', { tabs: [], active: 0 }),
      window: new Store(dir, 'window', {})
    };
    settings = stores.settings.get();
    i18n.setLanguage(i18n.resolve(settings.language, app.getLocale()));
    nativeTheme.themeSource = settings.theme || 'system';
    UA = session.defaultSession.getUserAgent().replace(/\s(?!Chrome\/|Safari\/|AppleWebKit\/)[A-Za-z][\w.-]*\/\d[\w.]*/g, '');
    app.userAgentFallback = UA;
    adblock = new AdBlocker(path.join(dir, 'filters'));
    const tmpDir = path.join(dir, 'tmp'); try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
    downloads = new DownloadManager({
      store: stores.downloads, getSettings: () => settings, getDefaultDir: () => app.getPath('downloads'), getTmpDir: () => tmpDir,
      onChange: list => { sendUI('downloads', list); sendInternalPages('downloads-update', list); },
      onProgress: (f, n) => { if (win && !win.isDestroyed()) win.setProgressBar(f === 2 ? 2 : f); sendUI('download-count', n); },
      askSavePath: async p => { const r = await dialog.showSaveDialog(win, { defaultPath: p }); return r.canceled ? null : r.filePath; },
      onTorrent: (url, ctx) => { addTorrentFromUrl(url, ctx); }
    });
    torrents = new TorrentManager({
      store: stores.torrents, dir: path.join(dir, 'torrents'), tmpDir: path.join(tmpDir, 'torrent-temp'), getSettings: () => settings, getDownloadDir: () => settings.downloadDir || app.getPath('downloads'),
      onChange: list => sendInternalPages('torrents-update', list)
    });
    restream = new RestreamManager({
      getSettings: () => settings, torrents,
      onChange: list => sendInternalPages('restream-update', list),
      notify: (title, body) => { try { new Notification({ title: L(title), body: L(body) }).show(); } catch (_) {} }
    });
    setupSession(session.fromPartition(MAIN_PART), false);
    setupSession(session.fromPartition(INCOG_PART), true);
    applyProxy();
    mseCap = new MseCapture(path.join(tmpDir, 'mse'), () => (settings.mseCapMB || 4096) * 1048576);
    mseCap.wipeAll();
    registerIpc();
    createWindow();
    ytdlp.setUserDir(path.join(dir, 'yt-dlp'));
    setTimeout(() => refreshYtdlp(false).catch(() => {}), 15000);   // background, after startup has settled
    uiView.webContents.once('did-finish-load', () => {
      restoreSession(argvToUrls(process.argv));
      layout();
    });
    refreshAdblock(false).catch(() => {});
    if (stores.torrents.get().length) torrents.restore().catch(() => {});
  });

  app.on('before-quit', () => {
    try {
      if (settings.clearOnExit.history) stores.history.set('items', []);
      if (settings.clearOnExit.cookies) session.fromPartition(MAIN_PART).clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb'] });
      if (settings.clearOnExit.cache) session.fromPartition(MAIN_PART).clearCache();
      for (const s of Object.values(stores)) s.flush();
      if (restream) restream.stopAll();
      if (torrents) torrents.destroy();
      if (mseCap) mseCap.wipeAll();
    } catch (_) {}
  });
  app.on('window-all-closed', () => app.quit());
}
