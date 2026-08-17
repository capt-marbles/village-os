import { describe, expect, it } from "vitest";
import {
  CrashReporter,
  diagnosticFieldAllowlist,
} from "../src/main/crash-reporting.js";

describe("local diagnostics", () => {
  it("accepts bounded updater diagnostics without opening an upload path", () => {
    const reporter = new CrashReporter();

    expect(
      reporter.capture({
        component: "UPDATER",
        code: "UPDATE_SIGNER_MISMATCH",
        retriable: false,
      }),
    ).toEqual({
      upload: "DISABLED",
      preview: {
        component: "UPDATER",
        code: "UPDATE_SIGNER_MISMATCH",
        retriable: false,
      },
    });
  });
  it("emits a bounded local preview with uploads disabled by default", () => {
    const reporter = new CrashReporter();
    const captured = reporter.capture({
      component: "SESSION_ERASURE",
      code: "ERASURE_PARTIAL_FAILURE",
      retriable: true,
    });
    expect(captured.upload).toBe("DISABLED");
    expect(captured.preview).toEqual({
      component: "SESSION_ERASURE",
      code: "ERASURE_PARTIAL_FAILURE",
      retriable: true,
    });
    expect(diagnosticFieldAllowlist).toEqual([
      "component",
      "code",
      "retriable",
    ]);
  });

  it("retains only a bounded local preview", () => {
    const reporter = new CrashReporter();
    for (let index = 0; index < 55; index += 1) {
      reporter.capture({
        component: "BROWSER_HOST",
        code: `FAILURE_${index}`,
        retriable: true,
      });
    }
    expect(reporter.snapshot()).toHaveLength(50);
    expect(reporter.snapshot()[0]).toMatchObject({ code: "FAILURE_5" });
  });

  it("cannot serialize page, profile, key, or secret-derived fields", () => {
    const reporter = new CrashReporter();
    expect(() =>
      reporter.capture({
        component: "SESSION_ERASURE",
        code: "ERASURE_PARTIAL_FAILURE",
        retriable: true,
        pageUrl: "https://linkedin.com/feed",
      } as never),
    ).toThrow("DIAGNOSTIC_FIELD_DENIED");
  });

  it("accepts a local continuity recovery diagnostic", () => {
    const reporter = new CrashReporter();
    expect(
      reporter.capture({
        component: "CONTINUITY",
        code: "RECIPIENT_KEY_CONFLICT_OWNER_RECOVERY_REQUIRED",
        retriable: false,
      }).preview,
    ).toEqual({
      component: "CONTINUITY",
      code: "RECIPIENT_KEY_CONFLICT_OWNER_RECOVERY_REQUIRED",
      retriable: false,
    });
  });
});
