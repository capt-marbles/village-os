import { OWNED_FIXTURE_ORIGIN } from "@village/contracts";
import { createHash } from "node:crypto";
import type { DebuggerTransport } from "./cdp-adapter.js";
import type {
  CredentialDestination,
  CredentialFillBinding,
} from "../secrets/credential-broker.js";

type BaseBinding = Omit<
  CredentialFillBinding,
  "documentId" | "mainFrameId" | "nodeId"
>;

type LiveField = {
  binding: CredentialFillBinding;
  objectId: string;
  approved: boolean;
  visible: boolean;
  enabled: boolean;
  obscured: boolean;
};

const fixtureFieldSelector =
  'input[type="password"][autocomplete="current-password"]';
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function fixtureFieldFacts(field: HTMLInputElement) {
  const rect = field.getBoundingClientRect();
  const style = getComputedStyle(field);
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const top = document.elementFromPoint(x, y);
  return {
    approved:
      field instanceof HTMLInputElement &&
      field.type === "password" &&
      field.autocomplete === "current-password",
    visible:
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility === "visible" &&
      style.opacity !== "0",
    enabled: !field.disabled && !field.readOnly,
    obscured: top !== field && !field.contains(top),
  };
}

const fixtureFieldFactsCall = `(${fixtureFieldFacts.toString()})(this)`;
const inspectFixtureFieldDeclaration = `function() { return ${fixtureFieldFactsCall}; }`;
const writeFixtureFieldDeclaration = `function(bytes) { try { const facts = ${fixtureFieldFactsCall}; const approved = this.isConnected && location.origin === 'https://fixture.village.test' && facts.approved && facts.visible && facts.enabled && !facts.obscured; if (!approved) return { written: false }; const value = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); this.value = value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return { written: this.value === value }; } finally { bytes.fill(0); } }`;

function villageOpaqueId(prefix: "doc" | "frm" | "nod", value: string): string {
  const digest = createHash("sha256").update(value).digest().subarray(0, 16);
  let numeric = BigInt(`0x${digest.toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = alphabet[Number(numeric & 31n)] + encoded;
    numeric >>= 5n;
  }
  return `${prefix}_${encoded}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CREDENTIAL_DESTINATION_UNAVAILABLE");
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("CREDENTIAL_DESTINATION_UNAVAILABLE");
  }
  return value;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("CREDENTIAL_DESTINATION_ABORTED");
  }
}

function sameDestination(
  expected: Pick<
    CredentialFillBinding,
    "exactOrigin" | "documentId" | "mainFrameId" | "nodeId" | "fieldSemantic"
  >,
  actual: CredentialFillBinding,
): boolean {
  return (
    expected.exactOrigin === actual.exactOrigin &&
    expected.documentId === actual.documentId &&
    expected.mainFrameId === actual.mainFrameId &&
    expected.nodeId === actual.nodeId &&
    expected.fieldSemantic === actual.fieldSemantic
  );
}

export class OwnedFixtureCredentialDestination implements CredentialDestination {
  constructor(
    private readonly baseBinding: Readonly<BaseBinding>,
    private readonly transport: DebuggerTransport,
  ) {
    if (
      baseBinding.site !== "OWNED_FIXTURE" ||
      baseBinding.exactOrigin !== OWNED_FIXTURE_ORIGIN ||
      baseBinding.fieldSemantic !== "PASSWORD"
    ) {
      throw new Error("CREDENTIAL_DESTINATION_DENIED");
    }
  }

