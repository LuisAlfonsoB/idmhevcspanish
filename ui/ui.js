'use strict';
const $ = s => document.querySelector(s);
const P = {
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  fwd: 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z',
  reload: 'M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  stop: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  star: 'M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z',
  starOn: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.62L12 2 9.19 8.62 2 9.24l5.46 4.73L5.82 21z',
  menu: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  dl: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  shield: 'M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z',
  lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM9 8V6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9z',
  warn: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  info: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
  search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  vol: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z',
  mute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  up: 'M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z',
  down: 'M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z',
  folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  hist: 'M13 3a9 9 0 00-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0013 21a9 9 0 000-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z',
  globe: 'M12 2a10 10 0 100 20 10 10 0 000-20zm-1 17.93A8 8 0 014.07 13H8c.1 1.5.4 2.9.9 4.1-.7.8-1.4 1.5-1.9 2.2zM4.07 11A8 8 0 0111 4.07C10.4 5 9.9 6.5 9.5 8.5 9.2 9.2 9 10.1 8.9 11H4.07z',
  film: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z',
  incog: 'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27z'
};
const svg = (k, cls) => `<svg viewBox="0 0 24 24"${cls ? ` class="${cls}"` : ''}><path d="${P[k]}"/></svg>`;
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let S = { tabs: [], activeId: null }, settings = {}, bookmarks = { items: [], folders: [] }, downloads = [], dlActive = 0;
let overlayOn = false, omniDirty = false, sugs = [], sugSel = -1, sugToken = 0, sugTimer = null, dragId = null;
const active = () => S.tabs.find(t => t.id === S.activeId);

// ---- static icons
$('#newtab').innerHTML = svg('plus'); $('#back').innerHTML = svg('back'); $('#fwd').innerHTML = svg('fwd');
$('#home').innerHTML = svg('home'); $('#star').innerHTML = svg('star');
$('#shield').insertAdjacentHTML('afterbegin', svg('shield')); $('#dl').insertAdjacentHTML('afterbegin', svg('dl'));
$('#menu').innerHTML = svg('menu'); $('#media').insertAdjacentHTML('afterbegin', svg('film')); $('#findprev').innerHTML = svg('up'); $('#findnext').innerHTML = svg('down'); $('#findclose').innerHTML = svg('stop');
$('#reload').innerHTML = svg('reload');

// ---- layout reporting
new ResizeObserver(() => shell.invoke('layout', $('#chrome').getBoundingClientRect().height)).observe($('#chrome'));

// ---- overlay / dropdown plumbing
function setOverlay(on) { if (on === overlayOn) return; overlayOn = on; $('#scrim').hidden = !on; shell.invoke('overlay', on); }
function closeDropdown() { $('#dropdown').hidden = true; $('#dropdown').innerHTML = ''; sugs = []; sugSel = -1; setOverlay(false); }
function showDropdown(html, x, y, opts = {}) {
  const d = $('#dropdown'); d.innerHTML = html; d.hidden = false; d.style.minWidth = opts.minWidth || ''; setOverlay(true);
  const r = d.getBoundingClientRect(), W = innerWidth, H = innerHeight;
  d.style.left = Math.max(4, Math.min(x, W - r.width - 6)) + 'px';
  d.style.top = Math.max(4, Math.min(y, H - Math.min(r.height, H - 8) - 4)) + 'px';
  return d;
}
$('#scrim').addEventListener('mousedown', closeDropdown);
shell.on('overlay-close', closeDropdown);
addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#dropdown').hidden) closeDropdown(); else if (!$('#findbar').hidden) closeFind(); else if (document.activeElement === $('#url')) { omniDirty = false; renderOmni(true); $('#url').blur(); } } });

function menuItem(label, key, act, extra = '') { return `<div class="mi ${extra}" data-act="${act}">${label}<span class="k">${key || ''}</span></div>`; }
function wireMenu(fn) { $('#dropdown').onclick = e => { const el = e.target.closest('[data-act]'); if (el && !el.classList.contains('dis')) { const a = el.dataset.act; if (!el.dataset.keep) closeDropdown(); fn(a, el); } }; }

