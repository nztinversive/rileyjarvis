const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ricky", {
  createRealtimeToken: () => ipcRenderer.invoke("realtime:create-token"),
  executeTool: (toolCall) => ipcRenderer.invoke("tools:execute", toolCall),
  getToolSpecs: () => ipcRenderer.invoke("tools:list"),
  onRemoteCodexEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("remote-codex:event", listener);
    return () => ipcRenderer.removeListener("remote-codex:event", listener);
  },
});