  async prepareBinding(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<CredentialFillBinding> {
    const live = await this.inspectLiveField(signal);
    try {
      if (!live.approved) throw new Error("CREDENTIAL_DESTINATION_DENIED");
      return live.binding;
    } finally {
      await this.release(live.objectId);
    }
  }

  async inspectApprovedFixtureField(signal: AbortSignal) {
    const live = await this.inspectLiveField(signal);
    try {
      return {
        ...live.binding,
        approved: live.approved,
        visible: live.visible,
        enabled: live.enabled,
        obscured: live.obscured,
      };
    } finally {
      await this.release(live.objectId);
    }
  }

  async writeApprovedFixtureField(
    request: {
      plaintext: Uint8Array;
      exactOrigin: string;
      documentId: string;
      mainFrameId: string;
      nodeId: string;
      fieldSemantic: "PASSWORD";
    },
    signal: AbortSignal,
  ): Promise<void> {
    const live = await this.inspectLiveField(signal);
    let bytes: number[] | undefined;
    try {
      if (
        !sameDestination(request, live.binding) ||
        !live.approved ||
        !live.visible ||
        !live.enabled ||
        live.obscured
      ) {
        throw new Error("CREDENTIAL_DESTINATION_BINDING_CHANGED");
      }
      assertNotAborted(signal);
      bytes = Array.from(request.plaintext);
      const response = record(
        await this.transport.sendCommand("Runtime.callFunctionOn", {
          objectId: live.objectId,
          functionDeclaration: writeFixtureFieldDeclaration,
          arguments: [{ value: bytes }],
          awaitPromise: false,
          returnByValue: true,
        }),
      );
      assertNotAborted(signal);
      const result = record(response.result);
      const value = record(result.value);
      if (value.written !== true) {
        throw new Error("CREDENTIAL_DESTINATION_WRITE_FAILED");
      }
    } finally {
      bytes?.fill(0);
      await this.release(live.objectId);
    }
  }

  detach(): void {
    if (this.transport.isAttached()) this.transport.detach();
  }

  private async ensureAttached(): Promise<void> {
    if (!this.transport.isAttached()) await this.transport.attach("1.3");
  }

  private async inspectLiveField(signal: AbortSignal): Promise<LiveField> {
    assertNotAborted(signal);
    await this.ensureAttached();
    const frameTree = record(
      await this.transport.sendCommand("Page.getFrameTree"),
    );
    assertNotAborted(signal);
    const rootFrame = record(record(frameTree.frameTree).frame);
    const frameId = stringField(rootFrame.id);
    const loaderId = stringField(rootFrame.loaderId);
    const url = new URL(stringField(rootFrame.url));
    if (
      url.origin !== OWNED_FIXTURE_ORIGIN ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error("CREDENTIAL_DESTINATION_DENIED");
    }

    const document = record(
      await this.transport.sendCommand("DOM.getDocument", {
        depth: 0,
        pierce: false,
      }),
    );
    assertNotAborted(signal);
    const rootNodeId = record(document.root).nodeId;
    if (!Number.isSafeInteger(rootNodeId)) {
      throw new Error("CREDENTIAL_DESTINATION_UNAVAILABLE");
    }
    const query = record(
      await this.transport.sendCommand("DOM.querySelectorAll", {
        nodeId: rootNodeId,
        selector: fixtureFieldSelector,
      }),
    );
    const nodeIds = query.nodeIds;
    if (
      !Array.isArray(nodeIds) ||
      nodeIds.length !== 1 ||
      !Number.isSafeInteger(nodeIds[0]) ||
      nodeIds[0] === 0
    ) {
      throw new Error("CREDENTIAL_DESTINATION_UNAVAILABLE");
    }
    const nodeId = nodeIds[0];
    const description = record(
      await this.transport.sendCommand("DOM.describeNode", { nodeId }),
    );
    const backendNodeId = record(description.node).backendNodeId;
    if (!Number.isSafeInteger(backendNodeId)) {
      throw new Error("CREDENTIAL_DESTINATION_UNAVAILABLE");
    }
    const resolved = record(
      await this.transport.sendCommand("DOM.resolveNode", { nodeId }),
    );
    const objectId = stringField(record(resolved.object).objectId);
    try {
      const inspection = record(
        await this.transport.sendCommand("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: inspectFixtureFieldDeclaration,
          awaitPromise: false,
          returnByValue: true,
        }),
      );
      assertNotAborted(signal);
      const facts = record(record(inspection.result).value);
      return {
        binding: {
          ...this.baseBinding,
          documentId: villageOpaqueId("doc", loaderId),
          mainFrameId: villageOpaqueId("frm", frameId),
          nodeId: villageOpaqueId("nod", String(backendNodeId)),
        },
        objectId,
        approved: facts.approved === true,
        visible: facts.visible === true,
        enabled: facts.enabled === true,
        obscured: facts.obscured !== false,
      };
    } catch (error) {
      await this.release(objectId);
      throw error;
    }
  }

  private async release(objectId: string): Promise<void> {
    await this.transport
      .sendCommand("Runtime.releaseObject", { objectId })
      .catch(() => undefined);
  }
}
