import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  compareVersions,
  parseMinimumSystemVersion,
  verifyPackagedSecureEnclave,
} from "./verify-secure-enclave-device-identity.mjs";

test("packages the Secure Enclave helper outside ASAR and exposes a verifier", async () => {
  const packageConfig = await readFile(
    new URL("../apps/desktop/electron-builder.yml", import.meta.url),
    "utf8",
  );
  const desktopManifest = JSON.parse(
    await readFile(
      new URL("../apps/desktop/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.match(packageConfig, /asarUnpack:\s*\n\s*- dist\/native\/\*\*/);
  assert.match(desktopManifest.scripts.build, /build-secure-enclave-helper/);
  assert.match(
    desktopManifest.scripts["package:mac:release"],
    /verify-secure-enclave-device-identity/,
  );
  assert.equal(typeof verifyPackagedSecureEnclave, "function");
});

test("pins and verifies the helper deployment target", async () => {
  const buildScript = await readFile(
    new URL("./build-secure-enclave-helper.mjs", import.meta.url),
    "utf8",
  );
  assert.match(buildScript, /-apple-macosx12\.0/);
  assert.equal(
    parseMinimumSystemVersion(
      `Load command 10\n      cmd LC_BUILD_VERSION\n    minos 12.0\n      sdk 15.5\n`,
    ),
    "12.0",
  );
  assert.equal(compareVersions("12.0", "12.0.0"), 0);
  assert.equal(compareVersions("13.0", "12.0"), 1);
  assert.equal(compareVersions("11.6", "12.0"), -1);
});
