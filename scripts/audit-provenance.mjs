import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function validateProvenance(manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== 1)
    errors.push("Unsupported provenance schemaVersion");
  if (!(manifest?.upstream?.repository ?? "").startsWith("https://github.com/"))
    errors.push("Missing upstream repository");
  if (!/^[0-9a-f]{40}$/.test(manifest?.upstream?.commit ?? ""))
    errors.push("Missing exact upstream source commit");
  if (manifest?.upstream?.license !== "MIT")
    errors.push("Downy provenance must declare MIT");
  if (!(manifest?.upstream?.copyright ?? "").trim())
    errors.push("Missing upstream copyright");
  if (!Array.isArray(manifest?.files))
    errors.push("Provenance files must be an array");
  for (const [index, file] of (manifest?.files ?? []).entries()) {
    for (const key of ["target", "source", "transformation", "notice"]) {
      if (!(file?.[key] ?? "").trim())
        errors.push(`files[${index}] missing ${key}`);
    }
  }
  return errors;
}

export async function auditProvenance(base = root) {
  const manifestPath = path.join(base, "docs/provenance/downy-files.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const errors = validateProvenance(manifest);
  const notice = await readFile(
    path.join(base, "THIRD_PARTY_NOTICES.md"),
    "utf8",
  );
  if (
    !notice.includes(manifest.upstream.commit) ||
    !notice.includes(manifest.upstream.copyright)
  ) {
    errors.push(
      "Third-party notice does not identify the exact Downy source and copyright",
    );
  }
  for (const file of manifest.files ?? []) {
    const target = path.join(base, file.target);
    try {
      await stat(target);
      const source = await readFile(target, "utf8");
      if (
        !source.includes("SPDX-License-Identifier: MIT") ||
        !source.includes(manifest.upstream.commit)
      ) {
        errors.push(
          `${file.target} is missing its inline MIT provenance header`,
        );
      }
    } catch {
      errors.push(`Attributed target does not exist: ${file.target}`);
    }
  }
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const errors = await auditProvenance();
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log("Downy provenance and notices are complete.");
  }
}
