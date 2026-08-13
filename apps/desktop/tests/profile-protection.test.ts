import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ProfileLock,
  eraseProfileHoldingLock,
  eraseScopedProfile,
  ensureProtectedProfile,
  profilePartition,
  scopedProfileAbsent,
} from "../src/browser/profile-protection.js";

describe("protected browser profile", () => {
  it("keeps the scope lock held until profile deletion succeeds", async () => {
    const release = vi.fn(async () => undefined);
    const failedErase = vi.fn(async () => {
      throw new Error("disk busy");
    });

    await expect(
      eraseProfileHoldingLock("/scoped/profile", { release }, failedErase),
    ).rejects.toThrow("disk busy");
    expect(release).not.toHaveBeenCalled();

    await eraseProfileHoldingLock(
      "/scoped/profile",
      { release },
      async () => undefined,
    );
    expect(release).toHaveBeenCalledOnce();
  });
  it("creates a private scoped directory and stable persistent partition", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-profile-"));
    const profile = await ensureProtectedProfile(
      root,
      {
        principalId: "usr_01J00000000000000000000000",
        deviceId: "dev_01J00000000000000000000000",
        site: "OWNED_FIXTURE",
      },
      "darwin",
    );
    const metadata = await stat(profile.path);
    expect(metadata.mode & 0o077).toBe(0);
    expect(profile.partition).toBe(
      profilePartition({
        principalId: "usr_01J00000000000000000000000",
        deviceId: "dev_01J00000000000000000000000",
        site: "OWNED_FIXTURE",
      }),
    );
  });

  it("fails closed outside the supported macOS alpha", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-profile-platform-"));
    await expect(
      ensureProtectedProfile(
        root,
        {
          principalId: "usr_01J00000000000000000000000",
          deviceId: "dev_01J00000000000000000000000",
          site: "OWNED_FIXTURE",
        },
        "linux",
      ),
    ).rejects.toThrow("PROFILE_PROTECTION_UNSUPPORTED_PLATFORM");
  });

  it("prevents two processes from claiming the same profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-profile-lock-"));
    const path = join(root, "profile");
    const first = await ProfileLock.acquire(path);
    await expect(ProfileLock.acquire(path)).rejects.toThrow("PROFILE_IN_USE");
    await first.release();
    const second = await ProfileLock.acquire(path);
    await second.release();
  });

  it("keeps the sibling lock authoritative while the profile is erased", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-profile-erase-lock-"));
    const path = join(root, "profile");
    const lock = await ProfileLock.acquire(path);

    await eraseScopedProfile(path);
    await expect(ProfileLock.acquire(path)).rejects.toThrow("PROFILE_IN_USE");

    await lock.release();
    const replacement = await ProfileLock.acquire(path);
    await replacement.release();
  });

  it("recovers a lock left by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-stale-lock-"));
    const path = join(root, "profile");
    await mkdir(path, { mode: 0o700 });
    await writeFile(`${path}.lock`, "2147483647\n", {
      mode: 0o600,
    });
    const lock = await ProfileLock.acquire(path);
    await lock.release();
  });

  it("fails closed while a newly-created lock has no complete PID", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-partial-lock-"));
    const path = join(root, "profile");
    await mkdir(path, { mode: 0o700 });
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, "", { mode: 0o600 });

    await expect(ProfileLock.acquire(path)).rejects.toThrow("PROFILE_IN_USE");
    await expect(readFile(lockPath, "utf8")).resolves.toBe("");
  });

  it("erases only the exact scoped profile and proves it remains absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-profile-erasure-"));
    const first = await ensureProtectedProfile(
      root,
      {
        principalId: "usr_01J00000000000000000000000",
        deviceId: "dev_01J00000000000000000000000",
        site: "LINKEDIN",
      },
      "darwin",
    );
    const other = await ensureProtectedProfile(
      root,
      {
        principalId: "usr_01J00000000000000000000000",
        deviceId: "dev_01J00000000000000000000001",
        site: "LINKEDIN",
      },
      "darwin",
    );
    await writeFile(join(first.path, "cookie-store"), "site-only");
    await writeFile(join(other.path, "cookie-store"), "other-device");

    await eraseScopedProfile(first.path);
    expect(await scopedProfileAbsent(first.path)).toBe(true);
    expect(await scopedProfileAbsent(other.path)).toBe(false);
    expect(await readFile(join(other.path, "cookie-store"), "utf8")).toBe(
      "other-device",
    );
  });
});
