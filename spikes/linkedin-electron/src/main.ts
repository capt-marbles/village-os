import { chmod, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  app,
  BaseWindow,
  BrowserWindow,
  dialog,
  Menu,
  safeStorage,
  session,
  WebContentsView,
} from "electron";
import { evaluateProfilePosture, profileDirectoryMode } from "./config.js";
import {
  classifyAuthRoute,
  decideDebuggerTarget,
  decideNavigation,
  decidePermission,
  decidePopup,
  LINKEDIN_LOGIN_URL,
  LINKEDIN_PARTITION,
  remoteWebPreferences,
  verifyAuthentication,
} from "./policy.js";

const execFileAsync = promisify(execFile);
const profileRoot = path.join(app.getPath("appData"), "Village LinkedIn Compatibility Spike", "profiles", "local-principal", "local-device", "linkedin");
app.setPath("userData", profileRoot);

function describeRoute(url: string): string {
  const route = classifyAuthRoute(url);
  const labels: Record<string, string> = {
    standard: "Human sign-in",
    "human-challenge": "Human-only security challenge",
    "human-2fa": "Human-only 2FA",
    "human-password-reset": "Human-only password reset",
    "human-terms-or-consent": "Human-only terms or consent",
    "unsupported-federated": "Unsupported federated route",
    "unsupported-passkey": "Unsupported passkey route",
    unknown: "Unknown route; no policy exception granted",
  };
  return labels[route] ?? labels.unknown;
}

async function protectProfile(): Promise<void> {
  await mkdir(profileRoot, { recursive: true, mode: profileDirectoryMode });
  await chmod(profileRoot, profileDirectoryMode);
  // macOS-recognized exclusions. Failure is fail-closed because R30 requires a declared posture.
  await execFileAsync("/usr/bin/xattr", ["-w", "com.apple.metadata:com_apple_backup_excludeItem", "com.apple.backupd", profileRoot]);
  await writeFile(path.join(profileRoot, ".metadata_never_index"), "", { mode: 0o600 });
}

async function createOwnedFixtureWindow(rawUrl: string): Promise<void> {
  const decision = decideDebuggerTarget(rawUrl);
  if (decision.action === "deny") {
    dialog.showErrorBox("Debugger blocked", "Debugger/CDP is restricted to the Village-owned loopback fixture.");
    app.quit();
    return;
  }
  const fixture = new BrowserWindow({
    width: 900,
    height: 700,
    title: "Village owned fixture — CDP compatibility only",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  fixture.webContents.on("will-navigate", (event, url) => {
    if (decideDebuggerTarget(url).action === "deny") event.preventDefault();
  });
  fixture.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await fixture.loadURL(rawUrl);
  fixture.webContents.debugger.attach("1.3");
  fixture.on("closed", () => {
    if (fixture.webContents.debugger.isAttached()) fixture.webContents.debugger.detach();
  });
}

function installDenyPolicy(linkedinSession: Electron.Session, window: BaseWindow): void {
  linkedinSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const decision = decidePermission(permission);
    window.setTitle(`Village internal spike — blocked ${decision.action === "deny" ? decision.reason : permission}`);
    callback(false);
  });
  linkedinSession.setPermissionCheckHandler((_webContents, permission) => decidePermission(permission).action === "allow");
  linkedinSession.on("will-download", (event) => {
    event.preventDefault();
    window.setTitle("Village internal spike — downloads blocked");
  });
}

function createLinkedInWindow(): void {
  const window = new BaseWindow({ width: 1180, height: 820, title: "Village internal spike — Human sign-in" });
  const linkedin = new WebContentsView({ webPreferences: remoteWebPreferences });
  window.contentView.addChildView(linkedin);
  const resize = () => linkedin.setBounds({ x: 0, y: 0, width: window.getBounds().width, height: window.getBounds().height });
  resize();
  window.on("resize", resize);

  const linkedinSession = session.fromPartition(LINKEDIN_PARTITION);
  installDenyPolicy(linkedinSession, window);

  const enforceNavigation = (event: Electron.Event, url: string) => {
    const decision = decideNavigation(url);
    if (decision.action === "deny") {
      event.preventDefault();
      window.setTitle(`Village internal spike — blocked ${decision.reason}`);
      return;
    }
    window.setTitle(`Village internal spike — ${describeRoute(url)}`);
  };
  linkedin.webContents.on("will-navigate", enforceNavigation);
  linkedin.webContents.on("will-redirect", enforceNavigation);
  linkedin.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decidePopup(url);
    window.setTitle(`Village internal spike — blocked ${decision.action === "deny" ? decision.reason : "popup"}`);
    return { action: "deny" };
  });
  linkedin.webContents.on("did-navigate", (_event, url) => window.setTitle(`Village internal spike — ${describeRoute(url)}`));
  linkedin.webContents.on("did-fail-load", (_event, code, description) => {
    window.setTitle(`Village internal spike — load failed (${code}: ${description})`);
  });
  window.on("closed", () => {
    // BaseWindow does not destroy child WebContentsView contents automatically.
    if (!linkedin.webContents.isDestroyed()) linkedin.webContents.close();
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: "Compatibility Spike",
    submenu: [{
      label: "Confirm signed in (owner)",
      click: () => {
        const result = verifyAuthentication(linkedin.webContents.getURL(), true);
        window.setTitle(`Village internal spike — auth ${result.status} (${result.predicateVersion})`);
      },
    }],
  }]));

  void linkedin.webContents.loadURL(LINKEDIN_LOGIN_URL);
}

app.whenReady().then(async () => {
  const posture = evaluateProfilePosture({ encryptionAvailable: safeStorage.isEncryptionAvailable(), platform: process.platform });
  if (!posture.ok) {
    dialog.showErrorBox("Profile protection unavailable", posture.warning);
    app.quit();
    return;
  }
  try {
    await protectProfile();
  } catch {
    dialog.showErrorBox("Profile protection failed", "Could not apply private permissions and backup/indexing exclusions; LinkedIn view will not open.");
    app.quit();
    return;
  }
  const ownedFixtureUrl = process.env.VILLAGE_OWNED_FIXTURE_URL;
  if (ownedFixtureUrl) await createOwnedFixtureWindow(ownedFixtureUrl);
  else createLinkedInWindow();
});

app.on("window-all-closed", () => app.quit());
