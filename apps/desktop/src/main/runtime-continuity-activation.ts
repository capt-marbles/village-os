import { join } from "node:path";
import type {
  ContinuityActivation,
  ContinuityActivationIdentity,
  ContinuityBinding,
  EncryptedContinuityRevision,
} from "@village/contracts";
import type { Cookie, CookiesGetFilter, CookiesSetDetails } from "electron";
import {
  FixtureContinuityDestination,
  FixtureContinuitySource,
} from "./site-session-continuity.js";
import {
  importDeviceVerificationKey,
  type DeviceSigningKey,
} from "./device-identity.js";

type ActivationCookieStore = {
  get(filter: CookiesGetFilter): Promise<Cookie[]>;
  set(details: CookiesSetDetails): Promise<void>;
  remove(url: string, name: string): Promise<void>;
  flushStore(): Promise<void>;
};

type ActivationMailbox = {
  loadActivations(
    identity: ContinuityActivationIdentity,
  ): Promise<ContinuityActivation[]>;
  publish(revision: EncryptedContinuityRevision): Promise<{ stored: boolean }>;
  fetchAfter(
    binding: ContinuityBinding,
    revision: number,
  ): Promise<EncryptedContinuityRevision | null>;
  acknowledge(
    binding: ContinuityBinding,
    acknowledgement: { revision: number; digest: string },
  ): Promise<{ acknowledged: boolean }>;
};

interface RuntimeContinuityActivationOptions {
  identity: ContinuityActivationIdentity;
  journalRoot: string;
  deviceSigningKey: DeviceSigningKey;
  recipientPrivateKey: CryptoKey;
  cookieStore: ActivationCookieStore;
  mailbox: ActivationMailbox;
  now?: () => number;
}

export type RuntimeContinuityActivationResult =
  | { role: "NONE" }
  | { role: "SOURCE"; published: number; stored: boolean }
  | { role: "DESTINATION"; applied: number; revision: number };

export class RuntimeContinuityActivation {
  private operation: Promise<RuntimeContinuityActivationResult> | undefined;

  constructor(private readonly options: RuntimeContinuityActivationOptions) {}

  synchronize(): Promise<RuntimeContinuityActivationResult> {
    this.operation ??= this.synchronizeExclusive().finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  private async synchronizeExclusive(): Promise<RuntimeContinuityActivationResult> {
    const activations = await this.options.mailbox.loadActivations(
      this.options.identity,
    );
    if (activations.length === 0) return { role: "NONE" };
    if (activations.length !== 1) {
      throw new Error("MULTIPLE_CONTINUITY_GRANTS_OWNER_RECOVERY_REQUIRED");
    }
    const activation = activations[0]!;
    assertActivationIdentity(activation, this.options.identity);
    return activation.role === "SOURCE"
      ? this.publishSource(activation)
      : this.applyDestination(activation);
  }

  private async publishSource(
    activation: Extract<ContinuityActivation, { role: "SOURCE" }>,
  ): Promise<RuntimeContinuityActivationResult> {
    const destinationKey = await crypto.subtle.importKey(
      "jwk",
      activation.destinationEncryptionPublicKey,
      "X25519",
      false,
      [],
    );
    const source = new FixtureContinuitySource({
      binding: activation.binding,
      journalPath: journalPath(
        this.options.journalRoot,
        activation.binding.grantId,
        "source",
      ),
      cookieStore: this.options.cookieStore,
      sourceSigningKey: this.options.deviceSigningKey,
      destinationEncryptionKey: destinationKey,
      publish: (revision) => this.options.mailbox.publish(revision),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    const published = await source.publishCurrent();
    return {
      role: "SOURCE",
      published: published.revision,
      stored: published.stored,
    };
  }

  private async applyDestination(
    activation: Extract<ContinuityActivation, { role: "DESTINATION" }>,
  ): Promise<RuntimeContinuityActivationResult> {
    const sourceSigningKey = await importDeviceVerificationKey(
      activation.peerSigningPublicKey,
    );
    const destination = new FixtureContinuityDestination({
      binding: activation.binding,
      journalPath: journalPath(
        this.options.journalRoot,
        activation.binding.grantId,
        "destination",
      ),
      cookieStore: this.options.cookieStore,
      sourceSigningKey,
      destinationEncryptionKey: this.options.recipientPrivateKey,
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    let current = await destination.current();
    if (current.revision > 0 && current.digest) {
      await this.options.mailbox.acknowledge(activation.binding, {
        revision: current.revision,
        digest: current.digest,
      });
    }
    let applied = 0;
    while (applied < 20) {
      const revision = await this.options.mailbox.fetchAfter(
        activation.binding,
        current.revision,
      );
      if (!revision) break;
      const acknowledgement = await destination.apply(revision);
      await this.options.mailbox.acknowledge(
        activation.binding,
        acknowledgement,
      );
      current = {
        revision: acknowledgement.revision,
        digest: acknowledgement.digest,
      };
      applied += 1;
    }
    return { role: "DESTINATION", applied, revision: current.revision };
  }
}

function assertActivationIdentity(
  activation: ContinuityActivation,
  identity: ContinuityActivationIdentity,
): void {
  const binding = activation.binding;
  const matches =
    binding.principalId === identity.principalId &&
    binding.site === identity.site &&
    (activation.role === "SOURCE"
      ? binding.sourceDeviceId === identity.deviceId &&
        binding.sourceBrowserSessionId === identity.browserSessionId
      : binding.destinationDeviceId === identity.deviceId &&
        binding.destinationBrowserSessionId === identity.browserSessionId);
  if (!matches) throw new Error("CONTINUITY_ACTIVATION_BINDING_MISMATCH");
}

function journalPath(
  root: string,
  grantId: string,
  role: "source" | "destination",
): string {
  return join(root, `${grantId}-${role}.json`);
}
