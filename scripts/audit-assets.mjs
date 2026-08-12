import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(path.join(root, "docs/provenance/assets.json"), "utf8"),
);
const registered = new Set((manifest.assets ?? []).map((asset) => asset.path));
const extensions = new Set([
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
  ".woff",
  ".woff2",
]);
const found = [];

async function walk(relative) {
  const directory = path.join(root, relative);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) await walk(child);
    else if (extensions.has(path.extname(entry.name).toLowerCase()))
      found.push(child);
  }
}

for (const directory of ["apps", "packages"]) await walk(directory);
export function findUnknownAssets(paths, registeredPaths) {
  const known = new Set(registeredPaths);
  return paths.filter((asset) => !known.has(asset));
}

const unknown = findUnknownAssets(found, registered);
if (unknown.length) {
  for (const asset of unknown) console.error(`Unregistered asset: ${asset}`);
  process.exitCode = 1;
} else {
  console.log("All repository assets have provenance records.");
}
