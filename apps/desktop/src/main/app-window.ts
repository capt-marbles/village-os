import { join } from "node:path";
import {
  BaseWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
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
import { CrashReporter } from "./crash-reporting.js";
import type { ModelProviderAccountOperations } from "./model-provider-account.js";
import {
  personalAgentTaskActivitySchema,
  personalAgentTaskResultSchema,
  type PersonalAgentTaskResult,
} from "@village/contracts";
import type { PersonalAgentTaskOperations } from "./personal-agent-task.js";
import type {
  DelegatedWorkflowAction,
  DelegatedWorkflowSnapshot,
  DelegatedWorkflowTask,
} from "@village/ui";
import type { BrowserHostManager } from "./browser-host-manager.js";
import type { AuthenticatedAutomationFence } from "./delegated-workflow-controller.js";

export interface InternalDelegatedWorkflowOperations {
  createFixtureHost(): Promise<LocalBrowserHost>;
  snapshot(): DelegatedWorkflowSnapshot;
  subscribe(
    listener: (snapshot: DelegatedWorkflowSnapshot) => void,
  ): () => void;
  start(): Promise<DelegatedWorkflowSnapshot>;
  takeOver(): Promise<DelegatedWorkflowSnapshot>;
  handBack(): Promise<DelegatedWorkflowSnapshot>;
  cancel(): Promise<DelegatedWorkflowSnapshot>;
  retry(): Promise<DelegatedWorkflowSnapshot>;
  fence(reason: "TASK_SWITCH" | "APP_CLOSE"): void;
}

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
  revokeCredentialReferences: (binding: SessionErasureBinding) => Promise<void>;
  modelProviderAccount: ModelProviderAccountOperations;
  personalAgentTask: PersonalAgentTaskOperations;
  /** Signed paired-device synchronization used by production workflow controllers. */
  automationFence?: AuthenticatedAutomationFence;
  /** Internal/dev proof composition. Release runtime never supplies this. */
  delegatedWorkflow?: InternalDelegatedWorkflowOperations;
}

export interface VillageAppWindow {
  window: BaseWindow;
  browserHost: LocalBrowserHost;
  trustedRenderer: WebContents;
  fixtureBrowserHost?: LocalBrowserHost;
  viewport: BrowserViewportCoordinator;
  automationFence?: AuthenticatedAutomationFence;
  /** Control-plane revocation seam; it fences all future trusted IPC work. */
  revokeDevice(): void;
}

