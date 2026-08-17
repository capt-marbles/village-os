import { OWNED_FIXTURE_ORIGIN } from "@village/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnedFixtureCredentialFill } from "../src/main/owned-fixture-credential-fill.js";
import type { DebuggerTransport } from "../src/browser/cdp-adapter.js";
import {
  SecretVault,
  type SecretEncryptionProvider,
} from "../src/secrets/secret-vault.js";

class TestProtector implements SecretEncryptionProvider {
  async availability() {
    return { available: true, backend: "test-keychain", secure: true };
  }
  async encrypt(value: string) {
    return new TextEncoder().encode(`cipher:${value}`);
  }
  async decrypt(value: Uint8Array) {
    return {
      value: new TextDecoder().decode(value).slice(7),
      shouldReEncrypt: false,
    };
  }
}

class LiveFixtureDebugger implements DebuggerTransport {
  attached = false;
  readonly calls: { method: string; params?: Record<string, unknown> }[] = [];
  isAttached() {
    return this.attached;
  }
  attach() {
    this.attached = true;
  }
  detach() {
    this.attached = false;
  }
  async sendCommand(method: string, params?: Record<string, unknown>) {
    this.calls.push({ method, ...(params ? { params } : {}) });
    if (method === "Page.getFrameTree")
      return {
        frameTree: {
          frame: {
            id: "main-frame",
            loaderId: "document-loader",
            url: `${OWNED_FIXTURE_ORIGIN}/login`,
          },
        },
      };
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") return { nodeIds: [2] };
    if (method === "DOM.describeNode") return { node: { backendNodeId: 3 } };
    if (method === "DOM.resolveNode")
      return { object: { objectId: "password-field" } };
    if (method === "Runtime.releaseObject") return {};
    if (method === "Runtime.callFunctionOn" && params?.arguments)
      return { result: { value: { written: true } } };
    if (method === "Runtime.callFunctionOn")
      return {
        result: {
          value: {
            approved: true,
            visible: true,
            enabled: true,
            obscured: false,
          },
        },
      };
    throw new Error(`unexpected ${method}`);
  }
}

class StalledFixtureDebugger extends LiveFixtureDebugger {
  override async sendCommand(method: string, params?: Record<string, unknown>) {
    if (method === "Page.getFrameTree") {
      return await new Promise<never>(() => undefined);
    }
    return await super.sendCommand(method, params);
  }
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("owned fixture credential fill operation", () => {
  it("binds main-process consent to the live field and returns no secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-fixture-fill-"));
    temporaryDirectories.push(directory);
    const vault = new SecretVault(
      join(directory, "vault.json"),
      new TestProtector(),
    );
    const secret = "seeded-destination-only-value";
    await vault.store("sec_fixture_primary", Buffer.from(secret));
    const transport = new LiveFixtureDebugger();
    const prompts: unknown[] = [];
    const operation = new OwnedFixtureCredentialFill(vault, {
      confirmCredentialUse: async (summary) => {
        prompts.push(summary);
        return true;
      },
    });

    const result = await operation.fill(
      {
        principalId: "prn_01J00000000000000000000000",
        deviceId: "dev_01J00000000000000000000000",
        jobId: "job_01J00000000000000000000000",
        browserSessionId: "brs_01J00000000000000000000000",
        actionId: "act_01J00000000000000000000000",
        leaseEpoch: 7,
        exactOrigin: OWNED_FIXTURE_ORIGIN,
        fieldSemantic: "PASSWORD",
        secretRef: "sec_fixture_primary",
        site: "OWNED_FIXTURE",
      },
      transport,
    );

    expect(result).toEqual({ ok: true });
    expect(prompts).toEqual([
      { exactOrigin: OWNED_FIXTURE_ORIGIN, fieldSemantic: "PASSWORD" },
    ]);
    expect(JSON.stringify({ result, prompts })).not.toContain(secret);
    expect(JSON.stringify(transport.calls)).not.toContain(secret);
    expect(transport.attached).toBe(false);
  });

  it("bounds a stalled pre-consent field binding and detaches", async () => {
    vi.useFakeTimers();
    try {
      const directory = await mkdtemp(join(tmpdir(), "village-fixture-fill-"));
      temporaryDirectories.push(directory);
      const vault = new SecretVault(
        join(directory, "vault.json"),
        new TestProtector(),
      );
      const transport = new StalledFixtureDebugger();
      const operation = new OwnedFixtureCredentialFill(vault, {
        confirmCredentialUse: async () => true,
      });
      const outcome = operation
        .fill(
          {
            principalId: "prn_01J00000000000000000000000",
            deviceId: "dev_01J00000000000000000000000",
            jobId: "job_01J00000000000000000000000",
            browserSessionId: "brs_01J00000000000000000000000",
            actionId: "act_01J00000000000000000000000",
            leaseEpoch: 7,
            exactOrigin: OWNED_FIXTURE_ORIGIN,
            fieldSemantic: "PASSWORD",
            secretRef: "sec_fixture_primary",
            site: "OWNED_FIXTURE",
          },
          transport,
        )
        .then(
          () => "resolved",
          (error: unknown) =>
            error instanceof Error ? error.message : "unknown rejection",
        );

      await vi.advanceTimersByTimeAsync(10_001);
      expect(await Promise.race([outcome, Promise.resolve("unsettled")])).toBe(
        "CREDENTIAL_DESTINATION_TIMEOUT",
      );
      expect(transport.attached).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
