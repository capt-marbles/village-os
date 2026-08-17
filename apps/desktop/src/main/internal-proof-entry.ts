import { browserSessionIdSchema } from "@village/contracts";
import { delegatedWorkflowReadySnapshot } from "@village/ui";
import { app, dialog, session, shell, type WebContents } from "electron";
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
import { provisionInternalOwnedFixture } from "./internal-fixture-provisioner.js";
import {
  resolveRuntimeIdentity,
  type PairedRuntimeIdentitySource,
} from "./runtime-identity.js";
import { LazyDelegatedWorkflow } from "./lazy-delegated-workflow.js";
import { InternalPairedBootstrap } from "./internal-paired-bootstrap.js";
import type { InternalDelegatedWorkflowOperations } from "./app-window.js";
import { exitWithoutContinuation } from "./abrupt-exit-barrier.js";
import { LocalBrowserHost } from "../browser/local-browser-host.js";
import {
  assertMacOsProfileEncryptionAvailable,
  ensureProtectedProfile,
  ProfileLock,
} from "../browser/profile-protection.js";
import { internalProofProfileProtection } from "./internal-profile-protection.js";
import { confirmSessionErasure } from "./session-erasure-request.js";
import { verifyMacOsOwnerPresence } from "./step-up-auth.js";

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
  workflow: InternalDelegatedWorkflowOperations,
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
  workflow: InternalDelegatedWorkflowOperations,
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

async function waitForWorkflowLabel(
  renderer: WebContents,
  expected: string,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  return renderer.executeJavaScript(
    `(async () => {
      const expected = ${JSON.stringify(expected)};
      const deadline = Date.now() + ${timeoutMs};
      while (Date.now() < deadline) {
        const label = document.querySelector('[aria-labelledby="delegated-workflow-title"] h3')?.textContent;
        if (label === expected) return label;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return undefined;
    })()`,
    true,
  );
}

