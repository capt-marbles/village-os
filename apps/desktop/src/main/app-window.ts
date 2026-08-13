import { join } from "node:path";
import {
  BaseWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  WebContentsView,
} from "electron";
import { LocalActionExecutor } from "../browser/local-action-executor.js";
import {
  LocalBrowserHost,
  type BrowserSite,
} from "../browser/local-browser-host.js";
import {
  BrowserViewportCoordinator,
  type NativeBrowserView,
} from "./browser-viewport-coordinator.js";
import { SensitiveActionAuthorizer } from "./sensitive-action-authorizer.js";
import { isTrustedVillageSender, trustedWebPreferences } from "./security.js";

export interface VillageAppWindowOptions {
  principalId: string;
  deviceId: string;
  browserSessionId: string;
  site: BrowserSite;
  initialUrl: string;
  userDataPath: string;
  preloadPath: string;
}

export interface VillageAppWindow {
  window: BaseWindow;
  browserHost: LocalBrowserHost;
  viewport: BrowserViewportCoordinator;
}

function browserViewAdapter(
  window: BaseWindow,
  browserHost: LocalBrowserHost,
  inputShield: WebContentsView,
): NativeBrowserView {
  return {
    setBounds: (bounds) => {
      browserHost.view.setBounds(bounds);
      inputShield.setBounds(bounds);
    },
    setVisible: (visible) => {
      browserHost.view.setVisible(visible);
      if (!visible) inputShield.setVisible(false);
    },
    setInputEnabled: (enabled) => inputShield.setVisible(!enabled),
    focus: () => browserHost.view.webContents.focus(),
    destroy: () => {
      window.contentView.removeChildView(inputShield);
      window.contentView.removeChildView(browserHost.view);
      if (!inputShield.webContents.isDestroyed())
        inputShield.webContents.close();
    },
  };
}

export async function createVillageAppWindow(
  options: VillageAppWindowOptions,
): Promise<VillageAppWindow> {
  const window = new BaseWindow({
    width: 1_280,
    height: 800,
    minWidth: 840,
    minHeight: 560,
    backgroundColor: "#101410",
    title: "Village",
    fullscreenable: false,
  });
  const appView = new WebContentsView({
    webPreferences: trustedWebPreferences(options.preloadPath),
  });
  const inputShield = new WebContentsView({
    webPreferences: trustedWebPreferences(),
  });
  inputShield.setBackgroundColor("#00000000");
  const appLoad = appView.webContents.loadURL("village://app/");
  const shieldLoad = inputShield.webContents.loadURL("village://app/shield");
  let browserHost: LocalBrowserHost | undefined;
  try {
    browserHost = await LocalBrowserHost.create({
      principalId: options.principalId,
      deviceId: options.deviceId,
      site: options.site,
      profileRoot: LocalBrowserHost.profileRoot(options.userDataPath),
      initialUrl: options.initialUrl,
    });
    await Promise.all([appLoad, shieldLoad]);
  } catch (error) {
    await Promise.allSettled([appLoad, shieldLoad]);
    await browserHost?.close();
    if (!appView.webContents.isDestroyed()) appView.webContents.close();
    if (!inputShield.webContents.isDestroyed()) inputShield.webContents.close();
    window.destroy();
    throw error;
  }
  if (!browserHost) throw new Error("BROWSER_HOST_CREATION_FAILED");
  const viewport = new BrowserViewportCoordinator(
    browserViewAdapter(window, browserHost, inputShield),
  );
  viewport.configure({ splitRatio: 0.42, topInset: 0, minWidth: 360 });

  window.contentView.addChildView(appView);
  window.contentView.addChildView(browserHost.view);
  window.contentView.addChildView(inputShield);

  const layout = () => {
    const size = window.getContentSize();
    const width = size[0] ?? 0;
    const height = size[1] ?? 0;
    appView.setBounds({ x: 0, y: 0, width, height });
    viewport.layout({ width, height });
  };
  window.on("resize", layout);
  layout();

  const authorizer = new SensitiveActionAuthorizer();
  const executor = new LocalActionExecutor({ leaseEpoch: 1 });
  let takeoverCompleted = false;
  const channel = "village:request-takeover";
  const handleTakeover = async (
    event: IpcMainInvokeEvent,
    ...arguments_: unknown[]
  ) => {
    if (
      event.sender !== appView.webContents ||
      !isTrustedVillageSender(event.sender)
    ) {
      throw new Error("UNTRUSTED_IPC_SENDER");
    }
    if (arguments_.length !== 0) throw new Error("MALFORMED_IPC_REQUEST");
    if (takeoverCompleted) return "QUIESCED" as const;
    const response = await dialog.showMessageBox({
      type: "question",
      title: "Take control of this browser?",
      message:
        "Village will stop automated browser actions before enabling input.",
      buttons: ["Take control", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response.response !== 0) return "DECLINED" as const;
    const binding = {
      principalId: options.principalId,
      deviceId: options.deviceId,
      browserSessionId: options.browserSessionId,
      operation: "TAKEOVER" as const,
    };
    const authorization = authorizer.mint(binding, 15_000);
    const consumed = authorizer.consume(authorization.token, binding);
    if (!consumed.ok) throw new Error(consumed.code);

    viewport.beginTakeover();
    try {
      const outcome = await executor.beginOnlineTakeover(2, 5_000);
      if (outcome.status === "OUTCOME_UNKNOWN") {
        await browserHost.reloadAfterUncertainAction();
      }
      takeoverCompleted = true;
      viewport.acknowledgeTakeover();
      return outcome.status;
    } catch (error) {
      viewport.cancelTakeover();
      throw error;
    }
  };
  ipcMain.handle(channel, handleTakeover);

  let closing = false;
  window.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    ipcMain.removeHandler(channel);
    viewport.destroy();
    if (!appView.webContents.isDestroyed()) appView.webContents.close();
    void browserHost.close().finally(() => window.destroy());
  });
  window.show();
  return { window, browserHost, viewport };
}

export function defaultPreloadPath(appPath: string): string {
  return join(appPath, "dist", "preload", "village-bridge.cjs");
}
