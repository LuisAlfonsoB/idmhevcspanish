'use strict';
// Translates this page's text into the interface language chosen in Settings (see src/i18n.js).
// The dictionary arrives synchronously from the preload (shell.i18n / onedm.i18n / authApi.i18n); English = no-op.
// The same file lives in ui/ and pages/shared/ (pages get it prepended to shared.js) - keep both copies identical.
(function () {
  const api = window.shell || window.onedm || window.authApi || {};
  const data = api.i18n;
  if (!data || !data.dict) return;
  const D = { dict: data.dict, pats: (data.pats || []).map(([s, t]) => [new RegExp(s), t]) };
  try { document.documentElement.lang = data.lang; } catch (_) {}

  function one(c) {
    if (Object.prototype.hasOwnProperty.call(D.dict, c)) return D.dict[c];
    for (const [re, tpl] of D.pats) if (re.test(c)) return c.replace(re, tpl);
    if (c.startsWith('✓ ')) { const r = one(c.slice(2)); if (r !== c.slice(2)) return '✓ ' + r; }
    if (c.indexOf(' · ') > 0) {
      const parts = c.split(' · '); let changed = false;
      const out = parts.map(p => { const r = one(p); if (r !== p) changed = true; return r; });
      if (changed) return out.join(' · ');
    }
    return c;
  }
  function tr(s) {
    if (typeof s !== 'string' || !s) return s;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    if (!m[2]) return s;
    const r = one(m[2]);
    return r === m[2] ? s : m[1] + r + m[3];
  }

  // user content (page titles, file names, bookmark names, URLs...) must never be translated
  const SKIP_TAG = /^(SCRIPT|STYLE|TEXTAREA|CODE|PRE|NOSCRIPT)$/;
  const SKIP_SELF = '[translate="no"], .ttl, .mname, .n, .u, .sug .t, .t > h3, .tile .n';
  const SKIP_TREE = '[translate="no"], .t > b, .tab, .bm';
  const skipped = el => el.matches(SKIP_SELF) || !!el.closest(SKIP_TREE);
  const ATTRS = ['title', 'placeholder', 'aria-label'];

  function text(n) {
    const p = n.parentNode;
    if (!p || p.nodeType !== 1 || SKIP_TAG.test(p.tagName) || skipped(p)) return;
    const v = n.nodeValue, r = tr(v);
    if (r !== v) n.nodeValue = r;
  }
  function attr(el, name) {
    if (!el.hasAttribute || !el.hasAttribute(name) || skipped(el)) return;
    const v = el.getAttribute(name), r = tr(v);
    if (r !== v) el.setAttribute(name, r);
  }
  function walk(node) {
    if (node.nodeType === 3) return text(node);
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    if (node.nodeType === 1) { if (SKIP_TAG.test(node.tagName)) return; for (const a of ATTRS) attr(node, a); }
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
  }

  walk(document);
  new MutationObserver(recs => {
    for (const r of recs) {
      if (r.type === 'childList') r.addedNodes.forEach(walk);
      else if (r.type === 'characterData') text(r.target);
      else if (r.type === 'attributes') attr(r.target, r.attributeName);
    }
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  document.addEventListener('DOMContentLoaded', () => walk(document));
})();