// ---- main menu
function openMenu() {
  const t = active() || {}; const zp = Math.round(100 * Math.pow(1.2, t.zoom || 0));
  let apHost = ''; try { if (/^https?:/.test(t.url || '')) apHost = new URL(t.url).hostname.toLowerCase(); } catch (_) {}
  const apOn = apHost && (settings.autoplayAllowed || []).includes(apHost);
  const apItem = apHost && settings.autoplayBlock ? menuItem(apOn ? 'Autoplay is allowed on this site — block it' : 'Autoplay is blocked on this site — allow it', '', 'autoplay-site') : '';
  const html = [
    menuItem('New tab', 'Ctrl+T', 'new-tab'), menuItem('New incognito tab', 'Ctrl+Shift+N', 'new-incognito'), menuItem('Reopen closed tab', 'Ctrl+Shift+T', 'reopen'), '<div class="sep"></div>',
    menuItem('Bookmarks', 'Ctrl+Shift+B', 'bookmarks'), menuItem('History', 'Ctrl+H', 'history'), menuItem('Downloads', 'Ctrl+J', 'downloads'), menuItem('Torrents', '', 'torrents'), menuItem('Live restream…', '', 'restream'), menuItem('Page grabber…', '', 'grabber'), '<div class="sep"></div>',
    `<div class="zoomrow"><b>Zoom</b><button data-act="zoom-out" data-keep="1">−</button><span id="zv" style="min-width:42px;text-align:center">${zp}%</span><button data-act="zoom-in" data-keep="1">+</button><button data-act="fullscreen" title="Full screen (F11)">⛶</button></div>`, '<div class="sep"></div>',
    menuItem('Find in page…', 'Ctrl+F', 'find'), menuItem('Reading mode', '', 'reader'), menuItem((t.inverted ? '✓ ' : '') + 'Invert page colors', '', 'invert'), apItem,
    menuItem((t.mobile ? '✓ ' : '') + 'Mobile site', '', 'mobile-site'), menuItem('Save page as…', 'Ctrl+S', 'save-page'), menuItem('Print…', 'Ctrl+P', 'print'), '<div class="sep"></div>',
    menuItem('View page source', 'Ctrl+U', 'view-source'), menuItem('Developer tools', 'F12', 'devtools'), '<div class="sep"></div>',
    menuItem('Settings', '', 'settings'), menuItem('Exit', '', 'exit')
  ].join('');
  const r = $('#menu').getBoundingClientRect();
  showDropdown(html, r.right - 280, r.bottom + 4, { minWidth: '280px' });
  wireMenu(a => {
    if (a === 'find') return openFind();
    if (a === 'zoom-in' || a === 'zoom-out') { shell.invoke('zoom', a === 'zoom-in' ? 0.5 : -0.5).then(() => setTimeout(() => { const z = active(); const e = $('#zv'); if (e && z) e.textContent = Math.round(100 * Math.pow(1.2, z.zoom || 0)) + '%'; }, 120)); return; }
    shell.invoke('menu-action', a);
  });
}
$('#menu').onclick = () => ($('#dropdown').hidden ? openMenu() : closeDropdown());

