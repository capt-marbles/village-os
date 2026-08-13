import {
  browserSessionIdSchema,
  deviceIdSchema,
  principalIdSchema,
} from "@village/contracts";

export interface RuntimeIdentity {
  principalId: string;
  deviceId: string;
  browserSessionId: string;
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
  if (!principalId.success || !deviceId.success || !browserSessionId.success) {
    throw new Error("PAIRED_RUNTIME_IDENTITY_REQUIRED");
  }
  return {
    principalId: principalId.data,
    deviceId: deviceId.data,
    browserSessionId: browserSessionId.data,
  };
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
