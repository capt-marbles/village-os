// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VillageIdentityGate } from "../VillageIdentityGate.js";
import type { VillageIdentityClient } from "../village-identity-client.js";

afterEach(cleanup);

describe("Village Identity gate", () => {
  it("reveals handoff controls only after the authenticated identity resolves", async () => {
    let resolveIdentity!: (value: {
      authenticated: true;
      principalId: "prn_01J00000000000000000000000";
      provider: "CLOUDFLARE_ACCESS";
      email: "owner@example.com";
      signOutPath: "/cdn-cgi/access/logout";
    }) => void;
    const load = vi.fn(
      () =>
        new Promise<Parameters<typeof resolveIdentity>[0]>((resolve) => {
          resolveIdentity = resolve;
        }),
    );
    const client = { load } as unknown as VillageIdentityClient;

    render(
      <VillageIdentityGate client={client}>
        <button type="button">Approve handoff</button>
      </VillageIdentityGate>,
    );

    expect(screen.getByRole("status").textContent).toMatch(
      /checking village sign-in/i,
    );
    expect(
      screen.queryByRole("button", { name: "Approve handoff" }),
    ).toBeNull();

    resolveIdentity({
      authenticated: true,
      principalId: "prn_01J00000000000000000000000",
      provider: "CLOUDFLARE_ACCESS",
      email: "owner@example.com",
      signOutPath: "/cdn-cgi/access/logout",
    });

    expect(await screen.findByText("owner@example.com")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approve handoff" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Sign out" }).getAttribute("href"),
    ).toBe("/cdn-cgi/access/logout");
  });

  it("keeps handoff controls unavailable when the session cannot authenticate", async () => {
    const client = {
      load: vi.fn().mockRejectedValue(new Error("UNAUTHENTICATED")),
    } as unknown as VillageIdentityClient;

    render(
      <VillageIdentityGate client={client}>
        <button type="button">Approve handoff</button>
      </VillageIdentityGate>,
    );

    expect(
      await screen.findByRole("link", { name: "Sign in to Village" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Approve handoff" }),
    ).toBeNull();
  });
});
