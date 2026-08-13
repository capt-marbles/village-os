import {
  OWNED_FIXTURE_ORIGIN,
  type CredentialFillRequest,
} from "@village/contracts";
import type { SecretVault } from "./secret-vault.js";

export type CredentialFillBinding = Pick<
  CredentialFillRequest,
  | "principalId"
  | "deviceId"
  | "jobId"
  | "browserSessionId"
  | "actionId"
  | "leaseEpoch"
  | "exactOrigin"
  | "documentId"
  | "mainFrameId"
  | "nodeId"
  | "fieldSemantic"
> & {
  secretRef: string;
  site: "OWNED_FIXTURE";
};

export interface CredentialDestination {
  inspectApprovedFixtureField(signal: AbortSignal): Promise<
    CredentialFillBinding & {
      approved: boolean;
      visible: boolean;
      enabled: boolean;
      obscured: boolean;
    }
  >;
  writeApprovedFixtureField(
    request: {
      plaintext: Uint8Array;
      exactOrigin: string;
      documentId: string;
      mainFrameId: string;
      nodeId: string;
      fieldSemantic: "PASSWORD";
    },
    signal: AbortSignal,
  ): Promise<void>;
}

export interface CredentialConsentPrompt {
  confirmCredentialUse(summary: {
    exactOrigin: string;
    fieldSemantic: "PASSWORD";
  }): Promise<boolean>;
}

type Authorization = {
  binding: Readonly<CredentialFillBinding>;
  expiresAt: number;
  state: "ACTIVE" | "CONSUMED" | "INVALIDATED";
  terminalAt?: number;
};

type FillFailureCode =
  | "AUTHORIZATION_UNKNOWN"
  | "AUTHORIZATION_REPLAYED"
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_BINDING_MISMATCH"
  | "AUTHORIZATION_INVALIDATED"
  | "DESTINATION_BINDING_MISMATCH"
  | "SECRET_REVOKED"
  | "DESTINATION_WRITE_FAILED";

const crockfordBase32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function newAuthorizationId(): string {
  const entropy = crypto.getRandomValues(new Uint8Array(26));
  const value = [...entropy].map((byte) => crockfordBase32[byte & 31]).join("");
  entropy.fill(0);
  return `sfa_${value}`;
}

function sameBinding(
  left: Readonly<CredentialFillBinding>,
  right: Readonly<CredentialFillBinding>,
): boolean {
  return (
    left.principalId === right.principalId &&
    left.deviceId === right.deviceId &&
    left.jobId === right.jobId &&
    left.browserSessionId === right.browserSessionId &&
    left.actionId === right.actionId &&
    left.leaseEpoch === right.leaseEpoch &&
    left.exactOrigin === right.exactOrigin &&
    left.documentId === right.documentId &&
    left.mainFrameId === right.mainFrameId &&
    left.nodeId === right.nodeId &&
    left.fieldSemantic === right.fieldSemantic &&
    left.secretRef === right.secretRef &&
    left.site === right.site
  );
}

function assertBinding(binding: CredentialFillBinding): void {
  let origin: URL;
  try {
    origin = new URL(binding.exactOrigin);
  } catch {
    throw new Error("CREDENTIAL_ORIGIN_DENIED");
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== binding.exactOrigin ||
    binding.exactOrigin !== OWNED_FIXTURE_ORIGIN ||
    binding.site !== "OWNED_FIXTURE" ||
    binding.fieldSemantic !== "PASSWORD" ||
    !Number.isSafeInteger(binding.leaseEpoch) ||
    binding.leaseEpoch < 1
  ) {
    throw new Error("CREDENTIAL_DESTINATION_DENIED");
  }
}

export class CredentialBroker {
  private readonly authorizations = new Map<string, Authorization>();
  private readonly lifecycleGenerations = new Map<string, number>();
  private readonly activeDestinations = new Map<string, Set<AbortController>>();

  constructor(
    private readonly vault: SecretVault,
    private readonly destination: CredentialDestination,
    private readonly consentPrompt: CredentialConsentPrompt,
    private readonly now: () => number = Date.now,
    private readonly destinationTimeoutMs = 10_000,
  ) {}