// ---- tabs
function faviconHtml(t) {
  if (t.loading) return '<div class="spin"></div>';
  if (t.favicon) return `<img src="${esc(t.favicon)}">`;
  return t.incognito ? svg('incog') : svg('globe');
}
function renderTabs() {
  const box = $('#tabs'); box.innerHTML = '';
  for (const t of S.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === S.activeId ? ' active' : '') + (t.pinned ? ' pinned' : '') + (t.incognito ? ' incog' : '');
    el.draggable = true; el.title = t.title;
    el.innerHTML = `<span class="fav">${faviconHtml(t)}</span><span class="ttl">${esc(t.title)}</span>${t.audible || t.muted ? `<span class="aud">${svg(t.muted ? 'mute' : 'vol')}</span>` : ''}<button class="x">${svg('stop')}</button>`;
    const img = el.querySelector('.fav img'); if (img) img.addEventListener('error', () => { img.parentElement.innerHTML = svg(t.incognito ? 'incog' : 'globe'); });
    el.addEventListener('mousedown', e => { if (e.button === 0 && !e.target.closest('.x')) shell.invoke('activate', t.id); if (e.button === 1) { e.preventDefault(); shell.invoke('close-tab', t.id); } });
    el.querySelector('.x').addEventListener('click', e => { e.stopPropagation(); shell.invoke('close-tab', t.id); });
    el.addEventListener('contextmenu', e => { e.preventDefault(); tabMenu(t, e.clientX, e.clientY); });
    el.addEventListener('dragstart', e => { dragId = t.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(t.id)); });
    el.addEventListener('dragover', e => { if (dragId !== null) { e.preventDefault(); el.classList.add('dragover'); } });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('dragover'); if (dragId !== null && dragId !== t.id) shell.invoke('move-tab', dragId, S.tabs.findIndex(x => x.id === t.id)); dragId = null; });
    el.addEventListener('dragend', () => { dragId = null; });
    box.appendChild(el);
  }
}
function tabMenu(t, x, y) {
  showDropdown([menuItem('New tab', '', 'new'), menuItem('Reload', '', 'reload'), menuItem('Duplicate', '', 'duplicate'), menuItem(t.pinned ? 'Unpin tab' : 'Pin tab', '', 'pin'),
    menuItem(t.muted ? 'Unmute site' : 'Mute site', '', 'mute'), '<div class="sep"></div>', menuItem('Close tab', 'Ctrl+W', 'close'), menuItem('Close other tabs', '', 'close-others'), menuItem('Close tabs to the right', '', 'close-right')].join(''), x, y);
  wireMenu(a => { if (a === 'new') shell.invoke('new-tab'); else if (a === 'close') shell.invoke('close-tab', t.id); else shell.invoke('tab-action', t.id, a); });
}
$('#newtab').onclick = () => shell.invoke('new-tab');
$('#tabstrip').addEventListener('dblclick', e => { if (e.target.id === 'tabstrip') shell.invoke('new-tab'); });

// ---- toolbar state
function renderToolbar() {
  const t = active(); if (!t) return;
  $('#back').disabled = !t.canGoBack; $('#fwd').disabled = !t.canGoForward;
  $('#reload').innerHTML = svg(t.loading ? 'stop' : 'reload'); $('#reload').title = t.loading ? 'Stop' : 'Reload (Ctrl+R)';
  const st = $('#star'); st.innerHTML = svg(t.bookmarked ? 'starOn' : 'star'); st.classList.toggle('on', !!t.bookmarked);
  const internal = /^onedm:/i.test(t.url), http = /^http:/i.test(t.url), https = /^https:/i.test(t.url);
  const si = $('#secure'); si.className = 'sicon' + (https ? ' ok' : (http ? ' warn' : ''));
  si.innerHTML = https ? svg('lock') : http ? svg('warn') : internal ? svg('shield') : svg('info');
  si.title = https ? 'Connection is secure' : http ? 'Connection is not secure' : '';
  const zi = $('#zoomind'); zi.hidden = !t.zoom; zi.textContent = Math.round(100 * Math.pow(1.2, t.zoom || 0)) + '%';
  const md = $('#media'); md.hidden = !t.media; $('#medn').textContent = t.media > 99 ? '99+' : t.media;
  const sh = $('#shield'), on = !!settings.adblock; sh.classList.toggle('off', !on);
  const n = $('#shieldn'); n.hidden = !(on && t.blocked); n.textContent = t.blocked > 99 ? '99+' : t.blocked;
  $('#bmbar').classList.toggle('hidden', !settings.showBookmarksBar);
  document.body.classList.toggle('incog', !!t.incognito);
  renderOmni();
}
function displayUrl(u) { if (!u || /^onedm:\/\/home\/?$/i.test(u)) return ''; return u; }
function renderOmni(force) { const t = active(); if (!t) return; if (force || (!omniDirty && document.activeElement !== $('#url'))) $('#url').value = displayUrl(t.url); }

