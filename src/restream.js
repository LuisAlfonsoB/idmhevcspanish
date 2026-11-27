'use strict';
// Live restream: play one video into an RTMP server (YouTube, Twitch, OK.ru, ...) with ffmpeg, in real time.
// Ported from the Android app (restream.py). It is the same thing as typing
//
//   ffmpeg -fflags +igndts -re -i SOURCE -c copy -c:a aac -b:v 100000 -ar 44100 -ab 128k -ac 2
//          -flags +global_header -bsf:a aac_adtstoasc -bufsize 3000k -f flv -flvflags no_duration_filesize rtmp://...
//
// (video is always copied untouched; the audio is copied when it already is AAC, see audioCopy()).
// Sources: an http(s) link (direct file or HLS), a local file, or one file of a torrent that is streamed from peers
// while it plays (no waiting for the download to finish).
const fs = require('fs');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const ffmpeg = require('./ffmpeg');

const MAX_STREAMS = 2;
const AUDIO_MODES = ['auto', 'copy', 'aac'];

// ---------- pure helpers (unit-tested in test/restream.test.js) ----------
/** RTMP address + optional stream key -> the full publish URL. */
function buildTarget(url, key) {
  url = (url || '').trim(); key = (key || '').trim().replace(/^\/+|\/+$/g, '');
  const withApp = /^rtmps?:\/\/[^\s/]+\/\S+$/i, hostOnly = /^rtmps?:\/\/[^\s/]+(\/\S*)?$/i;
  if (!withApp.test(url) && !(key && hostOnly.test(url))) throw new Error('The stream address must look like rtmp://server/app (and the key, if you have one, goes in the key field).');
  return key ? url.replace(/\/+$/, '') + '/' + key : url;
}
/** Hide the stream key (the last path segment) wherever the target shows up in a text. */
function mask(text, target) {
  if (!target) return text;
  let u; try { u = new URL(target); } catch (_) { return text; }
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length < 2) return text;
  const secret = segs[segs.length - 1], shown = `${u.protocol}//${u.host}/${segs.slice(0, -1).join('/')}/••••`;
  let out = text.split(target).join(shown);
  if (secret.length >= 4) out = out.split(secret).join('••••');
  return out;
}
/** auto: keep AAC as it is, convert everything else (AC3, DTS, Opus, FLAC, MP3...) to AAC. */
const audioCopy = (mode, codec) => mode === 'copy' || (mode === 'auto' && (codec || '').toLowerCase() === 'aac');

