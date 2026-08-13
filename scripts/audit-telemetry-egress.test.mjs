import assert from "node:assert/strict";
import test from "node:test";
import { auditTelemetrySource } from "./audit-telemetry-egress.mjs";

test("accepts a compile-time bounded primitive diagnostic projection", () => {
  assert.deepEqual(
    auditTelemetrySource(
      `
        export const diagnosticFieldAllowlist = ["component", "code", "retriable"] as const;
        const preview = { component: input.component, code: input.code, retriable: input.retriable };
        const upload = "DISABLED";
      `,
      "crash-reporting.ts",
    ),
    [],
  );
});

test("rejects outbound transports, forbidden page-derived fields and dynamic projections", () => {
  const errors = auditTelemetrySource(
    `
      const preview = { ...input, [input.key]: input.value, pageUrl: input.url };
      fetch("https://telemetry.invalid", { body: JSON.stringify(preview) });
    `,
    "crash-reporting.ts",
  );
  assert.ok(errors.some((error) => error.includes("outbound transport")));
  assert.ok(errors.some((error) => error.includes("page-derived field")));
  assert.ok(errors.some((error) => error.includes("dynamic projection")));
});