// ---- omnibox + suggestions
const url = $('#url');
url.addEventListener('focus', () => { setTimeout(() => url.select(), 0); });
url.addEventListener('input', () => { omniDirty = true; typed = url.value; clearTimeout(sugTimer); sugTimer = setTimeout(fetchSuggestions, 110); });
url.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== url) { omniDirty = false; } }, 0); });
let typed = '';
url.addEventListener('keydown', e => {
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && sugs.length) {
    e.preventDefault();
    const n = sugs.length; let i = sugSel + (e.key === 'ArrowDown' ? 1 : -1);
    if (i < -1) i = n - 1; if (i >= n) i = -1;
    sugSel = i; markSel(); url.value = i >= 0 ? sugs[i].url : typed;
  } else if (e.key === 'Enter') { e.preventDefault(); go(sugSel >= 0 ? sugs[sugSel].url : url.value, e.altKey); }
});
function go(text, newTab) { closeDropdown(); omniDirty = false; if (newTab) shell.invoke('new-tab', text); else shell.invoke('navigate', S.activeId, text); }
async function fetchSuggestions() {
  const q = url.value.trim(); const my = ++sugToken;
  if (!q || q === displayUrl((active() || {}).url)) { if (!$('#findbar').contains(document.activeElement)) closeDropdown(); return; }
  const list = await shell.invoke('suggest', q); if (my !== sugToken || document.activeElement !== url) return;
  sugs = list; sugSel = -1;
  if (!list.length) return closeDropdown();
  const r = $('#omni').getBoundingClientRect();
  showDropdown(list.map((s, i) => `<div class="mi sug" data-i="${i}">${svg(s.type === 'search' ? 'search' : s.type === 'bookmark' ? 'star' : 'hist')}<span class="t">${esc(s.title)}</span>${s.type === 'search' ? '' : `<span class="u">${esc(s.url)}</span>`}</div>`).join(''), r.left, r.bottom + 4, { minWidth: r.width + 'px' });
  $('#dropdown').style.width = r.width + 'px';
  $('#dropdown').onclick = e => { const el = e.target.closest('[data-i]'); if (el) go(sugs[+el.dataset.i].url); };
}
function markSel() { document.querySelectorAll('#dropdown .sug').forEach((el, i) => el.classList.toggle('sel', i === sugSel)); }

// ---- buttons
$('#back').onclick = () => shell.invoke('nav', S.activeId, 'back');
$('#fwd').onclick = () => shell.invoke('nav', S.activeId, 'forward');
$('#reload').onclick = e => { const t = active(); shell.invoke('nav', S.activeId, t && t.loading ? 'stop' : (e.shiftKey ? 'hard-reload' : 'reload')); };
$('#home').onclick = () => shell.invoke('nav', S.activeId, 'home');
$('#star').onclick = () => shell.invoke('toggle-bookmark', S.activeId);
$('#zoomind').onclick = () => shell.invoke('zoom', 'reset');
shell.on('focus-omnibox', () => { url.focus(); url.select(); });

// ---- ad-block popup
$('#shield').onclick = () => {
  if (!$('#dropdown').hidden) return closeDropdown();
  const t = active() || {}; let host = ''; try { host = new URL(t.url).hostname; } catch (_) {}
  const wl = (settings.adblockWhitelist || []).includes(host);
  const r = $('#shield').getBoundingClientRect();
  showDropdown(`<div class="pop-h">${svg('shield')} Ad blocker ${settings.adblock ? 'is on' : 'is off'}</div>
    <div class="pop-p">${settings.adblock ? `${t.blocked || 0} requests blocked on this page.` : 'Turn it on to block ads and trackers.'}</div>
    ${host && settings.adblock ? `<button class="pbtn" data-act="site">${wl ? 'Enable' : 'Disable'} on ${esc(host)}</button>` : ''}
    <button class="pbtn" data-act="toggle">${settings.adblock ? 'Turn off ad blocker' : 'Turn on ad blocker'}</button>`, r.right - 300, r.bottom + 4, { minWidth: '300px' });
  wireMenu(a => { if (a === 'site') shell.invoke('menu-action', 'adblock-site'); else shell.invoke('settings-set', { adblock: !settings.adblock }); });
};

