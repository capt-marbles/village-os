import {
  RestartStagedSessionErasureCoordinator,
  type SessionErasureBinding,
} from "./session-erasure.js";
import { StepUpAuthorizer } from "./step-up-auth.js";

export type SessionErasureRequestResult =
  "STEP_UP_REQUIRED" | "DECLINED" | "RESTART_REQUIRED" | "PARTIAL_FAILURE";

export interface SessionErasureRequestDependencies {
  binding(): SessionErasureBinding;
  verifyOwner(binding: SessionErasureBinding): Promise<boolean>;
  confirm(binding: SessionErasureBinding): Promise<boolean>;
  authorizer: StepUpAuthorizer;
  coordinator: RestartStagedSessionErasureCoordinator;
  onStepUpRequired(): void;
  onErasureStarted(): void;
  onErasureStaged(): void;
  onErasureFailed(failedStep?: string): void;
  restart(): void;
}

export interface SessionErasureConfirmationDialog {
  showMessageBox(options: {
    type: "warning";
    title: string;
    message: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    noLink: boolean;
  }): Promise<{ response: number }>;
}

/** Shared native confirmation used by production and the owner-operated proof. */
export async function confirmSessionErasure(
  nativeDialog: SessionErasureConfirmationDialog,
): Promise<boolean> {
  const confirmation = await nativeDialog.showMessageBox({
    type: "warning",
    title: "Forget this local session?",
    message:
      "Village will close the browser, clear this site's data, and restart to finish removing the local profile.",
    buttons: ["Forget session", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return confirmation.response === 0;
}

/** Main-process authorization and confirmation boundary for local erasure. */
export class SessionErasureRequestController {
  constructor(
    private readonly dependencies: SessionErasureRequestDependencies,
  ) {}

  async request(): Promise<SessionErasureRequestResult> {
    this.dependencies.onStepUpRequired();
    const binding = this.dependencies.binding();
    if (!(await this.dependencies.verifyOwner(binding))) {
      return "STEP_UP_REQUIRED";
    }
    if (!(await this.dependencies.confirm(binding))) return "DECLINED";
    const token = this.dependencies.authorizer.mint(binding, 15_000);
    this.dependencies.onErasureStarted();
    const result = await this.dependencies.coordinator.erase(
      token.token,
      binding,
    );
    if (result.status === "RESTART_REQUIRED") {
      this.dependencies.onErasureStaged();
      this.dependencies.restart();
      return "RESTART_REQUIRED";
    }
    if (result.status === "PARTIAL_FAILURE") {
      this.dependencies.onErasureFailed(result.failedStep);
      return "PARTIAL_FAILURE";
    }
    this.dependencies.onErasureFailed();
    return "STEP_UP_REQUIRED";
  }
}
