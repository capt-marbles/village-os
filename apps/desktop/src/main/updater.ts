import { timingSafeEqual } from "node:crypto";

const sha256Pattern = /^[a-f0-9]{64}$/;
const sha512Pattern = /^[a-f0-9]{128}$/;

export const VILLAGE_PRODUCT_ID = "com.village.desktop" as const;
export const VILLAGE_UPDATE_CHANNEL = "alpha" as const;
export const VILLAGE_UPDATE_ENDPOINT =
  "https://updates.village.run/desktop/alpha/manifest.json" as const;

export interface UpdateTrustPolicy {
  productId: string;
  channel: string;
  endpoint: string;
  /** Lowercase SHA-256 fingerprint of the expected release certificate. */
  signerSha256: string;
}

export interface UpdateCandidate {
  productId: string;
  channel: string;
  version: string;
  requestedUrl: string;
  finalUrl: string;
  signerSha256: string;
  expectedSha512: string;
  downloadedSha512: string;
}

export type UpdateValidation =
  | { ok: true; version: string }
  | {
      ok: false;
      code:
        | "INVALID_TRUST_POLICY"
        | "INVALID_UPDATE_METADATA"
        | "PRODUCT_MISMATCH"
        | "CHANNEL_MISMATCH"
        | "ENDPOINT_MISMATCH"
        | "REDIRECT_DENIED"
        | "SIGNER_MISMATCH"
        | "CHECKSUM_MISMATCH"
        | "VERSION_NOT_NEWER";
    };

interface ParsedVersion {
  core: readonly [number, number, number];
  prerelease: readonly (number | string)[];
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (!match) return undefined;
  const prerelease = match[4]
    ? match[4]
        .split(".")
        .map((identifier) =>
          /^0$|^[1-9]\d*$/.test(identifier) ? Number(identifier) : identifier,
        )
    : [];
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    const leftPart = left.core[index]!;
    const rightPart = right.core[index]!;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length
        ? -1
        : 1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "string")
      return -1;
    if (typeof leftPart === "string" && typeof rightPart === "number") return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function equalHex(left: string, right: string, length: 64 | 128): boolean {
  if (!isLowercaseHex(left, length) || !isLowercaseHex(right, length))
    return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isLowercaseHex(value: string, length: 64 | 128): boolean {
  return (length === 64 ? sha256Pattern : sha512Pattern).test(value);
}

function validPolicy(policy: UpdateTrustPolicy): boolean {
  return (
    policy.productId === VILLAGE_PRODUCT_ID &&
    policy.channel === VILLAGE_UPDATE_CHANNEL &&
    policy.endpoint === VILLAGE_UPDATE_ENDPOINT &&
    isLowercaseHex(policy.signerSha256, 64)
  );
}

function parseCandidate(candidate: unknown): UpdateCandidate | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return undefined;
  const record = candidate as Record<string, unknown>;
  const keys = [
    "productId",
    "channel",
    "version",
    "requestedUrl",
    "finalUrl",
    "signerSha256",
    "expectedSha512",
    "downloadedSha512",
  ] as const;
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every((key) => typeof record[key] === "string")
  ) {
    return undefined;
  }
  return record as unknown as UpdateCandidate;
}

export function validateUpdateCandidate(
  policy: UpdateTrustPolicy,
  currentVersion: string,
  input: unknown,
): UpdateValidation {
  if (!validPolicy(policy)) return { ok: false, code: "INVALID_TRUST_POLICY" };
  const candidate = parseCandidate(input);
  if (!candidate) return { ok: false, code: "INVALID_UPDATE_METADATA" };
  const current = parseVersion(currentVersion);
  const next = parseVersion(candidate.version);
  if (
    !current ||
    !next ||
    !isLowercaseHex(candidate.expectedSha512, 128) ||
    !isLowercaseHex(candidate.downloadedSha512, 128)
  ) {
    return { ok: false, code: "INVALID_UPDATE_METADATA" };
  }
  if (candidate.productId !== policy.productId)
    return { ok: false, code: "PRODUCT_MISMATCH" };
  if (candidate.channel !== policy.channel)
    return { ok: false, code: "CHANNEL_MISMATCH" };
  if (candidate.requestedUrl !== policy.endpoint)
    return { ok: false, code: "ENDPOINT_MISMATCH" };
  if (candidate.finalUrl !== candidate.requestedUrl)
    return { ok: false, code: "REDIRECT_DENIED" };
  if (!equalHex(candidate.signerSha256, policy.signerSha256, 64))
    return { ok: false, code: "SIGNER_MISMATCH" };
  if (!equalHex(candidate.downloadedSha512, candidate.expectedSha512, 128))
    return { ok: false, code: "CHECKSUM_MISMATCH" };
  if (compareVersions(next, current) <= 0)
    return { ok: false, code: "VERSION_NOT_NEWER" };
  return { ok: true, version: candidate.version };
}
