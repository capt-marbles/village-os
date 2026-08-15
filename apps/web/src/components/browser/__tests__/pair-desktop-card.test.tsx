// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PairDesktopCard } from "../PairDesktopCard.js";
import type { PairingSetupClient } from "../pairing-setup-client.js";

afterEach(cleanup);

describe("pair desktop card", () => {
  it("starts with a public-only, accessible pairing ceremony", () => {
    const html = renderToStaticMarkup(
      <PairDesktopCard client={{} as PairingSetupClient} />,
    );
    expect(html).toContain("Add desktop");
    expect(html).toContain("Public pairing request");
    expect(html).toContain("no password, cookies, or private key");
    expect(html).toContain("Review desktop");
    expect(html).not.toContain("pairing secret");
  });

  it("offers a safe retry after the desktop already consumed the challenge", async () => {
    const challenge = {
      principalId: "prn_01J00000000000000000000000",
      pairingId: "par_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      fingerprint: "A1B2C3D4E5F60708",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const createSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("FIXTURE_TEMPORARILY_UNAVAILABLE"))
      .mockResolvedValueOnce({
        jobId: "job_01J00000000000000000000000",
        browserSessionId: "brs_01J00000000000000000000000",
        hostId: "hst_01J00000000000000000000000",
        fixtureBrowserSessionId: "brs_01J00000000000000000000001",
      });
    const client = {
      begin: vi.fn().mockResolvedValue(challenge),
      confirm: vi.fn().mockResolvedValue(undefined),
      status: vi.fn().mockResolvedValue("CONSUMED"),
      createSession,
    } as unknown as PairingSetupClient;
    render(<PairDesktopCard client={client} />);

    fireEvent.change(screen.getByLabelText("Public pairing request"), {
      target: {
        value: JSON.stringify({
          deviceId: challenge.deviceId,
          deviceDisplayName: "Andrew's Mac",
          publicKey: { kty: "OKP", crv: "Ed25519", x: "cHVibGljX2tleQ" },
          protection: "OS_PROTECTED_FALLBACK",
          secretHash: "a".repeat(43),
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review desktop" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm desktop" }),
    );
    fireEvent.click(
      await screen.findByRole("link", { name: "Continue on this Mac" }),
    );

    expect(
      await screen.findByText(
        /desktop is paired, but browser setup is incomplete/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/copy a fresh request/i)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry browser setup" }),
    );

    expect(
      await screen.findByRole("link", { name: "Open assigned browser" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open without continuity" }),
    ).toBeTruthy();
    expect(createSession).toHaveBeenCalledTimes(2);
  });
});