function browserViewAdapter(
  window: BaseWindow,
  browserHost: LocalBrowserHost,
  inputShield: WebContentsView,
  activeBrowserHost: () => Pick<LocalBrowserHost, "view"> = () => browserHost,
): NativeBrowserView {
  let visible = true;
  let inputEnabled = false;
  let lastShieldVisible: boolean | undefined;
  const applyVisibility = () => {
    const state = calculateNativeViewVisibility(visible, inputEnabled);
    activeBrowserHost().view.setVisible(state.browserVisible);
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
    focus: () => activeBrowserHost().view.webContents.focus(),
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
  const browserHostCreation = LocalBrowserHost.create({
    principalId: options.principalId,
    deviceId: options.deviceId,
    site: options.site,
    profileRoot: LocalBrowserHost.profileRoot(options.userDataPath),
    initialUrl: options.initialUrl,
  });
  const fixtureHostCreation = options.delegatedWorkflow?.createFixtureHost();
  let browserHost: LocalBrowserHost | undefined;
  let fixtureBrowserHost: LocalBrowserHost | undefined;
  try {
    const [primaryHost, fixtureHost] = await Promise.all([
      browserHostCreation,
      fixtureHostCreation,
      shieldLoad,
    ]);
    browserHost = primaryHost;
    fixtureBrowserHost = fixtureHost;
  } catch (error) {
    const [primaryResult, fixtureResult] = await Promise.allSettled([
      browserHostCreation,
      fixtureHostCreation,
      shieldLoad,
    ]);
    if (primaryResult.status === "fulfilled") {
      browserHost = primaryResult.value;
    }
    if (fixtureResult.status === "fulfilled") {
      fixtureBrowserHost = fixtureResult.value;
    }
    await browserHost?.close();
    await fixtureBrowserHost?.close();
    if (!appView.webContents.isDestroyed()) appView.webContents.close();
    if (!inputShield.webContents.isDestroyed()) inputShield.webContents.close();
    window.destroy();
    throw error;
  }
  if (!browserHost) throw new Error("BROWSER_HOST_CREATION_FAILED");
  let hostManager: BrowserHostManager | undefined;
  const viewport = new BrowserViewportCoordinator(
    browserViewAdapter(
      window,
      browserHost,
      inputShield,
      () => hostManager?.currentHost() ?? browserHost,
    ),
  );
  viewport.configure({ splitRatio: 0.42, topInset: 0, minWidth: 360 });

  window.contentView.addChildView(appView);
  window.contentView.addChildView(browserHost.view);
  if (fixtureBrowserHost)
    window.contentView.addChildView(fixtureBrowserHost.view);
  window.contentView.addChildView(inputShield);
  if (fixtureBrowserHost && options.delegatedWorkflow) {
    const { BrowserHostManager: InternalBrowserHostManager } =
      await import("./browser-host-manager.js");
    hostManager = new InternalBrowserHostManager(
      browserHost,
      fixtureBrowserHost,
      {
        fenceFixture: (reason) => options.delegatedWorkflow!.fence(reason),
      },
    );
  }

  const layout = () => {
    const size = window.getContentSize();
    const width = size[0] ?? 0;
    const height = size[1] ?? 0;
    appView.setBounds({ x: 0, y: 0, width, height });
    viewport.layout({ width, height });
    if (fixtureBrowserHost)
      fixtureBrowserHost.view.setBounds(browserHost.view.getBounds());
  };
  window.on("resize", layout);
  layout();

  const authorizer = new SensitiveActionAuthorizer();
  const stepUpAuthorizer = new StepUpAuthorizer();
  const deviceRevocations = new DeviceRevocationRegistry();
  const executor = new LocalActionExecutor({ leaseEpoch: 1 });
  const transferGate = new ControlTransferGate();
  const erasureGate = new ControlTransferGate();
  const uiState = new DesktopBrowserUiState();
  const diagnostics = new CrashReporter();
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
    closeTarget: async () => browserHost.closeTargetForErasure(),
    clearBrowserStorage: async () => browserHost.clearSiteStorage(),
    clearPermissions: async () => browserHost.clearSitePermissions(),
    // Journals, temporary browser files, and download metadata live under the
    // same exact profile and are removed by removeScopedProfile below.
    clearActionJournal: async () => undefined,
    clearTemporaryData: async () => undefined,
    clearDownloads: async () => undefined,
    revokeCredentialReferences: options.revokeCredentialReferences,
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
  const unsubscribeWorkflow = options.delegatedWorkflow?.subscribe(
    (snapshot) => {
      if (!appView.webContents.isDestroyed()) {
        appView.webContents.send("village:delegated-workflow-state", snapshot);
      }
    },
  );
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
  if (options.delegatedWorkflow && hostManager) {
    const workflow = options.delegatedWorkflow;
    ipcMain.handle(
      "village:get-delegated-workflow-state",
      (event, ...arguments_) => {
        assertTrustedRequest(event, arguments_);
        return workflow.snapshot();
      },
    );
    ipcMain.handle(
      "village:run-delegated-workflow-action",
      async (event, action: unknown, ...arguments_) => {
        assertTrustedRequest(event, arguments_);
        if (
          !(
            ["START", "TAKE_OVER", "HAND_BACK", "CANCEL", "RETRY"] as unknown[]
          ).includes(action)
        ) {
          throw new Error("MALFORMED_IPC_REQUEST");
        }
        switch (action as DelegatedWorkflowAction) {
          case "START": {
            const snapshot = await workflow.start();
            if (snapshot.state !== "DISCONNECTED") {
              hostManager.allowFixtureAfterHandBack();
              hostManager.show("VILLAGE_FIXTURE");
            }
            return snapshot;
          }
          case "TAKE_OVER": {
            viewport.beginTakeover();
            const snapshot = await workflow.takeOver();
            if (snapshot.state === "OWNER_CONTROL") {
              viewport.acknowledgeTakeover();
            }
            return snapshot;
          }
          case "HAND_BACK": {
            viewport.beginTakeover();
            const snapshot = await workflow.handBack();
            if (
              snapshot.state !== "HUMAN_GATE" &&
              snapshot.state !== "OFFLINE"
            ) {
              hostManager.allowFixtureAfterHandBack();
              hostManager.show("VILLAGE_FIXTURE");
              viewport.restoreAgentControl();
            } else if (snapshot.state === "HUMAN_GATE") {
              viewport.restoreUserControl();
            }
            return snapshot;
          }
          case "CANCEL":
            return workflow.cancel();
          case "RETRY":
            return workflow.retry();
        }
      },
    );
    ipcMain.handle(
      "village:select-desktop-task",
      (event, task: unknown, ...arguments_) => {
        assertTrustedRequest(event, arguments_);
        if (task !== "LINKEDIN_PERSONAL" && task !== "VILLAGE_FIXTURE") {
          throw new Error("MALFORMED_IPC_REQUEST");
        }
        hostManager.show(task as DelegatedWorkflowTask);
        layout();
        return hostManager.currentTask();
      },
    );
  }
  ipcMain.handle("village:get-browser-ui-state", (event, ...arguments_) => {
    assertTrustedRequest(event, arguments_);
    return uiState.current();
  });
  ipcMain.handle("village:get-browser-diagnostics", (event, ...arguments_) => {
    assertTrustedRequest(event, arguments_);
    return diagnostics.snapshot();
  });
  ipcMain.handle(
    "village:get-model-provider-account",
    (event, ...arguments_) => {
      assertTrustedRequest(event, arguments_);
      return options.modelProviderAccount.refresh();
    },
  );
  ipcMain.handle("village:begin-chatgpt-login", (event, ...arguments_) => {
    assertTrustedRequest(event, arguments_);
    return options.modelProviderAccount.beginLogin();
  });
  ipcMain.handle("village:cancel-chatgpt-login", (event, ...arguments_) => {
    assertTrustedRequest(event, arguments_);
    return options.modelProviderAccount.cancelLogin();
  });
  ipcMain.handle(
    "village:run-personal-agent-task",
    async (
      event,
      candidate: unknown,
      ...arguments_
    ): Promise<PersonalAgentTaskResult> => {
      assertTrustedRequest(event, arguments_);
      const taskResult = await options.personalAgentTask.run(
        candidate,
        {
          readBrowserState: () => {
            if (browserHost.view.webContents.isDestroyed()) {
              throw new Error("BROWSER_TARGET_UNAVAILABLE");
            }
            return {
              currentUrl: browserHost.view.webContents.getURL(),
              debuggerAttached:
                browserHost.view.webContents.debugger.isAttached(),
            };
          },
          confirmAccount: async () => {
            const response = await dialog.showMessageBox({
              type: "question",
              title: "Confirm LinkedIn session",
              message: "Is the LinkedIn account shown in the browser yours?",
              buttons: ["Confirm", "Not mine"],
              defaultId: 0,
              cancelId: 1,
              noLink: true,
            });
            return response.response === 0;
          },
        },
        (activity) => {
          if (!appView.webContents.isDestroyed()) {
            appView.webContents.send(
              "village:personal-agent-task-activity",
              personalAgentTaskActivitySchema.parse(activity),
            );
          }
        },
      );
      return personalAgentTaskResultSchema.parse(taskResult);
    },
  );
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
      return erasureGate.run(async () => {
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
        if (result.status === "PARTIAL_FAILURE") {
          diagnostics.capture({
            component: "SESSION_ERASURE",
            code: `FAILED_${result.failedStep.toUpperCase()}`,
            retriable: true,
          });
          appView.webContents.send(
            "village:browser-diagnostics",
            diagnostics.snapshot(),
          );
        }
        return result.status === "PARTIAL_FAILURE"
          ? ("PARTIAL_FAILURE" as const)
          : ("STEP_UP_REQUIRED" as const);
      });
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
    unsubscribeWorkflow?.();
    for (const channel of [
      takeoverChannel,
      "village:get-browser-ui-state",
      "village:get-browser-diagnostics",
      "village:get-model-provider-account",
      "village:begin-chatgpt-login",
      "village:cancel-chatgpt-login",
      "village:run-personal-agent-task",
      "village:request-return-control",
      "village:set-browser-pane",
      "village:record-verification-decision",
      "village:request-forget-session",
      "village:request-observer-intent",
      "village:get-delegated-workflow-state",
      "village:run-delegated-workflow-action",
      "village:select-desktop-task",
    ]) {
      ipcMain.removeHandler(channel);
    }
    viewport.destroy();
    if (!appView.webContents.isDestroyed()) appView.webContents.close();
    void Promise.allSettled([
      hostManager ? hostManager.close() : browserHost.close(),
      options.modelProviderAccount.close(),
    ]).finally(() => window.destroy());
  });
  try {
    await appView.webContents.loadURL("village://app/");
  } catch (error) {
    window.close();
    throw error;
  }
  window.show();
  return {
    window,
    browserHost,
    trustedRenderer: appView.webContents,
    ...(fixtureBrowserHost ? { fixtureBrowserHost } : {}),
    viewport,
    ...(options.automationFence
      ? { automationFence: options.automationFence }
      : {}),
    revokeDevice,
  };
}

export function defaultPreloadPath(appPath: string): string {
  return join(appPath, "dist", "preload", "village-bridge.cjs");
}
