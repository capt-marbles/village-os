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
    restoreRevision: (request) =>
      ipcRenderer.invoke("village:ritual-builder:restore-revision", request),
    testRun: (request) =>
      ipcRenderer.invoke("village:ritual-builder:test-run", request),
    startRun: (request) =>
      ipcRenderer.invoke("village:ritual-builder:start-run", request),
    approveRunStep: (request) =>
      ipcRenderer.invoke("village:ritual-builder:approve-run-step", request),
    cancelRun: (request) =>
      ipcRenderer.invoke("village:ritual-builder:cancel-run", request),
    getAutomationState: () =>
      ipcRenderer.invoke("village:ritual-builder:get-automation-state"),
    getAuditTimeline: () =>
      ipcRenderer.invoke("village:ritual-builder:get-audit-timeline"),
    configureSchedule: (request) =>
      ipcRenderer.invoke("village:ritual-builder:configure-schedule", request),
    pauseSchedule: (request) =>
      ipcRenderer.invoke("village:ritual-builder:pause-schedule", request),
    proposeLearning: (request) =>
      ipcRenderer.invoke("village:ritual-builder:propose-learning", request),
    approveLearning: (request) =>
      ipcRenderer.invoke("village:ritual-builder:approve-learning", request),
    decideLearning: (request) =>
      ipcRenderer.invoke("village:ritual-builder:decide-learning", request),
    getExaCredentialStatus: () =>
      ipcRenderer.invoke("village:ritual-builder:get-exa-credential-status"),
    configureExaApiKey: (apiKey) =>
      ipcRenderer.invoke(
        "village:ritual-builder:configure-exa-api-key",
        apiKey,
      ),
    removeExaApiKey: () =>
      ipcRenderer.invoke("village:ritual-builder:remove-exa-api-key"),
    openExaDashboard: () =>
      ipcRenderer.invoke("village:ritual-builder:open-exa-dashboard"),
  }),
);
