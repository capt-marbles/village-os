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
    testRun: (request) =>
      ipcRenderer.invoke("village:ritual-builder:test-run", request),
    proposeLearning: (request) =>
      ipcRenderer.invoke("village:ritual-builder:propose-learning", request),
    approveLearning: (request) =>
      ipcRenderer.invoke("village:ritual-builder:approve-learning", request),
  }),
);
