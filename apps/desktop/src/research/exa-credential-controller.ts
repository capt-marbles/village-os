import {
  exaCredentialMutationResultSchema,
  exaCredentialSnapshotSchema,
  type ExaCredentialMutationResult,
  type ExaCredentialSnapshot,
} from "@village/contracts";
import {
  ExaApiKeyValidationError,
  type ExaApiKeyStore,
} from "./exa-api-key-store.js";

type ExaCredentialStore = Pick<
  ExaApiKeyStore,
  "status" | "configure" | "revoke"
>;

export interface ExaCredentialOperations {
  status(): Promise<ExaCredentialSnapshot>;
  configure(candidate: unknown): Promise<ExaCredentialMutationResult>;
  revoke(expectedVersion: number): Promise<ExaCredentialMutationResult>;
}

const unavailable = Object.freeze({
  provider: "EXA",
  state: "UNAVAILABLE",
  reason: "CREDENTIAL_STORE_UNAVAILABLE",
} satisfies ExaCredentialSnapshot);

/** Owns renderer-safe Exa credential lifecycle state; key bytes never return. */
export class ExaCredentialController implements ExaCredentialOperations {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly store: ExaCredentialStore) {}

  status(): Promise<ExaCredentialSnapshot> {
    return this.enqueue(async () => this.readStatus());
  }

  configure(candidate: unknown): Promise<ExaCredentialMutationResult> {
    return this.enqueue(async () => {
      if (!(candidate instanceof Uint8Array)) {
        return rejected("INVALID_API_KEY");
      }
      if (candidate.byteLength < 8 || candidate.byteLength > 512) {
        candidate.fill(0);
        return rejected("INVALID_API_KEY");
      }
      const transient = new Uint8Array(candidate);
      candidate.fill(0);
      try {
        const configured = await this.store.configure(transient);
        return result({
          provider: "EXA",
          state: "CONFIGURED",
          version: configured.version,
        });
      } catch (error) {
        return error instanceof ExaApiKeyValidationError
          ? rejected("INVALID_API_KEY")
          : rejected("CREDENTIAL_STORE_UNAVAILABLE");
      } finally {
        transient.fill(0);
      }
    });
  }

  revoke(expectedVersion: number): Promise<ExaCredentialMutationResult> {
    return this.enqueue(async () => {
      try {
        const current = await this.store.status();
        if (!current.configured) {
          return result({ provider: "EXA", state: "CONFIGURATION_REQUIRED" });
        }
        if (current.version !== expectedVersion) {
          return rejected("CREDENTIAL_CHANGED");
        }
        await this.store.revoke();
        return result({ provider: "EXA", state: "CONFIGURATION_REQUIRED" });
      } catch {
        return rejected("CREDENTIAL_STORE_UNAVAILABLE");
      }
    });
  }

  private async readStatus(): Promise<ExaCredentialSnapshot> {
    try {
      const status = await this.store.status();
      return exaCredentialSnapshotSchema.parse(
        status.configured
          ? { provider: "EXA", state: "CONFIGURED", version: status.version }
          : { provider: "EXA", state: "CONFIGURATION_REQUIRED" },
      );
    } catch {
      return { ...unavailable };
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const output = this.operationTail.then(operation, operation);
    this.operationTail = output.then(
      () => undefined,
      () => undefined,
    );
    return output;
  }
}

function result(snapshot: ExaCredentialSnapshot): ExaCredentialMutationResult {
  return exaCredentialMutationResultSchema.parse({
    status: "snapshot",
    snapshot,
  });
}

function rejected(
  reason: Extract<
    ExaCredentialMutationResult,
    { status: "rejected" }
  >["reason"],
): ExaCredentialMutationResult {
  return { status: "rejected", reason };
}
