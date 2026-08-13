import { spawn } from "node:child_process";

export type StepUpOperation = "FORGET_SESSION";
export type SiteSessionState = "PRESENT" | "ERASURE_FAILED";

export interface StepUpBinding {
  principalId: string;
  deviceId: string;
  browserSessionId: string;
  site: "OWNED_FIXTURE" | "LINKEDIN";
  operation: StepUpOperation;
  currentState: SiteSessionState;
}

type StoredStepUp = StepUpBinding & {
  expiresAt: number;
  consumedAt?: number;
};

export type StepUpConsumption =
  | { ok: true }
  | {
      ok: false;
      code:
        | "STEP_UP_UNKNOWN"
        | "STEP_UP_REPLAYED"
        | "STEP_UP_EXPIRED"
        | "STEP_UP_BINDING_MISMATCH";
    };

export type OwnerPresenceRunner = (
  file: string,
  arguments_: readonly string[],
) => Promise<number>;

const macOsAuthorizationScript =
  'do shell script "/usr/bin/true" with administrator privileges with prompt "Village needs permission to forget this local browser session."';

/**
 * Requests a system-owned macOS authorization dialog. Village supplies only a
 * fixed no-op command and never receives the password entered into that UI.
 */
export async function verifyMacOsOwnerPresence(
  platform = process.platform,
  run: OwnerPresenceRunner = runMacOsAuthorization,
): Promise<boolean> {
  if (platform !== "darwin") return false;
  try {
    return (
      (await run("/usr/bin/osascript", ["-e", macOsAuthorizationScript])) === 0
    );
  } catch {
    return false;
  }
}

function runMacOsAuthorization(
  file: string,
  arguments_: readonly string[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, arguments_, {
      stdio: "ignore",
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("STEP_UP_AUTHORIZATION_TIMEOUT"));
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
  });
}

/** Main-process-only, short-lived proof for destructive local operations. */
export class StepUpAuthorizer {
  private readonly tokens = new Map<string, StoredStepUp>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(
    binding: StepUpBinding,
    lifetimeMs: number,
  ): { token: string; expiresAt: number } {
    if (
      !Number.isInteger(lifetimeMs) ||
      lifetimeMs < 1 ||
      lifetimeMs > 60_000
    ) {
      throw new Error("INVALID_STEP_UP_LIFETIME");
    }
    this.purge();
    const token = crypto.randomUUID();
    const expiresAt = this.now() + lifetimeMs;
    this.tokens.set(token, { ...binding, expiresAt });
    return { token, expiresAt };
  }

  consume(token: string, binding: StepUpBinding): StepUpConsumption {
    this.purge();
    const stored = this.tokens.get(token);
    if (!stored) return { ok: false, code: "STEP_UP_UNKNOWN" };
    if (stored.consumedAt !== undefined) {
      return { ok: false, code: "STEP_UP_REPLAYED" };
    }
    if (this.now() >= stored.expiresAt) {
      stored.consumedAt = this.now();
      return { ok: false, code: "STEP_UP_EXPIRED" };
    }
    if (!sameBinding(stored, binding)) {
      stored.consumedAt = this.now();
      return { ok: false, code: "STEP_UP_BINDING_MISMATCH" };
    }
    stored.consumedAt = this.now();
    return { ok: true };
  }

  private purge(): void {
    const now = this.now();
    for (const [token, stored] of this.tokens) {
      if ((stored.consumedAt ?? stored.expiresAt) + 60_000 < now) {
        this.tokens.delete(token);
      }
    }
  }
}

function sameBinding(left: StepUpBinding, right: StepUpBinding): boolean {
  return (
    left.principalId === right.principalId &&
    left.deviceId === right.deviceId &&
    left.browserSessionId === right.browserSessionId &&
    left.site === right.site &&
    left.operation === right.operation &&
    left.currentState === right.currentState
  );
}
