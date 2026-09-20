// The one bridge between the web layer and the desktop shell. The page
// stays a normal web app (no node integration); anything the shell can do
// for it is declared here, explicitly, one method at a time.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  // This fork has no trusted update feed yet. Keep only the check bridge so
  // the existing menu can report that state without exposing install actions.
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  onUpdateEvent: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('update:event', listener);
    return () => ipcRenderer.removeListener('update:event', listener);
  },
  getProjectFolder: () => ipcRenderer.invoke('project:get'),
  selectProjectFolder: () => ipcRenderer.invoke('project:select'),
  clearProjectFolder: () => ipcRenderer.invoke('project:clear'),
  listCodexThreads: (options) => ipcRenderer.invoke('codex-history:list', options),
  readCodexThread: (threadId) => ipcRenderer.invoke('codex-history:read', threadId),
  readLegacyStorage31174: () => ipcRenderer.invoke('storage:read-legacy-31174'),
});
