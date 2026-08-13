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
  inspectApprovedFixtureField(): Promise<
    CredentialFillBinding & {
      approved: boolean;
      visible: boolean;
      enabled: boolean;
      obscured: boolean;
    }
  >;
  writeApprovedFixtureField(request: {
    plaintext: Uint8Array;
    exactOrigin: string;
    documentId: string;
    mainFrameId: string;
    nodeId: string;
    fieldSemantic: "PASSWORD";
  }): Promise<void>;
}

export interface CredentialConsentPrompt {
  confirmCredentialUse(summary: {
    exactOrigin: string;
    fieldSemantic: "PASSWORD";
  }): Promise<boolean>;
}

type Authorization = {
  binding: CredentialFillBinding;
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
  left: CredentialFillBinding,
  right: CredentialFillBinding,
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

  constructor(
    private readonly vault: SecretVault,
    private readonly destination: CredentialDestination,
    private readonly consentPrompt: CredentialConsentPrompt,
    private readonly now: () => number = Date.now,
  ) {}

  async authorize(binding: CredentialFillBinding, lifetimeMs: number) {
    this.purge();
    assertBinding(binding);
    if (
      !Number.isInteger(lifetimeMs) ||
      lifetimeMs < 1 ||
      lifetimeMs > 60_000
    ) {
      throw new Error("INVALID_AUTHORIZATION_LIFETIME");
    }
    const approved = await this.consentPrompt.confirmCredentialUse({
      exactOrigin: binding.exactOrigin,
      fieldSemantic: binding.fieldSemantic,
    });
    if (!approved) throw new Error("CREDENTIAL_USE_DECLINED");
    const authorizationId = newAuthorizationId();
    const expiresAt = this.now() + lifetimeMs;
    this.authorizations.set(authorizationId, {
      binding: { ...binding },
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
    if (this.now() > authorization.expiresAt) {
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
    try {
      return await this.vault.withSecret(
        binding.secretRef,
        async (plaintext) => {
          let current: Awaited<
            ReturnType<CredentialDestination["inspectApprovedFixtureField"]>
          >;
          try {
            current = await this.destination.inspectApprovedFixtureField();
          } catch {
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
          try {
            await this.destination.writeApprovedFixtureField({
              plaintext,
              exactOrigin: binding.exactOrigin,
              documentId: binding.documentId,
              mainFrameId: binding.mainFrameId,
              nodeId: binding.nodeId,
              fieldSemantic: binding.fieldSemantic,
            });
            return { ok: true } as const;
          } catch {
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
    this.invalidate((binding) => binding.browserSessionId === browserSessionId);
  }

  invalidateForDocumentReplacement(
    browserSessionId: string,
    documentId: string,
  ): void {
    this.invalidate(
      (binding) =>
        binding.browserSessionId === browserSessionId &&
        binding.documentId === documentId,
    );
  }

  invalidateForNodeReplacement(browserSessionId: string, nodeId: string): void {
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
