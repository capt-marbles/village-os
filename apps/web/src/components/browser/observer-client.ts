import {
  browserControlStateSchema,
  browserSessionIdSchema,
  jobIdSchema,
  jobSchema,
} from "@village/contracts";
import type { BrowserUiAction, BrowserUiSnapshot } from "@village/ui";

export interface ObserverSelection {
  jobId: string;
  browserSessionId: string;
}

type ObserverIntent = Extract<BrowserUiAction, "CANCEL_AUTOMATION">;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readCsrfCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const pair of document.cookie.split(";")) {
    const [name, ...value] = pair.trim().split("=");
    if (name === "village_csrf") return decodeURIComponent(value.join("="));
  }
  return undefined;
}

export function selectionFromUrl(url: URL): ObserverSelection | null {
  const jobId = jobIdSchema.safeParse(url.searchParams.get("jobId"));
  const browserSessionId = browserSessionIdSchema.safeParse(
    url.searchParams.get("browserSessionId"),
  );
  return jobId.success && browserSessionId.success
    ? { jobId: jobId.data, browserSessionId: browserSessionId.data }
    : null;
}

export function unavailableObserverSnapshot(
  now = new Date().toISOString(),
): BrowserUiSnapshot {
  return {
    surface: "OBSERVER",
    jobState: "WAITING_FOR_BROWSER",
    controller: "NONE",
    connection: "ABSENT",
    takeover: "NONE",
    pairing: "UNPAIRED",
    verification: "unknown",
    profile: "ABSENT",
    humanGate: null,
    erasure: "IDLE",
    lastUpdatedAt: now,
  };
}

export class ObserverApiClient {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string | URL,
    private readonly request: typeof fetch = fetch.bind(globalThis),
    private readonly csrfToken: () => string | undefined = readCsrfCookie,
  ) {
    this.baseUrl = new URL(baseUrl);
  }

  async loadSnapshot(
    candidate: ObserverSelection,
    signal?: AbortSignal,
  ): Promise<BrowserUiSnapshot> {
    const jobId = jobIdSchema.safeParse(candidate.jobId);
    const browserSessionId = browserSessionIdSchema.safeParse(
      candidate.browserSessionId,
    );
    if (!jobId.success || !browserSessionId.success) {
      throw new Error("OBSERVER_SELECTION_INVALID");
    }
    const requestOptions: RequestInit = {
      credentials: "include",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    };
    const [jobResponse, sessionResponse] = await Promise.all([
      this.request(
        new URL(`/api/jobs/${jobId.data}`, this.baseUrl),
        requestOptions,
      ),
      this.request(
        new URL(`/api/browser-sessions/${browserSessionId.data}`, this.baseUrl),
        requestOptions,
      ),
    ]);
    if (!jobResponse.ok || !sessionResponse.ok) {
      throw new Error("OBSERVER_STATE_UNAVAILABLE");
    }
    const jobBody = object(await jobResponse.json());
    const sessionBody = object(await sessionResponse.json());
    const job = jobSchema.safeParse(jobBody?.job);
    const control = browserControlStateSchema.safeParse(sessionBody?.control);
    if (
      jobBody?.ok !== true ||
      sessionBody?.ok !== true ||
      !job.success ||
      !control.success ||
      job.data.jobId !== jobId.data ||
      job.data.browserSessionId !== browserSessionId.data ||
      control.data.jobId !== jobId.data ||
      control.data.browserSessionId !== browserSessionId.data ||
      control.data.principalId !== job.data.principalId
    ) {
      throw new Error("OBSERVER_STATE_INVALID");
    }
    return {
      surface: "OBSERVER",
      jobState: job.data.state,
      controller: control.data.controller,
      connection: control.data.connection,
      takeover: control.data.takeover,
      pairing: "PAIRED",
      verification: "unknown",
      profile: control.data.profile,
      humanGate:
        job.data.activeHumanGateId === null ? null : "UNKNOWN_CHALLENGE",
      erasure:
        control.data.profile === "FORGETTING"
          ? "ERASING"
          : control.data.profile === "ERASURE_FAILED"
            ? "FAILED"
            : control.data.profile === "ABSENT"
              ? "COMPLETE"
              : "IDLE",
      lastUpdatedAt: job.data.updatedAt,
    };
  }

  async sendIntent(
    candidate: ObserverSelection,
    intent: ObserverIntent,
  ): Promise<void> {
    if (intent !== "CANCEL_AUTOMATION") {
      throw new Error("OBSERVER_INTENT_INVALID");
    }
    const browserSessionId = browserSessionIdSchema.safeParse(
      candidate.browserSessionId,
    );
    const jobId = jobIdSchema.safeParse(candidate.jobId);
    if (!browserSessionId.success || !jobId.success) {
      throw new Error("OBSERVER_SELECTION_INVALID");
    }
    const csrf = this.csrfToken();
    if (!csrf || csrf.length < 32) throw new Error("OBSERVER_CSRF_UNAVAILABLE");
    const response = await this.request(
      new URL(
        `/api/browser-sessions/${browserSessionId.data}/cancel`,
        this.baseUrl,
      ),
      {
        method: "POST",
        credentials: "include",
        headers: { "x-village-csrf": csrf },
      },
    );
    const body = object(await response.json());
    if (!response.ok || body?.ok !== true) {
      throw new Error(
        typeof body?.code === "string" ? body.code : "OBSERVER_INTENT_FAILED",
      );
    }
  }
}
