import {
  BaseWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  WebContentsView,
  type WebContents,
} from "electron";
import { isTrustedVillageSender, trustedWebPreferences } from "./security.js";
import type { RitualBuilderController } from "./ritual-builder-controller.js";
import { createVillageId } from "./local-village-id.js";

export interface RitualBuilderWindow {
  window: BaseWindow;
  trustedRenderer: WebContents;
}

export async function createRitualBuilderWindow(options: {
  preloadPath: string;
  controller: RitualBuilderController;
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
    return { identity, ...(await options.controller.loadLatestState()) };
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
  const cleanup = () => {
    if (closed) return;
    closed = true;
    ipcMain.removeHandler(initializeChannel);
    ipcMain.removeHandler(createDraftIdentityChannel);
    ipcMain.removeHandler(draftChannel);
    ipcMain.removeHandler(approveChannel);
    ipcMain.removeHandler(testRunChannel);
    void options.controller.close();
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
