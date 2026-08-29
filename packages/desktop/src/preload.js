const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('courtside', {
  getState: () => ipcRenderer.invoke('get-state'),
  openDashboard: (tournament) => ipcRenderer.invoke('open-dashboard', tournament),
  listTournaments: () => ipcRenderer.invoke('list-tournaments'),
  createTournament: (name) => ipcRenderer.invoke('create-tournament', name),
  onStateUpdate: (callback) => {
    ipcRenderer.on('server-state', (_event, state) => callback(state));
  },
});
