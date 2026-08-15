import { createHmac, randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredPath(name) {
  const value = argument(name);
  if (!value || !path.isAbsolute(value)) {
    throw new Error("OBSERVER_PROOF_PATH_UNSAFE");
  }
  return value;
}

const projectionKeys = [
  "actionPhase",
  "automationFenced",
  "cancellationAcknowledgedAt",
  "connection",
  "controller",
  "cursor",
  "humanGate",
  "jobRevision",
  "jobState",
  "lastDurableUpdateAt",
  "lastEffectActor",
  "logicalStep",
  "projectionLag",
  "terminalEvidence",
  "workflowKind",
  "workflowVersion",
];

function validateProjection(candidate) {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Object.keys(candidate).sort().join(",") !== projectionKeys.join(",") ||
    !Number.isInteger(candidate.cursor) ||
    candidate.cursor < 0 ||
    candidate.projectionLag !== 0 ||
    candidate.jobRevision !== 1 ||
    candidate.workflowKind !== "OWNED_FIXTURE_ACCOUNT_SETUP_V1" ||
    candidate.workflowVersion !== 1 ||
    !["RUNNING_AGENT", "CANCELED"].includes(candidate.jobState) ||
    !["AGENT", "USER", "NONE"].includes(candidate.controller) ||
    !["ONLINE", "OFFLINE", "ABSENT"].includes(candidate.connection) ||
    typeof candidate.automationFenced !== "boolean" ||
    typeof candidate.lastDurableUpdateAt !== "string"
  ) {
    throw new Error("OBSERVER_PROOF_PROJECTION_INVALID");
  }
  return candidate;
}

async function waitForProjection(pathname, afterCursor = -1) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const projection = validateProjection(
        JSON.parse(await readFile(pathname, "utf8")),
      );
      if (projection.cursor > afterCursor) return projection;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "OBSERVER_PROOF_PROJECTION_INVALID"
      ) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("OBSERVER_PROOF_PROJECTION_TIMEOUT");
}

async function writePrivateJson(pathname, value) {
  const temporary = `${pathname}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), {
    mode: 0o600,
    flag: "wx",
  });
  await chmod(temporary, 0o600);
  await rename(temporary, pathname);
}

async function main() {
  const mode = argument("--mode");
  const projectionPath = requiredPath("--projection");
  if (mode === "cancel") {
    const intentPath = requiredPath("--intent");
    const keyPath = requiredPath("--key");
    const projection = await waitForProjection(projectionPath);
    const payload = {
      type: "CANCEL_AUTOMATION",
      cursor: projection.cursor,
      jobRevision: projection.jobRevision,
      nonce: randomBytes(16).toString("hex"),
    };
    const signature = createHmac("sha256", await readFile(keyPath))
      .update(JSON.stringify(payload))
      .digest("hex");
    await writePrivateJson(intentPath, { ...payload, signature });
    console.log(
      JSON.stringify({ status: "CANCEL_SENT", cursor: projection.cursor }),
    );
    return;
  }
  if (mode === "reconnect") {
    const previousCursor = Number(argument("--cursor"));
    if (!Number.isInteger(previousCursor) || previousCursor < 0) {
      throw new Error("OBSERVER_PROOF_CURSOR_INVALID");
    }
    const projection = await waitForProjection(projectionPath, previousCursor);
    console.log(
      JSON.stringify({
        status: "RECONNECTED",
        previousCursor,
        cursor: projection.cursor,
        terminalEvidence: projection.terminalEvidence,
        automationFenced: projection.automationFenced,
      }),
    );
    return;
  }
  throw new Error("OBSERVER_PROOF_MODE_INVALID");
}

void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "OBSERVER_PROOF_FAILED",
  );
  process.exitCode = 1;
});