// ---- detected-media popup
// One card per detected stream: thumbnail, duration, quality picker and Download. The streams come from the network
// sniffer, so they show up even when the page's video never plays (e.g. an autoplay blocker stopped it).
let mediaTok = 0;
const hms = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60, p = n => String(n).padStart(2, '0'); return h ? `${h}:${p(m)}:${p(x)}` : `${m}:${p(x)}`; };
const qLabel = (v, kind) => v.text ? v.text : 'MP4 · ' + (v.height ? v.height + 'p' : v.bandwidth ? Math.round(v.bandwidth / 1000) + ' kbps' : 'Best') + (v.bandwidth && v.height ? ' · ' + (v.bandwidth / 1e6).toFixed(1) + ' Mbps' : '');
$('#media').onclick = async () => {
  if (!$('#dropdown').hidden) return closeDropdown();
  const list = await shell.invoke('media-list'); const r = $('#media').getBoundingClientRect();
  const pageTitle = ((active() || {}).title || '').replace(/\s+-\s+.*$/, '').trim();
  const row = (m, i) => {
    if (m.kind === 'scanrow') {
      const busy = m.state === 'running';
      const note = busy ? 'Scanning the page with yt-dlp\u2026 this can take a few seconds.' : m.state === 'done' ? (m.error ? esc(m.error) : m.found ? '' : 'yt-dlp found no downloadable video on this page.') : '';
      return `<div class="mscan">${note ? `<div class="mscan-n">${note}</div>` : ''}${busy ? '' : `<a data-act="scan:${i}" data-keep="1">${m.state === 'idle' ? 'Scan this page with yt-dlp' : 'Scan again'}</a>`}</div>`;
    }
    if (m.kind === 'mse') {
      if (m.drm) return `<div class="dlitem"><div class="n">${esc(m.name)}</div><div class="s"><span>Encrypted (DRM) streams can’t be saved.</span></div></div>`;
      const acts = m.capturing ? `<span>Capturing… ${Math.round((m.progress || 0) * 100)}%</span><a data-act="stop:${i}" data-keep="1">Stop</a>` : `<a data-act="cap:${i}">Capture whole video</a><a data-act="save:${i}">Save</a>`;
      return `<div class="dlitem" data-mse="${m.capturing ? 'busy' : '1'}"><div class="n">${esc(m.name)}</div><div class="s"><span>${m.capped ? 'Capture limit reached · ' : ''}${fmt(m.size)} captured</span>${acts}</div></div>`;
    }
    const yt = m.kind === 'youtube' || m.kind === 'scan';
    const stream = m.kind === 'hls' || m.kind === 'dash' || yt;
    const tag = m.kind === 'youtube' ? 'YOUTUBE' : m.kind === 'scan' ? 'YT-DLP' : m.kind === 'hls' ? 'HLS' : m.kind === 'dash' ? 'DASH' : m.kind === 'audio' ? 'AUDIO' : '';
    const ext = stream ? 'mp4' : ((m.name || '').split('.').pop() || (m.mime || '').split('/')[1] || 'mp4').toLowerCase().slice(0, 4);
    const title = yt ? m.name : stream ? (pageTitle || m.name || 'video') + '.mp4' : (m.name || m.url);
    const first = stream ? 'Loading qualities…' : ext.toUpperCase() + (m.size ? ' · ' + fmt(m.size) : '');
    return `<div class="mcard" data-i="${i}">
      <div class="mth">${tag ? `<span class="mtag">${tag}</span>` : ''}<span class="mdur" hidden></span></div>
      <div class="mbody">
        <div class="mname" title="${esc(m.url)}">${esc(title)}</div>
        <div class="mact">
          <button class="mq" data-act="q:${i}" data-keep="1"><span>${esc(first)}</span><i>▾</i></button>
          <button class="mdl" data-act="get:${i}">Download</button>
        </div>
        <div class="mqlist" hidden></div>
        <div class="mmore">${!yt && (m.kind === 'video' || m.kind === 'hls') ? `<a data-act="rs:${i}">Restream</a>` : ''}<a data-act="cp:${i}" data-keep="1">Copy URL</a></div>
      </div></div>`;
  };
  const onlyScan = list.every(m => m.kind === 'scanrow');
  const rows = (onlyScan ? '<div class="pop-p" style="padding:12px 14px">No media detected yet. Open a page with a video — it does not need to play.</div>' : '') + list.map(row).join('');
  const hasMse = list.some(m => m.kind === 'mse' && !m.drm);
  const d = showDropdown(rows + (hasMse ? '<div class="pop-p" data-mse="1">Streaming video is saved from what the page loads. “Capture whole video” plays it muted at high speed to load everything.</div>' : '') + '<div class="sep"></div>' + menuItem('Open page grabber…', '', 'grab'), r.right - 440, r.bottom + 4, { minWidth: '440px' });
  const tok = d.dataset.tok = String(++mediaTok);
  const picked = {};   // index -> chosen variant
  const infos = {};
  const card = i => d.querySelector(`.mcard[data-i="${i}"]`);
  const live = () => !d.hidden && d.dataset.tok === tok;
  // Once the qualities of each stream are known: a stream that only offers "Best" is redundant when another card already
  // lets you pick the quality of that same video (a variant playlist of it, or the same duration) -> hidden.
  // Other single-quality streams (a preview clip, say) are tucked behind one "Show N other stream(s)" link.
  let showMinor = false, toggle = null;
  const tidy = () => {
    const multi = [];
    list.forEach((m, i) => { const v = infos[i] && infos[i].variants; if (v && v.length > 1) multi.push({ i, info: infos[i] }); });
    const minor = [];
    list.forEach((m, i) => {
      const c = card(i), inf = infos[i]; if (!c || !inf) return;
      if (inf.variants && inf.variants.length > 1) { c.hidden = false; return; }
      if (!multi.length) { c.hidden = false; return; }
      const dup = multi.some(x => x.i !== i && ((inf.duration > 0 && Math.abs((x.info.duration || 0) - inf.duration) <= 1.5) || x.info.variants.some(v => v.url && v.url === m.url)));
      if (dup) { c.hidden = true; c.dataset.dup = '1'; return; }
      c.dataset.dup = ''; minor.push(c); c.hidden = !showMinor;
    });
    // the "Streaming video (blob)" capture is only the fallback: tuck it away once a proper download card exists
    // (a quality list, or a YouTube / yt-dlp result). A capture that is already running stays visible.
    const covered = multi.length > 0 || list.some((m, i) => (m.kind === 'youtube' || m.kind === 'scan') && infos[i] && infos[i].variants && infos[i].variants.length);
    d.querySelectorAll('[data-mse="1"]').forEach(e => { e.hidden = covered; });
    if (toggle) { toggle.remove(); toggle = null; }
    if (minor.length && !showMinor) {
      toggle = document.createElement('div'); toggle.className = 'mtoggle';
      toggle.innerHTML = `<a>Show ${minor.length} other stream${minor.length > 1 ? 's' : ''}</a>`;
      toggle.firstChild.onclick = () => { showMinor = true; tidy(); };
      minor[0].before(toggle);
    }
  };
  // fill in quality list + duration, then the thumbnail, for every card in the background
  list.forEach((m, i) => {
    if (m.kind === 'mse' || m.kind === 'scanrow') return;
    shell.invoke('media-info', m).then(info => {
      const c = card(i); if (!live() || !c) return;
      const label = c.querySelector('.mq span'), caret = c.querySelector('.mq i'), streamLike = m.kind === 'hls' || m.kind === 'dash';
      if (info && info.error) { label.textContent = info.error; caret.hidden = true; c.querySelector('.mname').title = info.error; return; }
      if (!info) { if (streamLike) label.textContent = 'MP4 · Best'; return; }
      infos[i] = info;
      const vs = info.variants || [];
      if (vs.length) { picked[i] = vs[0]; label.textContent = qLabel(vs[0], m.kind); } else if (streamLike) label.textContent = 'MP4 · Best';
      if (vs.length < 2) caret.hidden = true;
      const du = c.querySelector('.mdur');
      if (info.live) { du.textContent = '● LIVE'; du.hidden = false; } else if (info.duration > 0) { du.textContent = hms(info.duration); du.hidden = false; }
      tidy();
    }).catch(() => {});
    shell.invoke('media-thumb', m).then(src => {
      const c = card(i); if (!live() || !c || !src) return;
      c.querySelector('.mth').style.backgroundImage = `url("${src}")`;
    }).catch(() => {});
  });
  const reopen = () => { closeDropdown(); $('#media').onclick(); };
  if (list.some(m => m.kind === 'scanrow' && m.state === 'running')) shell.invoke('media-scan').then(() => { if (live()) reopen(); });   // an automatic scan is still running: refresh when it ends
  wireMenu(async (a, el) => {
    if (a === 'grab') return shell.invoke('menu-action', 'grabber');
    const [act, idx] = a.split(':'); const m = list[+idx]; if (!m) return;
    if (act === 'scan') {
      el.parentElement.innerHTML = '<div class="mscan-n">Scanning the page with yt-dlp\u2026 this can take a few seconds.</div>';
      await shell.invoke('media-scan'); if (live()) reopen(); return;
    }
    if (act === 'q') {   // open / close the quality list of this card
      const c = card(idx), box = c.querySelector('.mqlist'), vs = (infos[idx] && infos[idx].variants) || [];
      if (vs.length < 2) return;
      if (!box.hidden) { box.hidden = true; return; }
      box.innerHTML = vs.map((v, k) => `<div class="mqi${picked[idx] === v ? ' on' : ''}" data-act="pick:${idx}:${k}" data-keep="1">${esc(qLabel(v, m.kind))}</div>`).join(''); box.hidden = false; return;
    }
    if (act === 'pick') {
      const k = +a.split(':')[2], v = ((infos[idx] || {}).variants || [])[k]; if (!v) return;
      picked[idx] = v; const c = card(idx); c.querySelector('.mq span').textContent = qLabel(v, m.kind); c.querySelector('.mqlist').hidden = true; return;
    }
    if (act === 'cp') return shell.invoke('copy-text', picked[idx] && m.kind === 'hls' && picked[idx].url ? picked[idx].url : m.url);
    if (act === 'get') {
      const r = await shell.invoke('media-download', { ...m, variant: picked[idx] || null });
      if (r && r.ok === false && r.error) showDropdown(`<div class="pop-h">${svg('warn')} ${esc(r.error)}</div>`, innerWidth - 420, 60, { minWidth: '380px' });
      return;
    }
    if (act === 'rs') return shell.invoke('restream-media', m);
    const r = await shell.invoke('mse-action', act === 'save' ? 'save' : act === 'cap' ? 'capture' : 'stop');
    if (r && r.ok === false && r.error) { showDropdown(`<div class="pop-h">${svg('warn')} ${esc(r.error)}</div>`, innerWidth - 420, 60, { minWidth: '380px' }); }
  });
};

