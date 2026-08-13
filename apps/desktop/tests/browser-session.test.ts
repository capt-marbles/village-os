import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ActionJournal } from "../src/browser/action-journal.js";
import { FixtureCdpAdapter } from "../src/browser/cdp-adapter.js";
import { createSafeObservation } from "../src/browser/observation.js";

describe("browser session boundary", () => {
  it("journals bounded phases without page content", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-journal-"));
    const path = join(root, "actions.json");
    const journal = new ActionJournal(path);
    await journal.record({
      actionId: "act_01J00000000000000000000000",
      leaseEpoch: 4,
      phase: "ACCEPTED",
      mutationClass: "IDEMPOTENT",
      recordedAt: "2026-08-12T20:00:00.000Z",
    });
    await journal.record({
      actionId: "act_01J00000000000000000000000",
      leaseEpoch: 4,
      phase: "DISPATCHED",
      mutationClass: "IDEMPOTENT",
      recordedAt: "2026-08-12T20:00:01.000Z",
    });

    expect(await journal.read()).toHaveLength(2);
    expect(await readFile(path, "utf8")).not.toContain("pageText");
  });

  it("serializes concurrent journal records without losing a phase", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-journal-race-"));
    const journal = new ActionJournal(join(root, "actions.json"));
    await Promise.all([
      journal.record({
        actionId: "act_01J00000000000000000000000",
        leaseEpoch: 4,
        phase: "ACCEPTED",
        mutationClass: "IDEMPOTENT",
        recordedAt: "2026-08-12T20:00:00.000Z",
      }),
      journal.record({
        actionId: "act_01J00000000000000000000000",
        leaseEpoch: 4,
        phase: "DISPATCHED",
        mutationClass: "IDEMPOTENT",
        recordedAt: "2026-08-12T20:00:01.000Z",
      }),
    ]);
    expect((await journal.read()).map((entry) => entry.phase)).toEqual([
      "ACCEPTED",
      "DISPATCHED",
    ]);
  });

  it("limits CDP to the owned fixture and closed commands", async () => {
    const transport = {
      isAttached: vi.fn(() => false),
      attach: vi.fn(async () => undefined),
      detach: vi.fn(),
      sendCommand: vi.fn(async () => ({})),
    };
    expect(() => new FixtureCdpAdapter("LINKEDIN", transport)).toThrow(
      "CDP_SITE_DENIED",
    );
    const adapter = new FixtureCdpAdapter("OWNED_FIXTURE", transport);
    await adapter.insertNonSecretText("hello");
    expect(transport.attach).toHaveBeenCalledWith("1.3");
    expect(transport.sendCommand).toHaveBeenCalledWith("Input.insertText", {
      text: "hello",
    });
  });

  it("serializes only allowlisted structured observations", () => {
    expect(
      createSafeObservation({
        site: "OWNED_FIXTURE",
        url: "https://fixture.village.test/account?token=secret#private",
        authState: "AUTHENTICATED",
        humanGate: false,
      }),
    ).toEqual({
      site: "OWNED_FIXTURE",
      origin: "https://fixture.village.test",
      predicates: ["pred_auth_state_v1"],
      authState: "AUTHENTICATED",
      humanGate: false,
    });
  });
});
