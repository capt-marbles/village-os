// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailConnectionCard } from "../src/renderer/GmailConnectionCard.js";

afterEach(cleanup);

describe("Gmail connection card", () => {
  it("discloses the metadata-only boundary and connects without exposing tokens", async () => {
    const bridge = {
      getGmailConnectionStatus: vi.fn(async () => ({
        provider: "GMAIL" as const,
        state: "DISCONNECTED" as const,
      })),
      connectGmail: vi.fn(async () => ({
        status: "snapshot" as const,
        snapshot: {
          provider: "GMAIL" as const,
          state: "CONNECTED" as const,
          accountEmail: "owner@example.com",
          version: 1,
        },
      })),
      disconnectGmail: vi.fn(),
    };

    render(<GmailConnectionCard bridge={bridge} />);
    expect(await screen.findByText("Connect Gmail")).toBeTruthy();
    expect(screen.getByText(/headers and labels/i)).toBeTruthy();
    expect(screen.getByText(/never bodies, attachments/i)).toBeTruthy();
    expect(screen.getByText(/not sent to ChatGPT/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    await waitFor(() =>
      expect(screen.getByText("owner@example.com")).toBeTruthy(),
    );
    expect(bridge.connectGmail).toHaveBeenCalledOnce();
  });

  it("keeps disconnect retryable after a bounded failure", async () => {
    const bridge = {
      getGmailConnectionStatus: vi.fn(async () => ({
        provider: "GMAIL" as const,
        state: "CONNECTED" as const,
        accountEmail: "owner@example.com",
        version: 1,
      })),
      connectGmail: vi.fn(),
      disconnectGmail: vi.fn(async () => ({
        status: "rejected" as const,
        reason: "NETWORK_UNAVAILABLE" as const,
      })),
    };

    render(<GmailConnectionCard bridge={bridge} />);
    const disconnect = await screen.findByRole("button", {
      name: "Disconnect Gmail",
    });
    fireEvent.click(disconnect);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Village could not disconnect Gmail",
    );
    expect(
      screen.getByRole("button", { name: "Disconnect Gmail" }),
    ).toBeTruthy();
  });
});
