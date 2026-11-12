// The report window's only link to the app: saving the report.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reportApi', {
  save: () => ipcRenderer.invoke('report:save'),
  pdf: () => ipcRenderer.invoke('report:pdf'),
  show: (file) => ipcRenderer.invoke('report:show', file),
});
