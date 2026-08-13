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
      "getBrowserDiagnostics",
      "getBrowserUiState",
      "recordVerificationDecision",
      "requestForgetSession",
      "requestObserverIntent",
      "requestReturnControl",
      "requestTakeover",
      "setBrowserPane",
      "subscribeBrowserDiagnostics",
      "subscribeBrowserUiState",
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
  });
});
