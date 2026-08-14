import { describe, expect, it } from "vitest";
import {
  actionIdSchema,
  checkpointIdSchema,
  receiptIdSchema,
} from "@village/contracts";
import { createInternalProofId } from "../src/main/internal-proof-ids.js";

describe("internal proof durable IDs", () => {
  it("remain schema-valid and unique when a packaged process restarts", () => {
    const firstProcess = Array.from({ length: 16 }, () => ({
      action: createInternalProofId("act"),
      receipt: createInternalProofId("rcp"),
      checkpoint: createInternalProofId("chk"),
    }));
    const secondProcess = Array.from({ length: 16 }, () => ({
      action: createInternalProofId("act"),
      receipt: createInternalProofId("rcp"),
      checkpoint: createInternalProofId("chk"),
    }));
    const ids = [...firstProcess, ...secondProcess];

    expect(new Set(ids.map((entry) => entry.action)).size).toBe(32);
    expect(new Set(ids.map((entry) => entry.receipt)).size).toBe(32);
    expect(new Set(ids.map((entry) => entry.checkpoint)).size).toBe(32);
    for (const entry of ids) {
      expect(actionIdSchema.safeParse(entry.action).success).toBe(true);
      expect(receiptIdSchema.safeParse(entry.receipt).success).toBe(true);
      expect(checkpointIdSchema.safeParse(entry.checkpoint).success).toBe(true);
    }
  });
});
