import {
  ownedFixtureSetupCommandSchema,
  setupObservationSchema,
  type OwnedFixtureSetupCommand,
} from "@village/contracts";
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

  async performSetupAction(command: OwnedFixtureSetupCommand): Promise<void> {
    const semantic = ownedFixtureSetupCommandSchema.parse(command);
    if (
      semantic.capability === "OBSERVE_SETUP" ||
      semantic.capability === "VERIFY_SETUP"
    ) {
      throw new Error("CDP_MUTATION_CAPABILITY_REQUIRED");
    }
    await this.ensureAttached();
    await this.transport.sendCommand("Runtime.evaluate", {
      expression: `globalThis.__villageOwnedFixture.perform(${JSON.stringify(semantic.capability)})`,
      awaitPromise: true,
      returnByValue: true,
    });
  }

  async observeSetup(): Promise<
    ReturnType<typeof setupObservationSchema.parse>
  > {
    await this.ensureAttached();
    const response = (await this.transport.sendCommand("Runtime.evaluate", {
      expression: "globalThis.__villageOwnedFixture.observe()",
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    return setupObservationSchema.parse(response.result?.value);
  }

  detach(): void {
    if (this.transport.isAttached()) this.transport.detach();
  }
}
