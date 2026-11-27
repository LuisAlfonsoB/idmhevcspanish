'use strict';
// YouTube downloads through yt-dlp (the same engine the Android Aurex browser uses). YouTube hands out signed,
// throttled, separate video and audio streams, so a plain "grab the URL" downloader cannot save it: yt-dlp does the
// extraction and ffmpeg (bundled via ffmpeg-static) merges the picture and the sound into one MP4.
//
// Where the binary comes from (first hit wins):
//   $YTDLP_PATH, <resources>/bin/yt-dlp(.exe) (packaged build), <project>/bin/yt-dlp(.exe) (running from source), PATH.
//   `npm run get-ytdlp` downloads yt-dlp.exe into ./bin (the GitHub workflow does this before building).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpeg = require('./ffmpeg');

const EXE = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
let cached, userDir = '';
/** A folder (userData) holding a newer yt-dlp downloaded at run time; it wins over the copy bundled with the app. */
function setUserDir(d) { userDir = d || ''; cached = undefined; }
function binary() {
  if (cached !== undefined) return cached;
  cached = null;
  const cands = [];
  if (userDir) cands.push(path.join(userDir, EXE));
  if (process.env.YTDLP_PATH) cands.push(process.env.YTDLP_PATH);
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'bin', EXE));
  cands.push(path.join(__dirname, '..', 'bin', EXE));
  cands.push(path.join(path.dirname(process.execPath), EXE), path.join(path.dirname(process.execPath), 'bin', EXE));
  for (const d of (process.env.PATH || '').split(path.delimiter)) if (d) cands.push(path.join(d, EXE));
  for (const c of cands) { try { if (fs.statSync(c).isFile()) { cached = c; break; } } catch (_) {} }
  return cached;
}
const available = () => !!binary();

// ---------- URLs ----------
const YT_HOST = /^(?:[a-z0-9-]+\.)*(?:youtube\.com|youtube-nocookie\.com)$/i;
/** True for a page that is one YouTube video (watch page, Short, live, embed, youtu.be link) - not the home page or a search. */
function isYoutubeVideoUrl(u) {
  let x; try { x = new URL(u); } catch (_) { return false; }
  if (!/^https?:$/.test(x.protocol)) return false;
  const h = x.hostname.toLowerCase();
  if (h === 'youtu.be') return /^\/[\w-]{6,}/.test(x.pathname);
  if (!YT_HOST.test(h)) return false;
  if (x.pathname === '/watch') return /^[\w-]{6,}$/.test(x.searchParams.get('v') || '');
  return /^\/(shorts|live|embed|v)\/[\w-]{6,}/.test(x.pathname);
}
/** The URL handed to yt-dlp: the single video, never the playlist the page happens to be inside. */
function cleanUrl(u) {
  try {
    const x = new URL(u); const h = x.hostname.toLowerCase();
    if (h === 'youtu.be') return 'https://www.youtube.com/watch?v=' + x.pathname.slice(1).split('/')[0];
    if (YT_HOST.test(h) && x.pathname === '/watch') return 'https://www.youtube.com/watch?v=' + x.searchParams.get('v');
  } catch (_) {}
  return u;
}

// ---------- JavaScript runtime (YouTube needs one to solve its "n" challenge; the official yt-dlp.exe already bundles the solver script) ----------
// yt-dlp only enables deno by default. If deno is on PATH it is used as is. Otherwise this app's own Electron binary is offered
// as the "node" runtime: with ELECTRON_RUN_AS_NODE=1 it behaves exactly like node (needs node 20+, Electron 45 ships newer).
let denoCached;
function hasDeno() {
  if (denoCached !== undefined) return denoCached;
  denoCached = false;
  const exe = process.platform === 'win32' ? 'deno.exe' : 'deno';
  for (const d of (process.env.PATH || '').split(path.delimiter)) { try { if (d && fs.statSync(path.join(d, exe)).isFile()) { denoCached = true; break; } } catch (_) {} }
  return denoCached;
}
function runtimeArgs() {
  if (process.env.YTDLP_NO_RUNTIME) return [];
  if (hasDeno()) return [];
  return ['--js-runtimes', 'node:' + process.execPath];
}
function childEnv() { return Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8' }); }

// ---------- running ----------
function run(args, { signal, onLine, timeout = 0, bin: binOverride } = {}) {
  const bin = binOverride || binary();
  let child, killed = false, timer = null;
  const promise = new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('yt-dlp was not found. Put yt-dlp.exe in the "bin" folder next to the app (run: npm run get-ytdlp), or set YTDLP_PATH.'));
    child = spawn(bin, args, { windowsHide: true, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', buf = '';
    const feed = d => { buf += d.toString('utf8'); let i; while ((i = buf.search(/\r?\n/)) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + (buf[i] === '\r' ? 2 : 1)); if (onLine) { try { onLine(line); } catch (_) {} } } };
    child.stdout.on('data', d => { if (onLine) feed(d); else if (out.length < 64 * 1024 * 1024) out += d.toString('utf8'); });
    child.stderr.on('data', d => { err = (err + d.toString('utf8')).slice(-6000); if (onLine) feed(d); });
    child.on('error', e => reject(e));
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (killed) return reject(new Error('cancelled'));
      code === 0 ? resolve(out) : reject(new Error(friendlyError(err) || 'yt-dlp exited with code ' + code));
    });
    if (timeout) timer = setTimeout(() => { killed = false; try { child.kill(); } catch (_) {} reject(new Error('yt-dlp took too long to answer')); }, timeout);
    if (signal) signal.addEventListener('abort', () => { killed = true; try { child.kill(); } catch (_) {} }, { once: true });
  });
  return { promise, kill() { killed = true; try { child && child.kill(); } catch (_) {} } };
}

