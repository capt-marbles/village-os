import { join } from "node:path";
import {
  BaseWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  WebContentsView,
} from "electron";
import { LocalActionExecutor } from "../browser/local-action-executor.js";
import {
  LocalBrowserHost,
  type BrowserSite,
} from "../browser/local-browser-host.js";
import {
  BrowserViewportCoordinator,
  calculateNativeViewVisibility,
  type NativeBrowserView,
} from "./browser-viewport-coordinator.js";
import { SensitiveActionAuthorizer } from "./sensitive-action-authorizer.js";
import {
  SessionErasureCoordinator,
  type SessionErasureBinding,
} from "./session-erasure.js";
import { StepUpAuthorizer } from "./step-up-auth.js";
import { DeviceRevocationRegistry } from "./device-revocation.js";
import { DesktopBrowserUiState } from "./desktop-browser-ui-state.js";
import { ControlTransferGate } from "./control-transfer-gate.js";
import { BrowserControlTransfer } from "./browser-control-transfer.js";
import { isTrustedVillageSender, trustedWebPreferences } from "./security.js";

export interface VillageAppWindowOptions {
  principalId: string;
  deviceId: string;
  browserSessionId: string;
  site: BrowserSite;
  initialUrl: string;
  userDataPath: string;
  preloadPath: string;
  /** Main-process proof of current owner identity. Absent means fail closed. */
  verifyStepUp?: (binding: SessionErasureBinding) => Promise<boolean>;
  /** Site-scoped credential reference cleanup registered by the vault owner. */
  revokeCredentialReferences?: (
    binding: SessionErasureBinding,
  ) => Promise<void>;
}

export interface VillageAppWindow {
  window: BaseWindow;
  browserHost: LocalBrowserHost;
  viewport: BrowserViewportCoordinator;
  /** Control-plane revocation seam; it fences all future trusted IPC work. */
  revokeDevice(): void;
}

function browserViewAdapter(
  window: BaseWindow,
  browserHost: LocalBrowserHost,
  inputShield: WebContentsView,
): NativeBrowserView {
  let visible = true;
  let inputEnabled = false;
  let lastBrowserVisible: boolean | undefined;
  let lastShieldVisible: boolean | undefined;
  const applyVisibility = () => {
    const state = calculateNativeViewVisibility(visible, inputEnabled);
    if (state.browserVisible !== lastBrowserVisible) {
      browserHost.view.setVisible(state.browserVisible);
      lastBrowserVisible = state.browserVisible;
    }
    if (state.shieldVisible !== lastShieldVisible) {
      inputShield.setVisible(state.shieldVisible);
      lastShieldVisible = state.shieldVisible;
    }
  };
  return {
    setBounds: (bounds) => {
      browserHost.view.setBounds(bounds);
      inputShield.setBounds(bounds);
    },
    setVisible: (nextVisible) => {
      visible = nextVisible;
      applyVisibility();
    },
    setInputEnabled: (enabled) => {
      inputEnabled = enabled;
      applyVisibility();
    },
    focus: () => browserHost.view.webContents.focus(),
    destroy: () => {
      window.contentView.removeChildView(inputShield);
      window.contentView.removeChildView(browserHost.view);
      if (!inputShield.webContents.isDestroyed())
        inputShield.webContents.close();
    },
  };
}

