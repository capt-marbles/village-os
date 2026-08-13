import type { App, Session, WebContents, WebPreferences } from "electron";
import {
  browserWebPreferences,
  decideNavigation,
  decidePopup,
  isPermissionAllowed,
  type BrowserSite,
} from "../browser/session-policy.js";

const configuredSessions = new WeakSet<Session>();

export function trustedWebPreferences(preload: string): WebPreferences {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    devTools: false,
    preload,
  };
}

export function isTrustedVillageSender(contents: WebContents): boolean {
  if (contents.isDestroyed()) return false;
  try {
    const url = new URL(contents.getURL());
    return url.protocol === "village:" && url.host === "app";
  } catch {
    return false;
  }
}

export function configureBrowserSession(browserSession: Session): void {
  if (configuredSessions.has(browserSession)) return;
  configuredSessions.add(browserSession);
  browserSession.setPermissionCheckHandler((_contents, permission) =>
    isPermissionAllowed(permission),
  );
  browserSession.setPermissionRequestHandler((_contents, permission, done) =>
    done(isPermissionAllowed(permission)),
  );
  browserSession.setDevicePermissionHandler(() => false);
  browserSession.setDisplayMediaRequestHandler((_request, done) => done({}));
  browserSession.on("will-download", (event) => event.preventDefault());
}

export function configureRemoteContents(
  contents: WebContents,
  site: BrowserSite,
): void {
  contents.setWindowOpenHandler(decidePopup);
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("will-navigate", (event, url) => {
    if (!decideNavigation(site, url).allow) event.preventDefault();
  });
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame && !decideNavigation(site, event.url).allow) {
      event.preventDefault();
    }
  });
  contents.on("before-input-event", (event, input) => {
    const devToolsShortcut =
      input.key === "F12" ||
      ((input.meta || input.control) &&
        input.shift &&
        ["I", "J", "C"].includes(input.key.toUpperCase()));
    if (devToolsShortcut) event.preventDefault();
  });
  contents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
}

export function installGlobalSecurityPolicy(application: App): void {
  application.on(
    "certificate-error",
    (event, _contents, _url, _error, _cert, callback) => {
      event.preventDefault();
      callback(false);
    },
  );
  application.on(
    "select-client-certificate",
    (event, _contents, _url, _list, callback) => {
      event.preventDefault();
      callback();
    },
  );
  application.on("login", (event, _contents, _details, _authInfo, callback) => {
    event.preventDefault();
    callback();
  });
}
