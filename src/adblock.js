'use strict';
// Lightweight Adblock-Plus-syntax request filter (subset): ||domain^, |url, substrings with * and ^,
// @@ exceptions, $third-party / $script / $image / $stylesheet / $domain= options. Element hiding is ignored.
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPE_MAP = { script: 'script', image: 'image', stylesheet: 'stylesheet', mainFrame: 'document', subFrame: 'subdocument', xhr: 'xmlhttprequest', media: 'media', font: 'font', ping: 'ping', cspReport: 'ping', webSocket: 'websocket', object: 'object', other: 'other' };

function fetchText(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 1DMBrowser' }, timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function patternToRegex(p) {
  let s = p.replace(/[.+?${}()|[\]\\]/g, '\\$&');
  s = s.replace(/\*/g, '.*').replace(/\^/g, '(?:[^\\w\\-.%]|$)');
  if (s.startsWith('\\|\\|')) s = '^[a-z][a-z0-9+.-]*://([^/?#]*\\.)?' + s.slice(4);
  else if (s.startsWith('\\|')) s = '^' + s.slice(2);
  if (s.endsWith('\\|')) s = s.slice(0, -2) + '$';
  try { return new RegExp(s, 'i'); } catch (_) { return null; }
}

class AdBlocker {
  constructor(dir) {
    this.dir = dir;
    this.enabled = true;
    this.whitelist = new Set();
    this.reset();
    this.blockedCount = 0;
    this.listeners = [];
  }
  reset() {
    this.domainRules = new Map();   // host -> [{opts}]
    this.tokRules = new Map();      // token -> [{re, o}]
    this.genRules = [];             // rules without a usable token
    this.exceptDomain = new Map();
    this.exTokRules = new Map();
    this.exGenRules = [];
    this.count = 0;
  }
  parseOpts(str) {
    const o = { types: null, notTypes: null, third: null, domains: null, skip: false };
    if (!str) return o;
    const TYPES = ['script', 'image', 'stylesheet', 'subdocument', 'xmlhttprequest', 'media', 'font', 'ping', 'websocket', 'object', 'document', 'other'];
    for (const part of str.split(',')) {
      const neg = part.startsWith('~');
      const k = (neg ? part.slice(1) : part).toLowerCase();
      if (k === 'third-party' || k === '3p') o.third = !neg;
      else if (k === 'first-party' || k === '1p') o.third = neg;
      else if (k.startsWith('domain=')) {
        o.domains = { inc: [], exc: [] };
        for (const d of k.slice(7).split('|')) (d.startsWith('~') ? o.domains.exc : o.domains.inc).push(d.replace(/^~/, ''));
      } else if (TYPES.includes(k)) { if (neg) (o.notTypes = o.notTypes || []).push(k); else (o.types = o.types || []).push(k); }
      else if (k === 'xhr') (o.types = o.types || []).push('xmlhttprequest');
      else if (k === 'important' || k === 'match-case' || k === 'all') { /* accepted, no effect */ }
      else o.skip = true; // popup, csp, redirect, removeparam, badfilter, elemhide, generichide, ...
    }
    return o;
  }
  pickToken(p) {
    let best = '', m; const re = /[a-z0-9]+/gi;
    while ((m = re.exec(p))) {
      const t = m[0]; if (t.length < 4) continue;
      const before = p[m.index - 1], after = p[m.index + t.length];
      if (before === undefined || before === '*' || after === undefined || after === '*') continue;
      if (t.length > best.length) best = t.toLowerCase();
    }
    return best;
  }
  index(rule, pattern, exception) {
    const tok = pattern ? this.pickToken(pattern) : '';
    const map = exception ? this.exTokRules : this.tokRules, gen = exception ? this.exGenRules : this.genRules;
    if (tok) { if (!map.has(tok)) map.set(tok, []); map.get(tok).push(rule); } else gen.push(rule);
  }
  addText(text) {
    for (let line of text.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line[0] === '!' || line[0] === '[' || line.includes('##') || line.includes('#@#') || line.includes('#?#') || line.includes('#$#')) continue;
      let exception = false;
      if (line.startsWith('@@')) { exception = true; line = line.slice(2); }
      let opts = '';
      const di = line.lastIndexOf('$');
      if (di > 0 && !/\/.*\$.*\//.test(line.slice(di))) { opts = line.slice(di + 1); line = line.slice(0, di); }
      const o = this.parseOpts(opts);
      if (o.skip || !line) continue;
      if (line.startsWith('/') && line.endsWith('/') && line.length > 2) {
        let re; try { re = new RegExp(line.slice(1, -1), 'i'); } catch (_) { continue; }
        this.index({ re, o }, '', exception);
        this.count++; continue;
      }
      const m = /^\|\|([a-z0-9.-]+)(?:\^|\/?)$/i.exec(line.replace(/\^\*?$/, '^'));
      if (m && /^\|\|[a-z0-9.-]+\^?$/i.test(line)) {
        const map = exception ? this.exceptDomain : this.domainRules;
        const h = m[1].toLowerCase();
        if (!map.has(h)) map.set(h, []);
        map.get(h).push(o);
        this.count++; continue;
      }
      if (line.length < 4 && !line.startsWith('||')) continue;
      const re = patternToRegex(line);
      if (!re) continue;
      this.index({ re, o }, line, exception);
      this.count++;
    }
  }
  optsMatch(o, ctx) {
    if (o.third !== null && o.third !== ctx.third) return false;
    if (o.types && !o.types.includes(ctx.type)) return false;
    if (o.notTypes && o.notTypes.includes(ctx.type)) return false;
    if (o.domains) {
      const h = ctx.pageHost || '';
      const on = d => h === d || h.endsWith('.' + d);
      if (o.domains.exc.some(on)) return false;
      if (o.domains.inc.length && !o.domains.inc.some(on)) return false;
    }
    return true;
  }
  hostMatch(map, host, ctx) {
    let h = host;
    while (h) {
      const list = map.get(h);
      if (list && list.some(o => this.optsMatch(o, ctx))) return true;
      const i = h.indexOf('.');
      if (i < 0) break;
      h = h.slice(i + 1);
    }
    return false;
  }
  shouldBlock(url, resourceType, referrer) {
    if (!this.enabled) return false;
    let u;
    try { u = new URL(url); } catch (_) { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return false;
    let pageHost = '';
    try { pageHost = referrer ? new URL(referrer).hostname.toLowerCase() : ''; } catch (_) {}
    if (pageHost && [...this.whitelist].some(w => pageHost === w || pageHost.endsWith('.' + w))) return false;
    const host = u.hostname.toLowerCase();
    const base = h => h.split('.').slice(-2).join('.');
    const ctx = { type: TYPE_MAP[resourceType] || 'other', third: !!pageHost && base(pageHost) !== base(host), pageHost };
    if (resourceType === 'mainFrame') return false; // never block top-level navigation
    const lower = url.toLowerCase();
    const toks = new Set(lower.match(/[a-z0-9]{4,}/g) || []);
    const indexed = (map, gen) => {
      for (const t of toks) { const l = map.get(t); if (l) for (const r of l) if (this.optsMatch(r.o, ctx) && r.re.test(url)) return true; }
      for (const r of gen) if (this.optsMatch(r.o, ctx) && r.re.test(url)) return true;
      return false;
    };
    const hit = this.hostMatch(this.domainRules, host, ctx) || indexed(this.tokRules, this.genRules);
    if (!hit) return false;
    if (this.hostMatch(this.exceptDomain, host, ctx) || indexed(this.exTokRules, this.exGenRules)) return false;
    this.blockedCount++;
    return true;
  }
  loadBuiltin(assetsDir) {
    const p = path.join(assetsDir, 'adblocker', 'builtin.txt');
    try { this.addText(fs.readFileSync(p, 'utf8')); } catch (_) {}
  }
  cachePath(url) { return path.join(this.dir, 'filter-' + Buffer.from(url).toString('base64url').slice(0, 40) + '.txt'); }
  async loadLists(urls, forceUpdate) {
    this.reset();
    this.loadBuiltin(path.join(__dirname, '..', 'assets'));
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) {}
    for (const url of urls) {
      const cp = this.cachePath(url);
      let text = null;
      try {
        const st = fs.statSync(cp);
        if (!forceUpdate && Date.now() - st.mtimeMs < 3 * 24 * 3600 * 1000) text = fs.readFileSync(cp, 'utf8');
      } catch (_) {}
      if (text === null) {
        try { text = await fetchText(url); fs.writeFileSync(cp, text); }
        catch (e) { try { text = fs.readFileSync(cp, 'utf8'); } catch (_) { console.warn('adblock list failed', url, e.message); } }
      }
      if (text) this.addText(text);
    }
    return this.count;
  }
}
module.exports = { AdBlocker, fetchText };
