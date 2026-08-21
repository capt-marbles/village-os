import {
  browserSessionIdSchema,
  devicePairingMaterialSchema,
  deviceIdSchema,
  pairingIdSchema,
  principalIdSchema,
  type PublicPairingRequest,
} from "@village/contracts";
import type { DeviceIdentity } from "./device-identity-vault.js";
import type { PairingClient } from "./pairing-client.js";
import type { RuntimeIdentity } from "./runtime-identity.js";

interface DeviceIdentitySource {
  load(): Promise<
    Pick<DeviceIdentity, "publicJwk" | "protection" | "protectionBackend">
  >;
  create(): Promise<
    Pick<DeviceIdentity, "publicJwk" | "protection" | "protectionBackend">
  >;
}

interface RuntimeIdentitySink {
  store(identity: RuntimeIdentity): Promise<void>;
}

export type { PublicPairingRequest } from "@village/contracts";

export interface PairingCompletion {
  principalId: string;
  pairingId: string;
}

export interface PairingSessionAttachment {
  principalId: string;
  deviceId: string;
  browserSessionId: string;
  fixtureBrowserSessionId?: string;
}

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export async function deviceIdForPublicKey(publicKey: object): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(publicKey)),
    ),
  );
  let buffer = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of digest.slice(0, 17)) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      bits -= 5;
      encoded += alphabet[(buffer >>> bits) & 31];
    }
  }
  return deviceIdSchema.parse(`dev_${encoded.padEnd(26, "0").slice(0, 26)}`);
}

export class PairingBootstrapService {
  private identity:
    | Pick<DeviceIdentity, "publicJwk" | "protection" | "protectionBackend">
    | undefined;
  private deviceId: string | undefined;
  private pairedDevice: { principalId: string; deviceId: string } | undefined;
  private pairingSecret: string | undefined;

  constructor(
    private readonly identityVault: DeviceIdentitySource,
    private readonly pairingClient: Pick<PairingClient, "consume">,
    private readonly runtimeStore: RuntimeIdentitySink,
    private readonly createDeviceId: (
      publicKey: object,
    ) => string | Promise<string> = deviceIdForPublicKey,
    private readonly deviceDisplayName = "Village desktop",
    private readonly createPairingSecret = () =>
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
        "base64url",
      ),
    private readonly controlPlaneOrigin?: string,
  ) {}

  async request(): Promise<PublicPairingRequest> {
    if (!this.identity) {
      try {
        this.identity = await this.identityVault.load();
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )) {
          throw error;
        }
        this.identity = await this.identityVault.create();
      }
    }
    this.deviceId ??= await this.createDeviceId(this.identity.publicJwk);
    this.pairingSecret ??= this.createPairingSecret();
    const secretHash = Buffer.from(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(this.pairingSecret),
      ),
    ).toString("base64url");
    const pairingMaterial = devicePairingMaterialSchema.parse({
      publicKey: this.identity.publicJwk,
      protection: this.identity.protection,
    });
    return {
      deviceId: deviceIdSchema.parse(this.deviceId),
      deviceDisplayName: this.deviceDisplayName,
      ...pairingMaterial,
      secretHash,
    };
  }

  async complete(
    candidate: PairingCompletion,
  ): Promise<{ principalId: string; deviceId: string }> {
    const request = await this.request();
    const principalId = principalIdSchema.safeParse(candidate.principalId);
    const pairingId = pairingIdSchema.safeParse(candidate.pairingId);
    if (!principalId.success || !pairingId.success || !this.pairingSecret) {
      throw new Error("PAIRING_COMPLETION_INVALID");
    }
    const consumed = await this.pairingClient.consume({
      principalId: principalId.data,
      pairingId: pairingId.data,
      secret: this.pairingSecret,
    });
    if (consumed.deviceId !== request.deviceId) {
      throw new Error("PAIRING_DEVICE_MISMATCH");
    }
    this.pairedDevice = {
      principalId: principalId.data,
      deviceId: deviceIdSchema.parse(consumed.deviceId),
    };
    this.pairingSecret = undefined;
    return { ...this.pairedDevice };
  }

  async attachSession(
    candidate: PairingSessionAttachment,
  ): Promise<RuntimeIdentity> {
    const principalId = principalIdSchema.safeParse(candidate.principalId);
    const deviceId = deviceIdSchema.safeParse(candidate.deviceId);
    const browserSessionId = browserSessionIdSchema.safeParse(
      candidate.browserSessionId,
    );
    const fixtureBrowserSessionId =
      candidate.fixtureBrowserSessionId === undefined
        ? undefined
        : browserSessionIdSchema.safeParse(candidate.fixtureBrowserSessionId);
    if (
      !principalId.success ||
      !deviceId.success ||
      !browserSessionId.success ||
      (fixtureBrowserSessionId !== undefined &&
        (!fixtureBrowserSessionId.success ||
          browserSessionId.data === fixtureBrowserSessionId.data)) ||
      !this.pairedDevice ||
      principalId.data !== this.pairedDevice.principalId ||
      deviceId.data !== this.pairedDevice.deviceId
    ) {
      throw new Error("PAIRING_SESSION_INVALID");
    }
    const identity: RuntimeIdentity = {
      principalId: principalId.data,
      deviceId: deviceId.data,
      browserSessionId: browserSessionId.data,
      ...(fixtureBrowserSessionId?.success
        ? { fixtureBrowserSessionId: fixtureBrowserSessionId.data }
        : {}),
      ...(this.controlPlaneOrigin
        ? { controlPlaneOrigin: this.controlPlaneOrigin }
        : {}),
    };
    await this.runtimeStore.store(identity);
    return identity;
  }
}
