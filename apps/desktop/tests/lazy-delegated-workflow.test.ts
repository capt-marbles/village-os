import type { DelegatedWorkflowSnapshot } from "@village/ui";
import type { LocalBrowserHost } from "../src/browser/local-browser-host.js";
import { describe, expect, it, vi } from "vitest";
import { LazyDelegatedWorkflow } from "../src/main/lazy-delegated-workflow.js";

const ready: DelegatedWorkflowSnapshot = {
  workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
  state: "READY",
  logicalStep: null,
  controller: "NONE",
  connection: "ABSENT",
  actionPhase: "NONE",
  lastEffectActor: null,
  humanGate: null,
  inputOwner: "NONE",
  lastDurableUpdateAt: new Date(0).toISOString(),
};

function createdWorkflow() {
  const listeners = new Set<(snapshot: DelegatedWorkflowSnapshot) => void>();
  const working: DelegatedWorkflowSnapshot = {
    ...ready,
    state: "WORKING",
    logicalStep: "SET_DISPLAY_NAME",
    controller: "AGENT",
    connection: "ONLINE",
    actionPhase: "ACCEPTED",
    lastDurableUpdateAt: new Date(1).toISOString(),
  };
  const operations = {
    createFixtureHost: vi.fn(async () => ({ name: "fixture-host" })),
    snapshot: vi.fn(() => working),
    subscribe: vi.fn(
      (listener: (snapshot: DelegatedWorkflowSnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    ),
    start: vi.fn(async () => working),
    takeOver: vi.fn(async () => working),
    handBack: vi.fn(async () => working),
    cancel: vi.fn(async () => working),
    retry: vi.fn(async () => working),
    fence: vi.fn(),
  };
  return { operations, working, listeners };
}

describe("lazy delegated workflow", () => {
  it("does not provision until the fixture host is requested and creates it once", async () => {
    const created = createdWorkflow();
    const create = vi.fn(async () => ({
      operations: created.operations,
      evidence: "created",
    }));
    const workflow = new LazyDelegatedWorkflow(ready, create);

    expect(workflow.snapshot()).toEqual(ready);
    expect(workflow.isCreated()).toBe(false);
    expect(workflow.isCreationStarted()).toBe(false);
    expect(create).not.toHaveBeenCalled();

    const firstCreation = workflow.createFixtureHost();
    expect(workflow.isCreationStarted()).toBe(true);
    const [first, second] = await Promise.all([
      firstCreation,
      workflow.createFixtureHost(),
    ]);
    expect(first).toBe(second);
    expect(create).toHaveBeenCalledTimes(1);
    expect(workflow.isCreated()).toBe(true);
    expect(workflow.isCreationStarted()).toBe(true);
    expect(created.operations.createFixtureHost).toHaveBeenCalledTimes(1);
    await expect(workflow.result()).resolves.toMatchObject({
      evidence: "created",
    });
  });

  it("projects initialization failure and retries provisioning from the Retry action", async () => {
    const created = createdWorkflow();
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("CONTROL_PLANE_OFFLINE"))
      .mockResolvedValueOnce({
        operations: created.operations,
        evidence: "retried",
      });
    const workflow = new LazyDelegatedWorkflow(ready, create);
    const observed: DelegatedWorkflowSnapshot[] = [];
    workflow.subscribe((snapshot) => observed.push(snapshot));

    await expect(workflow.createFixtureHost()).rejects.toThrow(
      "CONTROL_PLANE_OFFLINE",
    );
    expect(workflow.snapshot().state).toBe("FAILED");
    await expect(workflow.retry()).resolves.toEqual(created.working);
    expect(create).toHaveBeenCalledTimes(2);
    expect(created.operations.start).not.toHaveBeenCalled();
    expect(created.operations.retry).toHaveBeenCalledTimes(1);
    expect(observed.map((snapshot) => snapshot.state)).toEqual([
      "FAILED",
      "WORKING",
    ]);
  });

  it("forwards durable updates and fences only after creation", async () => {
    const created = createdWorkflow();
    const workflow = new LazyDelegatedWorkflow(ready, async () => ({
      operations: created.operations,
      evidence: "created",
    }));
    const observed: DelegatedWorkflowSnapshot[] = [];
    workflow.subscribe((snapshot) => observed.push(snapshot));

    workflow.fence("TASK_SWITCH");
    expect(created.operations.fence).not.toHaveBeenCalled();
    await workflow.createFixtureHost();
    const owner: DelegatedWorkflowSnapshot = {
      ...created.working,
      state: "OWNER_CONTROL",
      controller: "USER",
      inputOwner: "OWNER",
      lastDurableUpdateAt: new Date(2).toISOString(),
    };
    for (const listener of created.listeners) listener(owner);
    workflow.fence("APP_CLOSE");

    expect(workflow.snapshot()).toEqual(owner);
    expect(observed.at(-1)).toEqual(owner);
    expect(created.operations.fence).toHaveBeenCalledWith("APP_CLOSE");
  });

  it("replaces a local fixture-host failure with the canonical retry snapshot", async () => {
    const created = createdWorkflow();
    created.operations.createFixtureHost
      .mockRejectedValueOnce(new Error("FIXTURE_HOST_FAILED"))
      .mockResolvedValueOnce({ name: "fixture-host" });
    const workflow = new LazyDelegatedWorkflow(ready, async () => ({
      operations: created.operations,
      evidence: "created",
    }));

    await expect(workflow.createFixtureHost()).rejects.toThrow(
      "FIXTURE_HOST_FAILED",
    );
    expect(workflow.snapshot().state).toBe("FAILED");
    await expect(workflow.retry()).resolves.toEqual(created.working);
    expect(workflow.snapshot()).toEqual(created.working);
    expect(created.operations.start).not.toHaveBeenCalled();
    expect(created.operations.retry).toHaveBeenCalledTimes(1);
  });

  it("always reconciles through the underlying Retry path", async () => {
    const created = createdWorkflow();
    const reconciled: DelegatedWorkflowSnapshot = {
      ...created.working,
      logicalStep: "SELECT_ROLE",
      lastDurableUpdateAt: new Date(3).toISOString(),
    };
    created.operations.retry.mockResolvedValue(reconciled);
    const workflow = new LazyDelegatedWorkflow(ready, async () => ({
      operations: created.operations,
      evidence: "created",
    }));

    await workflow.start();
    expect(await workflow.retry()).toEqual(reconciled);
    expect(created.operations.start).toHaveBeenCalledTimes(1);
    expect(created.operations.retry).toHaveBeenCalledTimes(1);
  });

  it("invalidates a closed fixture host so Retry creates a fresh host", async () => {
    const created = createdWorkflow();
    const first = { name: "first-host" } as unknown as LocalBrowserHost;
    const second = { name: "second-host" } as unknown as LocalBrowserHost;
    created.operations.createFixtureHost
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const workflow = new LazyDelegatedWorkflow(ready, async () => ({
      operations: created.operations,
      evidence: "created",
    }));

    expect(await workflow.createFixtureHost()).toBe(first);
    workflow.invalidateFixtureHost(first);
    expect(await workflow.createFixtureHost()).toBe(second);
    expect(created.operations.createFixtureHost).toHaveBeenCalledTimes(2);
  });
});
