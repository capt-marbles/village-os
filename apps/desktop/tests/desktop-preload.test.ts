import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("desktop preload bridge", () => {
  it("exposes only fixed UI operations and removable state subscription", async () => {
    const source = await readFile(
      new URL("../src/preload/village-bridge.cjs", import.meta.url),
      "utf8",
    );
    const bridges: Record<
      string,
      Record<string, (...arguments_: unknown[]) => unknown>
    > = {};
    const invoke = vi.fn(async () => undefined);
    const on = vi.fn();
    const removeListener = vi.fn();
    vm.runInNewContext(source, {
      require: () => ({
        contextBridge: {
          exposeInMainWorld: (
            name: string,
            value: (typeof bridges)[string],
          ) => {
            bridges[name] = value;
          },
        },
        ipcRenderer: { invoke, on, removeListener },
      }),
      Object,
      TypeError,
    });

    const bridge = bridges.village!;
    expect(Object.keys(bridge).sort()).toEqual([
      "beginChatGptLogin",
      "cancelChatGptLogin",
      "getBrowserDiagnostics",
      "getBrowserUiState",
      "getModelProviderAccount",
      "recordVerificationDecision",
      "requestForgetSession",
      "requestObserverIntent",
      "requestReturnControl",
      "requestTakeover",
      "runPersonalAgentTask",
      "setBrowserPane",
      "subscribeBrowserDiagnostics",
      "subscribeBrowserUiState",
      "subscribePersonalAgentTaskActivity",
    ]);
    expect(bridge.invoke).toBeUndefined();
    expect(Object.keys(bridges.villagePairing!).sort()).toEqual([
      "getPairingRequest",
      "subscribePairingState",
    ]);

    const listener = vi.fn();
    const unsubscribe = bridge.subscribeBrowserUiState!(listener);
    expect(on).toHaveBeenCalledWith(
      "village:browser-ui-state",
      expect.any(Function),
    );
    expect(typeof unsubscribe).toBe("function");
    (unsubscribe as () => void)();
    expect(removeListener).toHaveBeenCalledWith(
      "village:browser-ui-state",
      expect.any(Function),
    );

    const unsubscribeDiagnostics =
      bridge.subscribeBrowserDiagnostics!(listener);
    expect(on).toHaveBeenCalledWith(
      "village:browser-diagnostics",
      expect.any(Function),
    );
    (unsubscribeDiagnostics as () => void)();
    expect(removeListener).toHaveBeenCalledWith(
      "village:browser-diagnostics",
      expect.any(Function),
    );

    const unsubscribeTaskActivity =
      bridge.subscribePersonalAgentTaskActivity!(listener);
    expect(on).toHaveBeenCalledWith(
      "village:personal-agent-task-activity",
      expect.any(Function),
    );
    (unsubscribeTaskActivity as () => void)();
    expect(removeListener).toHaveBeenCalledWith(
      "village:personal-agent-task-activity",
      expect.any(Function),
    );

    await bridge.getModelProviderAccount!();
    await bridge.beginChatGptLogin!();
    await bridge.cancelChatGptLogin!();
    await bridge.runPersonalAgentTask!({ task: "CHECK_LINKEDIN_SIGN_IN" });
    expect(invoke).toHaveBeenCalledWith("village:get-model-provider-account");
    expect(invoke).toHaveBeenCalledWith("village:begin-chatgpt-login");
    expect(invoke).toHaveBeenCalledWith("village:cancel-chatgpt-login");
    expect(invoke).toHaveBeenCalledWith("village:run-personal-agent-task", {
      task: "CHECK_LINKEDIN_SIGN_IN",
    });
  });
});
