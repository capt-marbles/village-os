import {
  browserSessionIdSchema,
  deviceIdSchema,
  principalIdSchema,
} from "@village/contracts";
import type { SecretVault } from "../secrets/secret-vault.js";
import type {
  PairedRuntimeIdentitySource,
  RuntimeIdentity,
} from "./runtime-identity.js";
import { parseControlPlaneOrigin } from "./runtime-identity.js";

const runtimeIdentityReference = "sec_runtime_identity";

function parseRuntimeIdentity(value: unknown): RuntimeIdentity {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some(
      (key) =>
        ![
          "principalId",
          "deviceId",
          "browserSessionId",
          "controlPlaneOrigin",
        ].includes(key),
    )
  ) {
    throw new Error("PAIRED_RUNTIME_IDENTITY_REQUIRED");
  }
  const candidate = value as Record<string, unknown>;
  const principalId = principalIdSchema.safeParse(candidate.principalId);
  const deviceId = deviceIdSchema.safeParse(candidate.deviceId);
  const browserSessionId = browserSessionIdSchema.safeParse(
    candidate.browserSessionId,
  );
  const controlPlaneOrigin = parseControlPlaneOrigin(
    candidate.controlPlaneOrigin,
  );
  if (
    !principalId.success ||
    !deviceId.success ||
    !browserSessionId.success ||
    controlPlaneOrigin === null
  ) {
    throw new Error("PAIRED_RUNTIME_IDENTITY_REQUIRED");
  }
  return {
    principalId: principalId.data,
    deviceId: deviceId.data,
    browserSessionId: browserSessionId.data,
    ...(controlPlaneOrigin ? { controlPlaneOrigin } : {}),
  };
}

export class SecretRuntimeIdentityStore implements PairedRuntimeIdentitySource {
  constructor(
    private readonly vault: Pick<SecretVault, "store" | "withSecret">,
  ) {}

  async store(identity: RuntimeIdentity): Promise<void> {
    const parsed = parseRuntimeIdentity(identity);
    const bytes = new TextEncoder().encode(JSON.stringify(parsed));
    await this.vault.store(runtimeIdentityReference, bytes);
  }

  async load(): Promise<RuntimeIdentity> {
    return this.vault.withSecret(runtimeIdentityReference, async (bytes) => {
      try {
        return parseRuntimeIdentity(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
      } catch {
        throw new Error("PAIRED_RUNTIME_IDENTITY_REQUIRED");
      }
    });
  }
}
