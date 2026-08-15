import type { LocalBrowserHost } from "../browser/local-browser-host.js";

export type DesktopBrowserTask = "LINKEDIN_PERSONAL" | "VILLAGE_FIXTURE";

type ManagedHost = Pick<LocalBrowserHost, "view" | "close">;

export class BrowserHostManager {
  private active: DesktopBrowserTask = "LINKEDIN_PERSONAL";
  private fixtureHandBackRequired = false;

  constructor(
    readonly linkedin: ManagedHost,
    readonly fixture: ManagedHost,
    private readonly hooks: {
      fenceFixture(reason: "TASK_SWITCH" | "APP_CLOSE"): void;
    },
  ) {
    this.linkedin.view.setVisible(true);
    this.fixture.view.setVisible(false);
  }

  currentTask(): DesktopBrowserTask {
    return this.active;
  }

  currentHost(): ManagedHost {
    return this.active === "VILLAGE_FIXTURE" ? this.fixture : this.linkedin;
  }

  fixtureRequiresHandBack(): boolean {
    return this.fixtureHandBackRequired;
  }

  show(task: DesktopBrowserTask): void {
    if (task === "VILLAGE_FIXTURE" && this.fixtureHandBackRequired) {
      throw new Error("FIXTURE_HAND_BACK_REQUIRED");
    }
    if (task === "LINKEDIN_PERSONAL" && this.active === "VILLAGE_FIXTURE") {
      this.hooks.fenceFixture("TASK_SWITCH");
      this.fixtureHandBackRequired = true;
    }
    this.active = task;
    const fixtureVisible = task === "VILLAGE_FIXTURE";
    this.linkedin.view.setVisible(!fixtureVisible);
    this.fixture.view.setVisible(fixtureVisible);
    (fixtureVisible ? this.fixture : this.linkedin).view.webContents.focus();
  }

  allowFixtureAfterHandBack(): void {
    this.fixtureHandBackRequired = false;
  }

  async close(): Promise<void> {
    this.hooks.fenceFixture("APP_CLOSE");
    await Promise.allSettled([this.linkedin.close(), this.fixture.close()]);
  }
}
