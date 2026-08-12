import assert from "node:assert/strict";
import test from "node:test";
import { evaluateProfilePosture, profileDirectoryMode } from "../src/config.js";

test("profile posture fails closed when OS encryption support is unavailable", () => {
  assert.deepEqual(evaluateProfilePosture({ encryptionAvailable: false, platform: "darwin" }), {
    ok: false,
    warning: "Supported OS credential encryption is unavailable; LinkedIn view will not open.",
  });
});

test("profile posture rejects unsupported alpha platforms", () => {
  assert.equal(evaluateProfilePosture({ encryptionAvailable: true, platform: "linux" }).ok, false);
  assert.equal(profileDirectoryMode, 0o700);
});

test("profile posture accepts supported macOS with OS encryption", () => {
  assert.deepEqual(evaluateProfilePosture({ encryptionAvailable: true, platform: "darwin" }), { ok: true });
});
