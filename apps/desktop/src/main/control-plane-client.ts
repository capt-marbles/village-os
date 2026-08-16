import type {
  AutomationSyncResponse,
  BrowserCommand,
  OwnedFixtureSetupCommand,
  SignedCommandEnvelope,
  SignedResultEnvelope,
  UnsignedResultEnvelope,
} from "@village/contracts";
import {
  actionIdSchema,
  automationSyncResponseSchema,
  workflowOperationResponseSchema,
} from "@village/contracts";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  signAutomationSyncRequest,
  signCommandEnvelope,
  signResultEnvelope,
  signWorkflowOperationRequest,
} from "./device-identity.js";

export interface ProtocolSequenceStore {
  reserveNext(
    deviceId: string,
    browserSessionId: string,
    scope?: ProtocolSequenceScope,
  ): Promise<number>;
}

export type ProtocolSequenceScope =
  | "CONTROL_PLANE"
  | "CONTINUITY_ACTIVATION"
  | "CONTINUITY_ENROLLMENT"
  | "CONTINUITY_MAILBOX";

export interface AutomationSyncCursorStore {
  load(browserSessionId: string): Promise<number>;
  save(browserSessionId: string, cursor: number): Promise<void>;
}

export class ControlPlaneAutomationFence {
  constructor(
    private readonly client: Pick<ControlPlaneClient, "synchronizeAutomation">,
    private readonly cursors: AutomationSyncCursorStore,
  ) {}

  synchronize(identity: AutomationSyncIdentity) {
    return this.client.synchronizeAutomation(identity, this.cursors);
  }
}

export class ControlPlaneWorkflowCoordinator {
  constructor(
    private readonly client: Pick<
      ControlPlaneClient,
      "synchronizeAutomation" | "workflowCommand" | "workflowOperation"
    >,
    private readonly cursors: AutomationSyncCursorStore,
  ) {}

  async synchronize(input: CommandIdentity & { cursor: number }) {
    const state = await this.client.synchronizeAutomation(
      {
        principalId: input.principalId,
        deviceId: input.deviceId,
        browserSessionId: input.browserSessionId,
      },
      this.cursors,
    );
    if (
      state.jobId !== input.jobId ||
      state.workflow === null ||
      state.connection === "ABSENT" ||
      state.cursor < input.cursor
    ) {
      throw new Error("WORKFLOW_BINDING_UNAVAILABLE");
    }
    return {
      authenticated: true as const,
      principalId: input.principalId,
      deviceId: input.deviceId,
      jobId: state.jobId,
      browserSessionId: input.browserSessionId,
      ...state.workflow,
      cursor: state.cursor,
      connection: state.connection,
      controller: state.controller,
      leaseEpoch: state.leaseEpoch,
      automationBlocked: state.automationBlocked,
      canceled: state.canceled,
    };
  }