async function run(): Promise<void> {
  const proofProfilePath = argument("--village-proof-profile");
  const profileProtectionReport = argument(
    "--village-profile-protection-report",
  );
  if (proofProfilePath) {
    if (!isAbsolute(proofProfilePath)) {
      throw new Error("PACKAGED_DELEGATED_WORKFLOW_PROFILE_UNSAFE");
    }
    app.setPath("userData", proofProfilePath);
  }
  if (profileProtectionReport) {
    if (!isAbsolute(profileProtectionReport) || !proofProfilePath) {
      throw new Error("PACKAGED_PROFILE_PROTECTION_PATH_UNSAFE");
    }
    await writePrivateJson(profileProtectionReport, {
      status: "WAITING_FOR_APP_READY",
    });
  }
  await app.whenReady();
  if (profileProtectionReport) {
    if (!proofProfilePath) {
      throw new Error("PACKAGED_PROFILE_PROTECTION_PATH_UNSAFE");
    }
    const sentinel = process.env.VILLAGE_PROFILE_PROTECTION_SENTINEL;
    if (!sentinel || !/^[a-f0-9]{64}$/.test(sentinel)) {
      throw new Error("PACKAGED_PROFILE_PROTECTION_SENTINEL_INVALID");
    }
    await writePrivateJson(profileProtectionReport, {
      status: "WAITING_FOR_KEYCHAIN",
    });
    const protector = new ElectronSafeStorageProtector();
    const availability = await protector.availability();
    assertMacOsProfileEncryptionAvailable(availability, true);
    await writePrivateJson(profileProtectionReport, {
      status: "WAITING_FOR_OWNER_AUTHORIZATION",
    });
    app.focus({ steal: true });
    if (!(await verifyMacOsOwnerPresence())) {
      throw new Error("PACKAGED_PROFILE_OWNER_AUTHORIZATION_REJECTED");
    }
    await writePrivateJson(profileProtectionReport, {
      status: "WAITING_FOR_NATIVE_CONFIRMATION",
    });
    if (!(await confirmSessionErasure(dialog))) {
      throw new Error("PACKAGED_PROFILE_NATIVE_CONFIRMATION_REJECTED");
    }
    await writePrivateJson(profileProtectionReport, {
      status: "PREPARING_PROFILE",
    });
    const profile = await ensureProtectedProfile(
      LocalBrowserHost.profileRoot(proofProfilePath),
      {
        principalId: "prn_01J00000000000000000000070",
        deviceId: "dev_01J00000000000000000000070",
        site: "OWNED_FIXTURE",
      },
    );
    const lock = await ProfileLock.acquire(profile.path);
    try {
      await writePrivateJson(profileProtectionReport, {
        status: "OPENING_CHROMIUM_SESSION",
      });
      const proofSession = session.fromPath(profile.path, { cache: true });
      await writePrivateJson(profileProtectionReport, {
        status: "WRITING_COOKIE",
      });
      await proofSession.cookies.set({
        url: "https://fixture.village.test",
        name: "__Host-village_oscrypt_probe",
        value: sentinel,
        secure: true,
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        expirationDate: Date.now() / 1000 + 86_400,
      });
      await writePrivateJson(profileProtectionReport, {
        status: "FLUSHING_COOKIE",
      });
      await proofSession.flushStorageData();
      await writePrivateJson(profileProtectionReport, {
        status: "VERIFYING_COOKIE",
      });
      const persisted = await proofSession.cookies.get({
        url: "https://fixture.village.test",
        name: "__Host-village_oscrypt_probe",
      });
      if (persisted.length !== 1 || persisted[0]?.value !== sentinel) {
        throw new Error("PACKAGED_PROFILE_COOKIE_WRITE_FAILED");
      }
      await writePrivateJson(profileProtectionReport, {
        status: "READY_FOR_DISK_VERIFICATION",
        cookieName: "__Host-village_oscrypt_probe",
        osCryptBackend: availability.backend,
        backupExclusion: "VERIFIED",
        indexExclusion: "VERIFIED",
        ownerPresence: "VERIFIED",
        nativeConfirmation: "VERIFIED",
      });
    } finally {
      await lock.release();
      app.quit();
    }
    return;
  }
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
  const pairedSetup = await (async () => {
    if (coordinationMode !== "paired") return undefined;
    const protector = new ElectronSafeStorageProtector();
    const identityDirectory = join(app.getPath("userData"), "identity");
    const runtimeIdentityStore = new SecretRuntimeIdentityStore(
      new SecretVault(join(identityDirectory, "runtime-vault.json"), protector),
    );
    const identity = await resolveRuntimeIdentity({
      isPackaged: true,
      pairedIdentitySource: runtimeIdentityStore,
    });
    return {
      identity,
      controlPlaneUrl: resolveRuntimeControlPlaneUrl(
        identity.controlPlaneOrigin,
      ),
      identityDirectory,
      protector,
    };
  })();
  if (pairedSetup) {
    applicationIdentitySource = { load: async () => pairedSetup.identity };
  }
  type CreatedProof = Awaited<ReturnType<typeof createInternalDelegatedProof>>;
  let createdProof: CreatedProof | undefined;
  const pairedBootstrap = pairedSetup
    ? new InternalPairedBootstrap(
        async () => {
          const providedFixtureSessionId = argument(
            "--village-proof-fixture-session",
          );
          const fixtureBrowserSessionId = providedFixtureSessionId
            ? browserSessionIdSchema.parse(providedFixtureSessionId)
            : (
                await provisionInternalOwnedFixture({
                  controlPlaneUrl: pairedSetup.controlPlaneUrl,
                  identity: pairedSetup.identity,
                })
              ).browserSessionId;
          assertDistinctBrowserSessionIdentity(
            pairedSetup.identity.browserSessionId,
            fixtureBrowserSessionId,
          );
          return { fixtureBrowserSessionId };
        },
        ({ fixtureBrowserSessionId }) =>
          createPairedWorkflowRuntimeComposition({
            controlPlaneUrl: pairedSetup.controlPlaneUrl,
            userDataPath: app.getPath("userData"),
            identity: {
              ...pairedSetup.identity,
              browserSessionId: fixtureBrowserSessionId,
            },
            deviceIdentitySource: new DeviceIdentityVault(
              join(pairedSetup.identityDirectory, "device.json"),
              pairedSetup.protector,
            ),
          }),
      )
    : undefined;
  const lazyWorkflow = new LazyDelegatedWorkflow(
    delegatedWorkflowReadySnapshot,
    async () => {
      if (coordinationMode === "paired") {
        if (!pairedSetup) {
          throw new Error("PACKAGED_DELEGATED_WORKFLOW_PAIRED_SETUP_MISSING");
        }
        if (!pairedBootstrap) {
          throw new Error("PACKAGED_DELEGATED_WORKFLOW_PAIRED_SETUP_MISSING");
        }
        const bootstrap = await pairedBootstrap.result();
        fixtureBrowserSessionId = bootstrap.provisioned.fixtureBrowserSessionId;
        coordination = bootstrap.coordination;
      }
      createdProof = await createInternalDelegatedProof({
        userDataPath: proofProfilePath
          ? join(internalProofUserDataPath(), "proof-state")
          : join(
              internalProofUserDataPath(),
              "proof-runs",
              String(process.pid),
            ),
        providerMode,
        modelProvider: modelProviders.provider,
        profileProtection: internalProofProfileProtection,
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
          ? {
              abruptlyExitAfterFinalEffect: () =>
                exitWithoutContinuation((code) => process.exit(code), 86),
            }
          : {}),
        ...(ownerCheckpoint === "owner-handback-restart" ||
        ownerCheckpoint === "observer-cancel-restart"
          ? {
              delayProviderAfterFirstStepMs:
                ownerCheckpoint === "observer-cancel-restart" ? 30_000 : 3_000,
            }
          : {}),
      });
      return {
        operations: createdProof.delegatedWorkflow,
        proof: createdProof,
      };
    },
  );
  const proof = {
    delegatedWorkflow: lazyWorkflow,
    evidence: async () => (await lazyWorkflow.result()).proof.evidence(),
    cancelFromObserver: async () =>
      (await lazyWorkflow.result()).proof.cancelFromObserver(),
    close: async () => {
      lazyWorkflow.dispose();
      await createdProof?.close();
    },
  };
  const application = await runVillageApplication(applicationIdentitySource, {
    delegatedWorkflow: lazyWorkflow,
    modelProviders,
    profileProtection: internalProofProfileProtection,
  }).catch(async (error: unknown) => {
    await proof.close();
    await modelProviders.modelProviderAccount.close();
    throw error;
  });
  const reportPath = argument("--village-proof-report");
  if (!reportPath) return;
  try {
    const readyLabel = await waitForWorkflowLabel(
      application.trustedRenderer,
      "Ready for delegated setup",
    );
    const provisionedBeforeStart = lazyWorkflow.isCreationStarted();
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
      if (!application.prepareDelegatedWorkflowSurface) {
        throw new Error(
          "PACKAGED_DELEGATED_WORKFLOW_SURFACE_PREPARATION_MISSING",
        );
      }
      await application.prepareDelegatedWorkflowSurface();
      await proof.delegatedWorkflow.retry();
    } else {
      if (
        !(await clickVisibleButton(
          application.trustedRenderer,
          "Start demo setup",
        ))
      ) {
        throw new Error("PACKAGED_DELEGATED_WORKFLOW_START_CONTROL_MISSING");
      }
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
        provisionedBeforeStart,
        terminal,
        finalizationEffects: evidence.finalizationEffects,
        reconciliations: evidence.reconciliations,
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
