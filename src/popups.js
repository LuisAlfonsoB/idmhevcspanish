'use strict';
// Which window.open() calls must become a REAL popup window instead of a new tab.
//
// "Sign in with Google / Apple / Microsoft / GitHub ..." opens a small popup and, when you approve, that popup hands the result
// back to the page that opened it (window.opener.postMessage) and closes itself. A new TAB has no link to the opener any more, so
// the popup just sits there (e.g. on accounts.google.com/gsi/transform) and you never get signed in. A real child window keeps
// the link. Everything else (links with target=_blank, ordinary new pages) still opens as a tab.

// sign-in providers whose popups always need their opener
const AUTH_HOSTS = /^(accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|login\.windows\.net|id\.twitch\.tv|auth\.atlassian\.com|api\.twitter\.com|id\.atlassian\.com|login\.salesforce\.com|github\.com\/login\/oauth)/i;
// generic OAuth-looking paths on any site
const AUTH_PATH = /\/(oauth2?|authorize|signin\/oauth|gsi|openid|saml|sso)(\/|\?|$)/i;

function parseFeatures(features) {
  const out = {};
  for (const part of String(features || '').split(',')) {
    const [k, v] = part.split('=').map(s => s.trim().toLowerCase());
    if (k && v && /^(width|height|left|top)$/.test(k) && /^\d+$/.test(v)) out[k] = +v;
  }
  return out;
}

/**
 * True when this window.open should open as a real popup window.
 * disposition 'new-window' means the page asked for a window with a size/features (a popup); a plain window.open(url) or a
 * target=_blank link is 'foreground-tab' / 'background-tab'.
 */
function wantsPopupWindow({ url, disposition }) {
  if (!/^(https?:|about:blank)/i.test(url || '') ) return false;
  if (disposition === 'new-window') return true;
  if (disposition === 'background-tab') return false;   // ctrl+click: the user wants a tab
  let u; try { u = new URL(url); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  return AUTH_HOSTS.test(u.hostname + u.pathname) || AUTH_PATH.test(u.pathname);
}

/** Window options for the popup: the size the page asked for (clamped), otherwise a phone-ish sign-in sized window. */
function popupSize(features) {
  const f = parseFeatures(features);
  const clamp = (n, lo, hi, d) => Math.min(hi, Math.max(lo, n || d));
  const o = { width: clamp(f.width, 320, 1400, 520), height: clamp(f.height, 360, 1000, 700) };
  if (f.left != null) o.x = f.left;
  if (f.top != null) o.y = f.top;
  return o;
}

module.exports = { wantsPopupWindow, popupSize, parseFeatures };
