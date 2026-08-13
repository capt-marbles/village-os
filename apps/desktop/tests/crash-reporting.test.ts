import { describe, expect, it } from "vitest";
import {
  CrashReporter,
  diagnosticFieldAllowlist,
} from "../src/main/crash-reporting.js";

describe("local diagnostics", () => {
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
});
