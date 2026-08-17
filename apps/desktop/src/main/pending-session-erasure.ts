import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  eraseScopedProfile,
  scopedProfileAbsent,
  scopedProfilePath,
} from "../browser/profile-protection.js";
import type { SessionErasureBinding } from "./session-erasure.js";

const pendingSessionErasureSchema = z
  .object({
    version: z.literal(1),
    binding: z
      .object({
        principalId: z.string().min(1).max(128),
        deviceId: z.string().min(1).max(128),
        browserSessionId: z.string().min(1).max(128),
        site: z.enum(["OWNED_FIXTURE", "LINKEDIN"]),
        operation: z.literal("FORGET_SESSION"),
        currentState: z.enum(["PRESENT", "ERASURE_FAILED"]),
      })
      .strict(),
    requestedAt: z.number().int().nonnegative(),
  })
  .strict();

export type PendingSessionErasure = z.infer<typeof pendingSessionErasureSchema>;

export const pendingSessionErasureFailureCopy = {
  title: "Village could not finish forgetting the local session",
  message:
    "Village stopped before opening the browser because the previous session removal could not be safely completed. Reopen Village to retry; if the problem continues, review the local browser-profile permissions.",
} as const;

export function isPendingSessionErasureFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith("PENDING_SESSION_ERASURE_") ||
      error.message === "PROFILE_PATH_UNSAFE")
  );
}

export class PendingSessionErasureStore {
  private readonly path: string;

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(root, "pending.json");
  }

  async stage(binding: SessionErasureBinding): Promise<void> {
    const record = pendingSessionErasureSchema.parse({
      version: 1,
      binding,
      requestedAt: this.now(),
    });
    const existing = await this.load();
    if (existing && !sameBinding(existing.binding, binding)) {
      throw new Error("PENDING_SESSION_ERASURE_CONFLICT");
    }
    await ensurePrivateDirectory(dirname(this.path));
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.path);
    await chmod(this.path, 0o600);
  }

  async load(): Promise<PendingSessionErasure | null> {
    const handle = await open(
      this.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw new Error("PENDING_SESSION_ERASURE_UNSAFE");
    });
    if (!handle) return null;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > 8_192) {
        throw new Error("PENDING_SESSION_ERASURE_UNSAFE");
      }
      if ((metadata.mode & 0o077) !== 0) {
        throw new Error("PENDING_SESSION_ERASURE_PERMISSIONS_UNSAFE");
      }
      return pendingSessionErasureSchema.parse(
        JSON.parse(await handle.readFile("utf8")),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("PENDING_SESSION_ERASURE_")
      ) {
        throw error;
      }
      throw new Error("PENDING_SESSION_ERASURE_INVALID");
    } finally {
      await handle.close();
    }
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

export async function completePendingSessionErasure(
  store: PendingSessionErasureStore,
  profileRoot: string,
): Promise<PendingSessionErasure | null> {
  const pending = await store.load();
  if (!pending) return null;
  const target = scopedProfilePath(profileRoot, pending.binding);
  await eraseScopedProfile(target);
  if (!(await scopedProfileAbsent(target))) {
    throw new Error("PENDING_SESSION_ERASURE_VERIFICATION_FAILED");
  }
  await store.clear();
  return pending;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("PENDING_SESSION_ERASURE_PATH_UNSAFE");
  }
  await chmod(path, 0o700);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sameBinding(
  left: SessionErasureBinding,
  right: SessionErasureBinding,
): boolean {
  return (
    left.principalId === right.principalId &&
    left.deviceId === right.deviceId &&
    left.browserSessionId === right.browserSessionId &&
    left.site === right.site &&
    left.operation === right.operation &&
    left.currentState === right.currentState
  );
}
