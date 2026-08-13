import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ModelProviderAccountCard,
  dispatchModelProviderAccountAction,
  startModelProviderAccountPolling,
  type ModelProviderAccountBridge,
} from "../src/renderer/ModelProviderAccountCard.js";

function bridge(): ModelProviderAccountBridge {
  return {
    getModelProviderAccount: vi.fn(async () => ({
      provider: "CHATGPT",
      state: "AUTHENTICATION_REQUIRED",
    })),
    beginChatGptLogin: vi.fn(async () => ({
      provider: "CHATGPT",
      state: "AUTHENTICATING",
    })),
    cancelChatGptLogin: vi.fn(async () => ({
      provider: "CHATGPT",
      state: "AUTHENTICATION_REQUIRED",
    })),
  };
}

describe("ChatGPT account onboarding", () => {
  it("explains the local credential boundary before sign-in", () => {
    const html = renderToStaticMarkup(
      <ModelProviderAccountCard
        snapshot={{
          provider: "CHATGPT",
          state: "AUTHENTICATION_REQUIRED",
        }}
        pending={false}
        onAction={() => undefined}
      />,
    );

    expect(html).toContain("Connect ChatGPT");
    expect(html).toContain("never receives your password");
    expect(html).toContain("Sign in with ChatGPT");
  });

  it("shows truthful active, connected, and unavailable states", () => {
    const active = renderToStaticMarkup(
      <ModelProviderAccountCard
        snapshot={{ provider: "CHATGPT", state: "AUTHENTICATING" }}
        pending={false}
        onAction={() => undefined}
      />,
    );
    const connected = renderToStaticMarkup(
      <ModelProviderAccountCard
        snapshot={{
          provider: "CHATGPT",
          state: "AUTHENTICATED",
          accountType: "chatgpt",
        }}
        pending={false}
        onAction={() => undefined}
      />,
    );
    const unavailable = renderToStaticMarkup(
      <ModelProviderAccountCard
        snapshot={{
          provider: "CHATGPT",
          state: "UNAVAILABLE",
          errorCode: "PROVIDER_UNAVAILABLE",
        }}
        pending={false}
        onAction={() => undefined}
      />,
    );

    expect(active).toContain("Finish signing in");
    expect(active).toContain("Waiting for OpenAI sign-in");
    expect(connected).toContain("ChatGPT connected");
    expect(unavailable).toContain('role="alert"');
    expect(unavailable).toContain("ChatGPT is unavailable");
  });

  it("routes sign-in, cancel, and refresh through fixed bridge methods", async () => {
    const village = bridge();
    await dispatchModelProviderAccountAction(village, "BEGIN_LOGIN");
    await dispatchModelProviderAccountAction(village, "CANCEL_LOGIN");
    await dispatchModelProviderAccountAction(village, "REFRESH");

    expect(village.beginChatGptLogin).toHaveBeenCalledOnce();
    expect(village.cancelChatGptLogin).toHaveBeenCalledOnce();
    expect(village.getModelProviderAccount).toHaveBeenCalledOnce();
  });

  it("keeps at most one account refresh in flight", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: {
      provider: "CHATGPT";
      state: "AUTHENTICATING";
    }) => void;
    const first = new Promise<{
      provider: "CHATGPT";
      state: "AUTHENTICATING";
    }>((resolve) => {
      resolveFirst = resolve;
    });
    const getModelProviderAccount = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue({ provider: "CHATGPT", state: "AUTHENTICATING" });
    const publish = vi.fn();
    const stop = startModelProviderAccountPolling(
      { getModelProviderAccount },
      publish,
      10,
    );

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(100);
    expect(getModelProviderAccount).toHaveBeenCalledOnce();
    resolveFirst({ provider: "CHATGPT", state: "AUTHENTICATING" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(getModelProviderAccount).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(getModelProviderAccount).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
