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
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = n => n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : (n || 0) + ' B';
const letter = s => esc((s || '?').trim().charAt(0));
function modal(title, fields, ok = 'Save') {
  return new Promise(resolve => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<form class="modal"><h3>${esc(title)}</h3>${fields.map((f, i) => f.type === 'select'
      ? `<label>${esc(f.label)}</label><select name="f${i}">${f.options.map(o => `<option value="${esc(o.value)}"${o.value === f.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
      : f.type === 'message' ? `<p>${esc(f.label)}</p>` : `<label>${esc(f.label)}</label><input type="text" name="f${i}" value="${esc(f.value || '')}">`).join('')}
      <div class="btns"><button type="button" data-c>Cancel</button><button class="primary" type="submit">${esc(ok)}</button></div></form>`;
    document.body.appendChild(bg);
    const form = bg.querySelector('form'); const first = form.querySelector('input,select'); if (first) { first.focus(); if (first.select) first.select(); }
    const done = v => { bg.remove(); resolve(v); };
    form.onsubmit = e => { e.preventDefault(); done(fields.map((f, i) => (form.elements['f' + i] || {}).value)); };
    form.querySelector('[data-c]').onclick = () => done(null);
    bg.addEventListener('mousedown', e => { if (e.target === bg) done(null); });
    bg.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); });
  });
}
const confirmModal = (msg, ok = 'OK') => modal('Confirm', [{ type: 'message', label: msg }], ok).then(v => v !== null);
