import type { BrowserUiSnapshot, BrowserVerification } from "@village/ui";

type Listener = (snapshot: BrowserUiSnapshot) => void;

export class DesktopBrowserUiState {
  private snapshot: BrowserUiSnapshot;
  private readonly listeners = new Set<Listener>();

  constructor(initial?: Partial<BrowserUiSnapshot>) {
    this.snapshot = {
      surface: "DESKTOP",
      jobState: "RUNNING_AGENT",
      controller: "AGENT",
      connection: "ONLINE",
      takeover: "NONE",
      pairing: "PAIRED",
      verification: "unknown",
      profile: "PRESENT",
      humanGate: null,
      erasure: "IDLE",
      lastUpdatedAt: new Date().toISOString(),
      ...initial,
    };
  }

  current(): BrowserUiSnapshot {
    return { ...this.snapshot };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginTakeover(): void {
    if (
      this.snapshot.connection !== "ONLINE" ||
      this.snapshot.controller !== "AGENT" ||
      this.snapshot.takeover !== "NONE"
    ) {
      throw new Error("TAKEOVER_UNAVAILABLE");
    }
    this.update({
      controller: "NONE",
      takeover: "QUIESCING",
    });
  }

  completeTakeover(recoveryGate: BrowserUiSnapshot["humanGate"] = null): void {
    if (this.snapshot.takeover !== "QUIESCING") {
      throw new Error("TAKEOVER_NOT_PENDING");
    }
    this.update({
      jobState: "RUNNING_USER",
      controller: "USER",
      takeover: "NONE",
      humanGate: recoveryGate,
    });
  }

  restoreAgentAfterDeclinedTakeover(): void {
    if (this.snapshot.takeover !== "QUIESCING") return;
    this.update({ controller: "AGENT", takeover: "NONE" });
  }

  beginReturnControl(): void {
    if (
      this.snapshot.controller !== "USER" ||
      this.snapshot.connection !== "ONLINE"
    ) {
      throw new Error("RETURN_REQUIRES_ONLINE_USER_CONTROL");
    }
    this.update({ controller: "NONE", takeover: "RECONCILING" });
  }

  completeReturnControl(): void {
    if (this.snapshot.takeover !== "RECONCILING") {
      throw new Error("RECONCILIATION_NOT_PENDING");
    }
    this.update({
      jobState: "RUNNING_AGENT",
      controller: "AGENT",
      takeover: "NONE",
      humanGate: null,
    });
  }

  restoreUserAfterFailedReturn(): void {
    if (this.snapshot.takeover !== "RECONCILING") {
      throw new Error("RECONCILIATION_NOT_PENDING");
    }
    this.update({
      jobState: "RUNNING_USER",
      controller: "USER",
      takeover: "NONE",
      humanGate: "UNKNOWN_CHALLENGE",
    });
  }

  markConnection(connection: BrowserUiSnapshot["connection"]): void {
    if (connection === "ONLINE") {
      this.update({ connection });
      return;
    }
    if (this.snapshot.controller === "USER") {
      this.update({ connection, takeover: "OFFLINE_MARKED" });
      return;
    }
    this.update({
      connection,
      controller: "NONE",
      takeover: "NONE",
      jobState: "WAITING_FOR_BROWSER",
    });
  }

  recordVerification(status: BrowserVerification): void {
    this.update({
      verification: status,
      jobState:
        status === "authenticated" || status === "confirmed_by_user"
          ? "SUCCEEDED"
          : "VERIFYING",
    });
  }

  requireStepUpForErasure(): void {
    this.update({ erasure: "STEP_UP_REQUIRED" });
  }

  beginErasure(): void {
    this.update({
      erasure: "ERASING",
      profile: "FORGETTING",
      jobState: "CANCELED",
      controller: "NONE",
      takeover: "NONE",
    });
  }

  completeErasure(): void {
    this.update({
      erasure: "COMPLETE",
      profile: "ABSENT",
      controller: "NONE",
      takeover: "NONE",
    });
  }

  failErasure(): void {
    this.update({
      erasure: "FAILED",
      profile: "ERASURE_FAILED",
      controller: "NONE",
      takeover: "NONE",
    });
  }

  cancelFutureAutomation(): void {
    this.update({
      jobState: "CANCELED",
      controller: this.snapshot.controller === "USER" ? "USER" : "NONE",
      takeover:
        this.snapshot.controller === "USER" &&
        this.snapshot.connection === "OFFLINE"
          ? "OFFLINE_MARKED"
          : "NONE",
    });
  }

  markDeviceRevoked(): void {
    this.update({
      pairing: "REVOKED",
      jobState: "WAITING_FOR_BROWSER",
      controller: "NONE",
      takeover: "NONE",
    });
  }

  private update(update: Partial<BrowserUiSnapshot>): void {
    if (
      Object.entries(update).every(
        ([key, value]) =>
          this.snapshot[key as keyof BrowserUiSnapshot] === value,
      )
    ) {
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      ...update,
      surface: "DESKTOP",
      lastUpdatedAt: new Date().toISOString(),
    };
    const safeSnapshot = this.current();
    for (const listener of this.listeners) listener(safeSnapshot);
  }
}
