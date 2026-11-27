'use strict';
// Best-effort YouTube ad blocking. Network-level filter lists (EasyList etc.) can't remove most
// YouTube ads any more because YouTube now stitches many ads into the same video stream as the
// content itself (server-side ad insertion) — blocking that traffic would just break the video.
// So this works at the page level instead, in two layers:
//   1) Strip the ad-scheduling data out of YouTube's player response before its own code reads it,
//      which stops ads that are scheduled client-side (most pre/mid-rolls) before they start.
//   2) For ads that still play (fully server-stitched into the stream), detect the ad overlay and
//      fast-forward through it as a fallback.
// Layer 1 (installYtAdblockHook) lives in preload-page.js, because a sandboxed preload cannot require() local files. It is installed via contextBridge.executeInMainWorld, the same way the
// MediaSource hook is. YouTube's markup and internal API can change at any time, so this is a
// best-effort measure, not a guarantee — the same is true of any ad blocker's YouTube support.
const YT_HOST_RE = /(^|\.)youtube(-nocookie)?\.com$|(^|\.)youtubekids\.com$/i;

// Cosmetic: hides the ad containers YouTube still renders even when no ad is scheduled in them.
const YT_CSS = `
ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer, ytd-promoted-video-renderer, ytd-compact-promoted-video-renderer,
ytd-compact-promoted-item-renderer, ytd-action-companion-ad-renderer, ytd-companion-slot-renderer, ytd-ad-slot-renderer,
ytd-in-feed-ad-layout-renderer, ytd-banner-promo-renderer, ytd-statement-banner-renderer, ytd-mealbar-promo-renderer,
ytd-brand-video-shelf-renderer, ytd-brand-video-singleton-renderer, ytd-search-pyv-renderer, ytd-primetime-promo-renderer,
ytd-video-masthead-ad-v3-renderer, ytd-player-legacy-desktop-watch-ads-renderer, ytd-ad-inline-playback-meta-block,
#masthead-ad, #player-ads, #panels ytd-ad-slot-renderer, ytd-enforcement-message-view-model,
.ytp-ad-overlay-container, .ytp-ad-overlay-slot, .ytp-ad-image-overlay, .ytp-ad-text-overlay, .ytp-paid-content-overlay,
ytd-rich-item-renderer:has(ytd-ad-slot-renderer), ytd-rich-section-renderer:has(ytd-statement-banner-renderer),
ytd-rich-section-renderer:has(ytd-ad-slot-renderer), ytd-reel-video-renderer:has(ytd-ad-slot-renderer),
ytm-promoted-sparkles-web-renderer, ytm-companion-ad-renderer, ytm-promoted-video-renderer, ytm-ad-slot-renderer { display: none !important; }
`;

module.exports = { YT_HOST_RE, YT_CSS };
