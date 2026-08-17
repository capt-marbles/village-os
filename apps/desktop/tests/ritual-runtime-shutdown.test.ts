import { describe, expect, it, vi } from "vitest";
import { createRitualShutdownHandler } from "../src/main/ritual-runtime-shutdown.js";

describe("Ritual runtime shutdown", () => {
  it("holds the first quit until scheduler and controller shutdown finish", async () => {
    let finishScheduler!: () => void;
    const schedulerClose = new Promise<void>((resolve) => {
      finishScheduler = resolve;
    });
    const services = {
      scheduler: { close: vi.fn(async () => schedulerClose) },
      controller: { close: vi.fn(async () => undefined) },
    };
    const application = { quit: vi.fn() };
    const clear = vi.fn();
    const handler = createRitualShutdownHandler(
      application,
      () => services,
      clear,
    );
    const event = { preventDefault: vi.fn() };

    handler(event);
    handler(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(application.quit).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledOnce();

    finishScheduler();
    await schedulerClose;
    await vi.waitFor(() => expect(application.quit).toHaveBeenCalledOnce());
    expect(services.controller.close).toHaveBeenCalledOnce();

    handler(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
  });
});
