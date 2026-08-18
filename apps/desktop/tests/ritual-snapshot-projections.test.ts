import { describe, expect, it } from "vitest";
import { findLatestLearningReceipt } from "../src/main/ritual-snapshot-projections.js";

describe("Ritual snapshot projections", () => {
  it("finds the newest completed Receipt independently of the newest Run", () => {
    const ritualId = "rtl_01J00000000000000000000000";
    const testReceipt = {
      mode: "TEST" as const,
      receiptId: "rcp_01J00000000000000000000000",
      ritualId,
      ritualRevision: 1,
      recordedAt: "2026-08-17T12:00:00.000Z",
    };
    const runReceipt = {
      mode: "RUN" as const,
      receiptId: "rcp_01J00000000000000000000001",
      ritualId,
      ritualRevision: 1,
      recordedAt: "2026-08-17T08:00:00.000-05:00",
    };

    expect(
      findLatestLearningReceipt(
        { receipts: [testReceipt], runReceipts: [runReceipt] } as never,
        ritualId,
        1,
      ),
    ).toBe(runReceipt);
  });
});
