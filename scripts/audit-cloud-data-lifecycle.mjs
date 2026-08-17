import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(
  root,
  "docs/architecture/cloud-record-lifecycle.yaml",
);
const manifest = parse(await readFile(manifestPath, "utf8"));
if (manifest?.version !== 1 || !Array.isArray(manifest.records)) {
  throw new Error("CLOUD_RECORD_LIFECYCLE_MANIFEST_INVALID");
}

const required = [
  "authority",
  "table",
  "scope",
  "retention",
  "export",
  "deletion",
];
const declared = new Set();
for (const record of manifest.records) {
  if (!record || required.some((field) => typeof record[field] !== "string")) {
    throw new Error("CLOUD_RECORD_LIFECYCLE_RECORD_INVALID");
  }
  const key = `${record.authority}.${record.table}`;
  if (declared.has(key))
    throw new Error(`CLOUD_RECORD_LIFECYCLE_DUPLICATE:${key}`);
  declared.add(key);
}

const discovered = new Set();
const collectTables = (authority, source) => {
  for (const match of source.matchAll(
    /CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/gi,
  )) {
    if (match[1] !== "_sql_schema_migrations") {
      discovered.add(`${authority}.${match[1]}`);
    }
  }
};

const migrationDirectory = resolve(root, "apps/control-plane/migrations");
for (const name of (await readdir(migrationDirectory)).filter((name) =>
  name.endsWith(".sql"),
)) {
  collectTables(
    "D1",
    await readFile(resolve(migrationDirectory, name), "utf8"),
  );
}
collectTables(
  "COORDINATOR",
  await readFile(
    resolve(
      root,
      "apps/control-plane/src/worker/browser-control/session-coordinator.ts",
    ),
    "utf8",
  ),
);
collectTables(
  "MAILBOX",
  await readFile(
    resolve(
      root,
      "apps/control-plane/src/worker/site-session-continuity/mailbox.ts",
    ),
    "utf8",
  ),
);

const missing = [...discovered].filter((key) => !declared.has(key)).sort();
const stale = [...declared].filter((key) => !discovered.has(key)).sort();
if (missing.length || stale.length) {
  throw new Error(
    `CLOUD_RECORD_LIFECYCLE_MISMATCH missing=${missing.join(",") || "none"} stale=${stale.join(",") || "none"}`,
  );
}
console.log(
  `Cloud data lifecycle audit passed (${declared.size} record classes).`,
);
