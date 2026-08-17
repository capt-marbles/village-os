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
const activeGrant = {
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

afterEach(cleanup);

describe("continuity setup card", () => {
  it("guides the owner through a concise review before creating a handoff", async () => {
    const client = {
      load: vi.fn(async () => ({
        ok: true as const,
        sessions: [source, destination],
        grants: [],
      })),
      createGrant: vi.fn(async () => activeGrant),
      revokeGrant: vi.fn(async () => undefined),
      deleteGrant: vi.fn(async () => undefined),
      loadGrantStatus: vi.fn(async () => ({
        ok: true as const,
        grant: activeGrant,
        transfer: {
          state: "ACTIVE" as const,
          publishedRevision: 20,
          appliedRevision: 20,
          pendingRevisions: 0,
        },
      })),
    };
    render(<ContinuitySetupCard client={client} />);

    expect(
      await screen.findByRole("heading", { name: "Keep work on another Mac" }),
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
    expect(screen.getByText("Village-owned test fixture only")).toBeTruthy();
    expect(screen.getByText("Expires after 7 days")).toBeTruthy();
    expect(
      screen.getByText(/Cloudflare stores encrypted session data/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve handoff" }));

    await screen.findByText("Handoff ready");
    expect(await screen.findByText("20 updates published")).toBeTruthy();
    expect(screen.getByText("Destination applied revision 20")).toBeTruthy();
    expect(screen.getByText("Latest revision is applied")).toBeTruthy();
    expect(client.createGrant).toHaveBeenCalledWith(source, destination);
    fireEvent.click(screen.getByRole("button", { name: "Stop handoff" }));
    await waitFor(() =>
      expect(client.revokeGrant).toHaveBeenCalledWith(activeGrant.grantId),
    );
    expect(await screen.findByText("Handoff stopped")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete handoff data" }),
    );
    expect(
      screen.getByText(/permanently deletes the encrypted mailbox/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));
    await waitFor(() =>
      expect(client.deleteGrant).toHaveBeenCalledWith(activeGrant.grantId),
    );
    expect(await screen.findByText("Handoff deleted")).toBeTruthy();
  });

  it("stays out of the workspace until continuity is actionable", async () => {
    const client = {
      load: vi.fn(async () => ({
        ok: true as const,
        sessions: [],
        grants: [],
      })),
      createGrant: vi.fn(),
      revokeGrant: vi.fn(),
      deleteGrant: vi.fn(),
      loadGrantStatus: vi.fn(),
    };
    render(<ContinuitySetupCard client={client} />);

    await waitFor(() => expect(client.load).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("heading", { name: "Keep work on another Mac" }),
    ).toBeNull();
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
      deleteGrant: vi.fn(),
      loadGrantStatus: vi.fn(),
    };
    render(<ContinuitySetupCard client={client} />);

    await waitFor(() => expect(client.load).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("heading", { name: "Keep work on another Mac" }),
    ).toBeNull();
  });

  it("shows revocation discovered by status refresh", async () => {
    const revokedGrant = { ...activeGrant, state: "REVOKED" as const };
    const client = {
      load: vi.fn(async () => ({
        ok: true as const,
        sessions: [source, destination],
        grants: [activeGrant],
      })),
      createGrant: vi.fn(),
      revokeGrant: vi.fn(),
      deleteGrant: vi.fn(),
      loadGrantStatus: vi.fn(async () => ({
        ok: true as const,
        grant: revokedGrant,
        transfer: {
          state: "REVOKED" as const,
          publishedRevision: 3,
          appliedRevision: 2,
          pendingRevisions: 1,
        },
      })),
    };

    render(<ContinuitySetupCard client={client} />);

    expect(await screen.findByText("Handoff stopped")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Delete handoff data" }),
    ).toBeTruthy();
  });

  it("can delete an active handoff directly after confirmation", async () => {
    const client = {
      load: vi.fn(async () => ({
        ok: true as const,
        sessions: [source, destination],
        grants: [activeGrant],
      })),
      createGrant: vi.fn(),
      revokeGrant: vi.fn(),
      deleteGrant: vi.fn(async () => undefined),
      loadGrantStatus: vi.fn(async () => ({
        ok: true as const,
        grant: activeGrant,
        transfer: {
          state: "ACTIVE" as const,
          publishedRevision: 2,
          appliedRevision: 1,
          pendingRevisions: 1,
        },
      })),
    };

    render(<ContinuitySetupCard client={client} />);
    await screen.findByText("Handoff ready");
    fireEvent.click(
      screen.getByRole("button", { name: "Delete handoff data" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));

    await waitFor(() =>
      expect(client.deleteGrant).toHaveBeenCalledWith(activeGrant.grantId),
    );
    expect(client.revokeGrant).not.toHaveBeenCalled();
  });

  it("prioritizes an active handoff over a newer revoked record", async () => {
    const olderActiveGrant = {
      ...activeGrant,
      createdAt: "2026-08-15T20:00:00.000Z",
      expiresAt: "2026-08-22T20:00:00.000Z",
    };
    const revokedGrant = {
      ...olderActiveGrant,
      grantId: "cgr_01J00000000000000000000008",
      state: "REVOKED" as const,
      createdAt: "2026-08-15T21:00:00.000Z",
    };
    const client = {
      load: vi.fn(async () => ({
        ok: true as const,
        sessions: [source, destination],
        grants: [revokedGrant, olderActiveGrant],
      })),
      createGrant: vi.fn(),
      revokeGrant: vi.fn(),
      deleteGrant: vi.fn(),
      loadGrantStatus: vi.fn(async () => ({
        ok: true as const,
        grant: olderActiveGrant,
        transfer: {
          state: "ACTIVE" as const,
          publishedRevision: 1,
          appliedRevision: 1,
          pendingRevisions: 0,
        },
      })),
    };

    render(<ContinuitySetupCard client={client} />);

    await screen.findByText("Handoff ready");
    await waitFor(() =>
      expect(client.loadGrantStatus).toHaveBeenCalledWith(
        olderActiveGrant.grantId,
        expect.any(AbortSignal),
      ),
    );
  });

  it("shows mailbox expiry and a compact setup-load failure", async () => {
    const expiredClient = {
      load: vi.fn(async () => ({
        ok: true as const,
        sessions: [source, destination],
        grants: [activeGrant],
      })),
      createGrant: vi.fn(),
      revokeGrant: vi.fn(),
      deleteGrant: vi.fn(),
      loadGrantStatus: vi.fn(async () => ({
        ok: true as const,
        grant: activeGrant,
        transfer: {
          state: "EXPIRED" as const,
          publishedRevision: 2,
          appliedRevision: 2,
          pendingRevisions: 0,
        },
      })),
    };
    const { unmount } = render(<ContinuitySetupCard client={expiredClient} />);
    expect(await screen.findByText("Handoff expired")).toBeTruthy();
    unmount();

    const unavailableClient = {
      ...expiredClient,
      load: vi.fn(async () => Promise.reject(new Error("offline"))),
    };
    render(<ContinuitySetupCard client={unavailableClient} />);
    expect(
      (
        await screen.findByText(
          "Continuity setup is unavailable. Try again shortly.",
        )
      ).getAttribute("role"),
    ).toBe("alert");
  });
});
