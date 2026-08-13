import { createHash } from "node:crypto";
import {
  access,
  chmod,
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

function scopeHash(scope: ProfileScope): string {
  return createHash("sha256")
    .update(`${scope.principalId}\0${scope.deviceId}\0${scope.site}`)
    .digest("hex")
    .slice(0, 32);
}

export function profilePartition(scope: ProfileScope): string {
  return `persist:village-${scopeHash(scope)}`;
}

export async function ensureProtectedProfile(
  root: string,
  scope: ProfileScope,
  supportedPlatform: NodeJS.Platform = process.platform,
): Promise<{ path: string; partition: string }> {
  if (supportedPlatform !== "darwin") {
    throw new Error("PROFILE_PROTECTION_UNSUPPORTED_PLATFORM");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const path = join(root, scopeHash(scope));
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  return { path, partition: profilePartition(scope) };
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
