import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
});
