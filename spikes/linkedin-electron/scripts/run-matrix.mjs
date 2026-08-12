import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function field(record, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return record.match(new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, "im"))?.[1].trim();
}

function numberField(record, label) {
  const value = field(record, label);
  if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  return Number(value);
}

export function validateMatrix(record) {
  const errors = [];
  const representativeRuns = numberField(record, "Representative runs");
  const restartAttempts = numberField(record, "Minimum restart attempts per route/account");
  const restartRetention = numberField(record, "Restart retention percent");
  const chromeChallengeRate = numberField(record, "Normal Chrome challenge rate percent");
  const electronChallengeRate = numberField(record, "Packaged Electron challenge rate percent");
  const chromeFailureRate = numberField(record, "Normal Chrome failure rate percent");
  const electronFailureRate = numberField(record, "Packaged Electron failure rate percent");

  if (!(representativeRuns >= 1)) errors.push("Missing representative-run evidence");
  if (!(restartAttempts >= 3)) errors.push("Minimum restart retention evidence is fewer than 3 attempts");
  if (restartRetention !== 100) errors.push("Restart retention must be 100 percent");
  if ([chromeChallengeRate, electronChallengeRate, chromeFailureRate, electronFailureRate].some((value) => value === undefined)) {
    errors.push("Missing numeric Chrome/Electron challenge or failure rates");
  } else {
    if (electronChallengeRate - chromeChallengeRate > 10) errors.push("Electron challenge rate is more than 10 points worse than Chrome");
    if (electronFailureRate - chromeFailureRate > 10) errors.push("Electron failure rate is more than 10 points worse than Chrome");
  }

  for (const label of [
    "Policy exceptions",
    "LinkedIn debugger attachments",
    "Autonomous LinkedIn actions",
    "Credential or cookie logging events",
  ]) {
    if (numberField(record, label) !== 0) errors.push(`${label} must be 0`);
  }

  for (const label of ["Packaged artifact verified", "Password plus 2FA human completion"] ) {
    if (field(record, label)?.toLowerCase() !== "yes") errors.push(`${label} must be yes`);
  }
  for (const label of ["Federated redirects or popups", "Passkey route"] ) {
    if (!/^(human-operable|visibly unsupported|not encountered)$/i.test(field(record, label) ?? "")) {
      errors.push(`${label} must be human-operable, visibly unsupported, or not encountered`);
    }
  }
  if (!field(record, "Environment")) errors.push("Missing environment evidence");
  if (!field(record, "Local IP observation")) errors.push("Missing local-IP evidence");
  if (!field(record, "Terms-review status")) errors.push("Missing terms-review status");
  if (!/^Conclusion:\s*go\s*$/im.test(record)) errors.push("Missing approved go conclusion");
  if (!/^Approved by:\s*(?!pending\s*$).+/im.test(record) || !/^Approval date:\s*\d{4}-\d{2}-\d{2}\s*$/im.test(record)) {
    errors.push("Missing product-owner approval and date");
  }
  return { ok: errors.length === 0, errors };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scripts/run-matrix.mjs <record.md>");
    process.exitCode = 2;
  } else {
    const result = validateMatrix(await readFile(file, "utf8"));
    if (!result.ok) {
      for (const error of result.errors) console.error(error);
      process.exitCode = 1;
    } else {
      console.log("Compatibility record is complete and approved for a U0 go decision.");
    }
  }
}
