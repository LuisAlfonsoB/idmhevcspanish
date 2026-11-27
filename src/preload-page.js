'use strict';
// Runs in every tab (and iframe). Exposes the internal API on onedm:// pages, and installs two
// main-world hooks on real pages: one so blob: (MediaSource) videos can be captured (see mse.js),
// and one that does best-effort YouTube ad blocking (see youtube-adblock.js).
//
// contextBridge.executeInMainWorld is the correct, CSP-immune way to do this, but it only exists
// from Electron 35 onward. As a safety net in case that API is ever unavailable (an older Electron,
// or some future regression), there's a fallback that injects a <script> tag directly — this is the
// classic pre-executeInMainWorld technique, and still works because contextIsolation only isolates
// JS object identity, not the shared DOM: a <script> tag appended to the page's own document always
// runs in the page's own ("main") world. Its one limitation is that a strict page CSP blocking inline
// scripts could stop it; executeInMainWorld has no such limitation, which is why it's used whenever
// it's available.
const { contextBridge, ipcRenderer } = require('electron');
// NOTE: this preload runs sandboxed, where require() only knows 'electron' (and a few built-ins), NOT local files.
// A require('./something') here throws, the whole preload dies and the `onedm` bridge below is never exposed,
// which makes every onedm:// page (Torrents, Live restream, Downloads...) silently do nothing. Keep this file self-contained.

