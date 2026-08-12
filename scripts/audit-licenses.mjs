import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function hasUnknownLicense(report) {
  return /\b(?:UNKNOWN|UNLICENSED|SEE LICENSE IN)\b/i.test(report);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = spawnSync("pnpm", ["licenses", "list", "--json"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }

  const report = result.stdout.trim();
  if (!report)
    throw new Error("pnpm produced an empty dependency-license report");
  if (hasUnknownLicense(report)) {
    console.error(
      "Dependency audit found unknown or unresolvable license material.",
    );
    process.exitCode = 1;
  } else {
    console.log("Dependency license metadata contains no unknown material.");
  }
}
