export type ActionPostcondition = "SATISFIED" | "NOT_SATISFIED" | "UNKNOWN";

export interface LocalAction {
  actionId: string;
  leaseEpoch: number;
  mutationClass: "READ_ONLY" | "IDEMPOTENT" | "NON_IDEMPOTENT";
  run(): Promise<ActionPostcondition>;
}

type InFlight = {
  actionId: string;
  settled: Promise<void>;
};

export class LocalActionExecutor {
  private leaseEpoch: number;
  private blocked = false;
  private inFlight: InFlight | undefined;

  constructor(initial: { leaseEpoch: number }) {
    this.leaseEpoch = initial.leaseEpoch;
  }

  isAutomationBlocked(): boolean {
    return this.blocked;
  }

  async execute(action: LocalAction): Promise<ActionPostcondition> {
    if (this.blocked) throw new Error("AUTOMATION_BLOCKED");
    if (action.leaseEpoch !== this.leaseEpoch) {
      throw new Error("STALE_LEASE_EPOCH");
    }
    if (this.inFlight) throw new Error("ACTION_ALREADY_IN_FLIGHT");

    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    this.inFlight = {
      actionId: action.actionId,
      settled,
    };
    try {
      return await action.run();
    } finally {
      settle();
      this.inFlight = undefined;
    }
  }

  markOfflineTakeover(): void {
    this.blocked = true;
  }

  async beginOnlineTakeover(
    nextEpoch: number,
    timeoutMs: number,
  ): Promise<
    { status: "QUIESCED" } | { status: "OUTCOME_UNKNOWN"; actionId: string }
  > {
    if (nextEpoch <= this.leaseEpoch) throw new Error("STALE_LEASE_EPOCH");
    this.blocked = true;
    this.leaseEpoch = nextEpoch;
    const inFlight = this.inFlight;
    if (!inFlight) return { status: "QUIESCED" };

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      inFlight.settled.then(() => false),
      new Promise<true>((resolve) => {
        timeout = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timeout));
    if (!timedOut) return { status: "QUIESCED" };
    return { status: "OUTCOME_UNKNOWN", actionId: inFlight.actionId };
  }

  reconcileAgentLease(epoch: number): void {
    if (epoch <= this.leaseEpoch) throw new Error("STALE_LEASE_EPOCH");
    if (this.inFlight) throw new Error("ACTION_RECONCILIATION_REQUIRED");
    this.leaseEpoch = epoch;
    this.blocked = false;
  }
}
