import assert from "node:assert/strict";
import test from "node:test";
import { validateMatrix } from "../scripts/run-matrix.mjs";

test("rejects an unapproved or incomplete compatibility record", () => {
  const result = validateMatrix("# record\nConclusion: pending\n");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error: string) => error.includes("approval")));
  assert.ok(result.errors.some((error: string) => error.includes("restart retention")));
});

test("accepts a fully populated approved go record", () => {
  const record = [
    "Representative runs: 2",
    "Minimum restart attempts per route/account: 3",
    "Restart retention percent: 100",
    "Normal Chrome challenge rate percent: 5",
    "Packaged Electron challenge rate percent: 10",
    "Normal Chrome failure rate percent: 0",
    "Packaged Electron failure rate percent: 5",
    "Policy exceptions: 0",
    "LinkedIn debugger attachments: 0",
    "Autonomous LinkedIn actions: 0",
    "Credential or cookie logging events: 0",
    "Packaged artifact verified: yes",
    "Password plus 2FA human completion: yes",
    "Federated redirects or popups: not encountered",
    "Passkey route: not encountered",
    "Environment: macOS arm64, Electron 43.4.0",
    "Local IP observation: same public egress as Chrome",
    "Terms-review status: unresolved; internal technical test only",
    "Conclusion: go",
    "Approved by: Product Owner",
    "Approval date: 2026-08-12",
  ].join("\n");
  assert.deepEqual(validateMatrix(record), { ok: true, errors: [] });
});

test("rejects headings-only evidence and numerical threshold misses", () => {
  const record = [
    "Representative runs: 1",
    "Minimum restart attempts per route/account: 2",
    "Restart retention percent: 66",
    "Normal Chrome challenge rate percent: 0",
    "Packaged Electron challenge rate percent: 20",
    "Normal Chrome failure rate percent: 0",
    "Packaged Electron failure rate percent: 20",
    "Policy exceptions: 1",
    "LinkedIn debugger attachments: 0",
    "Autonomous LinkedIn actions: 0",
    "Credential or cookie logging events: 0",
    "Packaged artifact verified: yes",
    "Password plus 2FA human completion: yes",
    "Federated redirects or popups: visibly unsupported",
    "Passkey route: visibly unsupported",
    "Environment: test",
    "Local IP observation: test",
    "Terms-review status: unresolved",
    "Conclusion: go",
    "Approved by: Product Owner",
    "Approval date: 2026-08-12",
  ].join("\n");
  const result = validateMatrix(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error: string) => error.includes("Restart retention")));
  assert.ok(result.errors.some((error: string) => error.includes("challenge rate")));
  assert.ok(result.errors.some((error: string) => error.includes("Policy exceptions")));
});

test("rejects a route without a recorded supported disposition", () => {
  const record = [
    "Representative runs: 1",
    "Minimum restart attempts per route/account: 3",
    "Restart retention percent: 100",
    "Normal Chrome challenge rate percent: 0",
    "Packaged Electron challenge rate percent: 0",
    "Normal Chrome failure rate percent: 0",
    "Packaged Electron failure rate percent: 0",
    "Policy exceptions: 0",
    "LinkedIn debugger attachments: 0",
    "Autonomous LinkedIn actions: 0",
    "Credential or cookie logging events: 0",
    "Packaged artifact verified: yes",
    "Password plus 2FA human completion: yes",
    "Federated redirects or popups: unknown",
    "Passkey route: not encountered",
    "Environment: test",
    "Local IP observation: test",
    "Terms-review status: unresolved",
    "Conclusion: go",
    "Approved by: Product Owner",
    "Approval date: 2026-08-12",
  ].join("\n");
  const result = validateMatrix(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error: string) => error.includes("Federated redirects")));
});
