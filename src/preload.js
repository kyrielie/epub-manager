'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickLibrary:    ()            => ipcRenderer.invoke('pick-library'),
  loadLibrary:    (path)        => ipcRenderer.invoke('load-library', path),
  getAppData:     ()            => ipcRenderer.invoke('get-app-data'),
  saveAppData:    (data)        => ipcRenderer.invoke('save-app-data', data),
  openEpub:       (path)        => ipcRenderer.invoke('open-epub', path),
  coverDataUrl:   (path)        => ipcRenderer.invoke('cover-data-url', path),
  epubSample:     (path)        => ipcRenderer.invoke('epub-sample', path),
  openDataFolder: ()            => ipcRenderer.invoke('open-data-folder'),
});