  async acceptAction(
    input: CommandIdentity & {
      jobRevision: number;
      logicalStep: WorkflowCommandBinding["logicalStep"];
      effectId: string;
      objective: {
        kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1";
        version: 1;
      };
      leaseEpoch: number;
      actionId: string;
      command: OwnedFixtureSetupCommand;
    },
  ): Promise<
    { ok: true; actionId: string; cursor: number } | { ok: false; code: string }
  > {
    try {
      const result = await this.client.workflowCommand(
        {
          principalId: input.principalId,
          deviceId: input.deviceId,
          jobId: input.jobId,
          browserSessionId: input.browserSessionId,
        },
        {
          workflowKind: input.objective.kind,
          workflowVersion: input.objective.version,
          jobRevision: input.jobRevision,
          logicalStep: input.logicalStep,
          effectId: input.effectId,
        },
        input.actionId,
        input.leaseEpoch,
        input.command,
      );
      if (
        !Number.isInteger(result.eventSequence) ||
        (result.eventSequence ?? -1) < 0
      ) {
        return { ok: false, code: "INVALID_COMMAND_RESPONSE" };
      }
      const actionId = actionIdSchema.safeParse(
        result.canonicalActionId ?? input.actionId,
      );
      if (!actionId.success) {
        return { ok: false, code: "INVALID_COMMAND_RESPONSE" };
      }
      return {
        ok: true,
        actionId: actionId.data,
        cursor: result.eventSequence!,
      };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof Error ? error.message : "CONTROL_PLANE_REJECTED",
      };
    }
  }

  async recordReceipt(input: {
    receipt: Record<string, unknown>;
    checkpoint: Record<string, unknown>;
  }): Promise<{ ok: true; cursor: number } | { ok: false; code: string }> {
    try {
      const response = await this.client.workflowOperation(
        {
          principalId: String(input.receipt.principalId),
          deviceId: String(input.receipt.deviceId),
          jobId: String(input.receipt.jobId),
          browserSessionId: String(input.receipt.browserSessionId),
        },
        { operation: "RECORD_RECEIPT", ...input },
      );
      if (response.operation !== "RECORD_RECEIPT") {
        return { ok: false, code: "INVALID_WORKFLOW_OPERATION_RESPONSE" };
      }
      return { ok: true, cursor: response.cursor };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof Error ? error.message : "CONTROL_PLANE_REJECTED",
      };
    }
  }

  async claimFreshLease(
    input: CommandIdentity & {
      afterLeaseEpoch: number;
      cursor: number;
    },
  ): Promise<
    | { ok: true; leaseEpoch: number; cursor: number }
    | { ok: false; code: string }
  > {
    try {
      const response = await this.client.workflowOperation(input, {
        operation: "CLAIM_FRESH_LEASE",
        afterLeaseEpoch: input.afterLeaseEpoch,
        cursor: input.cursor,
        leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
      if (
        response.operation !== "CLAIM_FRESH_LEASE" ||
        response.leaseEpoch <= input.afterLeaseEpoch ||
        response.cursor <= input.cursor
      ) {
        return { ok: false, code: "INVALID_WORKFLOW_OPERATION_RESPONSE" };
      }
      return {
        ok: true,
        leaseEpoch: response.leaseEpoch,
        cursor: response.cursor,
      };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof Error ? error.message : "CONTROL_PLANE_REJECTED",
      };
    }
  }

  async takeover(
    input: CommandIdentity & {
      expectedLeaseEpoch: number;
      cursor: number;
    },
  ): Promise<
    | { ok: true; leaseEpoch: number; cursor: number }
    | { ok: false; code: string }
  > {
    try {
      const response = await this.client.workflowOperation(input, {
        operation: "TAKEOVER",
        expectedLeaseEpoch: input.expectedLeaseEpoch,
        cursor: input.cursor,
      });
      if (
        response.operation !== "TAKEOVER" ||
        response.leaseEpoch <= input.expectedLeaseEpoch ||
        response.cursor <= input.cursor
      ) {
        return { ok: false, code: "INVALID_WORKFLOW_OPERATION_RESPONSE" };
      }
      return {
        ok: true,
        leaseEpoch: response.leaseEpoch,
        cursor: response.cursor,
      };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof Error ? error.message : "CONTROL_PLANE_REJECTED",
      };
    }
  }

  async recordOwnerProgress(
    input: CommandIdentity & {
      objective: {
        kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1";
        version: 1;
      };
      jobRevision: number;
      logicalStep: WorkflowCommandBinding["logicalStep"];
      effectId: string;
      actionPhase:
        | "ACCEPTED"
        | "DISPATCHED"
        | "EFFECT_OBSERVED"
        | "RECEIPTED"
        | "RECONCILIATION_REQUIRED";
      leaseEpoch: number;
      cursor: number;
      actor: "OWNER";
      occurredAt: string;
    },
  ): Promise<{ ok: true; cursor: number } | { ok: false; code: string }> {
    try {
      const response = await this.client.workflowOperation(input, {
        operation: "RECORD_OWNER_PROGRESS",
        objective: input.objective,
        jobRevision: input.jobRevision,
        logicalStep: input.logicalStep,
        effectId: input.effectId,
        actionPhase: input.actionPhase,
        leaseEpoch: input.leaseEpoch,
        cursor: input.cursor,
        actor: input.actor,
        occurredAt: input.occurredAt,
      });
      if (
        response.operation !== "RECORD_OWNER_PROGRESS" ||
        response.cursor <= input.cursor
      ) {
        return { ok: false, code: "INVALID_WORKFLOW_OPERATION_RESPONSE" };
      }
      return { ok: true, cursor: response.cursor };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof Error ? error.message : "CONTROL_PLANE_REJECTED",
      };
    }
  }
}

export class MemoryAutomationSyncCursorStore implements AutomationSyncCursorStore {
  constructor(private cursor = 0) {}

  async load() {
    return this.cursor;
  }

  async save(_browserSessionId: string, cursor: number) {
    this.cursor = cursor;
  }
}

