const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "villageRitualBuilder",
  Object.freeze({
    initialize: () => ipcRenderer.invoke("village:ritual-builder:initialize"),
    createDraftIdentity: () =>
      ipcRenderer.invoke("village:ritual-builder:create-draft-identity"),
    draft: (context) =>
      ipcRenderer.invoke("village:ritual-builder:draft", context),
    approve: (ritual) =>
      ipcRenderer.invoke("village:ritual-builder:approve", ritual),
  }),
);
