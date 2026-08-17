import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const telemetryModules = ["apps/desktop/src/main/crash-reporting.ts"];
const allowedOutboundModules = [
  "apps/desktop/src/research/exa-search-provider.ts",
  "apps/desktop/src/main/update-runtime.ts",
];
const exaEgressContract =
  /const EXA_SEARCH_ENDPOINT = ["']https:\/\/api\.exa\.ai\/search["'];[\s\S]*this\.request\(EXA_SEARCH_ENDPOINT,/;
const updaterEgressContract =
  /export function desktopUpdateFetch[\s\S]*return globalThis\.fetch\(input, init\);[\s\S]*beginTimedFetch\(\s*this\.dependencies\.fetch,\s*this\.dependencies\.policy\.endpoint,[\s\S]*prevalidateManifest\([\s\S]*beginTimedFetch\(\s*this\.dependencies\.fetch,\s*manifest\.artifactUrl,/;
const sourceRoots = ["apps/desktop/src", "packages/ui/src"];

const outboundTransport =
  /\bglobalThis\s*\.\s*fetch\b|\bfetch\s*\(|\bsendBeacon\s*\(|\bXMLHttpRequest\b|\bcaptureException\s*\(|\b(?:http|https)\s*\.\s*request\s*\(/;
const thirdPartyTelemetry =
  /(?:from\s+|require\s*\()["'](?:@sentry|posthog|analytics-node|@segment|datadog|amplitude)(?:\/[^"']*)?["']/i;
const nativeCrashCollection = /\bcrashReporter\b/;
const pageDerivedField =
  /\b(?:pageUrl|rawDom|html|cookie|token|formValue|screenshot|profile|privateKey|secret)\s*:/i;
const dynamicProjection = /\.\.\.\s*[A-Za-z_$]|\[[^\]]+\]\s*:/;
const exactAllowlist =
  /diagnosticFieldAllowlist\s*=\s*\[\s*["']component["']\s*,\s*["']code["']\s*,\s*["']retriable["']\s*,?\s*\]\s*as const/;

export function auditTelemetrySource(source, file) {
  const errors = [];
  if (outboundTransport.test(source) && !allowedOutboundModules.includes(file))
    errors.push(`${file} contains forbidden outbound transport`);
  if (
    file === "apps/desktop/src/research/exa-search-provider.ts" &&
    !exaEgressContract.test(source)
  ) {
    errors.push(`${file} must retain the fixed Exa egress contract`);
  }
  if (
    file === "apps/desktop/src/main/update-runtime.ts" &&
    !updaterEgressContract.test(source)
  ) {
    errors.push(`${file} must retain the policy-gated updater egress contract`);
  }
  if (thirdPartyTelemetry.test(source))
    errors.push(`${file} imports a forbidden telemetry SDK`);
  if (nativeCrashCollection.test(source))
    errors.push(`${file} enables forbidden native crash collection`);
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
  const relativeFiles = new Set([
    ...telemetryModules,
    ...(await Promise.all(sourceRoots.map(sourceFiles))).flat(),
  ]);
  const sources = await Promise.all(
    [...relativeFiles].map(async (relative) => [
      relative,
      await readFile(path.join(root, relative), "utf8"),
    ]),
  );
  for (const [relative, source] of sources) {
    const sourceErrors = auditTelemetrySource(source, relative).filter(
      (error) => {
        if (telemetryModules.includes(relative)) return true;
        if (allowedOutboundModules.includes(relative)) return true;
        if (error.includes("outbound transport")) return true;
        if (error.includes("native crash collection")) return true;
        return error.includes("telemetry SDK");
      },
    );
    errors.push(...sourceErrors);
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
