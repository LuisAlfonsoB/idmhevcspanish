'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const EVENTS = ['state', 'settings', 'bookmarks', 'downloads', 'download-count', 'find-result', 'focus-omnibox', 'open-find', 'overlay-close'];
contextBridge.exposeInMainWorld('shell', {
  i18n: (() => { try { return ipcRenderer.sendSync('i18n'); } catch (_) { return null; } })(),
  invoke: (ch, ...args) => ipcRenderer.invoke('ui:' + ch, ...args),
  on: (ch, cb) => { if (EVENTS.includes(ch)) ipcRenderer.on(ch, (e, ...a) => cb(...a)); }
});
