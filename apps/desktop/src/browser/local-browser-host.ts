import { join } from "node:path";
import { session, type Session, WebContentsView } from "electron";
import {
  ensureProtectedProfile,
  ProfileLock,
  type MacProfileProtection,
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
  prepareSession?: (browserSession: Session) => Promise<() => Promise<void>>;
  /** Internal packaged proofs may replace only the host backup-status probe. */
  profileProtection?: MacProfileProtection;
}

export class LocalBrowserHost {
  readonly view: WebContentsView;
  private preparedSessionClose: Promise<void> | undefined;

  private constructor(
    view: WebContentsView,
    private readonly profileLock: ProfileLock,
    private readonly browserSession: ReturnType<typeof session.fromPath>,
    private readonly closePreparedSession?: () => Promise<void>,
  ) {
    this.view = view;
  }

  static async create(
    options: LocalBrowserHostOptions,
  ): Promise<LocalBrowserHost> {
    const decision = decideNavigation(options.site, options.initialUrl);
    if (!decision.allow) throw new Error(decision.code);
    const profile = await ensureProtectedProfile(
      options.profileRoot,
      options,
      process.platform,
      options.profileProtection,
    );
    const profileLock = await ProfileLock.acquire(profile.path);
    let closePreparedSession: (() => Promise<void>) | undefined;
    try {
      const browserSession = session.fromPath(profile.path, {
        cache: true,
      });
      configureBrowserSession(browserSession);
      closePreparedSession = await options.prepareSession?.(browserSession);
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
        browserSession,
        closePreparedSession,
      );
    } catch (error) {
      // The view may exist even when later session setup fails.
      await closePreparedSession?.();
      await profileLock.release();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closeViewContents();
    await this.closePreparedSessionOnce();
    await this.profileLock.release();
  }

  async closeTargetForErasure(): Promise<void> {
    this.closeViewContents();
    await this.closePreparedSessionOnce();
  }

  /** Destructive lifecycle helpers, called only after main-process step-up. */
  async clearSiteStorage(): Promise<void> {
    await this.browserSession.clearStorageData();
    await this.browserSession.clearCache();
    await this.browserSession.clearAuthCache();
    await this.browserSession.closeAllConnections();
    await this.browserSession.flushStorageData();
  }

  async clearSitePermissions(): Promise<void> {
    // Permission prompts are deny-by-default and process-local; persisted
    // Chromium permission state is erased with the scoped profile below.
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

  private async closePreparedSessionOnce(): Promise<void> {
    if (!this.closePreparedSession) return;
    const closing =
      this.preparedSessionClose ?? Promise.resolve(this.closePreparedSession());
    this.preparedSessionClose = closing;
    try {
      await closing;
    } catch (error) {
      if (this.preparedSessionClose === closing) {
        this.preparedSessionClose = undefined;
      }
      throw error;
    }
  }

  private closeViewContents(): void {
    const contents = (
      this.view as WebContentsView & {
        webContents?: WebContentsView["webContents"];
      }
    ).webContents;
    if (contents && !contents.isDestroyed()) contents.close();
  }
}

export type { BrowserSite };
