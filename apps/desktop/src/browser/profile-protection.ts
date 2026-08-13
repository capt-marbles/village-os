import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, unlink } from "node:fs/promises";
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

export class ProfileLock {
  private released = false;

  private constructor(
    private readonly lockPath: string,
    private readonly handle: Awaited<ReturnType<typeof open>>,
  ) {}

  static async acquire(profilePath: string): Promise<ProfileLock> {
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    await chmod(profilePath, 0o700);
    const lockPath = join(profilePath, ".village.lock");
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return new ProfileLock(lockPath, handle);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        const existingPid = Number.parseInt(
          await readFile(lockPath, "utf8").catch(() => ""),
          10,
        );
        if (Number.isInteger(existingPid) && isProcessAlive(existingPid)) {
          throw new Error("PROFILE_IN_USE");
        }
        await unlink(lockPath).catch(() => undefined);
        return ProfileLock.acquire(profilePath);
      }
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
