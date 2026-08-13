export type SensitiveOperation = "TAKEOVER" | "SECRET_USE" | "FORGET_SESSION";

export interface SensitiveActionBinding {
  principalId: string;
  deviceId: string;
  browserSessionId: string;
  operation: SensitiveOperation;
}

interface StoredAuthorization extends SensitiveActionBinding {
  expiresAt: number;
  consumedAt?: number;
}

export class SensitiveActionAuthorizer {
  private readonly authorizations = new Map<string, StoredAuthorization>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(binding: SensitiveActionBinding, lifetimeMs: number) {
    if (
      !Number.isInteger(lifetimeMs) ||
      lifetimeMs < 1 ||
      lifetimeMs > 60_000
    ) {
      throw new Error("INVALID_AUTHORIZATION_LIFETIME");
    }
    this.purge();
    const token = crypto.randomUUID();
    const expiresAt = this.now() + lifetimeMs;
    this.authorizations.set(token, {
      ...binding,
      expiresAt,
    });
    return { token, expiresAt };
  }

  consume(
    token: string,
    binding: SensitiveActionBinding,
  ):
    | { ok: true }
    | {
        ok: false;
        code:
          | "AUTHORIZATION_UNKNOWN"
          | "AUTHORIZATION_REPLAYED"
          | "AUTHORIZATION_EXPIRED"
          | "AUTHORIZATION_BINDING_MISMATCH";
      } {
    this.purge();
    const authorization = this.authorizations.get(token);
    if (!authorization) return { ok: false, code: "AUTHORIZATION_UNKNOWN" };
    if (authorization.consumedAt !== undefined) {
      return { ok: false, code: "AUTHORIZATION_REPLAYED" };
    }
    if (this.now() > authorization.expiresAt) {
      authorization.consumedAt = this.now();
      return { ok: false, code: "AUTHORIZATION_EXPIRED" };
    }
    if (
      authorization.principalId !== binding.principalId ||
      authorization.deviceId !== binding.deviceId ||
      authorization.browserSessionId !== binding.browserSessionId ||
      authorization.operation !== binding.operation
    ) {
      return { ok: false, code: "AUTHORIZATION_BINDING_MISMATCH" };
    }
    authorization.consumedAt = this.now();
    return { ok: true };
  }

  private purge(): void {
    const now = this.now();
    for (const [token, authorization] of this.authorizations) {
      const replayWindowEnds =
        (authorization.consumedAt ?? authorization.expiresAt) + 60_000;
      if (replayWindowEnds < now) this.authorizations.delete(token);
    }
  }
}
