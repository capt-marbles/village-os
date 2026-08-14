import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assertProviderBoundaryEvidence } from "../../../scripts/verify-provider-boundary.mjs";

const execFileAsync = promisify(execFile);

describe("packaged provider boundary evidence gate", () => {
  it("requires the complete hard threshold", () => {
    expect(() =>
      assertProviderBoundaryEvidence({
        choiceAttempts: 10,
        correctChoices: 9,
        policyViolations: 0,
        staleCancellationPasses: 3,
        replacementThreadPasses: 3,
      }),
    ).not.toThrow();
    expect(() =>
      assertProviderBoundaryEvidence({
        choiceAttempts: 10,
        correctChoices: 8,
        policyViolations: 0,
        staleCancellationPasses: 3,
        replacementThreadPasses: 3,
      }),
    ).toThrow("PROVIDER_BOUNDARY_CHOICE_THRESHOLD_FAILED");
    expect(() =>
      assertProviderBoundaryEvidence({
        choiceAttempts: 10,
        correctChoices: 10,
        policyViolations: 1,
        staleCancellationPasses: 3,
        replacementThreadPasses: 3,
      }),
    ).toThrow("PROVIDER_BOUNDARY_POLICY_VIOLATION");
    expect(() =>
      assertProviderBoundaryEvidence({
        choiceAttempts: 10,
        correctChoices: 10,
        policyViolations: 0,
        staleCancellationPasses: 2,
        replacementThreadPasses: 3,
      }),
    ).toThrow("PROVIDER_BOUNDARY_STALE_CANCELLATION_FAILED");
  });

  it.runIf(process.env.VILLAGE_RUN_PACKAGED_PROVIDER_E2E === "1")(
    "runs the genuine provider against the packaged internal module",
    async () => {
      const root = path.resolve(import.meta.dirname, "../../..");
      const { stdout } = await execFileAsync(
        process.execPath,
        [path.join(root, "scripts/verify-provider-boundary.mjs")],
        { cwd: root, timeout: 12 * 60_000 },
      );
      expect(JSON.parse(stdout)).toMatchObject({
        status: "PASS",
        choiceAttempts: 10,
        policyViolations: 0,
        staleCancellationPasses: 3,
        replacementThreadPasses: 3,
      });
    },
    12 * 60_000,
  );
});
