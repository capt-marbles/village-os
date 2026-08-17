import {
  BaseWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  WebContentsView,
  type WebContents,
} from "electron";
import { isTrustedVillageSender, trustedWebPreferences } from "./security.js";
import type { RitualBuilderController } from "./ritual-builder-controller.js";
import { createVillageId } from "./local-village-id.js";
import type { ExaCredentialOperations } from "../research/exa-credential-controller.js";

export interface RitualBuilderWindow {
  window: BaseWindow;
  trustedRenderer: WebContents;
}

export async function createRitualBuilderWindow(options: {
  preloadPath: string;
  controller: RitualBuilderController;
  exaCredentials: ExaCredentialOperations;
  openExaDashboard: () => Promise<void>;
}): Promise<RitualBuilderWindow> {
  const window = new BaseWindow({
    width: 1_280,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#101510",
    title: "Village · Ritual Builder",
    fullscreenable: false,
  });
  const appView = new WebContentsView({
    webPreferences: trustedWebPreferences(options.preloadPath),
  });
  let closed = false;
  window.contentView.addChildView(appView);
  let disposed = false;
  const disposeView = () => {
    if (disposed) return;
    disposed = true;
    window.contentView.removeChildView(appView);
    if (!appView.webContents.isDestroyed()) appView.webContents.close();
  };
  const layout = () => {
    const [width = 0, height = 0] = window.getContentSize();
    appView.setBounds({ x: 0, y: 0, width, height });
  };
  window.on("resize", layout);
  layout();
  let identity = createRitualBuilderIdentity();
  const initializeChannel = "village:ritual-builder:initialize";
  const createDraftIdentityChannel =
    "village:ritual-builder:create-draft-identity";
  const draftChannel = "village:ritual-builder:draft";
  const approveChannel = "village:ritual-builder:approve";
  const testRunChannel = "village:ritual-builder:test-run";
  const startRunChannel = "village:ritual-builder:start-run";
  const approveRunStepChannel = "village:ritual-builder:approve-run-step";
  const cancelRunChannel = "village:ritual-builder:cancel-run";
  const automationStateChannel = "village:ritual-builder:get-automation-state";
  const configureScheduleChannel = "village:ritual-builder:configure-schedule";
  const pauseScheduleChannel = "village:ritual-builder:pause-schedule";
  const proposeLearningChannel = "village:ritual-builder:propose-learning";
  const approveLearningChannel = "village:ritual-builder:approve-learning";
  const decideLearningChannel = "village:ritual-builder:decide-learning";
  const exaStatusChannel = "village:ritual-builder:get-exa-credential-status";
  const configureExaChannel = "village:ritual-builder:configure-exa-api-key";
  const removeExaChannel = "village:ritual-builder:remove-exa-api-key";
  const openExaDashboardChannel = "village:ritual-builder:open-exa-dashboard";
  const assertSender = (event: IpcMainInvokeEvent) => {
    if (
      event.sender !== appView.webContents ||
      !isTrustedVillageSender(event.sender)
    ) {
      throw new Error("UNTRUSTED_RITUAL_BUILDER_SENDER");
    }
  };
  ipcMain.handle(initializeChannel, async (event) => {
    assertSender(event);
    const [latest, automation] = await Promise.all([
      options.controller.loadLatestState(),
      options.controller.loadAutomationState(),
    ]);
    return { identity, ...latest, ...automation };
  });
  ipcMain.handle(createDraftIdentityChannel, async (event) => {
    assertSender(event);
    identity = createRitualBuilderIdentity();
    return identity;
  });
  ipcMain.handle(draftChannel, async (event, candidate) => {
    assertSender(event);
    if (!hasExactIdentity(candidate, identity, "draft")) {
      throw new Error("STALE_RITUAL_BUILDER_IDENTITY");
    }
    return options.controller.draft(candidate);
  });
  ipcMain.handle(approveChannel, async (event, candidate) => {
    assertSender(event);
    if (!hasExactIdentity(candidate, identity, "approval")) {
      throw new Error("STALE_RITUAL_BUILDER_IDENTITY");
    }
    return options.controller.approve(candidate);
  });
  ipcMain.handle(testRunChannel, async (event, candidate) => {
    assertSender(event);
    return options.controller.testRun(candidate);
  });
  ipcMain.handle(startRunChannel, async (event, candidate) => {
    assertSender(event);
    return options.controller.startRun(candidate);
  });
  ipcMain.handle(approveRunStepChannel, async (event, candidate) => {
    assertSender(event);
    return options.controller.approveRunStep(candidate);
  });
  ipcMain.handle(cancelRunChannel, async (event, candidate) => {
    assertSender(event);
    return options.controller.cancelRun(candidate);
  });
  ipcMain.handle(automationStateChannel, async (event, ...arguments_) => {
    assertSender(event);
    if (arguments_.length !== 0) throw new Error("MALFORMED_IPC_REQUEST");
    return options.controller.loadAutomationState();
  });
  ipcMain.handle(configureScheduleChannel, async (event, candidate) => {
    assertSender(event);
    return options.controller.configureSchedule(candidate);
  });
  ipcMain.handle(pauseScheduleChannel, async (event, candidate) => {
    assertSender(event);
    return options.controller.pauseSchedule(candidate);
  });
  ipcMain.handle(proposeLearningChannel, async (event, candidate) => {
    assertSender(event);
    return options.controller.proposeLearning(candidate);
  });
  ipcMain.handle(approveLearningChannel, async (event, candidate) => {
    assertSender(event);
    return options.controller.approveLearning(candidate);
  });
  ipcMain.handle(decideLearningChannel, async (event, candidate) => {
    assertSender(event);
    return options.controller.decideLearning(candidate);
  });
  ipcMain.handle(exaStatusChannel, async (event, ...arguments_) => {
    assertSender(event);
    if (arguments_.length !== 0) throw new Error("MALFORMED_IPC_REQUEST");
    return options.exaCredentials.status();
  });
  ipcMain.handle(
    configureExaChannel,
    async (event, candidate: unknown, ...arguments_) => {
      assertSender(event);
      if (arguments_.length !== 0) throw new Error("MALFORMED_IPC_REQUEST");
      return options.exaCredentials.configure(candidate);
    },
  );
  ipcMain.handle(removeExaChannel, async (event, ...arguments_) => {
    assertSender(event);
    if (arguments_.length !== 0) throw new Error("MALFORMED_IPC_REQUEST");
    const current = await options.exaCredentials.status();
    if (current.state !== "CONFIGURED") {
      return { status: "snapshot" as const, snapshot: current };
    }
    const response = await dialog.showMessageBox({
      type: "warning",
      title: "Remove the Exa key from this Mac?",
      message:
        "Future research steps will wait until you connect Exa again. Existing Rituals and Receipts are unchanged.",
      buttons: ["Remove key", "Keep key"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return response.response === 0
      ? options.exaCredentials.revoke(current.version)
      : {
          status: "snapshot" as const,
          snapshot: await options.exaCredentials.status(),
        };
  });
  ipcMain.handle(openExaDashboardChannel, async (event, ...arguments_) => {
    assertSender(event);
    if (arguments_.length !== 0) throw new Error("MALFORMED_IPC_REQUEST");
    await options.openExaDashboard();
  });
  const cleanup = () => {
    if (closed) return;
    closed = true;
    ipcMain.removeHandler(initializeChannel);
    ipcMain.removeHandler(createDraftIdentityChannel);
    ipcMain.removeHandler(draftChannel);
    ipcMain.removeHandler(approveChannel);
    ipcMain.removeHandler(testRunChannel);
    ipcMain.removeHandler(startRunChannel);
    ipcMain.removeHandler(approveRunStepChannel);
    ipcMain.removeHandler(cancelRunChannel);
    ipcMain.removeHandler(automationStateChannel);
    ipcMain.removeHandler(configureScheduleChannel);
    ipcMain.removeHandler(pauseScheduleChannel);
    ipcMain.removeHandler(proposeLearningChannel);
    ipcMain.removeHandler(approveLearningChannel);
    ipcMain.removeHandler(decideLearningChannel);
    ipcMain.removeHandler(exaStatusChannel);
    ipcMain.removeHandler(configureExaChannel);
    ipcMain.removeHandler(removeExaChannel);
    ipcMain.removeHandler(openExaDashboardChannel);
    disposeView();
  };
  window.on("close", cleanup);
  try {
    await appView.webContents.loadURL("village://app/?mode=ritual-builder");
  } catch (error) {
    cleanup();
    window.destroy();
    throw error;
  }
  window.show();
  return { window, trustedRenderer: appView.webContents };
}

function createRitualBuilderIdentity() {
  return {
    draftId: createVillageId("rtd"),
    ritualId: createVillageId("rtl"),
  };
}

function hasExactIdentity(
  candidate: unknown,
  identity: ReturnType<typeof createRitualBuilderIdentity>,
  kind: "draft" | "approval",
): boolean {
  if (typeof candidate !== "object" || candidate === null) return false;
  const record = candidate as Record<string, unknown>;
  return kind === "draft"
    ? record.draftId === identity.draftId
    : record.approvedDraftId === identity.draftId &&
        record.ritualId === identity.ritualId;
}
