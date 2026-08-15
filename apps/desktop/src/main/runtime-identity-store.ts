import type { SecretVault } from "../secrets/secret-vault.js";
import type {
  PairedRuntimeIdentitySource,
  RuntimeIdentity,
} from "./runtime-identity.js";
import { parsePairedRuntimeIdentity } from "./runtime-identity.js";

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
          "fixtureBrowserSessionId",
          "controlPlaneOrigin",
        ].includes(key),
    )
  ) {
    throw new Error("PAIRED_RUNTIME_IDENTITY_REQUIRED");
  }
  return parsePairedRuntimeIdentity(value);
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
