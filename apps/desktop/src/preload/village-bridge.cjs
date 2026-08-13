const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "village",
  Object.freeze({
    requestTakeover: () => ipcRenderer.invoke("village:request-takeover"),
  }),
);