export class FileAutomationSyncCursorStore implements AutomationSyncCursorStore {
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(browserSessionId: string) {
    const values = await this.read();
    return values[browserSessionId] ?? 0;
  }

  async save(browserSessionId: string, cursor: number) {
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new Error("INVALID_AUTOMATION_SYNC_CURSOR");
    }
    const operation = this.mutation.then(async () => {
      const values = await this.read();
      if (cursor < (values[browserSessionId] ?? 0)) {
        throw new Error("STALE_AUTOMATION_SYNC_CURSOR");
      }
      values[browserSessionId] = cursor;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(values), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.path);
    });
    this.mutation = operation.catch(() => undefined);
    await operation;
  }

  private async read(): Promise<Record<string, number>> {
    let candidate: unknown;
    try {
      candidate = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return {};
      }
      throw new Error("AUTOMATION_SYNC_CURSOR_STORE_CORRUPT");
    }
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.values(candidate).some(
        (value) => !Number.isInteger(value) || Number(value) < 0,
      )
    ) {
      throw new Error("AUTOMATION_SYNC_CURSOR_STORE_CORRUPT");
    }
    return candidate as Record<string, number>;
  }
}

export class FileProtocolSequenceStore implements ProtocolSequenceStore {
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async reserveNext(
    deviceId: string,
    browserSessionId: string,
    scope: ProtocolSequenceScope = "CONTROL_PLANE",
  ) {
    let reserved = 0;
    this.mutation = this.mutation.then(async () => {
      let values: Record<string, number> = {};
      try {
        values = JSON.parse(await readFile(this.path, "utf8")) as Record<
          string,
          number
        >;
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )) {
          throw error;
        }
      }
      const identity = `${deviceId}:${browserSessionId}`;
      const key = scope === "CONTROL_PLANE" ? identity : `${scope}:${identity}`;
      reserved = (values[key] ?? 0) + 1;
      values[key] = reserved;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, JSON.stringify(values), { mode: 0o600 });
      await rename(temporary, this.path);
    });
    await this.mutation;
    return reserved;
  }
}

export type CommandIdentity = {
  principalId: string;
  deviceId: string;
  jobId: string;
  browserSessionId: string;
};

export type AutomationSyncIdentity = Omit<CommandIdentity, "jobId">;

export type WorkflowCommandBinding = {
  workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1";
  workflowVersion: 1;
  jobRevision: number;
  logicalStep:
    | "SET_DISPLAY_NAME"
    | "SELECT_ROLE"
    | "SET_PREFERRED_FOCUS"
    | "FINALIZE_SETUP";
  effectId: string;
};

export class ControlPlaneClient {
  constructor(
    private readonly baseUrl: string,
    private readonly connectionId: string,
    private readonly privateKey: CryptoKey,
    private readonly sequences: ProtocolSequenceStore,
    private readonly request: typeof fetch = fetch,
    private readonly requestTimeoutMs = 30_000,
  ) {}

  async connect(
    identity: CommandIdentity,
    actionId: string,
    site: "OWNED_FIXTURE" | "LINKEDIN",
    leaseEpoch: number,
  ) {
    const envelope = await this.envelope(identity, actionId, leaseEpoch, {
      capability: "SESSION_OPEN",
      site,
    });
    return this.send(identity.browserSessionId, "connect", envelope);
  }

  async command(
    identity: CommandIdentity,
    actionId: string,
    leaseEpoch: number,
    command: BrowserCommand,
  ) {
    const envelope = await this.envelope(
      identity,
      actionId,
      leaseEpoch,
      command,
    );
    return this.send(identity.browserSessionId, "commands", envelope);
  }

  async workflowCommand(
    identity: CommandIdentity,
    binding: WorkflowCommandBinding,
    actionId: string,
    leaseEpoch: number,
    command: OwnedFixtureSetupCommand,
  ) {
    const envelope = await this.envelope(
      identity,
      actionId,
      leaseEpoch,
      command,
      binding,
    );
    return this.send(identity.browserSessionId, "commands", envelope);
  }

