import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("Ritual Builder preload", () => {
  it("exposes only the fixed Ritual and Exa credential operations", async () => {
    const source = await readFile(
      new URL("../src/preload/ritual-builder-bridge.cjs", import.meta.url),
      "utf8",
    );
    let bridge: Record<string, (...arguments_: unknown[]) => unknown> = {};
    const invoke = vi.fn(async () => undefined);
    vm.runInNewContext(source, {
      require: () => ({
        contextBridge: {
          exposeInMainWorld: (_name: string, value: typeof bridge) => {
            bridge = value;
          },
        },
        ipcRenderer: { invoke },
      }),
      Object,
    });
    expect(Object.keys(bridge).sort()).toEqual([
      "approve",
      "approveLearning",
      "approveRunStep",
      "cancelRun",
      "configureExaApiKey",
      "configureSchedule",
      "createDraftIdentity",
      "decideLearning",
      "draft",
      "getAuditTimeline",
      "getAutomationState",
      "getExaCredentialStatus",
      "getRituals",
      "initialize",
      "openExaDashboard",
      "pauseSchedule",
      "proposeLearning",
      "removeExaApiKey",
      "restoreRevision",
      "selectRitual",
      "startRun",
      "testRun",
    ]);
    await bridge.initialize!();
    await bridge.createDraftIdentity!();
    await bridge.draft!({ purpose: "bounded" });
    await bridge.approve!({ ritualId: "bounded" });
    await bridge.restoreRevision!({
      ritualId: "bounded",
      restoreFromRevision: 1,
    });
    await bridge.selectRitual!("rtl_01J00000000000000000000000");
    await bridge.getRituals!();
    await bridge.testRun!({ ritualId: "bounded", sample: "bounded" });
    await bridge.startRun!({ ritualId: "bounded" });
    await bridge.approveRunStep!({ runId: "bounded" });
    await bridge.cancelRun!({ runId: "bounded" });
    await bridge.proposeLearning!({ ritualId: "bounded", feedback: "bounded" });
    await bridge.approveLearning!({ ritualId: "bounded" });
    const key = new Uint8Array([1, 2, 3]);
    await bridge.getExaCredentialStatus!();
    await bridge.configureExaApiKey!(key);
    await bridge.removeExaApiKey!();
    await bridge.openExaDashboard!();
    await bridge.getAutomationState!();
    await bridge.configureSchedule!({ ritualId: "bounded" });
    await bridge.pauseSchedule!({ ritualId: "bounded" });
    await bridge.decideLearning!({ ritualId: "bounded" });
    await bridge.getAuditTimeline!();
    expect(invoke.mock.calls).toEqual([
      ["village:ritual-builder:initialize"],
      ["village:ritual-builder:create-draft-identity"],
      ["village:ritual-builder:draft", { purpose: "bounded" }],
      ["village:ritual-builder:approve", { ritualId: "bounded" }],
      [
        "village:ritual-builder:restore-revision",
        { ritualId: "bounded", restoreFromRevision: 1 },
      ],
      [
        "village:ritual-builder:select-ritual",
        "rtl_01J00000000000000000000000",
      ],
      ["village:ritual-builder:get-rituals"],
      [
        "village:ritual-builder:test-run",
        { ritualId: "bounded", sample: "bounded" },
      ],
      ["village:ritual-builder:start-run", { ritualId: "bounded" }],
      ["village:ritual-builder:approve-run-step", { runId: "bounded" }],
      ["village:ritual-builder:cancel-run", { runId: "bounded" }],
      [
        "village:ritual-builder:propose-learning",
        { ritualId: "bounded", feedback: "bounded" },
      ],
      ["village:ritual-builder:approve-learning", { ritualId: "bounded" }],
      ["village:ritual-builder:get-exa-credential-status"],
      ["village:ritual-builder:configure-exa-api-key", key],
      ["village:ritual-builder:remove-exa-api-key"],
      ["village:ritual-builder:open-exa-dashboard"],
      ["village:ritual-builder:get-automation-state"],
      ["village:ritual-builder:configure-schedule", { ritualId: "bounded" }],
      ["village:ritual-builder:pause-schedule", { ritualId: "bounded" }],
      ["village:ritual-builder:decide-learning", { ritualId: "bounded" }],
      ["village:ritual-builder:get-audit-timeline"],
    ]);
  });
});