/** Serialized and run in the page's own JS context. Must be self-contained: no outer closures. */
function installYtAdblockHook() {
  try {
    if (window.__1dmYtHooked) return;
    if (!/(^|\.)youtube(-nocookie)?\.com$|(^|\.)youtubekids\.com$/i.test(location.hostname)) return;
    Object.defineProperty(window, '__1dmYtHooked', { value: true });

    // ---- layer 1: remove the ad data before YouTube's own code reads it ----
    // keys that schedule ads inside a player / watch response
    var AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams', 'adBreakParams', 'playerLegacyDesktopWatchAdsRenderer'];
    // renderers that ARE an ad (or promo) when they show up as an item of a feed / shelf / result list
    var AD_ITEMS = {};
    ['adSlotRenderer', 'promotedSparklesWebRenderer', 'promotedVideoRenderer', 'compactPromotedVideoRenderer', 'compactPromotedItemRenderer',
      'bannerPromoRenderer', 'displayAdRenderer', 'inFeedAdLayoutRenderer', 'adBreakServiceRenderer', 'actionCompanionAdRenderer',
      'companionSlotRenderer', 'statementBannerRenderer', 'brandVideoShelfRenderer', 'brandVideoSingletonRenderer', 'searchPyvRenderer',
      'videoMastheadAdV3Renderer', 'primetimePromoRenderer', 'adSlotAndLayoutRenderer', 'inPlayerAdLayoutRenderer'].forEach(function (k) { AD_ITEMS[k] = 1; });

    function strip(obj) {            // the player-response level
      if (!obj || typeof obj !== 'object') return false;
      var changed = false;
      for (var i = 0; i < AD_KEYS.length; i++) { if (AD_KEYS[i] in obj) { try { delete obj[AD_KEYS[i]]; changed = true; } catch (e) {} } }
      return changed;
    }
    function isAdItem(x, d) {        // an ad directly, or wrapped one or two levels down (richItemRenderer.content.adSlotRenderer)
      if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
      for (var k in x) {
        if (AD_ITEMS[k]) return true;
        if (d < 2 && x[k] && typeof x[k] === 'object' && !Array.isArray(x[k]) && isAdItem(x[k], d + 1)) return true;
      }
      return false;
    }
    function deep(o, d) {            // prune ad items out of every list in a browse / next / search / shorts response
      if (!o || typeof o !== 'object' || d > 18) return false;
      var changed = false;
      if (Array.isArray(o)) {
        for (var i = o.length - 1; i >= 0; i--) { if (isAdItem(o[i], 0)) { o.splice(i, 1); changed = true; } else if (deep(o[i], d + 1)) changed = true; }
      } else {
        if (strip(o)) changed = true;
        for (var k in o) { var v = o[k]; if (v && typeof v === 'object' && deep(v, d + 1)) changed = true; }
      }
      return changed;
    }
    function clean(o) { var a = deep(o, 0); return a; }

    // 1a) the inline `var ytInitialPlayerResponse = {...}` / `ytInitialData` the page assigns on load
    ['ytInitialPlayerResponse', 'ytInitialReelWatchSequenceResponse', 'ytInitialData'].forEach(function (name) {
      var cur;
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          get: function () { return cur; },
          set: function (v) { clean(v); cur = v; }
        });
      } catch (e) {}
    });

    // 1b) SPA navigations fetch their data instead of reloading the page
    var URL_RE = /\/youtubei\/v1\/(player|next|get_watch|browse|search|reel\/[a-z_]+)(\?|$)/;
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        return origFetch.apply(this, arguments).then(function (res) {
          if (!URL_RE.test(url) || !res || !res.ok) return res;
          return res.clone().json().then(function (data) {
            if (!clean(data)) return res;
            return new Response(JSON.stringify(data), { status: res.status, statusText: res.statusText, headers: res.headers });
          }).catch(function () { return res; });
        });
      };
    }
    var open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) { this.__1dmAdUrl = URL_RE.test(String(url)); return open.apply(this, arguments); };
    var rtDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
    if (rtDesc && rtDesc.get) {
      try {
        Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
          configurable: true,
          get: function () {
            var t = rtDesc.get.call(this);
            if (!this.__1dmAdUrl || !t) return t;
            try { var data = JSON.parse(t); if (clean(data)) return JSON.stringify(data); } catch (e) {}
            return t;
          }
        });
      } catch (e) {}
    }
    // 1c) any other path that parses player JSON (embedded players, inline responses): cheap top-level strip only
    var origParse = JSON.parse;
    JSON.parse = function () {
      var x = origParse.apply(this, arguments);
      try { if (x && typeof x === 'object') { strip(x); if (x.playerResponse) strip(x.playerResponse); } } catch (e) {}
      return x;
    };

    // ---- layer 2: ads that are part of the video stream itself (server-side inserted) ----
    var adNow = false, mute0 = false, rate0 = 1;
    var SKIP = '.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-container button, .ytp-ad-overlay-close-button';
    function tick() {
      var p = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
      if (p) {
        var v = p.querySelector('video.html5-main-video') || p.querySelector('video');
        var ad = p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting');
        var btns = p.querySelectorAll(SKIP);
        for (var i = 0; i < btns.length; i++) { try { btns[i].click(); } catch (e) {} }
        if (ad && v) {
          if (!adNow) { adNow = true; mute0 = v.muted; rate0 = v.playbackRate; }
          v.muted = true;
          try { v.playbackRate = 16; } catch (e) {}
          try { if (isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration - 0.1) v.currentTime = v.duration; } catch (e) {}
        } else if (adNow) {
          adNow = false;
          if (v) { v.muted = mute0; v.playbackRate = rate0 > 0 && rate0 <= 4 ? rate0 : 1; }
        }
      }
      // "Ad blockers violate YouTube's Terms of Service" wall: remove it and carry on playing
      var nag = document.querySelector('ytd-enforcement-message-view-model');
      if (nag) {
        var dlg = nag.closest('tp-yt-paper-dialog') || nag;
        try { dlg.remove(); } catch (e) {}
        var bd = document.querySelectorAll('tp-yt-iron-overlay-backdrop'); for (var j = 0; j < bd.length; j++) { try { bd[j].remove(); } catch (e) {} }
        try { document.documentElement.style.overflow = ''; document.body.style.overflow = ''; } catch (e) {}
        var mv = document.querySelector('video.html5-main-video');
        if (mv && mv.paused && !mv.ended && navigator.userActivation && navigator.userActivation.hasBeenActive) { try { mv.play(); } catch (e) {} }
      }
      // Shorts: an ad is its own swipe-up card - move on to the next Short
      if (location.pathname.indexOf('/shorts') === 0) {
        var sad = document.querySelector('ytd-reel-video-renderer[is-active] ytd-ad-slot-renderer, ytd-reel-video-renderer[is-active] ytd-in-feed-ad-layout-renderer');
        if (sad) { var dn = document.querySelector('#navigation-button-down button'); if (dn) { try { dn.click(); } catch (e) {} } }
      }
    }
    setInterval(tick, 250);
  } catch (e) {}
}


