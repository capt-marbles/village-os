import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createProductionControlPlaneConfig } from "./production-control-plane-config.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedConfig = path.join(
  root,
  "apps/control-plane/wrangler.production.generated.jsonc",
);

export function productionDeploymentCommands({
  confirmed = false,
  dryRun = false,
} = {}) {
  if (!dryRun && !confirmed) {
    throw new Error("VILLAGE_PRODUCTION_DEPLOYMENT_CONFIRMATION_REQUIRED");
  }
  const build = ["pnpm", "--filter", "@village/web...", "build"];
  const wrangler = ["pnpm", "--dir", "apps/control-plane", "exec", "wrangler"];
  if (dryRun) {
    return [
      build,
      [
        ...wrangler,
        "deploy",
        "--dry-run",
        "--config",
        "wrangler.production.generated.jsonc",
      ],
    ];
  }
  return [
    build,
    [
      ...wrangler,
      "d1",
      "migrations",
      "apply",
      "VILLAGE_DB",
      "--remote",
      "--config",
      "wrangler.production.generated.jsonc",
    ],
    [...wrangler, "deploy", "--config", "wrangler.production.generated.jsonc"],
  ];
}

export async function runProductionDeployment({
  environment = process.env,
  confirmed = false,
  dryRun = false,
  execute = async ([command, ...arguments_]) => {
    const { stdout, stderr } = await execFileAsync(command, arguments_, {
      cwd: root,
    });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  },
} = {}) {
  const config = createProductionControlPlaneConfig(environment);
  await writeFile(generatedConfig, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  for (const command of productionDeploymentCommands({ confirmed, dryRun })) {
    await execute(command);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runProductionDeployment({
    confirmed: process.argv.includes("--confirm-production"),
    dryRun: process.argv.includes("--dry-run"),
  });
}
