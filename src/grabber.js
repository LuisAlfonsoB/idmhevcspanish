'use strict';
// Injected into a page to collect downloadable resources (port of the Android "grabber" screen).
const GRAB_SCRIPT = `(function () {
  var abs = function (u) { try { return new URL(u, location.href).href; } catch (e) { return null; } };
  var out = { pageTitle: document.title, videos: [], images: [], links: [] };
  var seen = {};
  var add = function (list, o) { if (o.url && !seen[list + o.url]) { seen[list + o.url] = 1; (out[list]).push(o); } };
  document.querySelectorAll('video, audio').forEach(function (v) {
    var srcs = [v.currentSrc, v.src].concat([].slice.call(v.querySelectorAll('source')).map(function (s) { return s.src; }));
    srcs.forEach(function (s) { var a = s && abs(s); if (a && /^https?:/.test(a)) add('videos', { url: a, kind: /\\.m3u8(\\?|#|$)/i.test(a) ? 'hls' : /\\.mpd(\\?|#|$)/i.test(a) ? 'dash' : (v.tagName === 'AUDIO' ? 'audio' : 'video'), poster: v.poster ? abs(v.poster) : '' }); });
  });
  document.querySelectorAll('video').forEach(function (v) { if (/^blob:/.test(v.currentSrc || v.src || '')) out.blob = true; });
  // hls.js/dash.js-based players never put the manifest URL in the DOM (the <video> plays a blob: URL),
  // so also scan the page's own script text for the manifest URL as a string literal.
  try {
    var html = document.documentElement.outerHTML.replace(/\\\\\\//g, '/');
    var re = /(?:https?:)?\\/\\/[^\\s"'<>\\\\]+?\\.(m3u8|mpd)(?:[^\\s"'<>\\\\]*)/gi, m;
    while ((m = re.exec(html))) {
      var u = m[0]; if (u.indexOf('//') === 0) u = 'https:' + u;
      var a2 = abs(u);
      if (a2) add('videos', { url: a2, kind: m[1].toLowerCase() === 'mpd' ? 'dash' : 'hls', poster: '', source: 'page-source' });
    }
  } catch (e) {}

  document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:audio"]').forEach(function (m) { var a = abs(m.content); if (a && /^https?:/.test(a)) add('videos', { url: a, kind: /\\.m3u8/i.test(a) ? 'hls' : 'video', poster: '' }); });
  [].slice.call(document.images).forEach(function (im) {
    var a = abs(im.currentSrc || im.src);
    if (a && /^https?:/.test(a) && (im.naturalWidth >= 48 || im.naturalHeight >= 48)) add('images', { url: a, kind: 'image', w: im.naturalWidth, h: im.naturalHeight });
  });
  var FILE = /\\.(zip|rar|7z|tar|gz|bz2|xz|iso|img|dmg|exe|msi|apk|deb|rpm|pdf|epub|mobi|docx?|xlsx?|pptx?|csv|txt|mp3|m4a|flac|wav|ogg|mp4|mkv|avi|mov|webm|flv|wmv|torrent|jar|bin)(\\?|#|$)/i;
  document.querySelectorAll('a[href]').forEach(function (a) {
    var h = a.getAttribute('href') || '';
    if (/^magnet:/i.test(h)) return add('links', { url: h, kind: 'magnet', name: (a.textContent || '').trim().slice(0, 120) });
    var u = abs(h);
    if (u && /^https?:/.test(u) && FILE.test(u.split('#')[0])) add('links', { url: u, kind: /\\.torrent(\\?|#|$)/i.test(u) ? 'torrent' : 'file', name: (a.textContent || a.download || '').trim().slice(0, 120) });
  });
  return out;
})()`;
module.exports = { GRAB_SCRIPT };
