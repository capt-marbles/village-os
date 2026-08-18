import {
  ritualAuditTimelineSchema,
  ritualCatalogSchema,
  ritualPendingLearningReviewSchema,
  RITUAL_AUDIT_TIMELINE_LIMIT,
  type ApprovedRitualRevision,
  type RitualAuditTimeline,
  type RitualCatalog,
  type RitualInboxItem,
  type RitualLatestSnapshot,
  type RitualLearningReceipt,
  type RitualPendingLearningReview,
  type RitualRun,
  type RitualStore,
} from "@village/contracts";

export function findLearningReceipt(
  store: RitualStore,
  receiptId: string,
): RitualLearningReceipt | null {
  const testReceipt = store.receipts.find(
    (receipt) => receipt.receiptId === receiptId,
  );
  const runReceipt = store.runReceipts.find(
    (receipt) => receipt.receiptId === receiptId,
  );
  if (testReceipt && runReceipt) throw new Error("RITUAL_RECEIPT_CONFLICT");
  return testReceipt ?? runReceipt ?? null;
}

export function findLatestLearningReceipt(
  store: RitualStore,
  ritualId: string,
  ritualRevision: number,
): RitualLearningReceipt | null {
  let latest: RitualLearningReceipt | null = null;
  for (const receipt of [...store.receipts, ...store.runReceipts]) {
    if (
      receipt.ritualId !== ritualId ||
      receipt.ritualRevision !== ritualRevision
    ) {
      continue;
    }
    if (
      !latest ||
      Date.parse(receipt.recordedAt) > Date.parse(latest.recordedAt)
    ) {
      latest = receipt;
    }
  }
  return latest;
}

export function projectLatestSnapshot(
  store: RitualStore,
  approved: ApprovedRitualRevision | null,
): RitualLatestSnapshot {
  const receipt = approved
    ? (store.receipts.findLast(
        (entry) =>
          entry.ritualId === approved.ritualId &&
          entry.ritualRevision === approved.ritualRevision,
      ) ?? null)
    : null;
  const run = approved
    ? (store.runs.findLast(
        (entry) =>
          entry.ritualId === approved.ritualId &&
          entry.ritualRevision === approved.ritualRevision,
      ) ?? null)
    : null;
  return {
    approved,
    receipt,
    run,
    runReceipt: run
      ? (store.runReceipts.findLast((entry) => entry.runId === run.runId) ??
        null)
      : null,
    learningReview: approved ? pendingLearningReview(store, approved) : null,
    auditTimeline: approved
      ? projectAuditTimeline(store, approved.ritualId)
      : [],
  };
}

export function projectCatalog(store: RitualStore): RitualCatalog {
  const currentById = new Map<string, ApprovedRitualRevision>();
  for (const ritual of store.rituals) currentById.set(ritual.ritualId, ritual);
  return ritualCatalogSchema.parse(
    [...currentById.values()]
      .sort((left, right) => right.approvedAt.localeCompare(left.approvedAt))
      .map(({ ritualId, ritualRevision, name, approvedAt }) => ({
        ritualId,
        ritualRevision,
        name,
        approvedAt,
      })),
  );
}

export function projectAutomationSnapshot(
  store: RitualStore,
  approved: ApprovedRitualRevision | null,
) {
  const schedule = approved
    ? (store.schedules.findLast(
        (entry) =>
          entry.ritualId === approved.ritualId &&
          entry.ritualRevision === approved.ritualRevision,
      ) ?? null)
    : null;
  return {
    approved,
    schedule,
    inbox: approved ? inboxFromStore(store, approved.ritualId) : [],
  };
}

export function inboxFromStore(
  store: RitualStore,
  ritualId?: string,
): readonly RitualInboxItem[] {
  const receipts = new Map(
    store.runReceipts.map((receipt) => [receipt.runId, receipt] as const),
  );
  return store.runs
    .filter((run) => !ritualId || run.ritualId === ritualId)
    .map((run) => ({
      run,
      receipt: receipts.get(run.runId) ?? null,
      attention: attentionFor(run),
    }))
    .sort((left, right) => {
      const attention =
        Number(Boolean(right.attention)) - Number(Boolean(left.attention));
      return attention || right.run.updatedAt.localeCompare(left.run.updatedAt);
    })
    .slice(0, 20);
}

