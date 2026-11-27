'use strict';
const assert = require('assert');
const { wantsPopupWindow, popupSize } = require('../src/popups');

// the Google sign-in popup on x.com (opened with window features) must be a real window, so it can talk to its opener
assert(wantsPopupWindow({ url: 'https://accounts.google.com/gsi/select?client_id=1', disposition: 'new-window' }));
// even when the page forgot to pass features
assert(wantsPopupWindow({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', disposition: 'foreground-tab' }));
assert(wantsPopupWindow({ url: 'https://appleid.apple.com/auth/authorize?x=1', disposition: 'foreground-tab' }));
assert(wantsPopupWindow({ url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', disposition: 'foreground-tab' }));
assert(wantsPopupWindow({ url: 'https://example.com/sso/start', disposition: 'foreground-tab' }));
assert(wantsPopupWindow({ url: 'about:blank', disposition: 'new-window' }), 'script-filled popups start as about:blank');
assert(!wantsPopupWindow({ url: 'https://accounts.google.com/o/oauth2/auth', disposition: 'background-tab' }), 'ctrl+click is a tab');
// ordinary links stay tabs
assert(!wantsPopupWindow({ url: 'https://example.com/article', disposition: 'foreground-tab' }));
assert(!wantsPopupWindow({ url: 'https://example.com/article', disposition: 'background-tab' }));
assert(!wantsPopupWindow({ url: 'https://example.com/authors', disposition: 'foreground-tab' }), '"authors" is not "authorize"');
assert(!wantsPopupWindow({ url: 'http://accounts.google.com/o/oauth2/auth', disposition: 'foreground-tab' }), 'plain http is never auto-promoted');
assert(!wantsPopupWindow({ url: 'magnet:?xt=urn:btih:abc', disposition: 'new-window' }));
assert(!wantsPopupWindow({ url: 'javascript:alert(1)', disposition: 'new-window' }));
assert(!wantsPopupWindow({ url: '', disposition: 'new-window' }));

// size from the window.open features string
assert.deepStrictEqual(popupSize('popup,width=450,height=600,left=100,top=50'), { width: 450, height: 600, x: 100, y: 50 });
assert.deepStrictEqual(popupSize(''), { width: 520, height: 700 });
assert.deepStrictEqual(popupSize('width=50000,height=10'), { width: 1400, height: 360 }, 'clamped to a sane range');
console.log('popups ok');
