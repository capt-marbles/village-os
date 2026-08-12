import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyAuthRoute,
  verifyAuthentication,
  decideNavigation,
  decidePermission,
  decideDebuggerTarget,
  decidePopup,
  LINKEDIN_PARTITION,
  remoteWebPreferences,
} from "../src/policy.js";

test("allows only official HTTPS LinkedIn navigation in the isolated view", () => {
  assert.deepEqual(decideNavigation("https://www.linkedin.com/login"), { action: "allow" });
  assert.deepEqual(decideNavigation("http://www.linkedin.com/login"), {
    action: "deny",
    reason: "https-required",
  });
  assert.deepEqual(decideNavigation("https://linkedin.example/login"), {
    action: "deny",
    reason: "origin-not-allowlisted",
  });
});

test("authentication verification is conservative and preserves owner confirmation", () => {
  assert.deepEqual(verifyAuthentication("https://www.linkedin.com/login", false), {
    status: "not_authenticated",
    predicateVersion: "linkedin-url-v1",
  });
  assert.deepEqual(verifyAuthentication("https://www.linkedin.com/feed/", false), {
    status: "unknown",
    predicateVersion: "linkedin-url-v1",
  });
  assert.deepEqual(verifyAuthentication("https://www.linkedin.com/feed/", true), {
    status: "confirmed_by_user",
    predicateVersion: "linkedin-url-v1",
  });
  assert.equal(verifyAuthentication("https://evil.example/feed/", true).status, "unknown");
});

test("allows debugger attachment only to an owned loopback fixture", () => {
  assert.deepEqual(decideDebuggerTarget("http://127.0.0.1:4173/auth"), { action: "allow" });
  assert.deepEqual(decideDebuggerTarget("http://localhost:4173/auth"), { action: "allow" });
  assert.deepEqual(decideDebuggerTarget("https://www.linkedin.com/login"), {
    action: "deny",
    reason: "debugger-owned-fixture-only",
  });
  assert.deepEqual(decideDebuggerTarget("http://fixture.example/auth"), {
    action: "deny",
    reason: "debugger-owned-fixture-only",
  });
});

test("classifies human auth routes explicitly and visibly", () => {
  assert.equal(classifyAuthRoute("https://www.linkedin.com/checkpoint/challenge"), "human-challenge");
  assert.equal(classifyAuthRoute("https://www.linkedin.com/checkpoint/lg/login-submit"), "human-2fa");
  assert.equal(classifyAuthRoute("https://www.linkedin.com/uas/request-password-reset"), "human-password-reset");
  assert.equal(classifyAuthRoute("https://accounts.google.com/o/oauth2/auth"), "unsupported-federated");
  assert.equal(classifyAuthRoute("https://www.linkedin.com/passkey"), "unsupported-passkey");
  assert.equal(classifyAuthRoute("https://www.linkedin.com/legal/user-agreement"), "human-terms-or-consent");
  assert.equal(classifyAuthRoute("https://www.linkedin.com/feed/"), "standard");
  assert.equal(classifyAuthRoute("not a url"), "unknown");
});

test("denies every remote permission and popup without runtime exceptions", () => {
  assert.deepEqual(decidePermission("media"), { action: "deny", reason: "permissions-disabled" });
  assert.deepEqual(decidePermission("unknownFuturePermission"), {
    action: "deny",
    reason: "permissions-disabled",
  });
  assert.deepEqual(decidePopup("https://accounts.google.com/o/oauth2/auth"), {
    action: "deny",
    reason: "unsupported-federated",
  });
  assert.deepEqual(decidePopup("https://www.linkedin.com/passkey"), {
    action: "deny",
    reason: "unsupported-passkey",
  });
});

test("production-intended remote configuration is isolated and hardened", () => {
  assert.equal(LINKEDIN_PARTITION, "persist:village-principal-local-device-local-linkedin");
  assert.deepEqual(remoteWebPreferences, {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    devTools: false,
    partition: LINKEDIN_PARTITION,
  });
});
