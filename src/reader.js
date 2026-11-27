'use strict';
// Script injected into a page to extract the main article (heuristic port of ArticleTextExtractor).
const EXTRACT_SCRIPT = `(function () {
  function textLen(n) { return (n.textContent || '').trim().length; }
  var paras = Array.prototype.slice.call(document.querySelectorAll('p'));
  var scores = new Map();
  paras.forEach(function (p) {
    var t = (p.textContent || '').trim();
    if (t.length < 40) return;
    var s = 1 + Math.min(3, Math.floor(t.length / 100)) + (t.split(',').length - 1);
    var parent = p.parentElement, gp = parent && parent.parentElement;
    if (parent) scores.set(parent, (scores.get(parent) || 0) + s);
    if (gp) scores.set(gp, (scores.get(gp) || 0) + s / 2);
  });
  var best = null, bestScore = 0;
  scores.forEach(function (v, k) {
    var cls = ((k.className || '') + ' ' + (k.id || '')).toLowerCase();
    if (/comment|sidebar|footer|nav|menu|related|advert|promo|share/.test(cls)) v *= 0.3;
    if (/article|content|post|story|entry|main/.test(cls)) v *= 1.4;
    if (v > bestScore) { bestScore = v; best = k; }
  });
  var art = document.querySelector('article');
  if (art && textLen(art) > 400 && (!best || textLen(art) >= textLen(best) * 0.7)) best = art;
  if (!best || bestScore < 3 && !art) return null;
  var out = document.createElement('div');
  var ALLOW = { P:1, H1:1, H2:1, H3:1, H4:1, H5:1, H6:1, UL:1, OL:1, LI:1, BLOCKQUOTE:1, PRE:1, CODE:1, EM:1, STRONG:1, B:1, I:1, A:1, IMG:1, FIGURE:1, FIGCAPTION:1, BR:1, TABLE:1, THEAD:1, TBODY:1, TR:1, TD:1, TH:1 };
  function clean(node, dest) {
    node.childNodes.forEach(function (c) {
      if (c.nodeType === 3) { dest.appendChild(document.createTextNode(c.textContent)); return; }
      if (c.nodeType !== 1) return;
      var tag = c.tagName;
      if (/^(SCRIPT|STYLE|NOSCRIPT|IFRAME|FORM|NAV|ASIDE|FOOTER|BUTTON|INPUT|SVG|VIDEO|AUDIO|OBJECT|EMBED)$/.test(tag)) return;
      var cls = ((c.className && c.className.toString ? c.className.toString() : '') + ' ' + (c.id || '')).toLowerCase();
      if (/comment|share|social|advert|promo|related|newsletter|sidebar|popup|modal/.test(cls)) return;
      if (ALLOW[tag]) {
        var el = document.createElement(tag.toLowerCase());
        if (tag === 'A') { try { var hu = new URL(c.getAttribute('href') || '', location.href); if (/^(https?|mailto):$/.test(hu.protocol)) el.href = hu.href; } catch (e) {} el.target = '_blank'; el.rel = 'noopener noreferrer'; }
        if (tag === 'IMG') { var src = c.currentSrc || c.src || c.getAttribute('data-src'); if (!src) return; try { var su = new URL(src, location.href); if (!/^https?:$/.test(su.protocol)) return; el.src = su.href; } catch (e) { return; } el.alt = c.alt || ''; dest.appendChild(el); return; }
        clean(c, el);
        if (tag === 'P' && !textLen(el) && !el.querySelector('img')) return;
        dest.appendChild(el);
      } else { clean(c, dest); }
    });
  }
  clean(best, out);
  var h1 = document.querySelector('h1');
  var meta = document.querySelector('meta[property="og:title"]');
  return { title: (meta && meta.content) || (h1 && h1.textContent.trim()) || document.title, url: location.href, site: location.hostname, html: out.innerHTML };
})()`;
module.exports = { EXTRACT_SCRIPT };
