import { app, shell, type WebContents } from "electron";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  createInternalDelegatedProof,
  internalProofIdentitySource,
  internalProofUserDataPath,
} from "./internal-delegated-proof.js";
import { runVillageApplication } from "./runtime.js";
import { createRuntimeModelProviderComposition } from "./runtime-model-provider.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function waitForTerminal(
  workflow: Awaited<
    ReturnType<typeof createInternalDelegatedProof>
  >["delegatedWorkflow"],
  timeoutMs = 120_000,
) {
  const current = workflow.snapshot();
  if (current.state === "RECEIPTED_SUCCESS") return current;
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
  const proof = await createInternalDelegatedProof({
    userDataPath: proofProfilePath
      ? join(internalProofUserDataPath(), "proof-state")
      : join(internalProofUserDataPath(), "proof-runs", String(process.pid)),
    providerMode,
    modelProvider: modelProviders.provider,
    ...(variantId ? { variantId } : {}),
    interruptAfterEffectBeforeReceipt:
      interruption === "post-effect-before-receipt",
    ...(interruption === "crash-after-effect-before-observation"
      ? { abruptlyExitAfterFinalEffect: () => app.exit(86) }
      : {}),
    ...(ownerCheckpoint === "owner-handback-restart"
      ? { delayProviderAfterFirstStepMs: 3_000 }
      : {}),
  }).catch(async (error: unknown) => {
    await modelProviders.modelProviderAccount.close();
    throw error;
  });
  const application = await runVillageApplication(
    internalProofIdentitySource(),
    {
      delegatedWorkflow: proof.delegatedWorkflow,
      modelProviders,
    },
  ).catch(async (error: unknown) => {
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
      resumedFrom === "owner-handback-restart"
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
            : interruption === "post-effect-before-receipt" &&
                terminal.state === "OFFLINE"
              ? "INTERRUPTED"
              : "STOPPED",
        provider: providerMode,
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
