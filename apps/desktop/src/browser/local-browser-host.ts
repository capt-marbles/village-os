import { join } from "node:path";
import { session, WebContentsView } from "electron";
import {
  eraseScopedProfile,
  ensureProtectedProfile,
  ProfileLock,
  scopedProfileAbsent,
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
    private readonly profilePath: string,
    private readonly browserSession: ReturnType<typeof session.fromPath>,
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
      const browserSession = session.fromPath(profile.path, {
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
      await view.webContents.loadURL(options.initialUrl).catch(() => undefined);
      return new LocalBrowserHost(
        view,
        profileLock,
        profile.path,
        browserSession,
      );
    } catch (error) {
      // The view may exist even when later session setup fails.
      await profileLock.release();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    await this.profileLock.release();
  }

  /** Destructive lifecycle helpers, called only after main-process step-up. */
  async clearSiteStorage(): Promise<void> {
    await this.browserSession.clearStorageData();
    await this.browserSession.clearCache();
    await this.browserSession.clearAuthCache();
  }

  async clearSitePermissions(): Promise<void> {
    // Permission prompts are deny-by-default and session configuration is
    // process-local. Removing the scoped profile below erases Chromium's
    // persisted permission state; clear storage here removes origin grants.
    await this.browserSession.clearStorageData();
  }

  async removeScopedProfile(): Promise<void> {
    await this.profileLock.release();
    await eraseScopedProfile(this.profilePath);
  }

  async scopedProfileAbsent(): Promise<boolean> {
    return scopedProfileAbsent(this.profilePath);
  }

  async reloadAfterUncertainAction(timeoutMs = 10_000): Promise<void> {
    const contents = this.view.webContents;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error("BROWSER_RELOAD_TIMEOUT")),
        timeoutMs,
      );
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        contents.removeListener("did-finish-load", loaded);
        contents.removeListener("did-fail-load", failed);
        if (error) reject(error);
        else resolve();
      };
      const loaded = () => finish();
      const failed = () => finish(new Error("BROWSER_RELOAD_FAILED"));
      contents.once("did-finish-load", loaded);
      contents.once("did-fail-load", failed);
      contents.reload();
    });
  }

  static profileRoot(userDataPath: string): string {
    return join(userDataPath, "browser-profiles");
  }
}

export type { BrowserSite };
