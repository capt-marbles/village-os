import type { LocalActionExecutor } from "../browser/local-action-executor.js";
import type { BrowserViewportCoordinator } from "./browser-viewport-coordinator.js";
import type { DesktopBrowserUiState } from "./desktop-browser-ui-state.js";

export type TakeoverResult =
  "QUIESCED" | "OUTCOME_UNKNOWN" | "RECOVERY_REQUIRED";

export class BrowserControlTransfer {
  private leaseEpoch = 1;

  constructor(
    private readonly state: DesktopBrowserUiState,
    private readonly viewport: BrowserViewportCoordinator,
    private readonly executor: LocalActionExecutor,
    private readonly reloadAfterUncertainAction: () => Promise<void>,
  ) {}

  async takeover(timeoutMs: number): Promise<TakeoverResult> {
    this.state.beginTakeover();
    this.viewport.beginTakeover();
    try {
      this.leaseEpoch += 1;
      const outcome = await this.executor.beginOnlineTakeover(
        this.leaseEpoch,
        timeoutMs,
      );
      if (outcome.status === "OUTCOME_UNKNOWN") {
        try {
          await this.reloadAfterUncertainAction();
        } catch {
          this.viewport.acknowledgeTakeover();
          this.state.completeTakeover("UNKNOWN_CHALLENGE");
          return "RECOVERY_REQUIRED";
        }
      }
      this.viewport.acknowledgeTakeover();
      this.state.completeTakeover();
      return outcome.status;
    } catch (error) {
      if (this.executor.isAutomationBlocked()) {
        this.viewport.acknowledgeTakeover();
        this.state.completeTakeover("UNKNOWN_CHALLENGE");
        return "RECOVERY_REQUIRED";
      }
      this.viewport.restoreAgentControl();
      this.state.restoreAgentAfterDeclinedTakeover();
      throw error;
    }
  }

  returnControl(): "RETURNED" {
    this.state.beginReturnControl();
    this.viewport.beginTakeover();
    try {
      this.leaseEpoch += 1;
      this.executor.reconcileAgentLease(this.leaseEpoch);
      this.state.completeReturnControl();
      return "RETURNED";
    } catch (error) {
      this.state.restoreUserAfterFailedReturn();
      this.viewport.restoreUserControl();
      throw error;
    }
  }
}
