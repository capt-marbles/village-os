import type { StepUpAuthorizer, StepUpBinding } from "./step-up-auth.js";

export type SessionErasureBinding = StepUpBinding;

export interface SessionErasureOperations {
  /** Fence any future automated mutation before the browser is touched. */
  revokeAutomation(binding: SessionErasureBinding): Promise<void>;
  /** Close the target view and release its partition before file removal. */
  closeTarget(binding: SessionErasureBinding): Promise<void>;
  clearBrowserStorage(binding: SessionErasureBinding): Promise<void>;
  clearPermissions(binding: SessionErasureBinding): Promise<void>;
  clearActionJournal(binding: SessionErasureBinding): Promise<void>;
  clearTemporaryData(binding: SessionErasureBinding): Promise<void>;
  clearDownloads(binding: SessionErasureBinding): Promise<void>;
  revokeCredentialReferences(binding: SessionErasureBinding): Promise<void>;
  removeProfile(binding: SessionErasureBinding): Promise<void>;
  /** Must re-open the local storage view and prove this scope is absent. */
  verifyAbsent(binding: SessionErasureBinding): Promise<boolean>;
}

export type SessionErasureResult =
  | { status: "COMPLETE" }
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
 * Serializes destructive work per desktop process. A retry requires a fresh
 * step-up token, but completed individual cleanup steps are allowed to be
 * idempotent so partial failures can be safely replayed.
 */
export class SessionErasureCoordinator {
  private running = false;

  constructor(
    private readonly authorizer: StepUpAuthorizer,
    private readonly operations: SessionErasureOperations,
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
          "clearActionJournal",
          () => this.operations.clearActionJournal(binding),
        ],
        [
          "clearTemporaryData",
          () => this.operations.clearTemporaryData(binding),
        ],
        ["clearDownloads", () => this.operations.clearDownloads(binding)],
        [
          "revokeCredentialReferences",
          () => this.operations.revokeCredentialReferences(binding),
        ],
        ["removeProfile", () => this.operations.removeProfile(binding)],
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
      if (!(await this.operations.verifyAbsent(binding))) {
        return {
          status: "PARTIAL_FAILURE",
          failedStep: "verifyAbsent",
          retriable: true,
        };
      }
      return { status: "COMPLETE" };
    } finally {
      this.running = false;
    }
  }
}
