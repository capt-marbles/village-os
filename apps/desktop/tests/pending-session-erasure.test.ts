import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { scopedProfilePath } from "../src/browser/profile-protection.js";
import {
  completePendingSessionErasure,
  PendingSessionErasureStore,
} from "../src/main/pending-session-erasure.js";
import type { SessionErasureBinding } from "../src/main/session-erasure.js";

const roots: string[] = [];
const binding: SessionErasureBinding = {
  principalId: "usr_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  browserSessionId: "bsn_01J00000000000000000000000",
  site: "LINKEDIN",
  operation: "FORGET_SESSION",
  currentState: "PRESENT",
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "village-erasure-"));
  roots.push(root);
  return {
    root,
    profileRoot: join(root, "profiles"),
    store: new PendingSessionErasureStore(join(root, "erasure"), () => 123),
  };
}

describe("restart-staged session erasure", () => {
  it("persists a private strict request and removes only its exact profile", async () => {
    const setup = await fixture();
    const target = scopedProfilePath(setup.profileRoot, binding);
    const siblingBinding = { ...binding, site: "OWNED_FIXTURE" as const };
    const sibling = scopedProfilePath(setup.profileRoot, siblingBinding);
    await mkdir(target, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(join(target, "cookie"), "target");
    await writeFile(join(sibling, "cookie"), "sibling");

    await setup.store.stage(binding);
    await expect(
      completePendingSessionErasure(setup.store, setup.profileRoot),
    ).resolves.toMatchObject({
      version: 1,
      binding,
      requestedAt: 123,
    });
    await expect(
      readFile(join(target, "cookie"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(sibling, "cookie"), "utf8")).resolves.toBe(
      "sibling",
    );
    await expect(setup.store.load()).resolves.toBeNull();
  });

  it("retains the request after a failed restart deletion so startup can retry", async () => {
    const setup = await fixture();
    await setup.store.stage(binding);
    const profileRootAsFile = join(setup.root, "profiles-file");
    await writeFile(profileRootAsFile, "blocked");

    await expect(
      completePendingSessionErasure(setup.store, profileRootAsFile),
    ).rejects.toBeDefined();
    await expect(setup.store.load()).resolves.toMatchObject({ binding });
  });

  it("rejects a permissive or symlinked pending record", async () => {
    const setup = await fixture();
    await setup.store.stage(binding);
    const recordPath = join(setup.root, "erasure", "pending.json");
    await import("node:fs/promises").then(({ chmod }) =>
      chmod(recordPath, 0o644),
    );
    await expect(setup.store.load()).rejects.toThrow(
      "PENDING_SESSION_ERASURE_PERMISSIONS_UNSAFE",
    );
    expect((await stat(recordPath)).mode & 0o077).not.toBe(0);
  });

  it("does not let a different Site Session replace a pending deletion", async () => {
    const setup = await fixture();
    await setup.store.stage(binding);
    await expect(
      setup.store.stage({ ...binding, site: "OWNED_FIXTURE" }),
    ).rejects.toThrow("PENDING_SESSION_ERASURE_CONFLICT");
    await expect(setup.store.load()).resolves.toMatchObject({ binding });
  });
});
