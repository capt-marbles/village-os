import type { StepUpAuthorizer, StepUpBinding } from "./step-up-auth.js";

export type SessionErasureBinding = StepUpBinding;

export interface RestartStagedSessionErasureOperations {
  /** Fence any future automated mutation before the browser is touched. */
  revokeAutomation(binding: SessionErasureBinding): Promise<void>;
  closeTarget(binding: SessionErasureBinding): Promise<void>;
  clearBrowserStorage(binding: SessionErasureBinding): Promise<void>;
  clearPermissions(binding: SessionErasureBinding): Promise<void>;
  revokeCredentialReferences(binding: SessionErasureBinding): Promise<void>;
  stageProfileRemoval(binding: SessionErasureBinding): Promise<void>;
}

export type SessionErasureResult =
  | { status: "RESTART_REQUIRED" }
  | {
      status: "REJECTED";
      code:
        | "STEP_UP_UNKNOWN"
        | "STEP_UP_REPLAYED"
        | "STEP_UP_EXPIRED"
        | "STEP_UP_BINDING_MISMATCH"
        | "ERASURE_ALREADY_RUNNING";
    }
  | {
      status: "PARTIAL_FAILURE";
      failedStep: string;
      retriable: true;
    };

/**
 * Performs every cleanup operation that is safe while Electron is running,
 * then records the exact profile for deletion by the next process. Chromium
 * Session objects have no destroy API, so physical profile removal must not
 * occur until process restart has released the partition.
 */
export class RestartStagedSessionErasureCoordinator {
  private running = false;

  constructor(
    private readonly authorizer: StepUpAuthorizer,
    private readonly operations: RestartStagedSessionErasureOperations,
  ) {}

  async erase(
    stepUpToken: string,
    binding: SessionErasureBinding,
  ): Promise<SessionErasureResult> {
    if (this.running)
      return { status: "REJECTED", code: "ERASURE_ALREADY_RUNNING" };
    const authorization = this.authorizer.consume(stepUpToken, binding);
    if (!authorization.ok)
      return { status: "REJECTED", code: authorization.code };
    this.running = true;
    try {
      const steps: readonly [string, () => Promise<void>][] = [
        ["revokeAutomation", () => this.operations.revokeAutomation(binding)],
        ["closeTarget", () => this.operations.closeTarget(binding)],
        [
          "clearBrowserStorage",
          () => this.operations.clearBrowserStorage(binding),
        ],
        ["clearPermissions", () => this.operations.clearPermissions(binding)],
        [
          "revokeCredentialReferences",
          () => this.operations.revokeCredentialReferences(binding),
        ],
        [
          "stageProfileRemoval",
          () => this.operations.stageProfileRemoval(binding),
        ],
      ];
      for (const [name, step] of steps) {
        try {
          await step();
        } catch {
          return {
            status: "PARTIAL_FAILURE",
            failedStep: name,
            retriable: true,
          };
        }
      }
      return { status: "RESTART_REQUIRED" };
    } finally {
      this.running = false;
    }
  }
}
