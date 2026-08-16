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
    startRun: (request) =>
      ipcRenderer.invoke("village:ritual-builder:start-run", request),
    approveRunStep: (request) =>
      ipcRenderer.invoke("village:ritual-builder:approve-run-step", request),
    cancelRun: (request) =>
      ipcRenderer.invoke("village:ritual-builder:cancel-run", request),
    proposeLearning: (request) =>
      ipcRenderer.invoke("village:ritual-builder:propose-learning", request),
    approveLearning: (request) =>
      ipcRenderer.invoke("village:ritual-builder:approve-learning", request),
  }),
);
