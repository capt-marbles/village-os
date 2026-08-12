import assert from "node:assert/strict";
import test from "node:test";
import { validateProvenance } from "./audit-provenance.mjs";

test("rejects an attributed file without exact source commit or notice", () => {
  const errors = validateProvenance({
    schemaVersion: 1,
    upstream: {
      repository: "https://github.com/example/downy",
      commit: "main",
      license: "MIT",
      copyright: "",
    },
    files: [
      {
        target: "file.ts",
        source: "source.ts",
        transformation: "",
        notice: "",
      },
    ],
  });
  assert.ok(errors.some((error) => error.includes("source commit")));
  assert.ok(errors.some((error) => error.includes("copyright")));
  assert.ok(errors.some((error) => error.includes("transformation")));
  assert.ok(errors.some((error) => error.includes("notice")));
});