function projectAuditTimeline(
  store: RitualStore,
  ritualId: string,
): RitualAuditTimeline {
  const revisionEntries = store.rituals
    .filter((ritual) => ritual.ritualId === ritualId)
    .map((ritual) => ({
      kind: "REVISION_APPROVED" as const,
      sourceId: ritual.ritualId,
      ritualRevision: ritual.ritualRevision,
      source: ritual.learningProposalId
        ? ("LEARNING" as const)
        : ritual.restoredFromRevision
          ? ("RESTORE" as const)
          : ("INITIAL" as const),
      ...(ritual.restoredFromRevision
        ? { restoredFromRevision: ritual.restoredFromRevision }
        : {}),
      occurredAt: ritual.approvedAt,
    }));
  const activityEntries = [
    ...store.receipts
      .filter((receipt) => receipt.ritualId === ritualId)
      .map((receipt) => ({
        kind: "TEST_RECORDED" as const,
        sourceId: receipt.receiptId,
        ritualRevision: receipt.ritualRevision,
        outcome: receipt.outcome,
        occurredAt: receipt.recordedAt,
      })),
    ...store.runReceipts
      .filter((receipt) => receipt.ritualId === ritualId)
      .map((receipt) => ({
        kind: "RUN_RECORDED" as const,
        sourceId: receipt.receiptId,
        ritualRevision: receipt.ritualRevision,
        outcome: receipt.outcome,
        occurredAt: receipt.recordedAt,
      })),
    ...store.learningDecisions
      .filter((decision) => decision.ritualId === ritualId)
      .map((decision) => ({
        kind: "LEARNING_DECIDED" as const,
        sourceId: decision.proposalId,
        ritualRevision: decision.fromRevision,
        decision: decision.decision,
        occurredAt: decision.decidedAt,
      })),
  ].sort((left, right) => {
    const byTime = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    return byTime || left.kind.localeCompare(right.kind);
  });
  const entries = [
    ...revisionEntries,
    ...activityEntries.slice(
      0,
      Math.max(0, RITUAL_AUDIT_TIMELINE_LIMIT - revisionEntries.length),
    ),
  ].sort((left, right) => {
    const byTime = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    return byTime || left.kind.localeCompare(right.kind);
  });
  return ritualAuditTimelineSchema.parse(entries);
}

function pendingLearningReview(
  store: RitualStore,
  approved: ApprovedRitualRevision,
): RitualPendingLearningReview | null {
  const proposal = store.learningProposals.findLast(
    (entry) =>
      entry.ritualId === approved.ritualId &&
      entry.fromRevision === approved.ritualRevision,
  );
  if (!proposal) return null;
  if (
    store.learningDecisions.some(
      (decision) => decision.proposalId === proposal.proposalId,
    )
  ) {
    return null;
  }
  const receipt = findLearningReceipt(store, proposal.receiptId);
  if (!receipt) throw new Error("RITUAL_LEARNING_LINEAGE_CORRUPT");
  if (receipt.mode === "TEST") {
    return ritualPendingLearningReviewSchema.parse({
      kind: "TEST",
      proposal,
      receipt,
    });
  }
  const run = store.runs.find((entry) => entry.runId === receipt.runId);
  if (!run) throw new Error("RITUAL_LEARNING_LINEAGE_CORRUPT");
  return ritualPendingLearningReviewSchema.parse({
    kind: "RUN",
    proposal,
    receipt,
    run,
  });
}

function attentionFor(run: RitualRun): RitualInboxItem["attention"] {
  switch (run.status) {
    case "WAITING_FOR_OWNER":
      return "OWNER_APPROVAL";
    case "WAITING_FOR_RESOURCE":
      return "RESOURCE";
    case "NEEDS_REVIEW":
      return "REVIEW";
    case "FAILED":
      return "FAILURE";
    default:
      return null;
  }
}
