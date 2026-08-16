import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("Ritual Builder preload", () => {
  it("exposes only the ten fixed Ritual operations", async () => {
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
      "createDraftIdentity",
      "draft",
      "initialize",
      "proposeLearning",
      "startRun",
      "testRun",
    ]);
    await bridge.initialize!();
    await bridge.createDraftIdentity!();
    await bridge.draft!({ purpose: "bounded" });
    await bridge.approve!({ ritualId: "bounded" });
    await bridge.testRun!({ ritualId: "bounded", sample: "bounded" });
    await bridge.startRun!({ ritualId: "bounded" });
    await bridge.approveRunStep!({ runId: "bounded" });
    await bridge.cancelRun!({ runId: "bounded" });
    await bridge.proposeLearning!({ ritualId: "bounded", feedback: "bounded" });
    await bridge.approveLearning!({ ritualId: "bounded" });
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      "village:ritual-builder:initialize",
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      "village:ritual-builder:create-draft-identity",
    );
    expect(invoke).toHaveBeenNthCalledWith(3, "village:ritual-builder:draft", {
      purpose: "bounded",
    });
    expect(invoke).toHaveBeenNthCalledWith(
      4,
      "village:ritual-builder:approve",
      { ritualId: "bounded" },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      5,
      "village:ritual-builder:test-run",
      { ritualId: "bounded", sample: "bounded" },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      6,
      "village:ritual-builder:start-run",
      { ritualId: "bounded" },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      7,
      "village:ritual-builder:approve-run-step",
      { runId: "bounded" },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      8,
      "village:ritual-builder:cancel-run",
      { runId: "bounded" },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      9,
      "village:ritual-builder:propose-learning",
      { ritualId: "bounded", feedback: "bounded" },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      10,
      "village:ritual-builder:approve-learning",
      { ritualId: "bounded" },
    );
  });
});
