import {
  actionPhaseSchema,
  browserSessionIdSchema,
  connectionStateSchema,
  controllerSchema,
  instantSchema,
  jobIdSchema,
  jobStateSchema,
  setupLogicalStepSchema,
} from "@village/contracts";
import type {
  BrowserUiAction,
  BrowserUiSnapshot,
  ObserverCancellationState,
} from "@village/ui";

export interface ObserverSelection {
  jobId: string;
  browserSessionId: string;
}

export interface ObserverWorkflowSnapshot extends BrowserUiSnapshot {
  cursor: number;
  projectionLag: number;
  jobRevision: number;
  workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1";
  workflowVersion: 1;
  logicalStep: ReturnType<typeof setupLogicalStepSchema.parse> | null;
  actionPhase: ReturnType<typeof actionPhaseSchema.parse> | null;
  lastEffectActor: "AGENT" | "OWNER" | null;
  terminalEvidence:
    "RECEIPTED_SUCCESS" | "CANCELLED" | "NON_CONVERGENT" | "FAILED" | null;
  cancellationAcknowledgedAt: string | null;
  automationFenced: boolean;
}

export interface ObserverCancellationReceipt {
  state: Extract<
    ObserverCancellationState,
    "DURABLY_ACCEPTED" | "PENDING_DESKTOP_SYNC" | "AUTOMATION_FENCED"
  >;
  acknowledgedAt: string;
}

type ObserverIntent = Extract<BrowserUiAction, "CANCEL_AUTOMATION">;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    keys.sort().every((key, index) => key === actual[index])
  );
}

function readCsrfCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const pair of document.cookie.split(";")) {
    const [name, ...value] = pair.trim().split("=");
    if (name === "village_csrf") return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function cancellationId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return `cnl_${Array.from(bytes, (value) => alphabet[value! & 31]).join("")}`;
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
): ObserverWorkflowSnapshot {
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
    cursor: 0,
    projectionLag: 0,
    jobRevision: 1,
    workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
    workflowVersion: 1,
    logicalStep: null,
    actionPhase: null,
    lastEffectActor: null,
    terminalEvidence: null,
    cancellationAcknowledgedAt: null,
    automationFenced: true,
  };
}

