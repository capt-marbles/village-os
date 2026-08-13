import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedWorkspaceDependencies = new Map([
  ["apps/control-plane", new Set(["@village/contracts"])],
  ["apps/desktop", new Set(["@village/contracts", "@village/ui"])],
  ["apps/web", new Set(["@village/contracts", "@village/ui"])],
  ["packages/contracts", new Set()],
  ["packages/test-auth-site", new Set(["@village/contracts"])],
  ["packages/ui", new Set(["@village/contracts"])],
]);
const errors = [];

for (const [workspace, allowed] of allowedWorkspaceDependencies) {
  const manifest = JSON.parse(
    await readFile(path.join(root, workspace, "package.json"), "utf8"),
  );
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  for (const dependency of Object.keys(dependencies)) {
    if (dependency.startsWith("@village/") && !allowed.has(dependency)) {
      errors.push(`${workspace} may not depend on ${dependency}`);
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log("Workspace dependency boundaries are valid.");
}
