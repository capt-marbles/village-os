import {
  BaseWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  WebContentsView,
} from "electron";
import type { PairingBootstrapService } from "./pairing-bootstrap.js";
import type { PairingDeepLinkInbox } from "./pairing-deep-link.js";
import type { RuntimeIdentity } from "./runtime-identity.js";
import { isTrustedVillageSender, trustedWebPreferences } from "./security.js";

export interface PairingWindowOptions {
  preloadPath: string;
  service: PairingBootstrapService;
  inbox: PairingDeepLinkInbox;
}

export async function createPairingWindow(
  options: PairingWindowOptions,
): Promise<RuntimeIdentity> {
  const window = new BaseWindow({
    width: 820,
    height: 720,
    minWidth: 620,
    minHeight: 540,
    backgroundColor: "#101410",
    title: "Pair Village Desktop",
    fullscreenable: false,
  });
  const appView = new WebContentsView({
    webPreferences: trustedWebPreferences(options.preloadPath),
  });
  window.contentView.addChildView(appView);
  const layout = () => {
    const size = window.getContentSize();
    const width = size[0] ?? 0;
    const height = size[1] ?? 0;
    appView.setBounds({ x: 0, y: 0, width, height });
  };
  window.on("resize", layout);
  layout();

  const requestChannel = "village:get-pairing-request";
  const assertTrusted = (event: IpcMainInvokeEvent, arguments_: unknown[]) => {
    if (
      event.sender !== appView.webContents ||
      !isTrustedVillageSender(event.sender) ||
      arguments_.length !== 0
    ) {
      throw new Error("UNTRUSTED_IPC_SENDER");
    }
  };
  ipcMain.handle(requestChannel, (event, ...arguments_) => {
    assertTrusted(event, arguments_);
    return options.service.request();
  });

  let completed = false;
  let resolveIdentity!: (identity: RuntimeIdentity) => void;
  let rejectIdentity!: (error: Error) => void;
  const identity = new Promise<RuntimeIdentity>((resolve, reject) => {
    resolveIdentity = resolve;
    rejectIdentity = reject;
  });
  const publish = (state: string) => {
    if (!appView.webContents.isDestroyed()) {
      appView.webContents.send("village:pairing-state", state);
    }
  };
  const cleanup = () => {
    ipcMain.removeHandler(requestChannel);
    if (!appView.webContents.isDestroyed()) appView.webContents.close();
  };
  window.on("closed", () => {
    cleanup();
    if (!completed) rejectIdentity(new Error("PAIRING_CANCELED"));
  });

  await appView.webContents.loadURL("village://app/?mode=pairing");
  window.show();

  void (async () => {
    let paired: { principalId: string; deviceId: string } | undefined;
    while (!paired && !window.isDestroyed()) {
      const completion = await options.inbox.next("COMPLETE_PAIRING");
      try {
        paired = await options.service.complete(completion);
        publish("WAITING_FOR_SESSION");
      } catch (error) {
        publish(
          error instanceof Error && error.message.includes("EXPIRED")
            ? "EXPIRED"
            : "REJECTED",
        );
      }
    }
    while (paired && !window.isDestroyed()) {
      const attachment = await options.inbox.next("ATTACH_SESSION");
      try {
        const result = await options.service.attachSession(attachment);
        completed = true;
        publish("PAIRED");
        resolveIdentity(result);
        setTimeout(() => {
          if (!window.isDestroyed()) window.close();
        }, 0);
        return;
      } catch {
        publish("REJECTED");
      }
    }
  })().catch((error: unknown) => {
    if (!completed) {
      rejectIdentity(
        error instanceof Error ? error : new Error("PAIRING_FAILED"),
      );
    }
  });

  return identity;
}
