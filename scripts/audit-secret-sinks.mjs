import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protectedRoots = [
  "apps/desktop/src/secrets",
  "apps/desktop/src/browser/redaction-policy.ts",
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

const errors = [];
for (const file of (
  await Promise.all(protectedRoots.map(sourceFiles))
).flat()) {
  const source = await readFile(file, "utf8");
  for (const [label, pattern] of forbidden) {
    if (pattern.test(source)) {
      errors.push(`${path.relative(root, file)} contains forbidden ${label}`);
    }
  }
}

const broker = await readFile(
  path.join(root, "apps/desktop/src/secrets/credential-broker.ts"),
  "utf8",
);
for (const required of [
  'site: "OWNED_FIXTURE"',
  'fieldSemantic: "PASSWORD"',
  'binding.exactOrigin !== "https://fixture.village.test"',
  "writeApprovedFixtureField",
]) {
  if (!broker.includes(required)) {
    errors.push(
      `credential broker is missing fixture-only boundary: ${required}`,
    );
  }
}

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log("Secret sink boundary is valid.");
}
