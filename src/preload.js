const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("beatsync", {
  signIn: (credentials) => ipcRenderer.invoke("auth:signIn", credentials),
  signUp: (credentials) => ipcRenderer.invoke("auth:signUp", credentials),
  restoreSession: () => ipcRenderer.invoke("auth:restore"),
  signOut: () => ipcRenderer.invoke("auth:signOut"),

  startSync: (options) => ipcRenderer.invoke("sync:start", options),
  stopSync: () => ipcRenderer.invoke("sync:stop"),
  autoResume: () => ipcRenderer.invoke("sync:autoResume"),
  getSyncStatus: () => ipcRenderer.invoke("sync:getStatus"),
  listDocuments: () => ipcRenderer.invoke("sync:listDocuments"),
  getConfig: () => ipcRenderer.invoke("config:get"),

  selectDirectory: () => ipcRenderer.invoke("dialog:selectDirectory"),

  encryption: {
    getStatus: () => ipcRenderer.invoke("encryption:getStatus"),
    generate: () => ipcRenderer.invoke("encryption:generate"),
    set: (key) => ipcRenderer.invoke("encryption:set", key),
    getKey: () => ipcRenderer.invoke("encryption:getKey"),
    clear: () => ipcRenderer.invoke("encryption:clear"),
  },

  onLog: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("log", listener);
    return () => ipcRenderer.removeListener("log", listener);
  },
  onWatcherStarted: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("watcher-started", listener);
    return () => ipcRenderer.removeListener("watcher-started", listener);
  },
  onWatcherStopped: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("watcher-stopped", listener);
    return () => ipcRenderer.removeListener("watcher-stopped", listener);
  },
  onDocUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("doc-updated", listener);
    return () => ipcRenderer.removeListener("doc-updated", listener);
  },
  onDocDeleted: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("doc-deleted", listener);
    return () => ipcRenderer.removeListener("doc-deleted", listener);
  },
});
