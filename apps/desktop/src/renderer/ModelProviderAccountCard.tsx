import { useCallback, useEffect, useState } from "react";
import type { ModelProviderAccountSnapshot } from "@village/contracts";

export type ModelProviderAccountAction =
  "BEGIN_LOGIN" | "CANCEL_LOGIN" | "REFRESH";

export interface ModelProviderAccountBridge {
  getModelProviderAccount(): Promise<ModelProviderAccountSnapshot>;
  beginChatGptLogin(): Promise<ModelProviderAccountSnapshot>;
  cancelChatGptLogin(): Promise<ModelProviderAccountSnapshot>;
}

const providerUnavailable = Object.freeze({
  provider: "CHATGPT",
  state: "UNAVAILABLE",
  errorCode: "PROVIDER_UNAVAILABLE",
} satisfies ModelProviderAccountSnapshot);

function sameSnapshot(
  current: ModelProviderAccountSnapshot,
  next: ModelProviderAccountSnapshot,
): boolean {
  if (current.state !== next.state) return false;
  if (current.state === "AUTHENTICATED" && next.state === "AUTHENTICATED") {
    return current.accountType === next.accountType;
  }
  if (current.state === "UNAVAILABLE" && next.state === "UNAVAILABLE") {
    return current.errorCode === next.errorCode;
  }
  return true;
}

export function startModelProviderAccountPolling(
  bridge: Pick<ModelProviderAccountBridge, "getModelProviderAccount">,
  publish: (snapshot: ModelProviderAccountSnapshot) => void,
  intervalMs = 1_500,
): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const snapshot = await bridge.getModelProviderAccount();
      if (active) publish(snapshot);
    } catch {
      if (active) publish(providerUnavailable);
    } finally {
      if (active) timer = setTimeout(() => void poll(), intervalMs);
    }
  };
  timer = setTimeout(() => void poll(), intervalMs);
  return () => {
    active = false;
    if (timer) clearTimeout(timer);
  };
}

export function dispatchModelProviderAccountAction(
  bridge: ModelProviderAccountBridge,
  action: ModelProviderAccountAction,
): Promise<ModelProviderAccountSnapshot> {
  switch (action) {
    case "BEGIN_LOGIN":
      return bridge.beginChatGptLogin();
    case "CANCEL_LOGIN":
      return bridge.cancelChatGptLogin();
    case "REFRESH":
      return bridge.getModelProviderAccount();
  }
}

export function ModelProviderAccountCard({
  snapshot,
  pending,
  onAction,
}: {
  snapshot: ModelProviderAccountSnapshot;
  pending: boolean;
  onAction(action: ModelProviderAccountAction): void;
}) {
  const content = (() => {
    switch (snapshot.state) {
      case "CHECKING":
        return {
          title: "Checking ChatGPT…",
          description: "Village is checking the local Codex account state.",
          action: null,
        };
      case "AUTHENTICATION_REQUIRED":
        return {
          title: "Connect ChatGPT",
          description:
            "Use your ChatGPT account through Codex. Village never receives your password or provider tokens.",
          action: {
            label: "Sign in with ChatGPT",
            kind: "BEGIN_LOGIN" as const,
          },
        };
      case "AUTHENTICATING":
        return {
          title: "Finish signing in",
          description:
            "Waiting for OpenAI sign-in… Complete the secure flow in your default browser, then return here.",
          action: { label: "Cancel sign-in", kind: "CANCEL_LOGIN" as const },
        };
      case "AUTHENTICATED":
        return {
          title: "ChatGPT connected",
          description:
            "Village can ask Codex to plan bounded work without storing your ChatGPT credentials.",
          action: null,
        };
      case "UNAVAILABLE":
        return {
          title: "ChatGPT is unavailable",
          description:
            "Village could not reach the local Codex account service. Check that Codex is installed, then try again.",
          action: { label: "Try again", kind: "REFRESH" as const },
        };
    }
  })();

  return (
    <section
      aria-label="Model provider"
      style={{
        margin: "1rem",
        padding: "1rem",
        border: "1px solid #38513c",
        borderRadius: "16px",
        background: "rgba(19, 29, 20, .92)",
      }}
    >
      <p
        style={{
          margin: 0,
          color: "#a8d48f",
          fontSize: ".72rem",
          fontWeight: 800,
          letterSpacing: ".12em",
          textTransform: "uppercase",
        }}
      >
        Model provider
      </p>
      <h2 style={{ margin: ".35rem 0", fontSize: "1.2rem" }}>
        {content.title}
      </h2>
      <p
        {...(snapshot.state === "UNAVAILABLE" ? { role: "alert" } : {})}
        style={{ margin: "0 0 .8rem", color: "#c5d0c2", lineHeight: 1.5 }}
      >
        {content.description}
      </p>
      {content.action ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onAction(content.action!.kind)}
          style={{
            border: "1px solid #89b675",
            borderRadius: "999px",
            padding: ".65rem 1rem",
            color: "#101410",
            background: "#b8e19f",
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          {pending ? "Working…" : content.action.label}
        </button>
      ) : null}
    </section>
  );
}

export function ModelProviderAccountOnboarding({
  bridge,
}: {
  bridge: ModelProviderAccountBridge;
}) {
  const [snapshot, setSnapshot] = useState<ModelProviderAccountSnapshot>({
    provider: "CHATGPT",
    state: "CHECKING",
  });
  const [pending, setPending] = useState(false);
  const publish = useCallback((next: ModelProviderAccountSnapshot) => {
    setSnapshot((current) => (sameSnapshot(current, next) ? current : next));
  }, []);

  const run = async (action: ModelProviderAccountAction) => {
    if (pending) return;
    setPending(true);
    try {
      publish(await dispatchModelProviderAccountAction(bridge, action));
    } finally {
      setPending(false);
    }
  };

  useEffect(() => {
    let active = true;
    void bridge
      .getModelProviderAccount()
      .then((next) => active && publish(next))
      .catch(() => active && publish(providerUnavailable));
    return () => {
      active = false;
    };
  }, [bridge, publish]);

  useEffect(() => {
    if (snapshot.state !== "AUTHENTICATING") return;
    return startModelProviderAccountPolling(bridge, publish);
  }, [bridge, publish, snapshot.state]);

  return (
    <ModelProviderAccountCard
      snapshot={snapshot}
      pending={pending}
      onAction={(action) => void run(action)}
    />
  );
}
