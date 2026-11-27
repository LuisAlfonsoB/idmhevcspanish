'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('authApi', {
  i18n: (() => { try { return ipcRenderer.sendSync('i18n'); } catch (_) { return null; } })(),
  submit: (user, pass) => ipcRenderer.send('auth:result', { user, pass }),
  cancel: () => ipcRenderer.send('auth:result', null)
});