export class ObserverApiClient {
  private readonly baseUrl: URL;
  private readonly accepted = new Map<string, ObserverWorkflowSnapshot>();

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
  ): Promise<ObserverWorkflowSnapshot> {
    const jobId = jobIdSchema.safeParse(candidate.jobId);
    const browserSessionId = browserSessionIdSchema.safeParse(
      candidate.browserSessionId,
    );
    if (!jobId.success || !browserSessionId.success)
      throw new Error("OBSERVER_SELECTION_INVALID");
    const key = `${jobId.data}:${browserSessionId.data}`;
    const current = this.accepted.get(key);
    const url = new URL(
      `/api/browser-sessions/${browserSessionId.data}/observer`,
      this.baseUrl,
    );
    url.searchParams.set("cursor", String(current?.cursor ?? 0));
    const response = await this.request(url, {
      credentials: "include",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error("OBSERVER_STATE_UNAVAILABLE");
    const body = object(await response.json());
    const projection = object(body?.projection);
    if (body?.ok !== true || !projection)
      throw new Error("OBSERVER_STATE_INVALID");
    const keys = [
      "cursor",
      "projectionLag",
      "jobRevision",
      "jobState",
      "workflowKind",
      "workflowVersion",
      "logicalStep",
      "actionPhase",
      "lastEffectActor",
      "controller",
      "connection",
      "automationFenced",
      "humanGate",
      "terminalEvidence",
      "cancellationAcknowledgedAt",
      "lastDurableUpdateAt",
    ];
    const parsedJob = jobStateSchema.safeParse(projection.jobState);
    const parsedController = controllerSchema.safeParse(projection.controller);
    const parsedConnection = connectionStateSchema.safeParse(
      projection.connection,
    );
    const parsedStep =
      projection.logicalStep === null
        ? null
        : setupLogicalStepSchema.safeParse(projection.logicalStep);
    const parsedPhase =
      projection.actionPhase === null
        ? null
        : actionPhaseSchema.safeParse(projection.actionPhase);
    const parsedTime = instantSchema.safeParse(projection.lastDurableUpdateAt);
    const parsedAck =
      projection.cancellationAcknowledgedAt === null
        ? null
        : instantSchema.safeParse(projection.cancellationAcknowledgedAt);
    const terminals = [
      null,
      "RECEIPTED_SUCCESS",
      "CANCELLED",
      "NON_CONVERGENT",
      "FAILED",
    ];
    if (
      !hasExactKeys(projection, keys) ||
      !parsedJob.success ||
      !parsedController.success ||
      !parsedConnection.success ||
      (parsedStep && !parsedStep.success) ||
      (parsedPhase && !parsedPhase.success) ||
      !parsedTime.success ||
      (parsedAck && !parsedAck.success) ||
      projection.workflowKind !== "OWNED_FIXTURE_ACCOUNT_SETUP_V1" ||
      projection.workflowVersion !== 1 ||
      !Number.isInteger(projection.cursor) ||
      (projection.cursor as number) < 0 ||
      !Number.isInteger(projection.projectionLag) ||
      (projection.projectionLag as number) < 0 ||
      !Number.isInteger(projection.jobRevision) ||
      (projection.jobRevision as number) < 1 ||
      ![null, "AGENT", "OWNER"].includes(projection.lastEffectActor as never) ||
      !terminals.includes(projection.terminalEvidence as never) ||
      (projection.humanGate !== null &&
        projection.humanGate !== "UNKNOWN_CHALLENGE") ||
      typeof projection.automationFenced !== "boolean"
    )
      throw new Error("OBSERVER_STATE_INVALID");
    if (current && (projection.cursor as number) <= current.cursor)
      return current;
    const next: ObserverWorkflowSnapshot = {
      surface: "OBSERVER",
      jobState: parsedJob.data,
      controller: parsedController.data,
      connection: parsedConnection.data,
      takeover: "NONE",
      pairing: "PAIRED",
      verification: "unknown",
      profile: "PRESENT",
      humanGate: projection.humanGate as "UNKNOWN_CHALLENGE" | null,
      erasure: "IDLE",
      lastUpdatedAt: parsedTime.data,
      cursor: projection.cursor as number,
      projectionLag: projection.projectionLag as number,
      jobRevision: projection.jobRevision as number,
      workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
      workflowVersion: 1,
      logicalStep: parsedStep ? parsedStep.data : null,
      actionPhase: parsedPhase ? parsedPhase.data : null,
      lastEffectActor: projection.lastEffectActor as "AGENT" | "OWNER" | null,
      terminalEvidence:
        projection.terminalEvidence as ObserverWorkflowSnapshot["terminalEvidence"],
      cancellationAcknowledgedAt: parsedAck ? parsedAck.data : null,
      automationFenced: projection.automationFenced,
    };
    this.accepted.set(key, next);
    return next;
  }

  async sendIntent(
    candidate: ObserverSelection,
    intent: ObserverIntent,
    expectedJobRevision: number,
  ): Promise<ObserverCancellationReceipt> {
    if (intent !== "CANCEL_AUTOMATION")
      throw new Error("OBSERVER_INTENT_INVALID");
    const browserSessionId = browserSessionIdSchema.safeParse(
      candidate.browserSessionId,
    );
    const jobId = jobIdSchema.safeParse(candidate.jobId);
    if (
      !browserSessionId.success ||
      !jobId.success ||
      !Number.isInteger(expectedJobRevision) ||
      expectedJobRevision < 1
    )
      throw new Error("OBSERVER_SELECTION_INVALID");
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
        headers: { "content-type": "application/json", "x-village-csrf": csrf },
        body: JSON.stringify({
          jobId: jobId.data,
          expectedJobRevision,
          cancellationId: cancellationId(),
        }),
      },
    );
    const body = object(await response.json());
    const acknowledgedAt = instantSchema.safeParse(body?.acknowledgedAt);
    if (!response.ok || body?.ok !== true || !acknowledgedAt.success) {
      throw new Error(
        typeof body?.code === "string" ? body.code : "OBSERVER_INTENT_FAILED",
      );
    }
    return { state: "DURABLY_ACCEPTED", acknowledgedAt: acknowledgedAt.data };
  }
}
