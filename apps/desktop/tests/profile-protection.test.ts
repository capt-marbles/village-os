import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProfileLock,
  ensureProtectedProfile,
  profilePartition,
} from "../src/browser/profile-protection.js";

describe("protected browser profile", () => {
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

  it("recovers a lock left by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-stale-lock-"));
    const path = join(root, "profile");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, ".village.lock"), "2147483647\n", {
      mode: 0o600,
    });
    const lock = await ProfileLock.acquire(path);
    await lock.release();
  });
});
