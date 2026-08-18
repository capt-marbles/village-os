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
    listRituals: vi.fn(async () => []),
    loadInitialWorkspaceState: vi.fn(async () => ({
      approved: null,
      receipt: null,
      run: null,
      runReceipt: null,
      learningReview: null,
      auditTimeline: [],
      rituals: [],
      schedule: null,
      inbox: [],
    })),
    loadRitualWorkspaceState: vi.fn(async () => ({
      approved: null,
      receipt: null,
      run: null,
      runReceipt: null,
      learningReview: null,
      auditTimeline: [],
      schedule: null,
      inbox: [],
    })),
    loadLatestState: vi.fn(async () => ({
      approved: null,
      receipt: null,
      run: null,
      runReceipt: null,
      learningReview: null,
      auditTimeline: [],
    })),
    loadRitualState: vi.fn(async () => ({
      approved: null,
      receipt: null,
      run: null,
      runReceipt: null,
      learningReview: null,
      auditTimeline: [],
    })),
    loadAuditTimeline: vi.fn(async () => []),
    loadAutomationState: vi.fn(async () => ({
      schedule: null,
      inbox: [],
    })),
    configureSchedule: vi.fn(async (schedule) => schedule),
    pauseSchedule: vi.fn(async (schedule) => schedule),
    draft: vi.fn(async () => ({ status: "waiting" })),
    followUp: vi.fn(async (request) => ({
      status: "answer",
      ...request,
      answer: "Bounded answer",
    })),
    approve: vi.fn(async (ritual) => ritual),
    restoreRevision: vi.fn(async (ritual) => ritual),
    testRun: vi.fn(async () => ({ status: "waiting" })),
    startRun: vi.fn(async () => ({ status: "run" })),
    approveRunStep: vi.fn(async () => ({ status: "run" })),
    cancelRun: vi.fn(async () => ({ status: "run" })),
    proposeLearning: vi.fn(async () => ({ status: "waiting" })),
    approveLearning: vi.fn(async (ritual) => ritual),
    decideLearning: vi.fn(async () => undefined),
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
  const gmailCredentials = {
    status: vi.fn(async () => ({
      provider: "GMAIL" as const,
      state: "DISCONNECTED" as const,
    })),
    connect: vi.fn(async () => ({
      status: "snapshot" as const,
      snapshot: {
        provider: "GMAIL" as const,
        state: "CONNECTED" as const,
        accountEmail: "owner@example.com",
        version: 1,
      },
    })),
    disconnect: vi.fn(async () => ({
      status: "snapshot" as const,
      snapshot: {
        provider: "GMAIL" as const,
        state: "DISCONNECTED" as const,
      },
    })),
  };

  const windowOptions = () => ({
    preloadPath: "/app/ritual-builder-bridge.cjs",
    controller,
    exaCredentials,
    openExaDashboard,
    gmailCredentials,
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

  it("selects one known Ritual and scopes later reads to it", async () => {
    await createRitualBuilderWindow(windowOptions());
    const sender = electron.views[0]!.webContents;
    const select = electron.handlers.get(
      "village:ritual-builder:select-ritual",
    )!;
    const automation = electron.handlers.get(
      "village:ritual-builder:get-automation-state",
    )!;
    const audit = electron.handlers.get(
      "village:ritual-builder:get-audit-timeline",
    )!;
    const ritualId = "rtl_01J00000000000000000000000";

    await select({ sender }, ritualId);
    await automation({ sender });
    await audit({ sender });

    expect(controller.loadRitualWorkspaceState).toHaveBeenCalledWith(ritualId);
    expect(controller.loadAutomationState).toHaveBeenLastCalledWith(ritualId);
    expect(controller.loadAuditTimeline).toHaveBeenLastCalledWith(ritualId);
  });

  it("allows a follow-up only for the explicitly selected Ritual", async () => {
    const ritualId = "rtl_01J00000000000000000000000";
    controller.loadInitialWorkspaceState.mockResolvedValueOnce({
      approved: { ritualId } as never,
      receipt: null,
      run: null,
      runReceipt: null,
      learningReview: null,
      auditTimeline: [],
      rituals: [],
      schedule: null,
      inbox: [],
    });
    await createRitualBuilderWindow(windowOptions());
    const event = { sender: electron.views[0]!.webContents };
    await electron.handlers.get("village:ritual-builder:initialize")!(event);
    const followUp = electron.handlers.get("village:ritual-builder:follow-up")!;
    const request = {
      schemaVersion: 1,
      requestId: "rfu_01J00000000000000000000000",
      ritualId,
      ritualRevision: 1,
      question: "What needs my attention?",
    };

    await expect(followUp(event, request)).resolves.toMatchObject({
      status: "answer",
    });
    await expect(
      followUp(event, {
        ...request,
        ritualId: "rtl_01J00000000000000000000009",
      }),
    ).rejects.toThrow("STALE_RITUAL_SELECTION");
    await expect(followUp(event, request, "extra")).rejects.toThrow(
      "MALFORMED_IPC_REQUEST",
    );
    await expect(
      followUp(event, { ...request, unexpected: true }),
    ).rejects.toThrow();
    await expect(followUp({ sender: {} }, request)).rejects.toThrow(
      "UNTRUSTED_RITUAL_BUILDER_SENDER",
    );
  });

  it("keeps a newer explicit selection after an earlier approval settles", async () => {
    let resolveApproval!: (value: { ritualId: string }) => void;
    controller.approve.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          resolveApproval = resolve;
        }),
    );
    await createRitualBuilderWindow(windowOptions());
    const sender = electron.views[0]!.webContents;
    const event = { sender };
    const initialize = electron.handlers.get(
      "village:ritual-builder:initialize",
    )!;
    const approve = electron.handlers.get("village:ritual-builder:approve")!;
    const select = electron.handlers.get(
      "village:ritual-builder:select-ritual",
    )!;
    const automation = electron.handlers.get(
      "village:ritual-builder:get-automation-state",
    )!;
    const initialized = (await initialize(event)) as {
      identity: { draftId: string; ritualId: string };
    };
    const pendingApproval = approve(event, {
      ritualId: initialized.identity.ritualId,
      approvedDraftId: initialized.identity.draftId,
    });
    const selectedRitualId = "rtl_01J00000000000000000000009";
    await select(event, selectedRitualId);
    resolveApproval({ ritualId: initialized.identity.ritualId });
    await pendingApproval;
    await automation(event);

    expect(controller.loadAutomationState).toHaveBeenLastCalledWith(
      selectedRitualId,
    );
  });

  it("does not project a prior Ritual while a new draft is active", async () => {
    await createRitualBuilderWindow(windowOptions());
    const event = { sender: electron.views[0]!.webContents };
    await electron.handlers.get("village:ritual-builder:initialize")!(event);
    await electron.handlers.get(
      "village:ritual-builder:create-draft-identity",
    )!(event);

    await expect(
      electron.handlers.get("village:ritual-builder:get-automation-state")!(
        event,
      ),
    ).resolves.toEqual({ schedule: null, inbox: [] });
    await expect(
      electron.handlers.get("village:ritual-builder:get-audit-timeline")!(
        event,
      ),
    ).resolves.toEqual([]);
    expect(controller.loadAutomationState).not.toHaveBeenCalled();
    expect(controller.loadAuditTimeline).not.toHaveBeenCalled();
  });

  it("keeps the current Ritual when a selected workspace cannot load", async () => {
    const currentRitualId = "rtl_01J00000000000000000000000";
    controller.loadInitialWorkspaceState.mockResolvedValueOnce({
      approved: { ritualId: currentRitualId } as never,
      receipt: null,
      run: null,
      runReceipt: null,
      learningReview: null,
      auditTimeline: [],
      rituals: [],
      schedule: null,
      inbox: [],
    });
    controller.loadRitualWorkspaceState.mockRejectedValueOnce(
      new Error("RITUAL_NOT_FOUND"),
    );
    await createRitualBuilderWindow(windowOptions());
    const event = { sender: electron.views[0]!.webContents };
    await electron.handlers.get("village:ritual-builder:initialize")!(event);
    await expect(
      electron.handlers.get("village:ritual-builder:select-ritual")!(
        event,
        "rtl_01J00000000000000000000009",
      ),
    ).rejects.toThrow("RITUAL_NOT_FOUND");
    await electron.handlers.get("village:ritual-builder:get-automation-state")!(
      event,
    );

    expect(controller.loadAutomationState).toHaveBeenLastCalledWith(
      currentRitualId,
    );
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
    const restoreRevision = electron.handlers.get(
      "village:ritual-builder:restore-revision",
    )!;
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
    const decideLearning = electron.handlers.get(
      "village:ritual-builder:decide-learning",
    )!;
    const automationState = electron.handlers.get(
      "village:ritual-builder:get-automation-state",
    )!;
    const selectRitual = electron.handlers.get(
      "village:ritual-builder:select-ritual",
    )!;
    const ritualCatalog = electron.handlers.get(
      "village:ritual-builder:get-rituals",
    )!;
    const auditTimeline = electron.handlers.get(
      "village:ritual-builder:get-audit-timeline",
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
    const gmailStatus = electron.handlers.get(
      "village:ritual-builder:get-gmail-connection-status",
    )!;
    const connectGmail = electron.handlers.get(
      "village:ritual-builder:connect-gmail",
    )!;
    const disconnectGmail = electron.handlers.get(
      "village:ritual-builder:disconnect-gmail",
    )!;

    const initialized = (await initialize(event)) as {
      identity: { draftId: string; ritualId: string };
    };
    await draft(event, { draftId: initialized.identity.draftId });
    await approve(event, {
      ritualId: initialized.identity.ritualId,
      approvedDraftId: initialized.identity.draftId,
    });
    await restoreRevision(event, {
      ritualId: initialized.identity.ritualId,
      restoreFromRevision: 1,
    });
    await testRun(event, { ritualId: initialized.identity.ritualId });
    await startRun(event, { ritualId: initialized.identity.ritualId });
    await approveRunStep(event, { runId: "bounded" });
    await cancelRun(event, { runId: "bounded" });
    await proposeLearning(event, { ritualId: initialized.identity.ritualId });
    await approveLearning(event, { ritualId: initialized.identity.ritualId });
    await decideLearning(event, { ritualId: initialized.identity.ritualId });
    await automationState(event);
    await auditTimeline(event);
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
    await expect(gmailStatus(event)).resolves.toMatchObject({
      state: "DISCONNECTED",
    });
    await expect(connectGmail(event)).resolves.toMatchObject({
      snapshot: { state: "CONNECTED" },
    });
    await expect(disconnectGmail(event)).resolves.toMatchObject({
      snapshot: { state: "DISCONNECTED" },
    });
    electron.dialogResponse = 1;
    await expect(disconnectGmail(event)).resolves.toEqual({
      status: "snapshot",
      snapshot: { provider: "GMAIL", state: "DISCONNECTED" },
    });
    expect(exaCredentials.configure).toHaveBeenCalledWith(apiKey);
    expect(exaCredentials.revoke).toHaveBeenCalledWith(1);
    expect(openExaDashboard).toHaveBeenCalledOnce();
    expect(gmailCredentials.connect).toHaveBeenCalledOnce();
    expect(gmailCredentials.disconnect).toHaveBeenCalledOnce();
    expect(controller.loadInitialWorkspaceState).toHaveBeenCalledOnce();
    expect(controller.draft).toHaveBeenCalledWith({
      draftId: initialized.identity.draftId,
    });
    expect(controller.approve).toHaveBeenCalledWith({
      ritualId: initialized.identity.ritualId,
      approvedDraftId: initialized.identity.draftId,
    });
    expect(controller.restoreRevision).toHaveBeenCalledWith({
      ritualId: initialized.identity.ritualId,
      restoreFromRevision: 1,
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
    expect(controller.decideLearning).toHaveBeenCalledWith({
      ritualId: initialized.identity.ritualId,
    });
    expect(controller.loadAutomationState).toHaveBeenLastCalledWith(
      initialized.identity.ritualId,
    );
    expect(controller.loadAuditTimeline).toHaveBeenLastCalledWith(
      initialized.identity.ritualId,
    );
    expect(controller.configureSchedule).toHaveBeenCalledWith({
      ritualId: initialized.identity.ritualId,
    });
    expect(controller.pauseSchedule).toHaveBeenCalledWith({
      ritualId: initialized.identity.ritualId,
    });
    await expect(automationState(event, "extra")).rejects.toThrow(
      "MALFORMED_IPC_REQUEST",
    );
    await expect(auditTimeline(event, "extra")).rejects.toThrow(
      "MALFORMED_IPC_REQUEST",
    );
    await expect(ritualCatalog(event, "extra")).rejects.toThrow(
      "MALFORMED_IPC_REQUEST",
    );
    await expect(
      selectRitual(event, initialized.identity.ritualId, "extra"),
    ).rejects.toThrow("MALFORMED_IPC_REQUEST");
    await expect(selectRitual(event, "not-a-ritual-id")).rejects.toThrow();
    await expect(
      selectRitual({ sender: {} }, initialized.identity.ritualId),
    ).rejects.toThrow("UNTRUSTED_RITUAL_BUILDER_SENDER");
    await expect(
      restoreRevision(
        event,
        { ritualId: initialized.identity.ritualId },
        "extra",
      ),
    ).rejects.toThrow("MALFORMED_IPC_REQUEST");

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
    controller.loadInitialWorkspaceState.mockResolvedValueOnce({
      approved: approved as never,
      receipt: receipt as never,
      run: null,
      runReceipt: null,
      learningReview: null,
      auditTimeline: [],
      rituals: [],
      schedule: null,
      inbox: [],
    });
    await createRitualBuilderWindow(windowOptions());
    const initialize = electron.handlers.get(
      "village:ritual-builder:initialize",
    )!;

    await expect(
      initialize({ sender: electron.views[0]!.webContents }),
    ).resolves.toMatchObject({ approved, receipt });
    expect(controller.loadInitialWorkspaceState).toHaveBeenCalledOnce();
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
