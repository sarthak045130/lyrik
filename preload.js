const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),
  onLightsStatus: (cb) => ipcRenderer.on('lights-status', (_e, s) => cb(s)),
  ready: () => ipcRenderer.send('ready'),
  cmd: (name) => ipcRenderer.send('cmd', name),
  set: (key, value) => ipcRenderer.send('set', key, value),
  settingsMenu: () => ipcRenderer.send('settings-menu'),
  hide: () => ipcRenderer.send('hide'),
  pickColor: (key, value) => ipcRenderer.send('color-result', key, value),
  lights: (patch) => ipcRenderer.send('lights', patch),
  openLights: () => ipcRenderer.send('open-lights'),
  lightsStatus: (text) => ipcRenderer.send('lights-status', text),
});
