import { browserSessionIdSchema } from "@village/contracts";
import { app, shell, type WebContents } from "electron";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  createInternalDelegatedProof,
  internalProofIdentitySource,
  internalProofUserDataPath,
} from "./internal-delegated-proof.js";
import {
  resolveRuntimeControlPlaneUrl,
  runVillageApplication,
} from "./runtime.js";
import { createRuntimeModelProviderComposition } from "./runtime-model-provider.js";
import {
  assertDistinctBrowserSessionIdentity,
  createPairedWorkflowRuntimeComposition,
} from "./runtime-control-plane.js";
import { DeviceIdentityVault } from "./device-identity-vault.js";
import { ElectronSafeStorageProtector } from "./electron-safe-storage.js";
import { SecretVault } from "../secrets/secret-vault.js";
import { SecretRuntimeIdentityStore } from "./runtime-identity-store.js";
import {
  resolveRuntimeIdentity,
  type PairedRuntimeIdentitySource,
} from "./runtime-identity.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredAbsoluteArgument(name: string): string {
  const value = argument(name);
  if (!value || !isAbsolute(value)) {
    throw new Error("PACKAGED_DELEGATED_WORKFLOW_OBSERVER_PATH_UNSAFE");
  }
  return value;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

async function waitForObserverIntent(
  intentPath: string,
  keyPath: string,
  expectedCursor: number,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const candidate = JSON.parse(await readFile(intentPath, "utf8"));
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Object.keys(candidate).sort().join(",") !==
          "cursor,jobRevision,nonce,signature,type" ||
        candidate.type !== "CANCEL_AUTOMATION" ||
        candidate.cursor !== expectedCursor ||
        candidate.jobRevision !== 1 ||
        typeof candidate.nonce !== "string" ||
        candidate.nonce.length !== 32 ||
        typeof candidate.signature !== "string" ||
        !/^[0-9a-f]{64}$/.test(candidate.signature)
      ) {
        throw new Error("PACKAGED_DELEGATED_WORKFLOW_OBSERVER_INTENT_INVALID");
      }
      const payload = JSON.stringify({
        type: candidate.type,
        cursor: candidate.cursor,
        jobRevision: candidate.jobRevision,
        nonce: candidate.nonce,
      });
      const expected = createHmac("sha256", await readFile(keyPath))
        .update(payload)
        .digest();
      const received = Buffer.from(candidate.signature, "hex");
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      ) {
        throw new Error("PACKAGED_DELEGATED_WORKFLOW_OBSERVER_INTENT_INVALID");
      }
      return;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "PACKAGED_DELEGATED_WORKFLOW_OBSERVER_INTENT_INVALID"
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("PACKAGED_DELEGATED_WORKFLOW_OBSERVER_INTENT_TIMEOUT");
}

async function waitForTerminal(
  workflow: Awaited<
    ReturnType<typeof createInternalDelegatedProof>
  >["delegatedWorkflow"],
  timeoutMs = 120_000,
) {
  const current = workflow.snapshot();
  if (
    [
      "RECEIPTED_SUCCESS",
      "HUMAN_GATE",
      "FAILED",
      "CANCELLED",
      "OFFLINE",
    ].includes(current.state)
  ) {
    return current;
  }
  return new Promise<typeof current>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("PACKAGED_DELEGATED_WORKFLOW_TIMEOUT"));
    }, timeoutMs);
    const unsubscribe = workflow.subscribe((snapshot) => {
      if (
        snapshot.state === "RECEIPTED_SUCCESS" ||
        snapshot.state === "HUMAN_GATE" ||
        snapshot.state === "FAILED" ||
        snapshot.state === "CANCELLED" ||
        snapshot.state === "OFFLINE"
      ) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(snapshot);
      }
    });
  });
}

async function waitForWorkflowSnapshot(
  workflow: Awaited<
    ReturnType<typeof createInternalDelegatedProof>
  >["delegatedWorkflow"],
  predicate: (snapshot: ReturnType<typeof workflow.snapshot>) => boolean,
  timeoutCode: string,
  timeoutMs = 10_000,
) {
  const current = workflow.snapshot();
  if (predicate(current)) return current;
  return new Promise<typeof current>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `${timeoutCode}_${JSON.stringify({
            state: workflow.snapshot().state,
            logicalStep: workflow.snapshot().logicalStep,
            controller: workflow.snapshot().controller,
            actionPhase: workflow.snapshot().actionPhase,
            lastEffectActor: workflow.snapshot().lastEffectActor,
          })}`,
        ),
      );
    }, timeoutMs);
    const unsubscribe = workflow.subscribe((snapshot) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(snapshot);
    });
  });
}

