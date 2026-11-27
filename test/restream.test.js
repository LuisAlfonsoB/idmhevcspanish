'use strict';
// Run: node test/restream.test.js   (needs ffmpeg on PATH or FFMPEG_PATH for the end-to-end part)
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...a) {            // electron is not needed for these tests
  if (req === 'electron') return { shell: {}, Notification: function () {} };
  if (req === 'ffmpeg-static') { try { return origLoad.call(this, req, ...a); } catch (_) { return require('child_process').execSync(process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg').toString().split(/\r?\n/)[0].trim(); } }
  return origLoad.call(this, req, ...a);
};
const { buildTarget, mask, audioCopy, ffmpegArgs, httpInputArgs, RestreamManager } = require('../src/restream');
const { parseTorrent } = require('../src/bencode');
const ffmpeg = require('../src/ffmpeg');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

(async () => {
  // --- target / key handling
  assert.strictEqual(buildTarget('rtmp://a.example.com/live2', 'abcd-1234'), 'rtmp://a.example.com/live2/abcd-1234');
  assert.strictEqual(buildTarget('rtmp://a.example.com/live2/abcd-1234', ''), 'rtmp://a.example.com/live2/abcd-1234');
  assert.strictEqual(buildTarget('rtmp://a.example.com', 'key'), 'rtmp://a.example.com/key');
  assert.strictEqual(buildTarget('rtmps://a.example.com/app/', '/key/'), 'rtmps://a.example.com/app/key');
  assert.throws(() => buildTarget('http://x/y', ''), /rtmp:\/\//);
  assert.throws(() => buildTarget('rtmp://hostonly', ''), /rtmp:\/\//);
  assert.throws(() => buildTarget('', 'k'), /rtmp:\/\//);
  // --- the key never shows up in messages
  const t = 'rtmp://a.example.com/live2/SECRETKEY99';
  const m = mask('failed to open ' + t + ' (SECRETKEY99)', t);
  assert(!m.includes('SECRETKEY99'), m); assert(m.includes('rtmp://a.example.com/live2/••••'));
  // --- audio decision
  assert(audioCopy('auto', 'aac')); assert(!audioCopy('auto', 'ac3')); assert(!audioCopy('auto', '')); assert(audioCopy('copy', 'dts')); assert(!audioCopy('aac', 'aac'));
  // --- command line is the user's command
  const a = ffmpegArgs({ src: 'in.mp4', target: t, loop: true, keepAudio: false });
  const s = a.join(' ');
  assert(s.includes('-re -stream_loop -1 -i in.mp4 -c copy -c:a aac -b:v 100000 -ar 44100 -ab 128k -ac 2 -flags +global_header -bsf:a aac_adtstoasc -bufsize 3000k -f flv -flvflags no_duration_filesize ' + t), s);
  assert(ffmpegArgs({ src: 'in.mp4', target: t, keepAudio: true }).join(' ').includes('-c copy -c:a copy -b:v 100000 -flags'));
  assert(httpInputArgs({ 'User-Agent': 'UA/1', Referer: 'https://r/', Cookie: 'a=b' }).join('|').includes('-user_agent|UA/1|-headers|Referer: https://r/\r\nCookie: a=b\r\n'));
  console.log('pure helpers ok');

  // --- end to end: a local RTMP "server" (ffmpeg -listen) receives a restream of a generated file
  if (!ffmpeg.available()) { console.log('no ffmpeg, skipping end-to-end'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const src = path.join(tmp, 'in.mp4'), out = path.join(tmp, 'out.flv');
  execFileSync(ffmpeg.binary(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-y', src]);
  const info = await ffmpeg.mediaInfo(src);
  assert(Math.abs(info.duration - 4) < 0.5 && info.audio === 'ac3' && info.video === 'h264', JSON.stringify(info));
  console.log('mediaInfo ok', JSON.stringify(info));

  const server = spawn(ffmpeg.binary(), ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', 'rtmp://127.0.0.1:19350/live/testkey', '-c', 'copy', '-y', out]);
  await new Promise(r => setTimeout(r, 800));
  let updates = 0, notified = null;
  const mgr = new RestreamManager({ getSettings: () => ({ restreamAudio: 'auto' }), torrents: null, onChange: () => updates++, notify: (t, b) => { notified = [t, b]; } });
  const { id } = await mgr.start({ kind: 'file', path: src, rtmpUrl: 'rtmp://127.0.0.1:19350/live', streamKey: 'testkey' });
  await new Promise(r => setTimeout(r, 1800));
  let j = mgr.list()[0];
  assert.strictEqual(j.id, id); assert.strictEqual(j.status, 'live', JSON.stringify(j));
  assert(j.audioNote === 'audio to AAC' && j.duration > 3, JSON.stringify(j));
  assert(!JSON.stringify(j).includes('testkey'), 'key leaked: ' + JSON.stringify(j));
  // only 2 at a time
  await mgr.start({ kind: 'file', path: src, rtmpUrl: 'rtmp://127.0.0.1:19351/live', streamKey: 'k2' });
  await assert.rejects(mgr.start({ kind: 'file', path: src, rtmpUrl: 'rtmp://127.0.0.1:19352/live', streamKey: 'k3' }), /already running/);
  mgr.stop(mgr.list().find(x => x.target.includes('19351')).id);
  // wait for the first stream to finish by itself (-re: real time, 4 s)
  for (let i = 0; i < 40 && mgr.list().find(x => x.id === id).status === 'live'; i++) await new Promise(r => setTimeout(r, 250));
  j = mgr.list().find(x => x.id === id);
  assert.strictEqual(j.status, 'ended', JSON.stringify(j));
  assert(notified && /finished/.test(notified[0]));
  await new Promise(r => setTimeout(r, 500)); server.kill();
  const got = await ffmpeg.mediaInfo(out);
  const codecs = [got.video, got.audio].sort();
  assert.deepStrictEqual(codecs, ['aac', 'h264'], 'received streams: ' + codecs);
  console.log('end-to-end ok: server received', codecs.join(' + '), '| UI updates:', updates);

  // --- read-ahead path: a link source (local http server) goes through the two-stage pipeline
  {
    const http = require('http'), out2 = path.join(tmp, 'out2.flv');
    const web = http.createServer((req, res) => { if (req.url === '/dead.mp4') { res.writeHead(404); return res.end(); } const st = fs.statSync(src); const rg = /bytes=(\d+)-/.exec(req.headers.range || ''); const s0 = rg ? +rg[1] : 0; res.writeHead(rg ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': st.size - s0, ...(rg ? { 'Content-Range': `bytes ${s0}-${st.size - 1}/${st.size}` } : {}) }); fs.createReadStream(src, { start: s0 }).pipe(res); });
    await new Promise(r => web.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + web.address().port;
    const srv2 = spawn(ffmpeg.binary(), ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', 'rtmp://127.0.0.1:19360/live/k', '-c', 'copy', '-y', out2]);
    await new Promise(r => setTimeout(r, 800));
    const m3 = new RestreamManager({ getSettings: () => ({ restreamAudio: 'auto', restreamBufferMB: 16 }), torrents: null, onChange() {}, notify() {} });
    await m3.start({ kind: 'url', url: base + '/in.mp4', rtmpUrl: 'rtmp://127.0.0.1:19360/live', streamKey: 'k' });
    for (let i = 0; i < 60 && !['ended', 'failed'].includes(m3.list()[0].status); i++) await new Promise(r => setTimeout(r, 250));
    const r3 = m3.list()[0];
    assert.strictEqual(r3.status, 'ended', JSON.stringify(r3));
    await new Promise(r => setTimeout(r, 500)); srv2.kill();
    const got2 = await ffmpeg.mediaInfo(out2);
    assert.deepStrictEqual([got2.video, got2.audio].sort(), ['aac', 'h264'], JSON.stringify(got2));
    console.log('read-ahead pipeline ok');
    // source that fails must be reported as failed, not "finished"
    const m4 = new RestreamManager({ getSettings: () => ({ restreamBufferMB: 16 }), torrents: null, onChange() {}, notify() {} });
    await m4.start({ kind: 'url', url: base + '/dead.mp4', rtmpUrl: 'rtmp://127.0.0.1:19361/live', streamKey: 'k' });
    for (let i = 0; i < 60 && !['ended', 'failed'].includes(m4.list()[0].status); i++) await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(m4.list()[0].status, 'failed', JSON.stringify(m4.list()[0]));
    console.log('read-ahead dead source ok:', m4.list()[0].error);
    web.close();
  }

  // --- a dead server fails with a masked message instead of hanging
  const m2 = new RestreamManager({ getSettings: () => ({}), torrents: null, onChange() {}, notify() {} });
  await m2.start({ kind: 'file', path: src, rtmpUrl: 'rtmp://127.0.0.1:19399/live', streamKey: 'topsecret1' });
  for (let i = 0; i < 40 && !m2.list()[0].error && m2.list()[0].status !== 'failed'; i++) await new Promise(r => setTimeout(r, 250));
  const f = m2.list()[0];
  assert.strictEqual(f.status, 'failed'); assert(!JSON.stringify(f).includes('topsecret1'), JSON.stringify(f));
  console.log('failure path ok:', f.error);
  // --- bad inputs
  await assert.rejects(m2.start({ kind: 'url', url: 'ftp://x/y', rtmpUrl: 'rtmp://h/a', streamKey: 'k' }), /http/);
  await assert.rejects(m2.start({ kind: 'file', path: '/nope.mp4', rtmpUrl: 'rtmp://h/a', streamKey: 'k' }), /does not exist/);
  await assert.rejects(m2.start({ kind: 'file', path: src, rtmpUrl: 'http://h/a' }), /rtmp:\/\//);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ALL OK');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
