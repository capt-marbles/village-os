// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContinuitySetupCard } from "../ContinuitySetupCard.js";

const source = {
  deviceId: "dev_01J00000000000000000000001",
  browserSessionId: "brs_01J00000000000000000000001",
  deviceName: "Studio Mac",
  connection: "ONLINE" as const,
  recipientKeyState: "MISSING" as const,
};
const destination = {
  deviceId: "dev_01J00000000000000000000002",
  browserSessionId: "brs_01J00000000000000000000002",
  deviceName: "Travel Mac",
  connection: "OFFLINE" as const,
  recipientKeyState: "READY" as const,
};

afterEach(cleanup);

describe("continuity setup card", () => {
  it("guides the owner through a concise review before creating a handoff", async () => {
    const grant = {
      grantId: "cgr_01J00000000000000000000009",
      sourceDeviceId: source.deviceId,
      destinationDeviceId: destination.deviceId,
      sourceBrowserSessionId: source.browserSessionId,
      destinationBrowserSessionId: destination.browserSessionId,
      site: "OWNED_FIXTURE" as const,
      state: "ACTIVE" as const,
      createdAt: "2026-08-15T21:00:00.000Z",
      expiresAt: "2026-08-22T21:00:00.000Z",
    };
    const client = {
      load: vi.fn(async () => ({
        ok: true as const,
        sessions: [source, destination],
        grants: [],
      })),
      createGrant: vi.fn(async () => grant),
      revokeGrant: vi.fn(async () => undefined),
    };
    render(<ContinuitySetupCard client={client} />);

    expect(
      screen.getByRole("heading", { name: "Keep work on another Mac" }),
    ).toBeTruthy();
    await screen.findByText("Two paired Macs are available.");
    fireEvent.click(screen.getByRole("button", { name: "Set up handoff" }));

    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Studio Mac/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Travel Mac/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review handoff" }));

    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    expect(
      screen.getByText(
        (_content, element) =>
          element?.textContent === "Studio Mac → Travel Mac",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Village demo account only")).toBeTruthy();
    expect(screen.getByText("Expires after 7 days")).toBeTruthy();
    expect(
      screen.getByText(/Cloudflare stores encrypted session data/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve handoff" }));

    await screen.findByText("Handoff ready");
    expect(client.createGrant).toHaveBeenCalledWith(source, destination);
    fireEvent.click(screen.getByRole("button", { name: "Stop handoff" }));
    await waitFor(() =>
      expect(client.revokeGrant).toHaveBeenCalledWith(grant.grantId),
    );
    expect(await screen.findByText("Handoff stopped")).toBeTruthy();
  });

  it("keeps the unavailable state honest and fixture-only", async () => {
    const client = {
      load: vi.fn(async () => ({
        ok: true as const,
        sessions: [],
        grants: [],
      })),
      createGrant: vi.fn(),
      revokeGrant: vi.fn(),
    };
    render(<ContinuitySetupCard client={client} />);

    await screen.findByText("Pair two Macs to try the demo handoff.");
    expect(screen.getByText("LinkedIn stays local for now.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up handoff" })).toBeNull();
  });

  it("does not start setup until a distinct destination is enrolled", async () => {
    const client = {
      load: vi.fn(async () => ({
        ok: true as const,
        sessions: [
          source,
          { ...destination, recipientKeyState: "STALE" as const },
        ],
        grants: [],
      })),
      createGrant: vi.fn(),
      revokeGrant: vi.fn(),
    };
    render(<ContinuitySetupCard client={client} />);

    await screen.findByText(
      "Finish continuity enrollment on a destination Mac.",
    );
    expect(screen.queryByRole("button", { name: "Set up handoff" })).toBeNull();
  });
});