// ---- downloads popup
const fmt = n => n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
function dlPopupHtml() {
  const list = downloads.slice(0, 6);
  const rows = list.map(d => {
    const pct = d.total > 0 ? Math.round(100 * d.received / d.total) : 0;
    const st = d.state === 'progressing' ? `${fmt(d.received)}${d.total > 0 ? ' / ' + fmt(d.total) : ''} · ${fmt(d.speed || 0)}/s` : d.state === 'paused' ? 'Paused' : d.state === 'completed' ? fmt(d.received) : d.state === 'cancelled' ? 'Cancelled' : 'Failed';
    const acts = d.state === 'progressing' ? `${d.live ? `<a data-act="stop:${d.id}" data-keep="1">Stop &amp; save</a>` : ''}<a data-act="pause:${d.id}" data-keep="1">${d.live ? '' : 'Pause'}</a><a data-act="cancel:${d.id}" data-keep="1">Cancel</a>` : d.state === 'paused' || d.state === 'interrupted' ? `<a data-act="resume:${d.id}" data-keep="1">Resume</a><a data-act="cancel:${d.id}" data-keep="1">Cancel</a>` : d.state === 'completed' ? `<a data-act="open:${d.id}">Open</a><a data-act="show:${d.id}">Show</a>` : '';
    return `<div class="dlitem"><div class="n">${esc(d.filename)}</div>${d.state === 'progressing' || d.state === 'paused' ? `<div class="bar"><div style="width:${pct}%"></div></div>` : ''}<div class="s"><span>${st}</span>${acts}</div></div>`;
  }).join('') || '<div class="pop-p" style="padding:12px 14px">No downloads yet.</div>';
  return rows + '<div class="sep"></div>' + menuItem('All downloads', 'Ctrl+J', 'all');
}
let dlPopup = false;
$('#dl').onclick = () => { if (!$('#dropdown').hidden) { dlPopup = false; return closeDropdown(); } dlPopup = true; drawDlPopup(); };
function drawDlPopup() {
  const r = $('#dl').getBoundingClientRect();
  showDropdown(dlPopupHtml(), r.right - 360, r.bottom + 4, { minWidth: '360px' });
  wireMenu(a => { if (a === 'all') return shell.invoke('menu-action', 'downloads'); const [act, id] = a.split(':'); shell.invoke('download-action', id, act); });
}
shell.on('downloads', list => { downloads = list; if (dlPopup && !$('#dropdown').hidden) { const d = $('#dropdown'); d.innerHTML = dlPopupHtml(); } });
shell.on('download-count', n => { dlActive = n; const b = $('#dln'); b.hidden = !n; b.textContent = n; });
new MutationObserver(() => { if ($('#dropdown').hidden) dlPopup = false; }).observe($('#dropdown'), { attributes: true, attributeFilter: ['hidden'] });

