import { BaseWindow, WebContentsView, type WebContents } from "electron";
import { trustedWebPreferences } from "./security.js";

export interface RitualBuilderWindow {
  window: BaseWindow;
  trustedRenderer: WebContents;
}

export async function createRitualBuilderWindow(): Promise<RitualBuilderWindow> {
  const window = new BaseWindow({
    width: 1_280,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#101510",
    title: "Village · Ritual Builder",
    fullscreenable: false,
  });
  const appView = new WebContentsView({
    webPreferences: trustedWebPreferences(),
  });
  window.contentView.addChildView(appView);
  const layout = () => {
    const [width = 0, height = 0] = window.getContentSize();
    appView.setBounds({ x: 0, y: 0, width, height });
  };
  window.on("resize", layout);
  layout();
  window.on("close", () => {
    if (!appView.webContents.isDestroyed()) appView.webContents.close();
  });
  try {
    await appView.webContents.loadURL("village://app/?mode=ritual-builder");
  } catch (error) {
    window.destroy();
    throw error;
  }
  window.show();
  return { window, trustedRenderer: appView.webContents };
}