/** Serialized and run in the page's own JS context (the only place where patching play() affects the page's scripts).
 *  Blocks media from starting until the user has interacted with the page. Self-contained: no outer closures. */
function installAutoplayHook() {
  try {
    if (window.__1dmApHooked) return;
    Object.defineProperty(window, '__1dmApHooked', { value: true });
    var touched = false;
    var mark = function (e) { if (e.isTrusted) touched = true; };
    ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click'].forEach(function (n) { window.addEventListener(n, mark, { capture: true, passive: true }); });
    // window.__1dmAllowPlay is set briefly by the browser's own "Capture whole video" feature
    var allowed = function () { return touched || window.__1dmAllowPlay === true || !!(navigator.userActivation && navigator.userActivation.hasBeenActive); };

    var realPlay = HTMLMediaElement.prototype.play;
    var wrapped = function () {
      if (allowed()) return realPlay.apply(this, arguments);
      try { this.autoplay = false; } catch (e) {}
      return Promise.reject(new DOMException('play() was blocked: the page has not been interacted with yet', 'NotAllowedError'));
    };
    try { Object.defineProperty(wrapped, 'name', { value: 'play' }); } catch (e) {}
    HTMLMediaElement.prototype.play = wrapped;

    // media with the autoplay attribute starts without anyone calling play(): pause whatever starts anyway
    ['play', 'playing', 'loadeddata', 'canplay'].forEach(function (n) {
      document.addEventListener(n, function (e) {
        var el = e.target;
        if (!allowed() && el instanceof HTMLMediaElement && !el.paused) { try { el.pause(); } catch (x) {} }
      }, true);
    });

    var PARAMS = ['autoplay', 'auto_play', 'autostart', 'autostarts', 'autostartup'];
    var cleanFrame = function (f) {
      try {
        var src = f.getAttribute('src'); if (!src) return;
        var u = new URL(src, location.href), changed = false;
        Array.from(u.searchParams.keys()).forEach(function (k) { if (PARAMS.indexOf(k.toLowerCase()) >= 0) { u.searchParams.delete(k); changed = true; } });
        if (changed) f.setAttribute('src', u.href);
      } catch (e) {}
    };
    var strip = function (el) {
      if (!el || el.nodeType !== 1 || allowed()) return;
      var n = el.localName;
      if (n === 'video' || n === 'audio') { try { el.autoplay = false; el.removeAttribute('autoplay'); } catch (e) {} }
      else if (n === 'iframe') cleanFrame(el);
      if (el.querySelectorAll) { var l = el.querySelectorAll('video,audio,iframe'); for (var i = 0; i < l.length; i++) strip(l[i]); }
    };
    var start = function () {
      var obs = new MutationObserver(function (muts) {
        if (allowed()) { obs.disconnect(); return; }   // after the first real interaction nothing needs stripping any more
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === 'attributes') strip(m.target);
          else for (var j = 0; j < m.addedNodes.length; j++) strip(m.addedNodes[j]);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['autoplay'] });
      strip(document.documentElement);
    };
    if (document.documentElement) start();
    else new MutationObserver(function (_, o) { if (document.documentElement) { o.disconnect(); start(); } }).observe(document, { childList: true });
  } catch (e) {}
}

function injectScript(code) {
  try {
    const s = document.createElement('script');
    s.textContent = code;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch (_) {}
}

/** Self-contained: bridges its one callback out via a DOM CustomEvent instead of a proxied function. */
function installMseHookFallback() {
  try {
    if (!window.MediaSource || !window.SourceBuffer || window.__1dmHooked) return;
    Object.defineProperty(window, '__1dmHooked', { value: true });
    var send = function (meta, bytes) { try { window.dispatchEvent(new CustomEvent('__1dmMse', { detail: { meta: meta, bytes: bytes } })); } catch (e) {} };
    var ids = new WeakMap(), mimes = new WeakMap(), next = 1;
    var addSB = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      var sb = addSB.apply(this, arguments);
      try { var id = next++; ids.set(sb, id); mimes.set(sb, String(mime)); send({ type: 'open', id: id, mime: String(mime) }); } catch (e) {}
      return sb;
    };
    var append = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
      try {
        var id = ids.get(this);
        if (id) {
          var u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          send({ type: 'chunk', id: id, mime: mimes.get(this) }, u8.slice());
        }
      } catch (e) {}
      return append.apply(this, arguments);
    };
    window.addEventListener('encrypted', function () { try { send({ type: 'drm' }); } catch (e) {} }, true);
  } catch (e) {}
}

