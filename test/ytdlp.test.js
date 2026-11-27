'use strict';
// Pure-function tests for the yt-dlp wrapper (nothing is spawned, so it runs the same on every OS).
const assert = require('assert');
const y = require('../src/ytdlp');

// which pages get the YouTube card
const yes = ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?t=5', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1', 'https://www.youtube.com/shorts/abcdEFGHijk', 'https://www.youtube.com/live/abcdEFGHijk'];
const no = ['https://www.youtube.com/', 'https://www.youtube.com/results?search_query=x', 'https://www.youtube.com/@channel', 'https://example.com/watch?v=dQw4w9WgXcQ', 'ftp://youtu.be/dQw4w9WgXcQ', 'not a url'];
yes.forEach(u => assert(y.isYoutubeVideoUrl(u), 'should match ' + u));
no.forEach(u => assert(!y.isYoutubeVideoUrl(u), 'should not match ' + u));
assert.strictEqual(y.cleanUrl('https://www.youtube.com/watch?v=abc123DEF45&list=PLx&index=3'), 'https://www.youtube.com/watch?v=abc123DEF45');
assert.strictEqual(y.cleanUrl('https://youtu.be/abc123DEF45?t=9'), 'https://www.youtube.com/watch?v=abc123DEF45');
console.log('urls ok');

// quality labels like YouTube's (portrait Shorts and cropped wide videos included)
assert.strictEqual(y.tierOf(1920, 1080), 1080); assert.strictEqual(y.tierOf(1280, 720), 720); assert.strictEqual(y.tierOf(854, 480), 480);
assert.strictEqual(y.tierOf(1080, 1920), 1080); assert.strictEqual(y.tierOf(1920, 800), 1080); assert.strictEqual(y.tierOf(3840, 2160), 2160);
console.log('tiers ok');

// what the popup shows, from a trimmed-down yt-dlp -J result
const info = { id: 'abc', title: 'Demo', duration: 100, thumbnail: 'https://i.ytimg.com/x.jpg', formats: [
  { format_id: 'sb0', ext: 'mhtml', vcodec: 'none', acodec: 'none', format_note: 'storyboard', width: 160, height: 90 },
  { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', filesize: 1000000 },
  { format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', filesize: 900000 },
  { format_id: '137', ext: 'mp4', vcodec: 'avc1', acodec: 'none', width: 1920, height: 1080, fps: 30, filesize: 50000000 },
  { format_id: '248', ext: 'webm', vcodec: 'vp9', acodec: 'none', width: 1920, height: 1080, fps: 60, filesize: 40000000 },
  { format_id: '136', ext: 'mp4', vcodec: 'avc1', acodec: 'none', width: 1280, height: 720, fps: 30, tbr: 2000 },
  { format_id: '313', ext: 'webm', vcodec: 'vp9', acodec: 'none', width: 7680, height: 4320, fps: 30, filesize: 9e9 }
] };
const s = y.summarize(info);
assert.strictEqual(s.title, 'Demo'); assert.strictEqual(s.duration, 100);
assert.deepStrictEqual(s.choices.map(c => c.id), ['1080', '720', 'm4a', 'mp3'], '8K is skipped, storyboards are ignored');
assert.strictEqual(s.choices[0].size, 50000000 + 1000000, 'biggest 1080p stream + best audio');
assert.strictEqual(s.choices[0].label, '1080p60', 'the fps shows when above 30');
assert.strictEqual(s.choices[1].size, Math.round(2000 * 1000 / 8 * 100) + 1000000, 'size estimated from the bitrate when unknown');
console.log('summary ok');

// scanning an arbitrary page: one video, a playlist of several, muxed formats, and a plain link with no resolution
const one = y.summarizeAny({ id: 'v1', title: 'Clip', duration: 30, webpage_url: 'https://site.test/clip', formats: [
  { vcodec: 'avc1', acodec: 'mp4a', width: 1280, height: 720, filesize: 8000000 }, { vcodec: 'avc1', acodec: 'mp4a', width: 640, height: 360, filesize: 3000000 }] });
assert.strictEqual(one.length, 1); assert.deepStrictEqual(one[0].choices.map(c => c.id), ['720', '360', 'm4a', 'mp3']);
assert.strictEqual(one[0].choices[0].size, 8000000, 'sound already inside: nothing added');
assert.strictEqual(one[0].url, 'https://site.test/clip');
const many = y.summarizeAny({ _type: 'playlist', entries: [null, { id: 'a', title: 'A', formats: [{ vcodec: 'avc1', acodec: 'none', width: 1920, height: 1080 }] }, { id: 'b', title: 'Only audio', formats: [{ vcodec: 'none', acodec: 'mp4a' }] }, { id: 'c', title: 'C', formats: [{ ext: 'mp4', vcodec: 'h264', acodec: 'aac' }] }] });
assert.deepStrictEqual(many.map(m => m.title), ['A', 'C'], 'empty and audio-only entries are dropped');
assert.strictEqual(many[1].choices[0].id, 'best', 'no resolution known: offered as Best quality');
console.log('scan summary ok');

// yt-dlp arguments
const v = y.formatArgs({ kind: 'video', height: 1080 });
assert(v.includes('-S') && v[v.indexOf('-S') + 1].startsWith('res:1080,'), 'resolution cap'); assert(v.includes('--merge-output-format') && v.includes('mp4'));
assert(y.formatArgs({ kind: 'video', height: 2160 })[1].includes('av01'), 'no AV1 at 4K');
assert(y.formatArgs({ kind: 'audio', id: 'mp3' }).includes('mp3'));
console.log('args ok');

// progress lines
assert.deepStrictEqual(y.parseProgress('[1dm] 1048576 NA 2097152 524288.5'), { done: 1048576, total: 2097152, speed: 524288.5 });
assert.deepStrictEqual(y.parseProgress('[1dm] 10 100 NA NA'), { done: 10, total: 100, speed: 0 });
assert.strictEqual(y.parseProgress('[download] 50%'), null);
console.log('progress ok');

// messages and names
assert(/signed-in/i.test(y.friendlyError('ERROR: [youtube] abc: Sign in to confirm you are not a bot')));
assert(/unavailable/i.test(y.friendlyError('ERROR: [youtube] abc: Video unavailable')));
assert.strictEqual(y.safeName('a/b:c*?"<>|d.'), 'a_b_c______d');
// a literal "%" in a title must not be read as yt-dlp output-template syntax
{
  const os = require('os'), fs = require('fs'), path = require('path'), cp = require('child_process');
  const orig = cp.spawn; let seen = null;
  cp.spawn = (bin, args, o) => { seen = args; return orig.call(cp, process.execPath, ['-e', ''], o); };
  process.env.YTDLP_PATH = process.execPath; delete require.cache[require.resolve('../src/ytdlp')];
  const y2 = require('../src/ytdlp');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ytt-'));
  y2.download('https://youtu.be/abc123DEF45', tmp, { title: '100% real', choice: { kind: 'video', height: 720 }, playlistItem: 2 }).promise.catch(() => {}).then(() => {
    cp.spawn = orig; fs.rmSync(tmp, { recursive: true, force: true });
    const o = seen[seen.indexOf('-o') + 1];
    assert(o.includes('100%% real 720p.%(ext)s'), 'percent escaped in the template: ' + o);
    assert.strictEqual(seen[seen.indexOf('--playlist-items') + 1], '2');
    console.log('template escaping ok');
    console.log('ALL OK');
  });
}