/** Options placed before -i for an http(s) source: user agent, referrer and cookies of the page it came from. */
function httpInputArgs(headers = {}) {
  const a = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
  let ua = '', extra = '';
  for (const [k, v] of Object.entries(headers)) { if (/^user-agent$/i.test(k)) ua = v; else if (v) extra += `${k}: ${String(v).replace(/[\r\n]+/g, ' ')}\r\n`; }
  if (ua) a.push('-user_agent', ua);
  if (extra) a.push('-headers', extra);
  return a;
}
function ffmpegArgs({ src, target, loop = false, keepAudio = false, inputArgs = [] }) {
  const audio = keepAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-ar', '44100', '-ab', '128k', '-ac', '2'];
  return ['-nostdin', '-fflags', '+igndts', '-hide_banner', '-loglevel', 'warning', '-progress', 'pipe:1', '-nostats', '-re',
    ...(loop ? ['-stream_loop', '-1'] : []), ...inputArgs, '-i', src, '-c', 'copy', audio[0], audio[1], '-b:v', '100000', ...audio.slice(2),
    '-flags', '+global_header', '-bsf:a', 'aac_adtstoasc', '-bufsize', '3000k', '-f', 'flv', '-flvflags', 'no_duration_filesize', target];
}
const s_ = (v, d) => (v == null || isNaN(+v) ? d : +v);
const fmtClock = sec => { sec = Math.max(0, Math.floor(sec)); return `${Math.floor(sec / 3600)}:${String(Math.floor(sec % 3600 / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };

// ---------- manager ----------
class RestreamManager {
  /** torrents: TorrentManager (for the torrent source). notify(title, body) shows a desktop notification. */
  constructor({ getSettings, torrents, onChange, notify }) {
    Object.assign(this, { getSettings, torrents, onChange: onChange || (() => {}), notify: notify || (() => {}) });
    this.jobs = new Map(); this.nextId = 1; this.timer = null;
  }
  activeCount() { let n = 0; for (const j of this.jobs.values()) if (j.status === 'starting' || j.status === 'live') n++; return n; }
  list() {
    const now = Date.now();
    return [...this.jobs.values()].sort((a, b) => b.started - a.started).map(j => ({
      id: j.id, name: j.name, kind: j.kind, status: j.status, stage: j.stage, error: j.error, loop: j.loop, target: j.maskedTarget,
      started: j.started, elapsed: Math.floor(((j.ended || now) - j.started) / 1000), pos: j.pos, duration: j.duration,
      speed: j.speed, bitrate: j.bitrate, audioNote: j.audioNote, peers: j.peers, down: j.down
    }));
  }
  changed() { this.onChange(this.list()); }
  _tick() {
    for (const j of this.jobs.values()) {
      if (j.status !== 'live' && j.status !== 'starting') continue;
      const st = j.torrent && j.torrent.stats ? j.torrent.stats() : null;
      if (st) { j.peers = st.peers; j.down = st.down; }
    }
    this.changed();
  }
  _startTimer() { if (!this.timer) this.timer = setInterval(() => { if (!this.activeCount()) { clearInterval(this.timer); this.timer = null; } this._tick(); }, 1000); }

  /**
   * opts: { kind: 'url'|'file'|'torrent', url, referrer, headers, path, key (info-hash), index, keep, rtmpUrl, streamKey, loop, audio, name }
   * Validates and starts; resolves { id } as soon as the job exists. Failures while running show up in the job itself.
   */
  async start(opts) {
    if (!ffmpeg.available()) throw new Error('ffmpeg is not available in this build, so live streaming cannot run.');
    const s = this.getSettings();
    const target = buildTarget(opts.rtmpUrl || s.restreamUrl, opts.streamKey != null ? opts.streamKey : s.restreamKey);
    if (this.activeCount() >= MAX_STREAMS) throw new Error(`${MAX_STREAMS} live streams are already running. Stop one first.`);
    const kind = opts.kind;
    let name = opts.name || '';
    if (kind === 'url') {
      let u; try { u = new URL((opts.url || '').trim()); } catch (_) { throw new Error('The video link must start with http:// or https://'); }
      if (!/^https?:$/.test(u.protocol)) throw new Error('The video link must start with http:// or https://');
      name = name || decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
    } else if (kind === 'file') {
      let st; try { st = fs.statSync(opts.path); } catch (_) { throw new Error('That file does not exist: ' + opts.path); }
      if (!st.isFile()) throw new Error('Choose a video file, not a folder.');
      name = name || require('path').basename(opts.path);
    } else if (kind === 'torrent') {
      if (!opts.key || opts.index == null) throw new Error('Load a torrent and choose the video first.');
    } else throw new Error('Unknown source');
    const job = {
      id: this.nextId++, kind, name: name || 'Video', status: 'starting', stage: 'Opening the video…', error: '', loop: !!opts.loop, started: Date.now(), ended: 0,
      pos: 0, duration: 0, speed: '', bitrate: 0, audioNote: '', peers: 0, down: 0, maskedTarget: mask(target, target), stopping: false, child: null, torrent: null
    };
    this.jobs.set(job.id, job);
    this._startTimer(); this.changed();
    this._run(job, opts, target, AUDIO_MODES.includes(opts.audio) ? opts.audio : (AUDIO_MODES.includes(s.restreamAudio) ? s.restreamAudio : 'copy'))
      .catch(e => this._finish(job, 'failed', mask(String((e && e.message) || e), target).slice(0, 300)));
    return { id: job.id };
  }

  async _run(job, opts, target, audioMode) {
    let src, inputArgs = [], noOutputLimit = 45;
    if (job.kind === 'file') src = opts.path;
    else if (job.kind === 'url') { src = opts.url.trim(); inputArgs = httpInputArgs(opts.headers); }
    else {
      job.stage = 'Connecting to peers…';
      // aria2 downloads the chosen file completely first (progress shown in the job), then ffmpeg reads it from disk
      const st = await this.torrents.openStream(opts.key, +opts.index, {
        keep: !!opts.keep, isCancelled: () => job.stopping,
        onProgress: p => { job.peers = p.peers; job.down = p.down; job.stage = p.state === 'metadata' ? 'Connecting to peers…' : `Downloading the file before streaming: ${Math.floor((p.progress || 0) * 100)}%`; }
      });
      if (!st || job.stopping) { if (st && st.release) await Promise.resolve(st.release()).catch(() => {}); return this._finish(job, 'stopped'); }
      job.torrent = st; src = st.url; job.name = opts.name || st.name || job.name; job.size = st.length; noOutputLimit = 240;
      }
    job.stage = 'Reading the video…';
    const info = await ffmpeg.mediaInfo(src, { inputArgs, timeout: job.kind === 'torrent' ? 90000 : 25000 });
    if (job.stopping) return this._finish(job, 'stopped');
    job.duration = info.duration || 0;
    const keep = audioCopy(audioMode, info.audio);
    job.audioNote = keep ? 'original audio' : 'audio to AAC';
    // Read-ahead: for a link (not looping), one ffmpeg downloads the source as fast as the network allows into a big
    // in-memory buffer, and a second ffmpeg streams from that buffer in real time. This absorbs slow or bursty
    // segment downloads (HLS) that would otherwise make the live stream fall below 1x.
    const bufMB = +s_(this.getSettings().restreamBufferMB, 128);
    const readAhead = job.kind === 'url' && !job.loop && bufMB > 0;
    let args, feeder = null, feederErr = '', feederCode = null;
    if (readAhead) {
      args = ffmpegArgs({ src: 'pipe:0', target, keepAudio: keep, inputArgs: ['-f', 'mpegts'] }).map(x => x);
      args.splice(args.indexOf('-nostdin'), 1);                      // stage 2 reads its input from stdin
      feeder = spawn(ffmpeg.binary(), ['-nostdin', '-hide_banner', '-loglevel', 'warning', ...inputArgs, '-i', src, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-f', 'mpegts', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      job.feeder = feeder;
      feeder.stderr.on('data', d => { feederErr = (feederErr + d.toString()).slice(-2000); });
      feeder.on('error', e => { feederErr = e.message; feederCode = -1; });
      feeder.on('close', c => { feederCode = c; });
    } else args = ffmpegArgs({ src, target, loop: job.loop, keepAudio: keep, inputArgs });
    job.stage = 'Connecting to the stream server…';
    const child = spawn(ffmpeg.binary(), args, { windowsHide: true, stdio: [readAhead ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    job.child = child;
    if (readAhead) {
      const ring = new PassThrough({ highWaterMark: Math.round(bufMB * 1048576) });   // back-pressure keeps the download from running away
      feeder.stdout.pipe(ring).pipe(child.stdin);
      child.stdin.on('error', () => {});
      ring.on('error', () => {});
    }
    let err = '', buf = '';
    child.stderr.on('data', d => { err = (err + d.toString()).slice(-2000); });
    child.stdout.on('data', d => {
      buf += d.toString(); let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        const eq = line.indexOf('='); if (eq < 0) continue;
        const k = line.slice(0, eq), v = line.slice(eq + 1).trim();
        if ((k === 'out_time_us' || k === 'out_time_ms') && /^-?\d+$/.test(v)) job.us = Math.max(0, parseInt(v, 10));
        else if (k === 'bitrate') { const m = /([\d.]+)kbits\/s/.exec(v); job.bitrate = m ? parseFloat(m[1]) * 125 : 0; }
        else if (k === 'speed') job.speed = v;
        else if (k === 'progress') this._progress(job);
      }
    });
    const code = await new Promise(resolve => {
      const guard = setInterval(() => {
        if (!job.us && Date.now() - job.started > noOutputLimit * 1000 && job.status === 'starting') { job.noVideo = true; try { child.kill('SIGKILL'); } catch (_) {} }
      }, 1000);
      child.on('error', e => { clearInterval(guard); err = e.message; resolve(-1); });
      child.on('close', c => { clearInterval(guard); resolve(c); });
    });
    job.child = null;
    if (feeder) { await new Promise(r => { if (feederCode !== null) return r(); const t = setTimeout(r, 3000); feeder.once('close', () => { clearTimeout(t); r(); }); }); try { feeder.kill('SIGKILL'); } catch (_) {} job.feeder = null; }
    if (job.stopping) return this._finish(job, 'stopped');
    if (feeder && feederCode && !job.noVideo) return this._finish(job, 'failed', 'The video source stopped: ' + (mask(feederErr.trim().split('\n').slice(-3).join(' | '), target) || 'exit code ' + feederCode).slice(0, 300));
    if (job.noVideo) return this._finish(job, 'failed', `No video reached the stream server in ${noOutputLimit} s. Check the address and the key.`);
    if (code !== 0) return this._finish(job, 'failed', 'ffmpeg stopped: ' + (mask(err.trim().split('\n').slice(-3).join(' | '), target) || 'exit code ' + code).slice(0, 300));
    this._finish(job, 'ended');
  }
  _progress(job) {
    const pos = (job.us || 0) / 1e6;
    if (pos <= 0) return;
    job.status = 'live'; job.pos = pos;
    const where = job.loop && job.duration ? pos % job.duration : pos;
    job.stage = `Live: ${fmtClock(where)}${job.duration ? ' of ' + fmtClock(job.duration) : ''}${job.speed ? ' • ' + job.speed : ''} • ${job.audioNote}`;
  }
  _finish(job, status, error = '') {
    if (job.ended) return;
    job.ended = Date.now(); job.status = status; job.error = error;
    job.stage = status === 'ended' ? 'The video finished.' : status === 'stopped' ? 'Stopped.' : 'Failed.';
    try { if (job.child) job.child.kill('SIGKILL'); } catch (_) {}
    try { if (job.feeder) job.feeder.kill('SIGKILL'); } catch (_) {}
    if (job.torrent && job.torrent.release) Promise.resolve(job.torrent.release()).catch(() => {});
    job.torrent = null;
    if (status !== 'stopped') this.notify(status === 'ended' ? 'Live stream finished' : 'Live stream failed', error ? `${job.name}: ${error}` : job.name);
    this.changed();
  }
  stop(id) {
    const j = this.jobs.get(+id); if (!j || j.ended) return;
    j.stopping = true; j.stage = 'Stopping…';
    if (j.feeder) { try { j.feeder.kill('SIGKILL'); } catch (_) {} }
    if (j.child) { try { j.child.kill('SIGKILL'); } catch (_) {} } else if (j.status === 'starting' && j.kind !== 'torrent') this._finish(j, 'stopped');
    this.changed();
  }
  remove(id) { const j = this.jobs.get(+id); if (j && j.ended) { this.jobs.delete(j.id); this.changed(); } }
  clearFinished() { for (const [k, j] of [...this.jobs]) if (j.ended) this.jobs.delete(k); this.changed(); }
  stopAll() { for (const j of this.jobs.values()) if (!j.ended) { j.stopping = true; try { if (j.child) j.child.kill('SIGKILL'); if (j.feeder) j.feeder.kill('SIGKILL'); } catch (_) {} } }
}
module.exports = { RestreamManager, buildTarget, mask, audioCopy, ffmpegArgs, httpInputArgs, MAX_STREAMS, AUDIO_MODES };
