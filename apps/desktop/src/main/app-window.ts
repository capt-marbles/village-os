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
): NativeBrowserView {
  return {
    setBounds: (bounds) => browserHost.view.setBounds(bounds),
    setVisible: (visible) => browserHost.view.setVisible(visible),
    setInputEnabled: (enabled) => browserHost.view.setVisible(enabled),
    focus: () => browserHost.view.webContents.focus(),
    destroy: () => window.contentView.removeChildView(browserHost.view),
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
  const browserHost = await LocalBrowserHost.create({
    principalId: options.principalId,
    deviceId: options.deviceId,
    site: options.site,
    profileRoot: LocalBrowserHost.profileRoot(options.userDataPath),
    initialUrl: options.initialUrl,
  });
  const viewport = new BrowserViewportCoordinator(
    browserViewAdapter(window, browserHost),
  );
  viewport.configure({ splitRatio: 0.42, topInset: 0, minWidth: 360 });

  window.contentView.addChildView(appView);
  window.contentView.addChildView(browserHost.view);

  const layout = () => {
    const size = window.getContentSize();
    const width = size[0] ?? 0;
    const height = size[1] ?? 0;
    appView.setBounds({ x: 0, y: 0, width, height });
    viewport.layout({ width, height });
  };
  window.on("resize", layout);
  layout();
  await appView.webContents.loadURL("village://app/");

  const authorizer = new SensitiveActionAuthorizer();
  const executor = new LocalActionExecutor({ leaseEpoch: 1 });
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
    const outcome = await executor.beginOnlineTakeover(2, 5_000);
    if (outcome.status === "OUTCOME_UNKNOWN") {
      browserHost.view.webContents.reload();
    }
    viewport.acknowledgeTakeover();
    return outcome.status;
  };
  ipcMain.handle(channel, handleTakeover);

  window.on("closed", () => {
    ipcMain.removeHandler(channel);
    viewport.destroy();
    if (!appView.webContents.isDestroyed()) appView.webContents.close();
    void browserHost.close();
  });
  window.show();
  return { window, browserHost, viewport };
}

export function defaultPreloadPath(appPath: string): string {
  return join(appPath, "dist", "preload", "village-bridge.cjs");
}
