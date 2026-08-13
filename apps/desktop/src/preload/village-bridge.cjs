const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "village",
  Object.freeze({
    requestTakeover: () => ipcRenderer.invoke("village:request-takeover"),
    requestReturnControl: () =>
      ipcRenderer.invoke("village:request-return-control"),
    getBrowserUiState: () => ipcRenderer.invoke("village:get-browser-ui-state"),
    subscribeBrowserUiState: (listener) => {
      if (typeof listener !== "function") {
        throw new TypeError("Browser UI listener must be a function");
      }
      const handler = (_event, snapshot) => listener(snapshot);
      ipcRenderer.on("village:browser-ui-state", handler);
      return () =>
        ipcRenderer.removeListener("village:browser-ui-state", handler);
    },
    setBrowserPane: (input) =>
      ipcRenderer.invoke("village:set-browser-pane", input),
    recordVerificationDecision: (decision) =>
      ipcRenderer.invoke("village:record-verification-decision", decision),
    requestForgetSession: () =>
      ipcRenderer.invoke("village:request-forget-session"),
    requestObserverIntent: (intent) =>
      ipcRenderer.invoke("village:request-observer-intent", intent),
  }),
);

contextBridge.exposeInMainWorld(
  "villagePairing",
  Object.freeze({
    getPairingRequest: () => ipcRenderer.invoke("village:get-pairing-request"),
    subscribePairingState: (listener) => {
      if (typeof listener !== "function") {
        throw new TypeError("Pairing state listener must be a function");
      }
      const handler = (_event, state) => listener(state);
      ipcRenderer.on("village:pairing-state", handler);
      return () => ipcRenderer.removeListener("village:pairing-state", handler);
    },
  }),
);