/** Short, readable version of yt-dlp's stderr. */
function friendlyError(raw) {
  const text = String(raw || '');
  const last = text.split(/\r?\n/).map(s => s.trim()).filter(s => /^ERROR:/i.test(s)).pop() || text.trim().split(/\r?\n/).pop() || '';
  const msg = last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/i, '').replace(/^[\w-]{11}:\s*/, '');
  if (/Sign in to confirm|not a bot|--cookies|use cookies|login required/i.test(msg)) return 'YouTube wants a signed-in session for this video. Turn on "Use my YouTube login for downloads" in Settings and try again. (' + msg.slice(0, 120) + ')';
  if (/Unsupported URL|No video formats found|no video could be found/i.test(text)) return 'yt-dlp found no downloadable video on this page.';
  if (/Video unavailable|Private video|has been removed|not available/i.test(msg)) return 'This video is unavailable (private, removed or blocked in your country).';
  if (/HTTP Error 403|n challenge|JS runtime|JavaScript runtime/i.test(text)) return 'YouTube refused the download (HTTP 403 or a failed challenge). Update yt-dlp (restart the app) and try again.';
  return msg.slice(0, 300) || 'Download failed';
}

// ---------- cookies (opt-in): the browser's own YouTube / Google cookies, written as a Netscape cookie file ----------
async function writeCookieFile(session, file, pageUrl) {
  const cookies = [];
  for (const domain of ['youtube.com', 'google.com']) { try { cookies.push(...await session.cookies.get({ domain })); } catch (_) {} }
  if (pageUrl) { try { cookies.push(...await session.cookies.get({ url: pageUrl })); } catch (_) {} }   // a page scan: the login of that site only
  const seen = new Set(), lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const k = c.domain + '|' + c.path + '|' + c.name; if (seen.has(k)) continue; seen.add(k);
    const dom = c.domain || '';
    lines.push([c.httpOnly ? '#HttpOnly_' + dom : dom, dom.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', Math.round(c.expirationDate || 0), c.name, c.value].join('\t'));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return file;
}

// ---------- looking a video up ----------
const TIERS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];
/** The quality label YouTube would use ("1080p"): portrait Shorts and cropped wide videos are matched by their long side as 16:9. */
function tierOf(w, h) {
  if (!w || !h) return h || 0;
  const eq = Math.max(w, h) * 9 / 16;
  for (const t of TIERS) if (eq <= t * 1.03) return t;
  return Math.round(eq);
}
const MAX_HEIGHT = 2160;   // 8K is never offered: most machines cannot play it and it is enormous
function fmtSize(f, dur) {
  const n = +f.filesize || +f.filesize_approx || 0;
  if (n) return n;
  const tbr = +f.tbr || 0; return tbr && dur ? Math.round(tbr * 1000 / 8 * dur) : 0;
}
/**
 * Turns yt-dlp's JSON into what the popup shows: { title, duration, thumbnail, live, choices[] }.
 * Choices are one per picture height (best size known for it, plus the audio track it needs), then MP3 / M4A.
 */
function summarize(info) {
  const dur = +info.duration || 0;
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const heights = new Map(); let bestAudio = 0, sawVideo = false;
  for (const f of formats) {
    if (!f || f.ext === 'mhtml' || /storyboard/i.test(f.format_note || '')) continue;
    const hasV = f.vcodec !== 'none' && !!(f.vcodec || f.height || (f.video_ext && f.video_ext !== 'none'));
    const hasA = f.acodec !== 'none' && !!(f.acodec || (f.audio_ext && f.audio_ext !== 'none'));
    if (!hasV && hasA) { bestAudio = Math.max(bestAudio, fmtSize(f, dur)); continue; }
    if (!hasV) continue;
    sawVideo = true;
    const tier = tierOf(+f.width || 0, +f.height || 0);
    if (!tier || tier > MAX_HEIGHT) continue;
    const cur = heights.get(tier) || { height: tier, size: 0, fps: 0, hdr: false, muxed: false };
    cur.size = Math.max(cur.size, fmtSize(f, dur));
    if (hasA) cur.muxed = true;   // picture and sound already in one file: no separate audio to add
    cur.fps = Math.max(cur.fps, +f.fps || 0);
    if (f.dynamic_range && f.dynamic_range !== 'SDR') cur.hdr = true;
    heights.set(tier, cur);
  }
  const choices = [...heights.values()].sort((a, b) => b.height - a.height).map(c => ({
    id: String(c.height), kind: 'video', height: c.height, fps: c.fps, hdr: c.hdr,
    label: c.height + 'p' + (c.fps > 30 ? c.fps : ''), size: c.size ? c.size + (c.muxed ? 0 : bestAudio) : 0
  }));
  // a site that gives no resolution at all (a plain video link): still offer the video, as "Best"
  if (!choices.length && sawVideo) choices.push({ id: 'best', kind: 'video', height: 0, fps: 0, hdr: false, label: 'Best quality', size: 0 });
  choices.push({ id: 'm4a', kind: 'audio', label: 'M4A audio', size: bestAudio, ext: 'm4a' });
  choices.push({ id: 'mp3', kind: 'audio', label: 'MP3 audio', size: bestAudio, ext: 'mp3' });
  return { id: info.id || '', title: info.title || 'video', duration: dur, thumbnail: info.thumbnail || '', live: !!info.is_live, url: info.webpage_url || info.original_url || '', choices };
}
/** A yt-dlp result for any page: one video, or a playlist of the videos found on it. Entries without a downloadable video are dropped. */
function summarizeAny(json) {
  const items = json && json._type === 'playlist' && Array.isArray(json.entries) ? json.entries.filter(Boolean) : [json];
  return items.map(summarize).filter(s => s.choices.some(c => c.kind === 'video'));
}
async function lookup(url, { cookies = '', signal } = {}) {
  const args = ['--ignore-config', '--no-playlist', '--no-warnings', '--skip-download', '-J', '--socket-timeout', '20', '--extractor-retries', '2', ...runtimeArgs()];
  if (cookies) args.push('--cookies', cookies);
  args.push(cleanUrl(url));
  const out = await run(args, { signal, timeout: 90000 }).promise;
  return summarize(JSON.parse(out));
}

/** Asks yt-dlp what video(s) a page holds. Takes a few seconds (it reads the page like a browser would, then the player data). */
async function scan(url, { cookies = '', signal, referer = '' } = {}) {
  const args = ['--ignore-config', '--no-playlist', '--playlist-items', '1-8', '--no-warnings', '--skip-download', '-J', '--socket-timeout', '20', '--extractor-retries', '1', ...runtimeArgs()];
  if (cookies) args.push('--cookies', cookies);
  if (referer) args.push('--referer', referer);
  args.push(url);
  return summarizeAny(JSON.parse(await run(args, { signal, timeout: 120000 }).promise));
}

// ---------- downloading ----------
/** yt-dlp arguments for one choice (see summarize). SDR H.264/AAC is preferred: it plays everywhere. */
function formatArgs(choice) {
  if (choice && choice.kind === 'audio') {
    return choice.id === 'mp3' ? ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'] : ['-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a'];
  }
  const h = choice && +choice.height > 0 ? +choice.height : 0;
  const base = h >= 2160 || !h ? 'bv*[vcodec!^=av01]+ba/bv*+ba/b' : 'bv*+ba/b';   // most PCs cannot decode AV1 at 4K
  return ['-f', base, '-S', (h ? 'res:' + h + ',' : '') + 'vcodec:h264,acodec:m4a,+hdr', '--merge-output-format', 'mp4'];
}
/** Parses one "[1dm] done total estimate speed" progress line. Missing values (yt-dlp prints NA) become 0. */
function parseProgress(line) {
  const m = /^\[1dm\]\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(line); if (!m) return null;
  const n = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
  return { done: n(m[1]), total: n(m[2]) || n(m[3]), speed: n(m[4]) };
}
const MEDIA_EXT = ['mp4', 'mkv', 'webm', 'mp3', 'm4a', 'opus', 'mov'];
function safeName(s) { return String(s || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').replace(/[. ]+$/, '').slice(0, 100).trim() || 'video'; }
function uniqueBase(dir, base) {
  const exists = b => MEDIA_EXT.some(e => fs.existsSync(path.join(dir, b + '.' + e)));
  if (!exists(base)) return base;
  for (let i = 2; i < 1000; i++) if (!exists(base + ' (' + i + ')')) return base + ' (' + i + ')';
  return base + ' ' + Date.now();
}
/**
 * Downloads `url` into `dir`. opts: { choice, title, expectedBytes, cookies, onProgress({received,total,speed}), signal }.
 * Resolves { path }. Progress is cumulative over the video and the audio stream (they are fetched one after the other).
 */
function download(url, dir, opts = {}) {
  const choice = opts.choice || { kind: 'video', height: 0 };
  fs.mkdirSync(dir, { recursive: true });
  const suffix = choice.kind === 'video' && choice.height ? ' ' + choice.height + 'p' : '';
  const base = uniqueBase(dir, safeName(opts.title) + suffix);
  const args = ['--ignore-config', '--no-playlist', '--no-mtime', '--no-warnings', '--newline', '--no-colors',
    '--progress-template', 'download:[1dm] %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s',
    '--concurrent-fragments', '8', '--http-chunk-size', '10M', '--retries', '5', '--fragment-retries', '10', '--socket-timeout', '20',
    ...runtimeArgs(), ...formatArgs(choice), '-o', path.join(dir, base.replace(/%/g, '%%') + '.%(ext)s')];
  const ff = ffmpeg.binary(); if (ff) args.push('--ffmpeg-location', ff);
  if (opts.cookies) args.push('--cookies', opts.cookies);
  if (opts.referer) args.push('--referer', opts.referer);
  if (opts.playlistItem > 0) args.push('--playlist-items', String(opts.playlistItem));
  args.push(cleanUrl(url));
  let carried = 0, last = 0;
  const job = run(args, {
    signal: opts.signal,
    onLine: line => {
      const p = parseProgress(line); if (!p || !opts.onProgress) return;
      if (p.done < last - 1024) carried += last;   // a new stream (the audio after the video) started counting from zero
      last = p.done;
      const total = opts.expectedBytes && opts.expectedBytes > carried + p.done ? opts.expectedBytes : (p.total ? carried + p.total : 0);
      opts.onProgress({ received: carried + p.done, total, speed: p.speed });
    }
  });
  const promise = job.promise.then(() => {
    const hit = MEDIA_EXT.map(e => path.join(dir, base + '.' + e)).filter(f => { try { return fs.statSync(f).size > 0; } catch (_) { return false; } })
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!hit) throw new Error('yt-dlp finished but the file was not found in ' + dir);
    return { path: hit };
  });
  return { promise, kill: job.kill };
}

/** Installed yt-dlp version ('' when unavailable) - shown in Settings. */
async function version() { try { return (await run(['--version'], { timeout: 15000 }).promise).trim(); } catch (_) { return ''; } }
/**
 * Keeps a current yt-dlp in `dir` (YouTube changes often and an old yt-dlp stops working within weeks). Windows only: the
 * packaged app is a portable exe, so the bundled copy cannot update itself; this one lives in the user-data folder.
 * fetchBuf(url) -> Promise<Buffer>. Resolves { ok, status }.
 */
async function installLatest(dir, fetchBuf) {
  if (process.platform !== 'win32') return { ok: false, status: 'unsupported' };
  try {
    const rel = JSON.parse((await fetchBuf('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest')).toString('utf8'));
    const tag = String(rel.tag_name || '').trim();
    if (!tag) throw new Error('no release tag');
    const have = await version();
    if (have && have === tag) return { ok: true, status: 'Up to date (' + have + ')' };
    fs.mkdirSync(dir, { recursive: true });
    const buf = await fetchBuf('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe');
    if (buf.length < 5 * 1024 * 1024) throw new Error('download too small');
    const tmp = path.join(dir, 'yt-dlp.new.exe'), dest = path.join(dir, EXE);
    fs.writeFileSync(tmp, buf);
    const v = (await run(['--version'], { bin: tmp, timeout: 30000 }).promise).trim();   // a broken download must never replace a working copy
    if (!v) throw new Error('downloaded file does not run');
    fs.renameSync(tmp, dest);
    setUserDir(dir);
    return { ok: true, status: 'Updated to ' + v };
  } catch (e) { try { fs.rmSync(path.join(dir, 'yt-dlp.new.exe'), { force: true }); } catch (_) {} return { ok: false, status: 'Update failed: ' + e.message }; }
}

module.exports = { scan, summarizeAny, tierOf, binary, available, isYoutubeVideoUrl, cleanUrl, lookup, summarize, download, formatArgs, parseProgress, writeCookieFile, version, installLatest, setUserDir, friendlyError, safeName, runtimeArgs };
