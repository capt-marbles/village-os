import { OWNED_FIXTURE_ORIGIN } from "@village/contracts";
import { describe, expect, it } from "vitest";
import { OwnedFixtureCredentialDestination } from "../src/browser/owned-fixture-credential-destination.js";
import type { DebuggerTransport } from "../src/browser/cdp-adapter.js";

const binding = {
  principalId: "prn_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  jobId: "job_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
  actionId: "act_01J00000000000000000000000",
  leaseEpoch: 7,
  exactOrigin: OWNED_FIXTURE_ORIGIN,
  fieldSemantic: "PASSWORD" as const,
  secretRef: "sec_fixture_primary",
  site: "OWNED_FIXTURE" as const,
};

class FixtureDebugger implements DebuggerTransport {
  attached = false;
  backendNodeId = 41;
  writtenBytes: number[] | undefined;
  readonly calls: { method: string; params?: Record<string, unknown> }[] = [];

  isAttached(): boolean {
    return this.attached;
  }

  attach(): void {
    this.attached = true;
  }

  detach(): void {
    this.attached = false;
  }

  async sendCommand(method: string, params?: Record<string, unknown>) {
    this.calls.push({ method, ...(params ? { params } : {}) });
    switch (method) {
      case "Page.getFrameTree":
        return {
          frameTree: {
            frame: {
              id: "main-frame-1",
              loaderId: "document-loader-1",
              url: `${OWNED_FIXTURE_ORIGIN}/login`,
            },
          },
        };
      case "DOM.getDocument":
        return { root: { nodeId: 1 } };
      case "DOM.querySelectorAll":
        return { nodeIds: [9] };
      case "DOM.describeNode":
        return { node: { backendNodeId: this.backendNodeId } };
      case "DOM.resolveNode":
        return { object: { objectId: `field-${this.backendNodeId}` } };
      case "Runtime.callFunctionOn":
        if (params?.arguments) {
          this.writtenBytes = [
            ...((params.arguments as [{ value: number[] }])[0]?.value ?? []),
          ];
          return { result: { value: { written: true } } };
        }
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
      case "Runtime.releaseObject":
        return {};
      default:
        throw new Error(`unexpected ${method}`);
    }
  }
}

describe("owned fixture credential destination", () => {
  it("derives a bound main-frame field and writes bytes through one fixed capability", async () => {
    const transport = new FixtureDebugger();
    const destination = new OwnedFixtureCredentialDestination(
      binding,
      transport,
    );
    const prepared = await destination.prepareBinding();

    expect(prepared).toMatchObject(binding);
    expect(prepared.documentId).toMatch(/^doc_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(prepared.mainFrameId).toMatch(/^frm_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(prepared.nodeId).toMatch(/^nod_[0-9A-HJKMNP-TV-Z]{26}$/);

    const plaintext = new TextEncoder().encode("seeded-fixture-secret");
    await destination.writeApprovedFixtureField(
      {
        plaintext,
        exactOrigin: prepared.exactOrigin,
        documentId: prepared.documentId,
        mainFrameId: prepared.mainFrameId,
        nodeId: prepared.nodeId,
        fieldSemantic: prepared.fieldSemantic,
      },
      new AbortController().signal,
    );

    const write = transport.calls.find(
      (call) =>
        call.method === "Runtime.callFunctionOn" && call.params?.arguments,
    );
    const writeArguments = write?.params?.arguments as
      [{ value: number[] }] | undefined;
    expect(write?.params?.functionDeclaration).toContain("TextDecoder");
    expect(transport.writtenBytes).toEqual([...plaintext]);
    expect(writeArguments?.[0].value).toEqual(
      Array.from({ length: plaintext.length }, () => 0),
    );
    expect(
      transport.calls.filter(
        (call) =>
          call.method === "Runtime.callFunctionOn" && call.params?.arguments,
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(write)).not.toContain("seeded-fixture-secret");
    expect(write?.params).not.toHaveProperty("expression");
  });

  it("makes a replacement node fail the prepared binding", async () => {
    const transport = new FixtureDebugger();
    const destination = new OwnedFixtureCredentialDestination(
      binding,
      transport,
    );
    const prepared = await destination.prepareBinding();
    transport.backendNodeId = 42;

    await expect(
      destination.writeApprovedFixtureField(
        {
          plaintext: new TextEncoder().encode("never-written"),
          exactOrigin: prepared.exactOrigin,
          documentId: prepared.documentId,
          mainFrameId: prepared.mainFrameId,
          nodeId: prepared.nodeId,
          fieldSemantic: prepared.fieldSemantic,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("CREDENTIAL_DESTINATION_BINDING_CHANGED");
    expect(
      transport.calls.filter(
        (call) =>
          call.method === "Runtime.callFunctionOn" && call.params?.arguments,
      ),
    ).toHaveLength(0);
  });

  it("rejects an ambiguous fixture with more than one approved password field", async () => {
    const transport = new FixtureDebugger();
    const original = transport.sendCommand.bind(transport);
    transport.sendCommand = async (method, params) =>
      method === "DOM.querySelectorAll"
        ? { nodeIds: [9, 10] }
        : original(method, params);
    const destination = new OwnedFixtureCredentialDestination(
      binding,
      transport,
    );

    await expect(destination.prepareBinding()).rejects.toThrow(
      "CREDENTIAL_DESTINATION_UNAVAILABLE",
    );
  });
});