  async result(
    result: Omit<UnsignedResultEnvelope, "sequence" | "issuedAt" | "expiresAt">,
  ) {
    const issuedAt = new Date();
    const sequence = await this.sequences.reserveNext(
      result.deviceId,
      result.browserSessionId,
    );
    const envelope = await signResultEnvelope(
      {
        ...result,
        sequence,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + 30_000).toISOString(),
      },
      this.privateKey,
    );
    return this.send(result.browserSessionId, "results", envelope);
  }

  async synchronizeAutomation(
    identity: AutomationSyncIdentity,
    cursors: AutomationSyncCursorStore,
  ): Promise<AutomationSyncResponse> {
    const cursor = await cursors.load(identity.browserSessionId);
    const issuedAt = new Date();
    const sequence = await this.sequences.reserveNext(
      identity.deviceId,
      identity.browserSessionId,
    );
    const envelope = await signAutomationSyncRequest(
      {
        protocolVersion: 1,
        ...identity,
        connectionId: this.connectionId,
        sequence,
        cursor,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + 30_000).toISOString(),
      },
      this.privateKey,
    );
    const response = await this.requestWithTimeout(
      new URL(
        `/api/browser-sessions/${identity.browserSessionId}/automation-sync`,
        this.baseUrl,
      ),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-village-connection-id": this.connectionId,
        },
        body: JSON.stringify(envelope),
      },
    );
    const candidate: unknown = await response.json();
    const parsed = automationSyncResponseSchema.safeParse(candidate);
    if (!response.ok || !parsed.success) {
      const code =
        candidate && typeof candidate === "object" && "code" in candidate
          ? String(candidate.code)
          : "INVALID_AUTOMATION_SYNC_RESPONSE";
      throw new Error(code);
    }
    if (parsed.data.cursor < cursor) {
      throw new Error("STALE_AUTOMATION_SYNC_RESPONSE");
    }
    await cursors.save(identity.browserSessionId, parsed.data.cursor);
    return parsed.data;
  }

  async workflowOperation(
    identity: CommandIdentity,
    operation: Record<string, unknown>,
  ) {
    const issuedAt = new Date();
    const sequence = await this.sequences.reserveNext(
      identity.deviceId,
      identity.browserSessionId,
    );
    const envelope = await signWorkflowOperationRequest(
      {
        protocolVersion: 1,
        ...identity,
        connectionId: this.connectionId,
        sequence,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + 30_000).toISOString(),
        ...operation,
      },
      this.privateKey,
    );
    const response = await this.requestWithTimeout(
      new URL(
        `/api/browser-sessions/${identity.browserSessionId}/workflow-operations`,
        this.baseUrl,
      ),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-village-connection-id": this.connectionId,
        },
        body: JSON.stringify(envelope),
      },
    );
    const candidate: unknown = await response.json();
    const parsed = workflowOperationResponseSchema.safeParse(candidate);
    if (!response.ok || !parsed.success) {
      const code =
        candidate && typeof candidate === "object" && "code" in candidate
          ? String(candidate.code)
          : "INVALID_WORKFLOW_OPERATION_RESPONSE";
      throw new Error(code);
    }
    return parsed.data;
  }

  private async envelope(
    identity: CommandIdentity,
    actionId: string,
    leaseEpoch: number,
    command: BrowserCommand,
    workflow?: WorkflowCommandBinding,
  ): Promise<SignedCommandEnvelope> {
    const issuedAt = new Date();
    const sequence = await this.sequences.reserveNext(
      identity.deviceId,
      identity.browserSessionId,
    );
    return signCommandEnvelope(
      {
        protocolVersion: 1,
        ...identity,
        actionId,
        leaseEpoch,
        ...workflow,
        sequence,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + 30_000).toISOString(),
        command,
      },
      this.privateKey,
    );
  }

  private async send(
    browserSessionId: string,
    operation: "connect" | "commands" | "results",
    envelope: SignedCommandEnvelope | SignedResultEnvelope,
  ) {
    const response = await this.requestWithTimeout(
      new URL(
        `/api/browser-sessions/${browserSessionId}/${operation}`,
        this.baseUrl,
      ),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-village-connection-id": this.connectionId,
        },
        body: JSON.stringify(envelope),
      },
    );
    const result = (await response.json()) as {
      ok: boolean;
      code?: string;
      leaseEpoch?: number;
      eventSequence?: number;
      canonicalActionId?: string;
    };
    if (!response.ok || !result.ok) {
      throw new Error(result.code ?? "CONTROL_PLANE_REJECTED");
    }
    return result;
  }

  private async requestWithTimeout(
    url: URL,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("CONTROL_PLANE_TIMEOUT"));
      }, this.requestTimeoutMs);
    });
    try {
      return await Promise.race([
        this.request(url, { ...init, signal: controller.signal }),
        deadline,
      ]);
    } catch (error) {
      if (timedOut || (error instanceof Error && error.name === "AbortError")) {
        throw new Error("CONTROL_PLANE_TIMEOUT");
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
