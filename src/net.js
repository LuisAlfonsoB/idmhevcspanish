'use strict';
// Low-level HTTP helpers shared by the accelerated downloader, HLS downloader and grabber.
const http = require('http');
const https = require('https');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseContentDisposition(h) {
  if (!h) return '';
  let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(h);
  if (m) { try { return decodeURIComponent(m[2].trim().replace(/^"|"$/g, '')); } catch (_) {} }
  m = /filename\s*=\s*"?([^";]+)"?/i.exec(h);
  return m ? m[1].trim() : '';
}

/**
 * Open a request, following redirects. Resolves { res, url } with the final IncomingMessage.
 * opts: headersFor(url) -> Promise<object>, range ('bytes=a-b'), signal (AbortSignal), method, timeout
 */
async function open(url, opts = {}, hops = 0) {
  if (hops > 10) throw new Error('Too many redirects');
  if (opts.signal && opts.signal.aborted) throw new Error('aborted');
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const headers = Object.assign({ 'Accept': '*/*', 'Accept-Encoding': 'identity' }, opts.headersFor ? await opts.headersFor(url) : {});
  if (opts.range) headers['Range'] = opts.range;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method: opts.method || 'GET', headers, timeout: opts.timeout || 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch (e) { return reject(e); }
        return open(next, opts, hops + 1).then(resolve, reject);
      }
      resolve({ res, url });
    });
    const onAbort = () => req.destroy(new Error('aborted'));
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
    req.on('timeout', () => req.destroy(new Error('Connection timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function readAll(res, limit = 64 * 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of res) { n += c.length; if (n > limit) { res.destroy(); throw new Error('Response too large'); } chunks.push(c); }
  return Buffer.concat(chunks);
}

async function getBuffer(url, opts = {}) {
  const { res } = await open(url, opts);
  if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); throw new Error('HTTP ' + res.statusCode); }
  return readAll(res, opts.limit);
}

/** Ask the server about a URL: size, range support, filename. */
async function probe(url, opts = {}) {
  const { res, url: finalUrl } = await open(url, Object.assign({}, opts, { range: 'bytes=0-0' }));
  try {
    let size = 0, ranges = false;
    if (res.statusCode === 206) {
      const m = /\/(\d+)\s*$/.exec(res.headers['content-range'] || '');
      if (m) { size = +m[1]; ranges = size > 0; }
    } else if (res.statusCode === 200) {
      size = +res.headers['content-length'] || 0;
    } else throw new Error('HTTP ' + res.statusCode);
    return {
      size, ranges, finalUrl,
      mime: (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),
      filename: parseContentDisposition(res.headers['content-disposition']),
      etag: res.headers['etag'] || '', lastModified: res.headers['last-modified'] || ''
    };
  } finally { res.destroy(); }
}

module.exports = { open, readAll, getBuffer, probe, sleep, parseContentDisposition };