async function clickVisibleButton(
  renderer: WebContents,
  label: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  return renderer.executeJavaScript(
    `(async () => {
      const label = ${JSON.stringify(label)};
      const deadline = Date.now() + ${timeoutMs};
      while (Date.now() < deadline) {
        const root = document.querySelector('[aria-labelledby="delegated-workflow-title"]');
        const button = Array.from(root?.querySelectorAll('button') ?? []).find(
          (candidate) => candidate.textContent === label && !candidate.disabled
        );
        if (button) { button.click(); return true; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    })()`,
    true,
  );
}

async function run(): Promise<void> {
  const proofProfilePath = argument("--village-proof-profile");
  if (proofProfilePath) {
    if (!isAbsolute(proofProfilePath)) {
      throw new Error("PACKAGED_DELEGATED_WORKFLOW_PROFILE_UNSAFE");
    }
    app.setPath("userData", proofProfilePath);
  }
  await app.whenReady();
  const providerMode =
    argument("--village-proof-provider") === "chatgpt"
      ? "CHATGPT_ACCOUNT"
      : "DETERMINISTIC";
  const variantId = argument("--village-proof-variant");
  const interruption = argument("--village-proof-interrupt");
  const resumedFrom = argument("--village-proof-resume");
  const ownerCheckpoint = argument("--village-proof-checkpoint");
  const modelProviders = createRuntimeModelProviderComposition((url) =>
    shell.openExternal(url),
  );
  const coordinationMode = argument("--village-proof-coordinator");
  if (coordinationMode && coordinationMode !== "paired") {
    throw new Error("PACKAGED_DELEGATED_WORKFLOW_COORDINATOR_INVALID");
  }
  if (providerMode === "CHATGPT_ACCOUNT" && coordinationMode !== "paired") {
    throw new Error("PACKAGED_DELEGATED_WORKFLOW_PAIRED_COORDINATOR_REQUIRED");
  }
  let applicationIdentitySource: PairedRuntimeIdentitySource =
    internalProofIdentitySource();
  let coordination:
    | Awaited<ReturnType<typeof createPairedWorkflowRuntimeComposition>>
    | undefined;
  let fixtureBrowserSessionId: string | undefined;
  if (coordinationMode === "paired") {
    fixtureBrowserSessionId = browserSessionIdSchema.parse(
      argument("--village-proof-fixture-session"),
    );
    const protector = new ElectronSafeStorageProtector();
    const identityDirectory = join(app.getPath("userData"), "identity");
    const runtimeIdentityStore = new SecretRuntimeIdentityStore(
      new SecretVault(join(identityDirectory, "runtime-vault.json"), protector),
    );
    const pairedIdentity = await resolveRuntimeIdentity({
      isPackaged: true,
      pairedIdentitySource: runtimeIdentityStore,
    });
    assertDistinctBrowserSessionIdentity(
      pairedIdentity.browserSessionId,
      fixtureBrowserSessionId,
    );
    applicationIdentitySource = { load: async () => pairedIdentity };
    coordination = await createPairedWorkflowRuntimeComposition({
      controlPlaneUrl: resolveRuntimeControlPlaneUrl(
        pairedIdentity.controlPlaneOrigin,
      ),
      userDataPath: app.getPath("userData"),
      identity: {
        ...pairedIdentity,
        browserSessionId: fixtureBrowserSessionId,
      },
      deviceIdentitySource: new DeviceIdentityVault(
        join(identityDirectory, "device.json"),
        protector,
      ),
    });
  }
  const proof = await createInternalDelegatedProof({
    userDataPath: proofProfilePath
      ? join(internalProofUserDataPath(), "proof-state")
      : join(internalProofUserDataPath(), "proof-runs", String(process.pid)),
    providerMode,
    modelProvider: modelProviders.provider,
    ...(coordination
      ? {
          coordination: {
            initialSnapshot: coordination.initialSnapshot,
            coordinator: coordination.workflowCoordinator,
            automationFence: coordination.automationFence,
          },
        }
      : {}),
    ...(variantId ? { variantId } : {}),
    interruptAfterEffectBeforeReceipt:
      interruption === "post-effect-before-receipt",
    ...(interruption === "crash-after-effect-before-observation"
      ? { abruptlyExitAfterFinalEffect: () => app.exit(86) }
      : {}),
    ...(ownerCheckpoint === "owner-handback-restart" ||
    ownerCheckpoint === "observer-cancel-restart"
      ? {
          delayProviderAfterFirstStepMs:
            ownerCheckpoint === "observer-cancel-restart" ? 30_000 : 3_000,
        }
      : {}),
  }).catch(async (error: unknown) => {
    await modelProviders.modelProviderAccount.close();
    throw error;
  });
  const application = await runVillageApplication(applicationIdentitySource, {
    delegatedWorkflow: proof.delegatedWorkflow,
    modelProviders,
  }).catch(async (error: unknown) => {
    await proof.close();
    await modelProviders.modelProviderAccount.close();
    throw error;
  });
  const reportPath = argument("--village-proof-report");
  if (!reportPath) return;
  try {
    const readyLabel = await application.trustedRenderer.executeJavaScript(
      `document.querySelector('[aria-labelledby="delegated-workflow-title"] h3')?.textContent`,
      true,
    );
    if (ownerCheckpoint === "observer-cancel-restart") {
      const projectionPath = requiredAbsoluteArgument(
        "--village-proof-observer-projection",
      );
      const intentPath = requiredAbsoluteArgument(
        "--village-proof-observer-intent",
      );
      const keyPath = requiredAbsoluteArgument("--village-proof-observer-key");
      if (
        !(await clickVisibleButton(
          application.trustedRenderer,
          "Start demo setup",
        ))
      ) {
        throw new Error("PACKAGED_DELEGATED_WORKFLOW_START_CONTROL_MISSING");
      }
      const working = await waitForWorkflowSnapshot(
        proof.delegatedWorkflow,
        (snapshot) =>
          snapshot.state === "WORKING" &&
          snapshot.logicalStep === "SELECT_ROLE",
        "PACKAGED_DELEGATED_WORKFLOW_OBSERVER_START_TIMEOUT",
      );
      const before = await proof.evidence();
      await writePrivateJson(projectionPath, {
        cursor: before.cursor,
        projectionLag: 0,
        jobRevision: 1,
        jobState: "RUNNING_AGENT",
        workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
        workflowVersion: 1,
        logicalStep: working.logicalStep,
        actionPhase: working.actionPhase,
        lastEffectActor: working.lastEffectActor,
        controller: working.controller,
        connection: working.connection,
        automationFenced: false,
        humanGate: null,
        terminalEvidence: null,
        cancellationAcknowledgedAt: null,
        lastDurableUpdateAt: working.lastDurableUpdateAt,
      });
      await waitForObserverIntent(intentPath, keyPath, before.cursor);
      const terminal = await proof.cancelFromObserver();
      const after = await proof.evidence();
      const acknowledgedAt = terminal.lastDurableUpdateAt;
      await writePrivateJson(projectionPath, {
        cursor: after.cursor,
        projectionLag: 0,
        jobRevision: 1,
        jobState: "CANCELED",
        workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
        workflowVersion: 1,
        logicalStep: terminal.logicalStep,
        actionPhase: terminal.actionPhase,
        lastEffectActor: terminal.lastEffectActor,
        controller: terminal.controller,
        connection: terminal.connection,
        automationFenced: true,
        humanGate: null,
        terminalEvidence: "CANCELLED",
        cancellationAcknowledgedAt: acknowledgedAt,
        lastDurableUpdateAt: terminal.lastDurableUpdateAt,
      });
      await writeFile(
        reportPath,
        JSON.stringify({
          status: "OBSERVER_CANCELED",
          provider: providerMode,
          terminal,
          finalizationEffects: after.finalizationEffects,
        }),
        { mode: 0o600 },
      );
      return;
    }
    if (ownerCheckpoint === "owner-handback-restart") {
      if (
        !(await clickVisibleButton(
          application.trustedRenderer,
          "Start demo setup",
        ))
      ) {
        throw new Error("PACKAGED_DELEGATED_WORKFLOW_START_CONTROL_MISSING");
      }
      if (
        !(await clickVisibleButton(application.trustedRenderer, "Take control"))
      ) {
        throw new Error("PACKAGED_DELEGATED_WORKFLOW_TAKEOVER_CONTROL_MISSING");
      }
      await waitForWorkflowSnapshot(
        proof.delegatedWorkflow,
        (snapshot) => snapshot.state === "OWNER_CONTROL",
        "PACKAGED_DELEGATED_WORKFLOW_OWNER_CONTROL_TIMEOUT",
      );
      const ownerControlVisible =
        await application.trustedRenderer.executeJavaScript(
          `document.querySelector('[aria-labelledby="delegated-workflow-title"] h3')?.textContent === 'You have control'`,
          true,
        );
      const fixtureRenderer = application.fixtureBrowserHost?.view.webContents;
      if (!fixtureRenderer) {
        throw new Error("PACKAGED_DELEGATED_WORKFLOW_FIXTURE_SURFACE_MISSING");
      }
      await fixtureRenderer.executeJavaScript(
        `document.querySelector('[data-field="ROLE"]').value = 'BUILDER';
         document.querySelector('[data-field="PREFERRED_FOCUS"]').value = 'RELIABILITY'`,
        true,
      );
      const returnControlVisible = await clickVisibleButton(
        application.trustedRenderer,
        "Return control to Village",
      );
      const checkpoint = await waitForWorkflowSnapshot(
        proof.delegatedWorkflow,
        (snapshot) =>
          snapshot.lastEffectActor === "OWNER" &&
          snapshot.logicalStep === "SET_PREFERRED_FOCUS",
        "PACKAGED_DELEGATED_WORKFLOW_HAND_BACK_TIMEOUT",
      );
      const evidence = await proof.evidence();
      await writeFile(
        reportPath,
        JSON.stringify({
          status: "OWNER_CHECKPOINT",
          provider: providerMode,
          ownerControlVisible,
          returnControlVisible,
          lastEffectActor: checkpoint.lastEffectActor,
          logicalStep: checkpoint.logicalStep,
          leaseEpoch: evidence.leaseEpoch,
          completedEffectCount: evidence.completedEffectCount,
        }),
        { mode: 0o600 },
      );
      return;
    }
    if (
      resumedFrom === "post-effect-before-receipt" ||
      resumedFrom === "crash-after-effect-before-observation" ||
      resumedFrom === "owner-handback-restart" ||
      resumedFrom === "observer-cancel-restart"
    ) {
      await proof.delegatedWorkflow.retry();
    } else {
      await application.trustedRenderer.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Start demo setup')?.click()`,
        true,
      );
    }
    const terminal = await waitForTerminal(proof.delegatedWorkflow);
    const evidence = await proof.evidence();
    const fixtureUrl =
      application.fixtureBrowserHost?.view.webContents.getURL();
    await writeFile(
      reportPath,
      JSON.stringify({
        status:
          terminal.state === "RECEIPTED_SUCCESS"
            ? "PASS"
            : resumedFrom === "observer-cancel-restart" &&
                terminal.state === "CANCELLED"
              ? "CANCELED_RESTART"
              : interruption === "post-effect-before-receipt" &&
                  terminal.state === "OFFLINE"
                ? "INTERRUPTED"
                : "STOPPED",
        provider: providerMode,
        coordinator: coordinationMode === "paired" ? "PAIRED" : "LOCAL_PROOF",
        ...(coordination
          ? {
              coordinatorJobId: coordination.initialSnapshot.jobId,
              fixtureBrowserSessionId,
            }
          : {}),
        readyLabel,
        terminal,
        finalizationEffects: evidence.finalizationEffects,
        stopReason: evidence.stopReason,
        actionPhase: terminal.actionPhase,
        ...(interruption ? { interruption } : {}),
        ...(resumedFrom ? { resumedFrom } : {}),
        fixtureSurfaceVisible:
          typeof fixtureUrl === "string" &&
          fixtureUrl.startsWith("https://fixture.village.test/setup"),
      }),
      { mode: 0o600 },
    );
  } finally {
    await proof.close();
    application.window.close();
    app.quit();
  }
}

void run().catch((error: unknown) => {
  console.error(
    "Village internal delegated proof blocked:",
    error instanceof Error ? error.message : "UNKNOWN_FAILURE",
  );
  app.exit(1);
});