if (location.protocol === 'onedm:') {
  const EVENTS = ['downloads-update', 'bookmarks-changed', 'settings-changed', 'torrents-update', 'restream-update'];
  contextBridge.exposeInMainWorld('onedm', {
    i18n: (() => { try { return ipcRenderer.sendSync('i18n'); } catch (_) { return null; } })(),
    invoke: (ch, ...args) => ipcRenderer.invoke('page:' + ch, ...args),
    on: (ch, cb) => { if (EVENTS.includes(ch)) ipcRenderer.on(ch, (e, ...a) => cb(...a)); }
  });
} else if (/^(https?|file):$/.test(location.protocol)) {
  const hasNative = typeof contextBridge.executeInMainWorld === 'function';

  // YouTube ad block: entirely self-contained, no callback needed, so the fallback is just as capable.
  if (hasNative) {
    try { contextBridge.executeInMainWorld({ func: installYtAdblockHook, args: [] }); } catch (_) { injectScript('(' + installYtAdblockHook.toString() + ')();'); }
  } else {
    injectScript('(' + installYtAdblockHook.toString() + ')();');
  }

  // Autoplay blocker: whether it applies to this page (setting + per-site allow list) is decided by the main process.
  let ap = null;
  try { ap = ipcRenderer.sendSync('autoplay-state'); } catch (_) {}
  if (ap && ap.block && /^https?:$/.test(location.protocol)) {
    if (hasNative) {
      try { contextBridge.executeInMainWorld({ func: installAutoplayHook, args: [] }); } catch (_) { injectScript('(' + installAutoplayHook.toString() + ')();'); }
    } else {
      injectScript('(' + installAutoplayHook.toString() + ')();');
    }
  }

  // MediaSource capture: needs a callback into this (isolated) world for every chunk.
  if (hasNative) {
    try {
      contextBridge.executeInMainWorld({
        func: function installMseHook(send) {
          try {
            if (!window.MediaSource || !window.SourceBuffer || window.__1dmHooked) return;
            Object.defineProperty(window, '__1dmHooked', { value: true });
            var ids = new WeakMap(), mimes = new WeakMap(), next = 1;
            var addSB = MediaSource.prototype.addSourceBuffer;
            MediaSource.prototype.addSourceBuffer = function (mime) {
              var sb = addSB.apply(this, arguments);
              try { var id = next++; ids.set(sb, id); mimes.set(sb, String(mime)); send({ type: 'open', id: id, mime: String(mime) }); } catch (e) {}
              return sb;
            };
            var append = SourceBuffer.prototype.appendBuffer;
            SourceBuffer.prototype.appendBuffer = function (data) {
              try {
                var id = ids.get(this);
                if (id) {
                  var u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                  send({ type: 'chunk', id: id, mime: mimes.get(this) }, u8.slice());
                }
              } catch (e) {}
              return append.apply(this, arguments);
            };
            window.addEventListener('encrypted', function () { try { send({ type: 'drm' }); } catch (e) {} }, true);
          } catch (e) {}
        },
        args: [function (meta, bytes) { try { ipcRenderer.send('mse', meta, bytes); } catch (_) {} }]
      });
    } catch (_) {
      injectScript('(' + installMseHookFallback.toString() + ')();');
      window.addEventListener('__1dmMse', e => { try { ipcRenderer.send('mse', e.detail.meta, e.detail.bytes); } catch (_) {} });
    }
  } else {
    injectScript('(' + installMseHookFallback.toString() + ')();');
    window.addEventListener('__1dmMse', e => { try { ipcRenderer.send('mse', e.detail.meta, e.detail.bytes); } catch (_) {} });
  }
}
