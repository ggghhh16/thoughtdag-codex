// The one bridge between the web layer and the desktop shell. The page
// stays a normal web app (no node integration); anything the shell can do
// for it is declared here, explicitly, one method at a time.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  textbookOpen: () => ipcRenderer.invoke('textbook:open'),
  textbookDock: (value) => ipcRenderer.invoke('textbook:dock', value),
  textbookFiles: (request) => ipcRenderer.invoke('textbook:files', request),
  textbookCommand: (command) => ipcRenderer.invoke('textbook:command', command),
  textbookReply: (id, reply) => ipcRenderer.send('textbook:reply', { id, reply }),
  textbookPublish: (snapshot) => ipcRenderer.send('textbook:publish', snapshot),
  textbookReveal: (request) => ipcRenderer.invoke('textbook:reveal', request),
  onTextbookEvent: (channel, cb) => {
    if (!['command', 'snapshot', 'reveal'].includes(channel)) throw new Error('Invalid textbook channel');
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('textbook:' + channel, listener);
    return () => ipcRenderer.removeListener('textbook:' + channel, listener);
  },
  // This fork has no trusted update feed yet. Keep only the check bridge so
  // the existing menu can report that state without exposing install actions.
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  onUpdateEvent: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('update:event', listener);
    return () => ipcRenderer.removeListener('update:event', listener);
  },
  getProjectFolder: () => ipcRenderer.invoke('project:get'),
  selectProjectFolder: (options) => ipcRenderer.invoke('project:select', options),
  activateProjectFolder: (path) => ipcRenderer.invoke('project:activate', path),
  openProjectFolder: (path) => ipcRenderer.invoke('project:open', path),
  createProjectWorktree: (path) => ipcRenderer.invoke('project:worktree', path),
  clearProjectFolder: () => ipcRenderer.invoke('project:clear'),
  listCodexThreads: (options) => ipcRenderer.invoke('codex-history:list', options),
  readCodexThread: (threadId) => ipcRenderer.invoke('codex-history:read', threadId),
  readLegacyStorage31174: () => ipcRenderer.invoke('storage:read-legacy-31174'),
});
