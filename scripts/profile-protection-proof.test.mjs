import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEncryptedCookieFiles,
  assertProfileProtectionReport,
} from "./verify-profile-protection.mjs";

test("requires the real owner-presence and native-confirmation ceremony", () => {
  assert.doesNotThrow(() =>
    assertProfileProtectionReport({
      status: "READY_FOR_DISK_VERIFICATION",
      cookieName: "__Host-village_oscrypt_probe",
      osCryptBackend: "keychain",
      backupExclusion: "VERIFIED",
      indexExclusion: "VERIFIED",
      ownerPresence: "VERIFIED",
      nativeConfirmation: "VERIFIED",
    }),
  );
  assert.throws(
    () =>
      assertProfileProtectionReport({
        status: "READY_FOR_DISK_VERIFICATION",
        cookieName: "__Host-village_oscrypt_probe",
        osCryptBackend: "keychain",
        backupExclusion: "VERIFIED",
        indexExclusion: "VERIFIED",
      }),
    /PACKAGED_PROFILE_PROTECTION_REPORT_INVALID/,
  );
});

test("accepts an encrypted Chromium cookie record without the plaintext value", () => {
  assert.doesNotThrow(() =>
    assertEncryptedCookieFiles(
      [Buffer.from("__Host-village_oscrypt_probe\0v10\0ciphertext")],
      "a".repeat(64),
      "__Host-village_oscrypt_probe",
    ),
  );
});

test("rejects plaintext, missing records, and missing OS-crypt prefixes", () => {
  assert.throws(
    () =>
      assertEncryptedCookieFiles(
        [Buffer.from(`__Host-village_oscrypt_probe\0v10\0${"a".repeat(64)}`)],
        "a".repeat(64),
        "__Host-village_oscrypt_probe",
      ),
    /PACKAGED_PROFILE_COOKIE_PLAINTEXT_FOUND/,
  );
  assert.throws(
    () =>
      assertEncryptedCookieFiles(
        [Buffer.from("unrelated\0v10\0ciphertext")],
        "a".repeat(64),
        "__Host-village_oscrypt_probe",
      ),
    /PACKAGED_PROFILE_COOKIE_RECORD_MISSING/,
  );
  assert.throws(
    () =>
      assertEncryptedCookieFiles(
        [Buffer.from("__Host-village_oscrypt_probe\0ciphertext")],
        "a".repeat(64),
        "__Host-village_oscrypt_probe",
      ),
    /PACKAGED_PROFILE_COOKIE_ENCRYPTION_PREFIX_MISSING/,
  );
});
