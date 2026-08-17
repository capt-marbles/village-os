import { OwnedFixtureCredentialDestination } from "../browser/owned-fixture-credential-destination.js";
import type { DebuggerTransport } from "../browser/cdp-adapter.js";
import {
  CredentialBroker,
  type CredentialConsentPrompt,
  type CredentialFillBinding,
} from "../secrets/credential-broker.js";
import type { SecretVault } from "../secrets/secret-vault.js";

export type OwnedFixtureCredentialFillInput = Omit<
  CredentialFillBinding,
  "documentId" | "mainFrameId" | "nodeId"
>;

export class OwnedFixtureCredentialFill {
  constructor(
    private readonly vault: SecretVault,
    private readonly consentPrompt: CredentialConsentPrompt,
    private readonly now: () => number = Date.now,
  ) {}

  async fill(
    input: OwnedFixtureCredentialFillInput,
    transport: DebuggerTransport,
  ) {
    const destination = new OwnedFixtureCredentialDestination(input, transport);
    const controller = new AbortController();
    let preflightTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const binding = await Promise.race([
        destination.prepareBinding(controller.signal),
        new Promise<never>((_resolve, reject) => {
          preflightTimeout = setTimeout(() => {
            const error = new Error("CREDENTIAL_DESTINATION_TIMEOUT");
            controller.abort(error);
            reject(error);
          }, 10_000);
        }),
      ]);
      const broker = new CredentialBroker(
        this.vault,
        destination,
        this.consentPrompt,
        this.now,
      );
      const authorization = await broker.authorize(binding, 30_000);
      return await broker.fill(authorization.authorizationId, binding);
    } finally {
      if (preflightTimeout) clearTimeout(preflightTimeout);
      destination.detach();
    }
  }
}
