import {
  browserSessionIdSchema,
  deviceIdSchema,
  principalIdSchema,
} from "@village/contracts";

export interface RuntimeIdentity {
  principalId: string;
  deviceId: string;
  browserSessionId: string;
  controlPlaneOrigin?: string;
}

export interface PairedRuntimeIdentitySource {
  load(): Promise<unknown>;
}

export interface RuntimeIdentityResolutionOptions {
  isPackaged: boolean;
  pairedIdentitySource?: PairedRuntimeIdentitySource;
}

export const LOCAL_DEVELOPMENT_FIXTURE_IDENTITY = Object.freeze({
  principalId: "prn_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
});

function parsePairedRuntimeIdentity(value: unknown): RuntimeIdentity {
  if (!value || typeof value !== "object") {
    throw new Error("PAIRED_RUNTIME_IDENTITY_REQUIRED");
  }
  const candidate = value as Partial<RuntimeIdentity>;
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

export function parseControlPlaneOrigin(
  value: unknown,
): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost";
    return url.origin === value &&
      (url.protocol === "https:" || (url.protocol === "http:" && loopback))
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export async function resolveRuntimeIdentity(
  options: RuntimeIdentityResolutionOptions,
): Promise<RuntimeIdentity> {
  if (!options.isPackaged) {
    return { ...LOCAL_DEVELOPMENT_FIXTURE_IDENTITY };
  }
  if (!options.pairedIdentitySource) {
    throw new Error("PAIRED_RUNTIME_IDENTITY_REQUIRED");
  }
  return parsePairedRuntimeIdentity(await options.pairedIdentitySource.load());
}
