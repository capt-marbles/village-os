// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExaApiKeyCard,
  type ExaCredentialBridge,
} from "../src/renderer/ExaApiKeyCard.js";

afterEach(cleanup);

function bridge(): ExaCredentialBridge {
  return {
    getExaCredentialStatus: vi.fn(async () => ({
      provider: "EXA" as const,
      state: "CONFIGURATION_REQUIRED" as const,
    })),
    configureExaApiKey: vi.fn(async () => ({
      status: "snapshot" as const,
      snapshot: {
        provider: "EXA" as const,
        state: "CONFIGURED" as const,
        version: 1,
      },
    })),
    removeExaApiKey: vi.fn(async () => ({
      status: "snapshot" as const,
      snapshot: {
        provider: "EXA" as const,
        state: "CONFIGURATION_REQUIRED" as const,
      },
    })),
    openExaDashboard: vi.fn(async () => undefined),
  };
}

describe("Exa API key setup", () => {
  it("keeps setup quiet until requested, saves a masked key, and never renders it", async () => {
    const activeBridge = bridge();
    render(<ExaApiKeyCard bridge={activeBridge} />);

    await screen.findByText("Add web research");
    expect(screen.queryByLabelText("Exa API key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect Exa" }));
    const input = screen.getByLabelText("Exa API key") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "exa-owner-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await screen.findByText("Exa key saved");
    const sent = vi.mocked(activeBridge.configureExaApiKey).mock.calls[0]?.[0];
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(sent?.every((byte) => byte === 0)).toBe(true);
    expect(document.body.textContent).not.toContain("exa-owner-secret");
    expect(screen.queryByLabelText("Exa API key")).toBeNull();
  });

  it("shows actionable bounded failures and permits a safe retry", async () => {
    const activeBridge = bridge();
    vi.mocked(activeBridge.configureExaApiKey)
      .mockResolvedValueOnce({
        status: "rejected",
        reason: "INVALID_API_KEY",
      })
      .mockResolvedValueOnce({
        status: "snapshot",
        snapshot: { provider: "EXA", state: "CONFIGURED", version: 1 },
      });
    render(<ExaApiKeyCard bridge={activeBridge} />);
    await screen.findByText("Add web research");
    fireEvent.click(screen.getByRole("button", { name: "Connect Exa" }));
    fireEvent.change(screen.getByLabelText("Exa API key"), {
      target: { value: "bad-key!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Check the key",
    );

    fireEvent.change(screen.getByLabelText("Exa API key"), {
      target: { value: "exa-owner-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await screen.findByText("Exa key saved");
    expect(activeBridge.configureExaApiKey).toHaveBeenCalledTimes(2);
  });

  it("opens the fixed dashboard and removes a configured key", async () => {
    const activeBridge = bridge();
    vi.mocked(activeBridge.getExaCredentialStatus).mockResolvedValueOnce({
      provider: "EXA",
      state: "CONFIGURED",
      version: 3,
    });
    render(<ExaApiKeyCard bridge={activeBridge} />);
    await screen.findByText("Exa key saved");

    fireEvent.click(
      screen.getByRole("button", { name: "Open Exa key dashboard" }),
    );
    await waitFor(() =>
      expect(activeBridge.openExaDashboard).toHaveBeenCalledOnce(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    await screen.findByText("Add web research");
    expect(activeBridge.removeExaApiKey).toHaveBeenCalledOnce();
  });

  it("rechecks secure storage without requiring an app restart", async () => {
    const activeBridge = bridge();
    vi.mocked(activeBridge.getExaCredentialStatus)
      .mockRejectedValueOnce(new Error("locked"))
      .mockResolvedValueOnce({
        provider: "EXA",
        state: "CONFIGURATION_REQUIRED",
      });
    render(<ExaApiKeyCard bridge={activeBridge} />);
    await screen.findByText("Web research unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Add web research");
    expect(activeBridge.getExaCredentialStatus).toHaveBeenCalledTimes(2);
  });

  it("opens at most one Exa dashboard while the external action is pending", async () => {
    const activeBridge = bridge();
    let finishOpen: (() => void) | undefined;
    vi.mocked(activeBridge.openExaDashboard).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishOpen = resolve;
        }),
    );
    render(<ExaApiKeyCard bridge={activeBridge} />);
    await screen.findByText("Add web research");
    const open = screen.getByRole("button", { name: "Get an Exa key" });
    fireEvent.click(open);
    fireEvent.click(open);

    expect(activeBridge.openExaDashboard).toHaveBeenCalledOnce();
    expect(
      (
        screen.getByRole("button", {
          name: "Opening…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    finishOpen?.();
    await screen.findByRole("button", { name: "Get an Exa key" });
  });
});
