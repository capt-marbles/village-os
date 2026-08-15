import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  windows: [] as Array<{
    listeners: Map<string, () => void>;
    contentView: {
      addChildView: ReturnType<typeof vi.fn>;
      removeChildView: ReturnType<typeof vi.fn>;
    };
    destroy: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
  }>,
  views: [] as Array<{
    setBounds: ReturnType<typeof vi.fn>;
    webContents: {
      close: ReturnType<typeof vi.fn>;
      isDestroyed: ReturnType<typeof vi.fn>;
      loadURL: ReturnType<typeof vi.fn>;
    };
  }>,
  loadError: null as Error | null,
  handlers: new Map<string, (...arguments_: any[]) => unknown>(),
}));

vi.mock("electron", () => {
  class BaseWindow {
    readonly listeners = new Map<string, () => void>();
    readonly contentView = {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    };
    readonly destroy = vi.fn();
    readonly show = vi.fn();
    constructor(_options: object) {
      electron.windows.push(this);
    }
    getContentSize() {
      return [1_280, 800];
    }
    on(event: string, listener: () => void) {
      this.listeners.set(event, listener);
    }
  }

  class WebContentsView {
    readonly setBounds = vi.fn();
    readonly webContents = {
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => "village://app/?mode=ritual-builder"),
      loadURL: vi.fn(async () => {
        if (electron.loadError) throw electron.loadError;
      }),
    };
    constructor(_options: object) {
      electron.views.push(this);
    }
  }

  return {
    BaseWindow,
    WebContentsView,
    ipcMain: {
      handle: vi.fn((channel, handler) =>
        electron.handlers.set(channel, handler),
      ),
      removeHandler: vi.fn((channel) => electron.handlers.delete(channel)),
    },
  };
});

import { createRitualBuilderWindow } from "../src/main/ritual-builder-window.js";

describe("Ritual Builder window", () => {
  const controller = {
    loadLatestState: vi.fn(async () => ({ approved: null, receipt: null })),
    draft: vi.fn(async () => ({ status: "waiting" })),
    approve: vi.fn(async (ritual) => ritual),
    testRun: vi.fn(async () => ({ status: "waiting" })),
    close: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    electron.windows.length = 0;
    electron.views.length = 0;
    electron.loadError = null;
    electron.handlers.clear();
    vi.clearAllMocks();
  });

  it("shows after load and disposes the child view exactly once", async () => {
    await createRitualBuilderWindow({
      preloadPath: "/app/ritual-builder-bridge.cjs",
      controller,
    });
    const window = electron.windows[0]!;
    const view = electron.views[0]!;

    expect(view.webContents.loadURL).toHaveBeenCalledWith(
      "village://app/?mode=ritual-builder",
    );
    expect(window.show).toHaveBeenCalledOnce();
    window.listeners.get("close")?.();
    window.listeners.get("close")?.();
    expect(window.contentView.removeChildView).toHaveBeenCalledOnce();
    expect(view.webContents.close).toHaveBeenCalledOnce();
    expect(controller.close).toHaveBeenCalledOnce();
  });

  it("disposes and destroys the window when loading fails", async () => {
    electron.loadError = new Error("renderer failed");
    await expect(
      createRitualBuilderWindow({
        preloadPath: "/app/ritual-builder-bridge.cjs",
        controller,
      }),
    ).rejects.toThrow("renderer failed");
    const window = electron.windows[0]!;
    const view = electron.views[0]!;

    expect(window.contentView.removeChildView).toHaveBeenCalledOnce();
    expect(view.webContents.close).toHaveBeenCalledOnce();
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(window.show).not.toHaveBeenCalled();
  });

  it("routes only exact local-renderer IPC to the controller", async () => {
    await createRitualBuilderWindow({
      preloadPath: "/app/ritual-builder-bridge.cjs",
      controller,
    });
    const view = electron.views[0]!;
    const event = { sender: view.webContents };
    const initialize = electron.handlers.get(
      "village:ritual-builder:initialize",
    )!;
    const createDraftIdentity = electron.handlers.get(
      "village:ritual-builder:create-draft-identity",
    )!;
    const draft = electron.handlers.get("village:ritual-builder:draft")!;
    const approve = electron.handlers.get("village:ritual-builder:approve")!;
    const testRun = electron.handlers.get("village:ritual-builder:test-run")!;

    const initialized = (await initialize(event)) as {
      identity: { draftId: string; ritualId: string };
    };
    await draft(event, { draftId: initialized.identity.draftId });
    await approve(event, {
      ritualId: initialized.identity.ritualId,
      approvedDraftId: initialized.identity.draftId,
    });
    await testRun(event, { ritualId: initialized.identity.ritualId });
    expect(controller.loadLatestState).toHaveBeenCalledOnce();
    expect(controller.draft).toHaveBeenCalledWith({
      draftId: initialized.identity.draftId,
    });
    expect(controller.approve).toHaveBeenCalledWith({
      ritualId: initialized.identity.ritualId,
      approvedDraftId: initialized.identity.draftId,
    });
    expect(controller.testRun).toHaveBeenCalledWith({
      ritualId: initialized.identity.ritualId,
    });

    const nextIdentity = (await createDraftIdentity(event)) as {
      draftId: string;
      ritualId: string;
    };
    expect(nextIdentity).not.toEqual(initialized.identity);
    await expect(
      draft(event, { draftId: initialized.identity.draftId }),
    ).rejects.toThrow("STALE_RITUAL_BUILDER_IDENTITY");
    await expect(
      approve(event, {
        ritualId: initialized.identity.ritualId,
        approvedDraftId: initialized.identity.draftId,
      }),
    ).rejects.toThrow("STALE_RITUAL_BUILDER_IDENTITY");
    await expect(
      draft(event, { draftId: nextIdentity.draftId }),
    ).resolves.toEqual({ status: "waiting" });
    await expect(
      approve(event, {
        ritualId: nextIdentity.ritualId,
        approvedDraftId: nextIdentity.draftId,
      }),
    ).resolves.toEqual({
      ritualId: nextIdentity.ritualId,
      approvedDraftId: nextIdentity.draftId,
    });
    await expect(initialize({ sender: {} })).rejects.toThrow(
      "UNTRUSTED_RITUAL_BUILDER_SENDER",
    );
  });

  it("restores the latest Receipt only for the latest approved Ritual", async () => {
    const approved = { ritualId: "rtl_01J00000000000000000000000" };
    const receipt = { receiptId: "rcp_01J00000000000000000000000" };
    controller.loadLatestState.mockResolvedValueOnce({
      approved: approved as never,
      receipt: receipt as never,
    });
    await createRitualBuilderWindow({
      preloadPath: "/app/ritual-builder-bridge.cjs",
      controller,
    });
    const initialize = electron.handlers.get(
      "village:ritual-builder:initialize",
    )!;

    await expect(
      initialize({ sender: electron.views[0]!.webContents }),
    ).resolves.toMatchObject({ approved, receipt });
    expect(controller.loadLatestState).toHaveBeenCalledOnce();
  });
});
