import type { BrowserSite } from "./session-policy.js";

export interface DebuggerTransport {
  isAttached(): boolean;
  attach(protocolVersion?: string): void | Promise<void>;
  detach(): void;
  sendCommand(
    method: string,
    commandParams?: Record<string, unknown>,
  ): Promise<unknown>;
}

export class FixtureCdpAdapter {
  constructor(
    site: BrowserSite,
    private readonly transport: DebuggerTransport,
  ) {
    if (site !== "OWNED_FIXTURE") throw new Error("CDP_SITE_DENIED");
  }

  private async ensureAttached(): Promise<void> {
    if (!this.transport.isAttached()) await this.transport.attach("1.3");
  }

  async insertNonSecretText(text: string): Promise<void> {
    if (text.length < 1 || text.length > 256) {
      throw new Error("CDP_ARGUMENT_BUDGET_EXCEEDED");
    }
    await this.ensureAttached();
    await this.transport.sendCommand("Input.insertText", { text });
  }

  detach(): void {
    if (this.transport.isAttached()) this.transport.detach();
  }
}
