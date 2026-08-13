import { join } from "node:path";
import { session, WebContentsView } from "electron";
import {
  ensureProtectedProfile,
  ProfileLock,
  type ProfileScope,
} from "./profile-protection.js";
import {
  browserWebPreferences,
  decideNavigation,
  type BrowserSite,
} from "./session-policy.js";
import {
  configureBrowserSession,
  configureRemoteContents,
} from "../main/security.js";

export interface LocalBrowserHostOptions extends ProfileScope {
  profileRoot: string;
  initialUrl: string;
}

export class LocalBrowserHost {
  readonly view: WebContentsView;

  private constructor(
    view: WebContentsView,
    private readonly profileLock: ProfileLock,
  ) {
    this.view = view;
  }

  static async create(
    options: LocalBrowserHostOptions,
  ): Promise<LocalBrowserHost> {
    const decision = decideNavigation(options.site, options.initialUrl);
    if (!decision.allow) throw new Error(decision.code);
    const profile = await ensureProtectedProfile(options.profileRoot, options);
    const profileLock = await ProfileLock.acquire(profile.path);
    try {
      const browserSession = session.fromPartition(profile.partition, {
        cache: true,
      });
      configureBrowserSession(browserSession);
      const view = new WebContentsView({
        webPreferences: {
          ...browserWebPreferences,
          session: browserSession,
        },
      });
      configureRemoteContents(view.webContents, options.site);
      await view.webContents.loadURL(options.initialUrl);
      return new LocalBrowserHost(view, profileLock);
    } catch (error) {
      await profileLock.release();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    await this.profileLock.release();
  }

  static profileRoot(userDataPath: string): string {
    return join(userDataPath, "browser-profiles");
  }
}

export type { BrowserSite };