// ---- bookmarks bar
function renderBmBar() {
  const bar = $('#bmbar'); bar.innerHTML = '';
  const mk = (cls, inner, onclick, title) => { const b = document.createElement('button'); b.className = 'bm'; b.innerHTML = inner; b.title = title || ''; b.onclick = onclick; bar.appendChild(b); return b; };
  for (const f of bookmarks.folders) {
    mk('', `${svg('folder')}<span>${esc(f.title)}</span>`, e => {
      const items = bookmarks.items.filter(b => b.folder === f.id); const r = e.currentTarget.getBoundingClientRect();
      showDropdown(items.map(b => `<div class="mi" data-act="${esc(b.url)}">${esc(b.title)}</div>`).join('') || '<div class="pop-p" style="padding:10px 14px">Empty folder</div>', r.left, r.bottom + 4, { minWidth: '200px' });
      wireMenu(u => shell.invoke('navigate', S.activeId, u));
    });
  }
  for (const b of bookmarks.items.filter(x => !x.folder)) {
    const letter = (b.title || '?').trim().charAt(0);
    const el = mk('', `<i>${esc(letter)}</i><span>${esc(b.title)}</span>`, () => shell.invoke('navigate', S.activeId, b.url), b.url);
    el.addEventListener('auxclick', e => { if (e.button === 1) shell.invoke('new-tab', b.url); });
  }
}
shell.on('bookmarks', b => { bookmarks = b; renderBmBar(); });
shell.on('settings', s => { settings = s; renderToolbar(); });

