import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protectedRoots = [
  "apps/desktop/src/secrets",
  "apps/desktop/src/research",
  "apps/desktop/src/browser/redaction-policy.ts",
  "apps/desktop/src/browser/owned-fixture-credential-destination.ts",
  "apps/desktop/src/main/owned-fixture-credential-fill.ts",
];
const forbidden = [
  ["clipboard API", /\bclipboard\b/i],
  ["renderer IPC", /\bipcRenderer\b/],
  ["renderer send", /\bwebContents\s*\.\s*send\b/],
  ["page evaluation", /\bexecuteJavaScript\b|Runtime\.evaluate/],
  ["raw debugger/CDP", /\bdebugger\s*\.\s*(attach|sendCommand)\b/],
  ["page capture", /\bcapturePage\b|desktopCapturer/],
  ["console sink", /\bconsole\s*\.\s*(log|info|warn|error|debug)\b/],
  ["telemetry sink", /\b(telemetry|analytics|track|captureException)\s*\(/i],
];

async function sourceFiles(target) {
  const absolute = path.join(root, target);
  if (/\.[cm]?[jt]sx?$/.test(target)) return [absolute];
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? sourceFiles(path.join(target, entry.name))
        : /\.[cm]?[jt]sx?$/.test(entry.name)
          ? [path.join(absolute, entry.name)]
          : [],
    ),
  );
  return nested.flat();
}

const files = (await Promise.all(protectedRoots.map(sourceFiles))).flat();
const errors = (
  await Promise.all(
    files.map(async (file) => {
      const source = await readFile(file, "utf8");
      return forbidden.flatMap(([label, pattern]) =>
        pattern.test(source)
          ? [`${path.relative(root, file)} contains forbidden ${label}`]
          : [],
      );
    }),
  )
).flat();

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log("Secret sink boundary is valid.");
}
