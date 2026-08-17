import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import type { BrowserSite } from "./session-policy.js";

export interface ProfileScope {
  principalId: string;
  deviceId: string;
  site: BrowserSite;
}

export interface MacProfileProtection {
  runTmutil(arguments_: string[]): Promise<{ stdout: string }>;
}

export interface ProfileEncryptionAvailability {
  available: boolean;
  backend: string;
  secure: boolean;
}

export const profileProtectionFailureCopy = {
  title: "Village could not protect the browser profile",
  message:
    "Village stopped before opening the browser because this Mac could not confirm Keychain encryption, private profile storage, Spotlight exclusion, or Time Machine exclusion. Review the local profile-protection setup, then reopen Village.",
} as const;

export function isProfileProtectionFailure(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("PROFILE_");
}

const defaultMacProfileProtection: MacProfileProtection = {
  runTmutil: (arguments_) =>
    new Promise((resolve, reject) => {
      execFile(
        "/usr/bin/tmutil",
        arguments_,
        { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          if (error) reject(new Error("PROFILE_BACKUP_EXCLUSION_FAILED"));
          else resolve({ stdout });
        },
      );
    }),
};

function scopeHash(scope: ProfileScope): string {
  return createHash("sha256")
    .update(`${scope.principalId}\0${scope.deviceId}\0${scope.site}`)
    .digest("hex")
    .slice(0, 32);
}

export function scopedProfilePath(root: string, scope: ProfileScope): string {
  return join(root, scopeHash(scope));
}

export function profilePartition(scope: ProfileScope): string {
  return `persist:village-${scopeHash(scope)}`;
}

export async function ensureProtectedProfile(
  root: string,
  scope: ProfileScope,
  supportedPlatform: NodeJS.Platform = process.platform,
  macProfileProtection: MacProfileProtection = defaultMacProfileProtection,
): Promise<{ path: string; partition: string }> {
  if (supportedPlatform !== "darwin") {
    throw new Error("PROFILE_PROTECTION_UNSUPPORTED_PLATFORM");
  }
  await ensurePrivateDirectory(root);
  await ensureSpotlightExclusion(root);
  await macProfileProtection.runTmutil(["addexclusion", root]).catch(() => {
    throw new Error("PROFILE_BACKUP_EXCLUSION_FAILED");
  });
  const exclusion = await macProfileProtection
    .runTmutil(["isexcluded", root])
    .catch(() => {
      throw new Error("PROFILE_BACKUP_EXCLUSION_UNVERIFIED");
    });
  if (!/^\[Excluded\]\s+/m.test(exclusion.stdout)) {
    throw new Error("PROFILE_BACKUP_EXCLUSION_UNVERIFIED");
  }
  const path = scopedProfilePath(root, scope);
  await ensurePrivateDirectory(path);
  return { path, partition: profilePartition(scope) };
}

export function assertMacOsProfileEncryptionAvailable(
  availability: ProfileEncryptionAvailability,
  isPackaged: boolean,
  supportedPlatform: NodeJS.Platform = process.platform,
): void {
  if (!isPackaged) return;
  if (supportedPlatform !== "darwin") {
    throw new Error("PROFILE_PROTECTION_UNSUPPORTED_PLATFORM");
  }
  if (
    !availability.available ||
    !availability.secure ||
    availability.backend !== "keychain"
  ) {
    throw new Error("PROFILE_OS_CRYPT_UNAVAILABLE");
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  let metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new Error("PROFILE_PATH_UNSAFE");
  }
  await chmod(path, 0o700);
  metadata = await lstat(path);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("PROFILE_PERMISSIONS_UNSAFE");
  }
}

async function ensureSpotlightExclusion(root: string): Promise<void> {
  const markerPath = join(root, ".metadata_never_index");
  try {
    const handle = await open(markerPath, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    )) {
      throw new Error("PROFILE_INDEX_EXCLUSION_FAILED");
    }
  }
  const marker = await lstat(markerPath).catch(() => undefined);
  if (!marker?.isFile() || marker.isSymbolicLink()) {
    throw new Error("PROFILE_INDEX_EXCLUSION_UNVERIFIED");
  }
  await chmod(markerPath, 0o600);
}

/** Only callers already holding an exact scope path may invoke this helper. */
export async function eraseScopedProfile(profilePath: string): Promise<void> {
  await rm(profilePath, { recursive: true, force: true, maxRetries: 2 });
}

export async function eraseProfileHoldingLock(
  profilePath: string,
  profileLock: Pick<ProfileLock, "release">,
  erase: (path: string) => Promise<void> = eraseScopedProfile,
): Promise<void> {
  await erase(profilePath);
  await profileLock.release();
}

/** File-system proof used after a destructive lifecycle and app restart. */
export async function scopedProfileAbsent(
  profilePath: string,
): Promise<boolean> {
  try {
    await access(profilePath);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

export class ProfileLock {
  private released = false;

  private constructor(
    private readonly lockPath: string,
    private readonly handle: Awaited<ReturnType<typeof open>>,
  ) {}

  static async acquire(profilePath: string): Promise<ProfileLock> {
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    await chmod(profilePath, 0o700);
    // Keep the lock beside the profile so destructive erasure can remove the
    // entire profile directory without opening a second-host race window.
    const lockPath = `${profilePath}.lock`;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      )) {
        throw error;
      }
      const existingPid = completedLockPid(
        await readFile(lockPath, "utf8").catch(() => ""),
      );
      if (existingPid === undefined || isProcessAlive(existingPid)) {
        throw new Error("PROFILE_IN_USE");
      }
      await unlink(lockPath).catch(() => undefined);
      return ProfileLock.acquire(profilePath);
    }

    try {
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return new ProfileLock(lockPath, handle);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.handle.close();
    await unlink(this.lockPath).catch(() => undefined);
  }
}

function completedLockPid(contents: string): number | undefined {
  if (!/^[1-9]\d*\n$/.test(contents)) return undefined;
  const pid = Number.parseInt(contents, 10);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error.code === "ESRCH" || error.code === "EINVAL")
    );
  }
}