  async authorize(binding: CredentialFillBinding, lifetimeMs: number) {
    this.purge();
    const snapshot = Object.freeze({ ...binding });
    assertBinding(snapshot);
    if (
      !Number.isInteger(lifetimeMs) ||
      lifetimeMs < 1 ||
      lifetimeMs > 60_000
    ) {
      throw new Error("INVALID_AUTHORIZATION_LIFETIME");
    }
    const lifecycleGeneration = this.lifecycleGeneration(
      snapshot.browserSessionId,
    );
    const approved = await this.consentPrompt.confirmCredentialUse({
      exactOrigin: snapshot.exactOrigin,
      fieldSemantic: snapshot.fieldSemantic,
    });
    if (!approved) throw new Error("CREDENTIAL_USE_DECLINED");
    if (
      lifecycleGeneration !==
      this.lifecycleGeneration(snapshot.browserSessionId)
    ) {
      throw new Error("CREDENTIAL_USE_INVALIDATED");
    }
    const authorizationId = newAuthorizationId();
    const expiresAt = this.now() + lifetimeMs;
    this.authorizations.set(authorizationId, {
      binding: snapshot,
      expiresAt,
      state: "ACTIVE",
    });
    return { authorizationId, expiresAt };
  }

  async fill(
    authorizationId: string,
    binding: CredentialFillBinding,
  ): Promise<{ ok: true } | { ok: false; code: FillFailureCode }> {
    this.purge();
    const authorization = this.authorizations.get(authorizationId);
    if (!authorization) return { ok: false, code: "AUTHORIZATION_UNKNOWN" };
    if (authorization.state === "CONSUMED") {
      return { ok: false, code: "AUTHORIZATION_REPLAYED" };
    }
    if (authorization.state === "INVALIDATED") {
      return { ok: false, code: "AUTHORIZATION_INVALIDATED" };
    }
    if (this.now() >= authorization.expiresAt) {
      authorization.state = "CONSUMED";
      authorization.terminalAt = this.now();
      return { ok: false, code: "AUTHORIZATION_EXPIRED" };
    }
    if (!sameBinding(authorization.binding, binding)) {
      authorization.state = "CONSUMED";
      authorization.terminalAt = this.now();
      return { ok: false, code: "AUTHORIZATION_BINDING_MISMATCH" };
    }
    authorization.state = "CONSUMED";
    authorization.terminalAt = this.now();
    const lifecycleGeneration = this.lifecycleGeneration(
      authorization.binding.browserSessionId,
    );
    try {
      return await this.vault.withSecret(
        authorization.binding.secretRef,
        async (plaintext) => {
          let current: Awaited<
            ReturnType<CredentialDestination["inspectApprovedFixtureField"]>
          >;
          try {
            current = await this.runDestination(
              authorization.binding.browserSessionId,
              lifecycleGeneration,
              authorization.expiresAt,
              (signal) => this.destination.inspectApprovedFixtureField(signal),
            );
          } catch (error) {
            if (this.isAuthorizationExpiry(error)) {
              return { ok: false, code: "AUTHORIZATION_EXPIRED" } as const;
            }
            if (this.isLifecycleInvalidation(error)) {
              return { ok: false, code: "AUTHORIZATION_INVALIDATED" } as const;
            }
            return { ok: false, code: "DESTINATION_BINDING_MISMATCH" } as const;
          }
          if (
            !sameBinding(authorization.binding, current) ||
            !current.approved ||
            !current.visible ||
            !current.enabled ||
            current.obscured
          ) {
            return { ok: false, code: "DESTINATION_BINDING_MISMATCH" } as const;
          }
          if (this.now() >= authorization.expiresAt) {
            return { ok: false, code: "AUTHORIZATION_EXPIRED" } as const;
          }
          try {
            await this.runDestination(
              authorization.binding.browserSessionId,
              lifecycleGeneration,
              authorization.expiresAt,
              (signal) =>
                this.destination.writeApprovedFixtureField(
                  {
                    plaintext,
                    exactOrigin: authorization.binding.exactOrigin,
                    documentId: authorization.binding.documentId,
                    mainFrameId: authorization.binding.mainFrameId,
                    nodeId: authorization.binding.nodeId,
                    fieldSemantic: authorization.binding.fieldSemantic,
                  },
                  signal,
                ),
            );
            return { ok: true } as const;
          } catch (error) {
            if (this.isAuthorizationExpiry(error)) {
              return { ok: false, code: "AUTHORIZATION_EXPIRED" } as const;
            }
            if (this.isLifecycleInvalidation(error)) {
              return { ok: false, code: "AUTHORIZATION_INVALIDATED" } as const;
            }
            return { ok: false, code: "DESTINATION_WRITE_FAILED" } as const;
          }
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message === "SECRET_REVOKED") {
        return { ok: false, code: "SECRET_REVOKED" };
      }
      throw error;
    }
  }

  invalidateForNavigation(browserSessionId: string): void {
    this.advanceLifecycle(browserSessionId);
    this.invalidate((binding) => binding.browserSessionId === browserSessionId);
  }

  invalidateForDocumentReplacement(
    browserSessionId: string,
    documentId: string,
  ): void {
    this.advanceLifecycle(browserSessionId);
    this.invalidate(
      (binding) =>
        binding.browserSessionId === browserSessionId &&
        binding.documentId === documentId,
    );
  }

  invalidateForNodeReplacement(browserSessionId: string, nodeId: string): void {
    this.advanceLifecycle(browserSessionId);
    this.invalidate(
      (binding) =>
        binding.browserSessionId === browserSessionId &&
        binding.nodeId === nodeId,
    );
  }

  invalidateForTakeover(browserSessionId: string): void {
    this.invalidateForNavigation(browserSessionId);
  }

  private invalidate(
    predicate: (binding: CredentialFillBinding) => boolean,
  ): void {
    for (const authorization of this.authorizations.values()) {
      if (
        predicate(authorization.binding) &&
        authorization.state === "ACTIVE"
      ) {
        authorization.state = "INVALIDATED";
        authorization.terminalAt = this.now();
      }
    }
  }

  private lifecycleGeneration(browserSessionId: string): number {
    return this.lifecycleGenerations.get(browserSessionId) ?? 0;
  }

  private advanceLifecycle(browserSessionId: string): void {
    this.lifecycleGenerations.set(
      browserSessionId,
      this.lifecycleGeneration(browserSessionId) + 1,
    );
    for (const controller of this.activeDestinations.get(browserSessionId) ??
      []) {
      controller.abort(new Error("CREDENTIAL_USE_INVALIDATED"));
    }
    this.activeDestinations.delete(browserSessionId);
  }

  private async runDestination<T>(
    browserSessionId: string,
    lifecycleGeneration: number,
    expiresAt: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (lifecycleGeneration !== this.lifecycleGeneration(browserSessionId)) {
      throw new Error("CREDENTIAL_USE_INVALIDATED");
    }
    const expiresInMs = expiresAt - this.now();
    if (expiresInMs <= 0) throw new Error("AUTHORIZATION_EXPIRED");
    const timeoutMs = Math.min(this.destinationTimeoutMs, expiresInMs);
    const timeoutError =
      expiresInMs <= this.destinationTimeoutMs
        ? "AUTHORIZATION_EXPIRED"
        : "CREDENTIAL_DESTINATION_TIMEOUT";
    const controller = new AbortController();
    const active =
      this.activeDestinations.get(browserSessionId) ??
      new Set<AbortController>();
    active.add(controller);
    this.activeDestinations.set(browserSessionId, active);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () =>
              reject(
                controller.signal.reason ??
                  new Error("CREDENTIAL_DESTINATION_ABORTED"),
              ),
            { once: true },
          );
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new Error(timeoutError);
            controller.abort(error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      active.delete(controller);
      if (active.size === 0) this.activeDestinations.delete(browserSessionId);
    }
  }

  private isLifecycleInvalidation(error: unknown): boolean {
    return (
      error instanceof Error && error.message === "CREDENTIAL_USE_INVALIDATED"
    );
  }

  private isAuthorizationExpiry(error: unknown): boolean {
    return error instanceof Error && error.message === "AUTHORIZATION_EXPIRED";
  }

  private purge(): void {
    const now = this.now();
    for (const [authorizationId, authorization] of this.authorizations) {
      const terminalAt = authorization.terminalAt ?? authorization.expiresAt;
      if (terminalAt + 60_000 < now) {
        this.authorizations.delete(authorizationId);
      }
    }
  }
}
