const { contextBridge, ipcRenderer } = require("electron");

function subscription(channel, label) {
  return (listener) => {
    if (typeof listener !== "function")
      throw new TypeError(`${label} listener must be a function`);
    const handler = (_event, value) => listener(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld(
  "village",
  Object.freeze({
    requestTakeover: () => ipcRenderer.invoke("village:request-takeover"),
    requestReturnControl: () =>
      ipcRenderer.invoke("village:request-return-control"),
    getBrowserUiState: () => ipcRenderer.invoke("village:get-browser-ui-state"),
    getBrowserDiagnostics: () =>
      ipcRenderer.invoke("village:get-browser-diagnostics"),
    getModelProviderAccount: () =>
      ipcRenderer.invoke("village:get-model-provider-account"),
    beginChatGptLogin: () => ipcRenderer.invoke("village:begin-chatgpt-login"),
    cancelChatGptLogin: () =>
      ipcRenderer.invoke("village:cancel-chatgpt-login"),
    runPersonalAgentTask: (request) =>
      ipcRenderer.invoke("village:run-personal-agent-task", request),
    subscribePersonalAgentTaskActivity: subscription(
      "village:personal-agent-task-activity",
      "Task activity",
    ),
    subscribeBrowserUiState: subscription(
      "village:browser-ui-state",
      "Browser UI",
    ),
    subscribeBrowserDiagnostics: subscription(
      "village:browser-diagnostics",
      "Browser diagnostics",
    ),
    setBrowserPane: (input) =>
      ipcRenderer.invoke("village:set-browser-pane", input),
    recordVerificationDecision: (decision) =>
      ipcRenderer.invoke("village:record-verification-decision", decision),
    requestForgetSession: () =>
      ipcRenderer.invoke("village:request-forget-session"),
    requestObserverIntent: (intent) =>
      ipcRenderer.invoke("village:request-observer-intent", intent),
    getDelegatedWorkflowState: () =>
      ipcRenderer.invoke("village:get-delegated-workflow-state"),
    runDelegatedWorkflowAction: (action) =>
      ipcRenderer.invoke("village:run-delegated-workflow-action", action),
    selectDesktopTask: (task) =>
      ipcRenderer.invoke("village:select-desktop-task", task),
    subscribeDelegatedWorkflowState: subscription(
      "village:delegated-workflow-state",
      "Delegated workflow",
    ),
  }),
);

contextBridge.exposeInMainWorld(
  "villagePairing",
  Object.freeze({
    getPairingRequest: () => ipcRenderer.invoke("village:get-pairing-request"),
    subscribePairingState: subscription(
      "village:pairing-state",
      "Pairing state",
    ),
  }),
);
