'use strict';
const DEFAULT_SETTINGS = {
  language: 'auto',            // auto (follow the system language) | en | es
  searchEngine: 'google',
  searchSuggestions: true,
  homepage: 'onedm://home',
  restoreTabs: true,
  theme: 'system',            // system | light | dark
  showBookmarksBar: true,
  adblock: true,
  filterLists: [
    'https://easylist.to/easylist/easylist.txt',
    'https://easylist.to/easylist/easyprivacy.txt'
  ],
  adblockWhitelist: [],
  doNotTrack: true,
  blockThirdPartyCookies: false,
  httpsOnly: false,
  askDownloadLocation: false,
  hlsToMp4: true,             // remux HLS .ts downloads into .mp4 (needs bundled ffmpeg)
  ytDownloader: true,         // YouTube download card in the media popup (needs yt-dlp, see ytdlp.js)
  ytAutoScan: true,           // scan with yt-dlp when a page has a video player but nothing was sniffed
  ytUseCookies: false,        // hand the browser's YouTube login to yt-dlp (age-restricted / members-only videos)
  ytdlpUpdated: 0,            // time of the last yt-dlp update check
  autoplayBlock: true,        // stop videos/audio from starting by themselves (see preload-page.js)
  autoplayAllowed: [],        // hosts where autoplay is allowed
  ytAdblock: true,            // best-effort YouTube ad blocking (see youtube-adblock.js)
  mseCapture: true,           // capture blob:/MediaSource videos so they can be saved
  mseCapMB: 4096,             // max temp disk use per tab for captured video
  accelerated: true,          // multi-connection downloads
  connections: 8,             // 1-16 parallel connections per file
  accelMinMB: 2,              // only accelerate files at least this big
  torrentSeed: false,         // keep seeding after a torrent finishes
  torrentDht: true,
  torrentMaxPeers: 80,
  torrentDownKB: 0,           // 0 = unlimited
  torrentUpKB: 0,
  torrentTimeout: 600,        // seconds without progress before a torrent is abandoned
  torrentSeedRatio: 0,        // stop seeding at this upload ratio (0 = no goal)
  torrentSeedMinutes: 0,      // ...or after this many minutes (0 = no goal; with both 0, seeding lasts until you stop it)
  restreamUrl: '',            // default RTMP address for live restreaming
  restreamKey: '',            // default stream key (kept in settings.json, masked in the app)
  restreamBufferMB: 128,      // read-ahead buffer for link sources (0 = off): smooths slow/bursty downloads
  restreamAudio: 'copy',      // copy (original audio) | auto (keep AAC, convert the rest) | aac
  downloadDir: '',
  userAgent: '',              // custom UA override ('' = default Chrome UA)
  proxyMode: 'system',        // system | direct | custom
  proxyRules: '',
  clearOnExit: { history: false, cookies: false, cache: false }
};
module.exports = { DEFAULT_SETTINGS };
