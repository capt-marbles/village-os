import { describe, expect, it, vi } from "vitest";
import {
  installFixtureSessionHandler,
  type FixtureProtocol,
} from "../src/main/fixture-session-handler.js";

describe("fixture session handler", () => {
  it("installs an exact-origin handler on only the supplied dedicated protocol", async () => {
    let callback: ((request: Request) => Promise<Response>) | undefined;
    const protocol: FixtureProtocol = {
      handle: vi.fn(async (_scheme, handler) => {
        callback = handler;
      }),
      unhandle: vi.fn(async () => undefined),
    };
    const application = vi.fn(async () => new Response("fixture"));
    const close = await installFixtureSessionHandler(protocol, application);
    await expect(
      callback!(new Request("https://fixture.village.test/setup")),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      callback!(new Request("https://fixture.village.test.evil/setup")),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      callback!(new Request("https://fixture.village.test:444/setup")),
    ).resolves.toMatchObject({ status: 403 });
    await close();
    expect(protocol.unhandle).toHaveBeenCalledWith("https");
  });
});
