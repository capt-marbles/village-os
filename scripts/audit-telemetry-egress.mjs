import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const telemetryModules = ["apps/desktop/src/main/crash-reporting.ts"];
const sourceRoots = ["apps/desktop/src", "packages/ui/src"];

const outboundTransport =
  /\bfetch\s*\(|\bsendBeacon\s*\(|\bXMLHttpRequest\b|\bcaptureException\s*\(|\b(?:http|https)\s*\.\s*request\s*\(/;
const thirdPartyTelemetry =
  /(?:from\s+|require\s*\()["'](?:@sentry|posthog|analytics-node|@segment|datadog|amplitude)(?:\/[^"']*)?["']/i;
const pageDerivedField =
  /\b(?:pageUrl|rawDom|html|cookie|token|formValue|screenshot|profile|privateKey|secret)\s*:/i;
const dynamicProjection = /\.\.\.\s*[A-Za-z_$]|\[[^\]]+\]\s*:/;
const exactAllowlist =
  /diagnosticFieldAllowlist\s*=\s*\[\s*["']component["']\s*,\s*["']code["']\s*,\s*["']retriable["']\s*,?\s*\]\s*as const/;

export function auditTelemetrySource(source, file) {
  const errors = [];
  if (outboundTransport.test(source))
    errors.push(`${file} contains forbidden outbound transport`);
  if (thirdPartyTelemetry.test(source))
    errors.push(`${file} imports a forbidden telemetry SDK`);
  if (pageDerivedField.test(source))
    errors.push(`${file} contains forbidden page-derived field`);
  if (dynamicProjection.test(source))
    errors.push(`${file} contains forbidden dynamic projection`);
  if (file.endsWith("crash-reporting.ts") && !exactAllowlist.test(source)) {
    errors.push(`${file} must retain the compile-time diagnostic allowlist`);
  }
  return errors;
}

async function sourceFiles(relative) {
  const absolute = path.join(root, relative);
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? sourceFiles(path.join(relative, entry.name))
        : /\.[cm]?[jt]sx?$/.test(entry.name)
          ? [path.join(relative, entry.name)]
          : [],
    ),
  );
  return nested.flat();
}

export async function auditTelemetryEgress() {
  const errors = [];
  for (const relative of telemetryModules) {
    const source = await readFile(path.join(root, relative), "utf8");
    errors.push(...auditTelemetrySource(source, relative));
  }
  for (const relative of (
    await Promise.all(sourceRoots.map(sourceFiles))
  ).flat()) {
    const source = await readFile(path.join(root, relative), "utf8");
    if (thirdPartyTelemetry.test(source))
      errors.push(`${relative} imports a forbidden telemetry SDK`);
  }
  return [...new Set(errors)];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = await auditTelemetryEgress();
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log("Telemetry egress boundary is valid.");
  }
}
