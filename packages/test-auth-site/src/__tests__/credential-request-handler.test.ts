import { OWNED_FIXTURE_ORIGIN } from "@village/contracts";
import { describe, expect, it } from "vitest";
import { createOwnedFixtureCredentialRequestHandler } from "../credential-request-handler.js";

describe("owned fixture credential request handler", () => {
  it("renders one password destination and captures only its exact POST", async () => {
    const received: { username: string; password: string }[] = [];
    const handler = createOwnedFixtureCredentialRequestHandler({
      onDestinationRequest: async (request) => {
        received.push(request);
      },
    });
    const page = await handler(
      new Request(`${OWNED_FIXTURE_ORIGIN}/login`, { method: "GET" }),
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('autocomplete="current-password"');

    const secret = "destination-only-secret";
    const response = await handler(
      new Request(`${OWNED_FIXTURE_ORIGIN}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: "owner", password: secret }),
      }),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).not.toContain(secret);
    expect(received).toEqual([{ username: "owner", password: secret }]);
  });

  it("denies foreign origins, query strings, and additional form fields", async () => {
    const handler = createOwnedFixtureCredentialRequestHandler({
      onDestinationRequest: async () => {
        throw new Error("must not capture");
      },
    });
    await expect(
      handler(new Request("https://evil.example/login")),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      handler(new Request(`${OWNED_FIXTURE_ORIGIN}/login?next=/other`)),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      handler(
        new Request(`${OWNED_FIXTURE_ORIGIN}/login`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "username=owner&password=secret&redirect=evil",
        }),
      ),
    ).resolves.toMatchObject({ status: 400 });
  });
});
