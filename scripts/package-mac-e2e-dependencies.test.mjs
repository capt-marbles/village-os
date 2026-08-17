import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const desktopPackage = JSON.parse(
  await readFile(
    new URL("../apps/desktop/package.json", import.meta.url),
    "utf8",
  ),
);
const ciWorkflow = await readFile(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const ritualPackageConfig = parse(
  await readFile(
    new URL("../apps/desktop/electron-builder.ritual-e2e.yml", import.meta.url),
    "utf8",
  ),
);
const ritualPackageEntry = await readFile(
  new URL("../apps/desktop/src/main/ritual-builder-entry.ts", import.meta.url),
  "utf8",
);
const continuityPackageConfig = parse(
  await readFile(
    new URL(
      "../apps/desktop/electron-builder.continuity-e2e.yml",
      import.meta.url,
    ),
    "utf8",
  ),
);
const credentialPackageConfig = parse(
  await readFile(
    new URL(
      "../apps/desktop/electron-builder.credential-e2e.yml",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("the packaged desktop command builds its complete workspace graph", () => {
  assert.match(
    desktopPackage.scripts["package:mac:e2e"],
    /^pnpm --dir \.\.\/\.\. exec tsc -b --force packages\/contracts packages\/ui packages\/test-auth-site apps\/desktop && pnpm build && /,
  );
});

test("CI delegates packaged dependency preparation to the package command", () => {
  assert.doesNotMatch(
    ciWorkflow,
    /pnpm --filter @village\/test-auth-site build/,
  );
  assert.match(ciWorkflow, /pnpm --filter @village\/desktop package:mac:e2e/);
  assert.match(
    ciWorkflow,
    /pnpm --filter @village\/desktop package:mac:continuity-e2e/,
  );
  assert.match(
    ciWorkflow,
    /pnpm --filter @village\/desktop package:mac:credential-e2e/,
  );
});

test("the Ritual smoke package opens its isolated surface, never the delegated proof harness", () => {
  assert.match(
    desktopPackage.scripts["package:mac:ritual-e2e"],
    /electron-builder --dir --config electron-builder\.ritual-e2e\.yml --mac/,
  );
  assert.equal(
    ritualPackageConfig.extraMetadata.main,
    "dist/main/ritual-builder-entry.js",
  );
  assert.notEqual(
    ritualPackageConfig.extraMetadata.main,
    "dist/main/internal-proof-entry.js",
  );
  assert.match(ritualPackageEntry, /runRitualBuilderApplication\(\)/);
  assert.doesNotMatch(ritualPackageEntry, /runVillageApplication/);
});

test("the continuity smoke package uses only its isolated proof entry", () => {
  assert.match(
    desktopPackage.scripts["package:mac:continuity-e2e"],
    /electron-builder --dir --config electron-builder\.continuity-e2e\.yml --mac/,
  );
  assert.match(
    desktopPackage.scripts["package:mac:continuity-e2e"],
    /--config\.directories\.output=release\/continuity-e2e/,
  );
  assert.equal(
    continuityPackageConfig.extraMetadata.main,
    "dist/main/internal-continuity-proof-entry.js",
  );
  assert.notEqual(
    continuityPackageConfig.extraMetadata.main,
    "dist/main/production-entry.js",
  );
  for (const excludedOutput of [
    "!dist/mac*/**",
    "!dist/ritual-e2e/**",
    "!dist/e2e/**",
    "!dist/continuity-e2e/**",
  ]) {
    assert.ok(continuityPackageConfig.files.includes(excludedOutput));
  }
});

test("the fixture secret smoke package uses its isolated proof entry and verifier", () => {
  assert.match(
    desktopPackage.scripts["package:mac:credential-e2e"],
    /electron-builder --dir --config electron-builder\.credential-e2e\.yml --mac/,
  );
  assert.match(
    desktopPackage.scripts["package:mac:credential-e2e"],
    /verify-fixture-secret-broker\.mjs/,
  );
  assert.equal(
    credentialPackageConfig.extraMetadata.main,
    "dist/main/internal-credential-proof-entry.js",
  );
  assert.notEqual(
    credentialPackageConfig.extraMetadata.main,
    "dist/main/production-entry.js",
  );
  for (const excludedOutput of [
    "!dist/mac*/**",
    "!dist/steward-default/**",
    "!dist/ritual-e2e/**",
    "!dist/e2e/**",
    "!dist/continuity-e2e/**",
    "!dist/credential-e2e/**",
  ]) {
    assert.ok(credentialPackageConfig.files.includes(excludedOutput));
  }
});