export async function createVillageAppWindow(
  options: VillageAppWindowOptions,
): Promise<VillageAppWindow> {
  const window = new BaseWindow({
    width: 1_280,
    height: 800,
    minWidth: 840,
    minHeight: 560,
    backgroundColor: "#101410",
    title: "Village",
    fullscreenable: false,
  });
  const appView = new WebContentsView({
    webPreferences: trustedWebPreferences(options.preloadPath),
  });
  const inputShield = new WebContentsView({
    webPreferences: trustedWebPreferences(),
  });
  inputShield.setBackgroundColor("#00000000");
  const shieldLoad = inputShield.webContents.loadURL("village://app/shield");
  let browserHost: LocalBrowserHost | undefined;
  try {
    browserHost = await LocalBrowserHost.create({
      principalId: options.principalId,
      deviceId: options.deviceId,
      site: options.site,
      profileRoot: LocalBrowserHost.profileRoot(options.userDataPath),
      initialUrl: options.initialUrl,
    });
    await shieldLoad;
  } catch (error) {
    await Promise.allSettled([shieldLoad]);
    await browserHost?.close();
    if (!appView.webContents.isDestroyed()) appView.webContents.close();
    if (!inputShield.webContents.isDestroyed()) inputShield.webContents.close();
    window.destroy();
    throw error;
  }
  if (!browserHost) throw new Error("BROWSER_HOST_CREATION_FAILED");
  const viewport = new BrowserViewportCoordinator(
    browserViewAdapter(window, browserHost, inputShield),
  );
  viewport.configure({ splitRatio: 0.42, topInset: 0, minWidth: 360 });

  window.contentView.addChildView(appView);
  window.contentView.addChildView(browserHost.view);
  window.contentView.addChildView(inputShield);

  const layout = () => {
    const size = window.getContentSize();
    const width = size[0] ?? 0;
    const height = size[1] ?? 0;
    appView.setBounds({ x: 0, y: 0, width, height });
    viewport.layout({ width, height });
  };
  window.on("resize", layout);
  layout();

  const authorizer = new SensitiveActionAuthorizer();
  const stepUpAuthorizer = new StepUpAuthorizer();
  const deviceRevocations = new DeviceRevocationRegistry();
  const executor = new LocalActionExecutor({ leaseEpoch: 1 });
  const transferGate = new ControlTransferGate();
  const uiState = new DesktopBrowserUiState();
  const controlTransfer = new BrowserControlTransfer(
    uiState,
    viewport,
    executor,
    () => browserHost.reloadAfterUncertainAction(),
    () => browserHost.reloadAfterUncertainAction(),
  );
  const erasureBinding = (): SessionErasureBinding => ({
    principalId: options.principalId,
    deviceId: options.deviceId,
    browserSessionId: options.browserSessionId,
    site: options.site,
    operation: "FORGET_SESSION",
    currentState:
      uiState.current().profile === "ERASURE_FAILED"
        ? "ERASURE_FAILED"
        : "PRESENT",
  });
  const sessionErasure = new SessionErasureCoordinator(stepUpAuthorizer, {
    revokeAutomation: async () => {
      executor.markOfflineTakeover();
      uiState.cancelFutureAutomation();
    },
    closeTarget: async () => browserHost.close(),
    clearBrowserStorage: async () => browserHost.clearSiteStorage(),
    clearPermissions: async () => browserHost.clearSitePermissions(),
    // Journals, temporary browser files, and download metadata live under the
    // same exact profile and are removed by removeScopedProfile below.
    clearActionJournal: async () => undefined,
    clearTemporaryData: async () => undefined,
    clearDownloads: async () => undefined,
    revokeCredentialReferences: async (binding) =>
      options.revokeCredentialReferences?.(binding),
    removeProfile: async () => browserHost.removeScopedProfile(),
    verifyAbsent: async () => browserHost.scopedProfileAbsent(),
  });
  const revokeDevice = () => {
    deviceRevocations.revoke(options.deviceId);
    executor.markOfflineTakeover();
    uiState.markDeviceRevoked();
  };
  const unsubscribeUiState = uiState.subscribe((snapshot) => {
    if (!appView.webContents.isDestroyed()) {
      appView.webContents.send("village:browser-ui-state", snapshot);
    }
  });
  const takeoverChannel = "village:request-takeover";
  const assertTrustedRequest = (
    event: IpcMainInvokeEvent,
    arguments_: unknown[],
  ) => {
    if (
      event.sender !== appView.webContents ||
      !isTrustedVillageSender(event.sender)
    ) {
      throw new Error("UNTRUSTED_IPC_SENDER");
    }
    if (arguments_.length !== 0) throw new Error("MALFORMED_IPC_REQUEST");
    const device = deviceRevocations.authorize(options.deviceId);
    if (!device.ok) throw new Error(device.code);
  };
  const handleTakeover = async (
    event: IpcMainInvokeEvent,
    ...arguments_: unknown[]
  ) => {
    assertTrustedRequest(event, arguments_);
    return transferGate.run(async () => {
      if (uiState.current().controller === "USER") return "QUIESCED" as const;
      const response = await dialog.showMessageBox({
        type: "question",
        title: "Take control of this browser?",
        message:
          "Village will stop automated browser actions before enabling input.",
        buttons: ["Take control", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response.response !== 0) return "DECLINED" as const;
      const binding = {
        principalId: options.principalId,
        deviceId: options.deviceId,
        browserSessionId: options.browserSessionId,
        operation: "TAKEOVER" as const,
      };
      const authorization = authorizer.mint(binding, 15_000);
      const consumed = authorizer.consume(authorization.token, binding);
      if (!consumed.ok) throw new Error(consumed.code);

      return controlTransfer.takeover(5_000);
    });
  };
  ipcMain.handle(takeoverChannel, handleTakeover);
  ipcMain.handle("village:get-browser-ui-state", (event, ...arguments_) => {
    assertTrustedRequest(event, arguments_);
    return uiState.current();
  });
  ipcMain.handle(
    "village:request-return-control",
    async (event, ...arguments_) => {
      assertTrustedRequest(event, arguments_);
      return transferGate.run(async () => {
        const response = await dialog.showMessageBox({
          type: "question",
          title: "Return control to Village?",
          message:
            "Village will reconcile the last browser state before automation resumes.",
          buttons: ["Return control", "Keep control"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (response.response !== 0) return "DECLINED" as const;
        const binding = {
          principalId: options.principalId,
          deviceId: options.deviceId,
          browserSessionId: options.browserSessionId,
          operation: "TAKEOVER" as const,
        };
        const authorization = authorizer.mint(binding, 15_000);
        const consumed = authorizer.consume(authorization.token, binding);
        if (!consumed.ok) throw new Error(consumed.code);
        return await controlTransfer.returnControl();
      });
    },
  );
  ipcMain.handle("village:set-browser-pane", (event, input: unknown) => {
    if (
      event.sender !== appView.webContents ||
      !isTrustedVillageSender(event.sender)
    ) {
      throw new Error("UNTRUSTED_IPC_SENDER");
    }
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some((key) => !["visible", "splitRatio"].includes(key))
    ) {
      throw new Error("MALFORMED_IPC_REQUEST");
    }
    const candidate = input as { visible?: unknown; splitRatio?: unknown };
    if (
      typeof candidate.visible !== "boolean" ||
      typeof candidate.splitRatio !== "number" ||
      !Number.isFinite(candidate.splitRatio) ||
      candidate.splitRatio < 0.25 ||
      candidate.splitRatio > 0.75
    ) {
      throw new Error("MALFORMED_IPC_REQUEST");
    }
    viewport.setSplitRatio(candidate.splitRatio);
    viewport.setVisible(candidate.visible);
    if (!candidate.visible) appView.webContents.focus();
    layout();
  });
  ipcMain.handle(
    "village:record-verification-decision",
    (event, decision: unknown, ...arguments_) => {
      if (
        event.sender !== appView.webContents ||
        !isTrustedVillageSender(event.sender) ||
        arguments_.length !== 0 ||
        (decision !== "CONFIRM" && decision !== "REJECT")
      ) {
        throw new Error("MALFORMED_IPC_REQUEST");
      }
      uiState.recordVerification(
        decision === "CONFIRM" ? "confirmed_by_user" : "unknown",
      );
    },
  );
  ipcMain.handle(
    "village:request-forget-session",
    async (event, ...arguments_) => {
      assertTrustedRequest(event, arguments_);
      uiState.requireStepUpForErasure();
      const binding = erasureBinding();
      if (!(await options.verifyStepUp?.(binding))) {
        await dialog.showMessageBox({
          type: "info",
          title: "Step-up authentication required",
          message:
            "Forgetting a session is separate from canceling work. Village needs a main-process step-up authentication provider before it can remove this local profile.",
          buttons: ["OK"],
          noLink: true,
        });
        return "STEP_UP_REQUIRED" as const;
      }
      const confirmation = await dialog.showMessageBox({
        type: "warning",
        title: "Forget this local session?",
        message:
          "This closes the browser and permanently clears this site's local profile on this Mac.",
        buttons: ["Forget session", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (confirmation.response !== 0) return "DECLINED" as const;
      const token = stepUpAuthorizer.mint(binding, 15_000);
      uiState.beginErasure();
      const result = await sessionErasure.erase(token.token, binding);
      if (result.status === "COMPLETE") {
        uiState.completeErasure();
        return "COMPLETE" as const;
      }
      uiState.failErasure();
      return result.status === "PARTIAL_FAILURE"
        ? ("PARTIAL_FAILURE" as const)
        : ("STEP_UP_REQUIRED" as const);
    },
  );
  ipcMain.handle(
    "village:request-observer-intent",
    (event, intent: unknown, ...arguments_) => {
      if (
        event.sender !== appView.webContents ||
        !isTrustedVillageSender(event.sender) ||
        arguments_.length !== 0 ||
        intent !== "CANCEL_FUTURE_AUTOMATION"
      ) {
        throw new Error("MALFORMED_IPC_REQUEST");
      }
      if (intent === "CANCEL_FUTURE_AUTOMATION") {
        executor.markOfflineTakeover();
        uiState.cancelFutureAutomation();
      }
    },
  );

  let closing = false;
  window.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    unsubscribeUiState();
    for (const channel of [
      takeoverChannel,
      "village:get-browser-ui-state",
      "village:request-return-control",
      "village:set-browser-pane",
      "village:record-verification-decision",
      "village:request-forget-session",
      "village:request-observer-intent",
    ]) {
      ipcMain.removeHandler(channel);
    }
    viewport.destroy();
    if (!appView.webContents.isDestroyed()) appView.webContents.close();
    void browserHost.close().finally(() => window.destroy());
  });
  try {
    await appView.webContents.loadURL("village://app/");
  } catch (error) {
    window.close();
    throw error;
  }
  window.show();
  return { window, browserHost, viewport, revokeDevice };
}

export function defaultPreloadPath(appPath: string): string {
  return join(appPath, "dist", "preload", "village-bridge.cjs");
}
