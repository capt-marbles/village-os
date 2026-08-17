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
  dialogResponse: 0,
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
    dialog: {
      showMessageBox: vi.fn(async () => ({
        response: electron.dialogResponse,
      })),
    },
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
    loadLatestState: vi.fn(async () => ({
      approved: null,
      receipt: null,
      run: null,
      runReceipt: null,
    })),
    loadAutomationState: vi.fn(async () => ({
      schedule: null,
      inbox: [],
    })),
    configureSchedule: vi.fn(async (schedule) => schedule),
    pauseSchedule: vi.fn(async (schedule) => schedule),
    draft: vi.fn(async () => ({ status: "waiting" })),
    approve: vi.fn(async (ritual) => ritual),
    testRun: vi.fn(async () => ({ status: "waiting" })),
    startRun: vi.fn(async () => ({ status: "run" })),
    approveRunStep: vi.fn(async () => ({ status: "run" })),
    cancelRun: vi.fn(async () => ({ status: "run" })),
    proposeLearning: vi.fn(async () => ({ status: "waiting" })),
    approveLearning: vi.fn(async (ritual) => ritual),
    close: vi.fn(async () => undefined),
  };
  const exaCredentials = {
    status: vi.fn(async () => ({
      provider: "EXA" as const,
      state: "CONFIGURATION_REQUIRED" as const,
    })),
    configure: vi.fn(async () => ({
      status: "snapshot" as const,
      snapshot: {
        provider: "EXA" as const,
        state: "CONFIGURED" as const,
        version: 1,
      },
    })),
    revoke: vi.fn(async (_expectedVersion: number) => ({
      status: "snapshot" as const,
      snapshot: {
        provider: "EXA" as const,
        state: "CONFIGURATION_REQUIRED" as const,
      },
    })),
  };
  const openExaDashboard = vi.fn(async () => undefined);

  const windowOptions = () => ({
    preloadPath: "/app/ritual-builder-bridge.cjs",
    controller,
    exaCredentials,
    openExaDashboard,
  });

  beforeEach(() => {
    electron.windows.length = 0;
    electron.views.length = 0;
    electron.loadError = null;
    electron.dialogResponse = 0;
    electron.handlers.clear();
    vi.clearAllMocks();
  });

  it("shows after load and disposes the child view exactly once", async () => {
    await createRitualBuilderWindow(windowOptions());
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
    expect(controller.close).not.toHaveBeenCalled();
  });

  it("disposes and destroys the window when loading fails", async () => {
    electron.loadError = new Error("renderer failed");
    await expect(createRitualBuilderWindow(windowOptions())).rejects.toThrow(
      "renderer failed",
    );
    const window = electron.windows[0]!;
    const view = electron.views[0]!;

    expect(window.contentView.removeChildView).toHaveBeenCalledOnce();
    expect(view.webContents.close).toHaveBeenCalledOnce();
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(window.show).not.toHaveBeenCalled();
  });

  it("routes only exact local-renderer IPC to the controller", async () => {
    await createRitualBuilderWindow(windowOptions());
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
    const startRun = electron.handlers.get("village:ritual-builder:start-run")!;
    const approveRunStep = electron.handlers.get(
      "village:ritual-builder:approve-run-step",
    )!;
    const cancelRun = electron.handlers.get(
      "village:ritual-builder:cancel-run",
    )!;
    const proposeLearning = electron.handlers.get(
      "village:ritual-builder:propose-learning",
    )!;
    const approveLearning = electron.handlers.get(
      "village:ritual-builder:approve-learning",
    )!;
    const automationState = electron.handlers.get(
      "village:ritual-builder:get-automation-state",
    )!;
    const configureSchedule = electron.handlers.get(
      "village:ritual-builder:configure-schedule",
    )!;
    const pauseSchedule = electron.handlers.get(
      "village:ritual-builder:pause-schedule",
    )!;
    const exaStatus = electron.handlers.get(
      "village:ritual-builder:get-exa-credential-status",
    )!;
    const configureExa = electron.handlers.get(
      "village:ritual-builder:configure-exa-api-key",
    )!;
    const removeExa = electron.handlers.get(
      "village:ritual-builder:remove-exa-api-key",
    )!;
    const openDashboard = electron.handlers.get(
      "village:ritual-builder:open-exa-dashboard",
    )!;

    const initialized = (await initialize(event)) as {
      identity: { draftId: string; ritualId: string };
    };
    await draft(event, { draftId: initialized.identity.draftId });
    await approve(event, {
      ritualId: initialized.identity.ritualId,
      approvedDraftId: initialized.identity.draftId,
    });
    await testRun(event, { ritualId: initialized.identity.ritualId });
    await startRun(event, { ritualId: initialized.identity.ritualId });
    await approveRunStep(event, { runId: "bounded" });
    await cancelRun(event, { runId: "bounded" });
    await proposeLearning(event, { ritualId: initialized.identity.ritualId });
    await approveLearning(event, { ritualId: initialized.identity.ritualId });
    await automationState(event);
    await configureSchedule(event, { ritualId: initialized.identity.ritualId });
    await pauseSchedule(event, { ritualId: initialized.identity.ritualId });
    const apiKey = new TextEncoder().encode("exa-owner-secret");
    await expect(exaStatus(event)).resolves.toMatchObject({
      state: "CONFIGURATION_REQUIRED",
    });
    await expect(configureExa(event, apiKey)).resolves.toMatchObject({
      snapshot: { state: "CONFIGURED" },
    });
    exaCredentials.status.mockResolvedValueOnce({
      provider: "EXA" as const,
      state: "CONFIGURED" as const,
      version: 1,
    });
    await expect(removeExa(event)).resolves.toMatchObject({
      snapshot: { state: "CONFIGURATION_REQUIRED" },
    });
    await openDashboard(event);
    expect(exaCredentials.configure).toHaveBeenCalledWith(apiKey);
    expect(exaCredentials.revoke).toHaveBeenCalledWith(1);
    expect(openExaDashboard).toHaveBeenCalledOnce();
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
    expect(controller.startRun).toHaveBeenCalledWith({
      ritualId: initialized.identity.ritualId,
    });
    expect(controller.approveRunStep).toHaveBeenCalledWith({
      runId: "bounded",
    });
    expect(controller.cancelRun).toHaveBeenCalledWith({ runId: "bounded" });
    expect(controller.proposeLearning).toHaveBeenCalledWith({
      ritualId: initialized.identity.ritualId,
    });
    expect(controller.approveLearning).toHaveBeenCalledWith({
      ritualId: initialized.identity.ritualId,
    });
    expect(controller.loadAutomationState).toHaveBeenCalled();
    expect(controller.configureSchedule).toHaveBeenCalledWith({
      ritualId: initialized.identity.ritualId,
    });
    expect(controller.pauseSchedule).toHaveBeenCalledWith({
      ritualId: initialized.identity.ritualId,
    });
    await expect(automationState(event, "extra")).rejects.toThrow(
      "MALFORMED_IPC_REQUEST",
    );

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
      run: null,
      runReceipt: null,
    });
    await createRitualBuilderWindow(windowOptions());
    const initialize = electron.handlers.get(
      "village:ritual-builder:initialize",
    )!;

    await expect(
      initialize({ sender: electron.views[0]!.webContents }),
    ).resolves.toMatchObject({ approved, receipt });
    expect(controller.loadLatestState).toHaveBeenCalledOnce();
  });

  it("keeps the Exa key when removal is canceled and rejects extra IPC fields", async () => {
    electron.dialogResponse = 1;
    exaCredentials.status
      .mockResolvedValueOnce({
        provider: "EXA" as const,
        state: "CONFIGURED" as const,
        version: 4,
      })
      .mockResolvedValueOnce({
        provider: "EXA" as const,
        state: "CONFIGURED" as const,
        version: 4,
      });
    await createRitualBuilderWindow(windowOptions());
    const event = { sender: electron.views[0]!.webContents };
    const exaStatus = electron.handlers.get(
      "village:ritual-builder:get-exa-credential-status",
    )!;
    const configureExa = electron.handlers.get(
      "village:ritual-builder:configure-exa-api-key",
    )!;
    const removeExa = electron.handlers.get(
      "village:ritual-builder:remove-exa-api-key",
    )!;
    const openDashboard = electron.handlers.get(
      "village:ritual-builder:open-exa-dashboard",
    )!;

    await expect(removeExa(event)).resolves.toMatchObject({
      snapshot: { state: "CONFIGURED", version: 4 },
    });
    expect(exaCredentials.revoke).not.toHaveBeenCalled();
    expect(exaCredentials.status).toHaveBeenCalledTimes(2);
    await expect(exaStatus(event, "extra")).rejects.toThrow(
      "MALFORMED_IPC_REQUEST",
    );
    await expect(
      configureExa(event, new Uint8Array(8), "extra"),
    ).rejects.toThrow("MALFORMED_IPC_REQUEST");
    await expect(removeExa(event, "extra")).rejects.toThrow(
      "MALFORMED_IPC_REQUEST",
    );
    await expect(openDashboard(event, "extra")).rejects.toThrow(
      "MALFORMED_IPC_REQUEST",
    );
  });
});