// ---- find bar
function openFind() { $('#findbar').hidden = false; $('#findq').focus(); $('#findq').select(); if ($('#findq').value) doFind(true, true); }
function closeFind() { $('#findbar').hidden = true; shell.invoke('find-stop'); }
function doFind(forward, first) { shell.invoke('find', $('#findq').value, forward, $('#findcase').checked, !first); }
$('#findq').addEventListener('input', () => doFind(true, true));
$('#findq').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doFind(!e.shiftKey, false); } });
$('#findnext').onclick = () => doFind(true, false); $('#findprev').onclick = () => doFind(false, false);
$('#findclose').onclick = closeFind; $('#findcase').onchange = () => doFind(true, true);
shell.on('open-find', openFind);
shell.on('find-result', r => { $('#findc').textContent = $('#findq').value ? (r.total ? `${r.active} / ${r.total}` : 'No results') : ''; });

// ---- state
shell.on('state', s => { const prev = S.activeId; S = s; if (prev !== s.activeId) { omniDirty = false; if (!$('#findbar').hidden) { $('#findc').textContent = ''; } } renderTabs(); renderToolbar(); });
shell.invoke('ready').then(r => { S = { tabs: r.tabs, activeId: r.activeId }; settings = r.settings; bookmarks = r.bookmarks; renderTabs(); renderToolbar(); renderBmBar(); shell.invoke('downloads').then(d => downloads = d); });
