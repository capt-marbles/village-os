import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  windows: [] as Array<{
    listeners: Map<string, () => void>;
    contentView: {
      addChildView: ReturnType<typeof vi.fn>;
      removeChildView: ReturnType<typeof vi.fn>;
    };
    destroy: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
  }>,
  views: [] as Array<{
    setBounds: ReturnType<typeof vi.fn>;
    webContents: {
      close: ReturnType<typeof vi.fn>;
      isDestroyed: ReturnType<typeof vi.fn>;
      loadURL: ReturnType<typeof vi.fn>;
    };
  }>,
  loadError: null as Error | null,
}));

vi.mock("electron", () => {
  class BaseWindow {
    readonly listeners = new Map<string, () => void>();
    readonly contentView = {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    };
    readonly destroy = vi.fn();
    readonly show = vi.fn();
    constructor(_options: object) {
      electron.windows.push(this);
    }
    getContentSize() {
      return [1_280, 800];
    }
    on(event: string, listener: () => void) {
      this.listeners.set(event, listener);
    }
  }

  class WebContentsView {
    readonly setBounds = vi.fn();
    readonly webContents = {
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
      loadURL: vi.fn(async () => {
        if (electron.loadError) throw electron.loadError;
      }),
    };
    constructor(_options: object) {
      electron.views.push(this);
    }
  }

  return { BaseWindow, WebContentsView };
});

import { createRitualBuilderWindow } from "../src/main/ritual-builder-window.js";

describe("Ritual Builder window", () => {
  beforeEach(() => {
    electron.windows.length = 0;
    electron.views.length = 0;
    electron.loadError = null;
  });

  it("shows after load and disposes the child view exactly once", async () => {
    await createRitualBuilderWindow();
    const window = electron.windows[0]!;
    const view = electron.views[0]!;

    expect(view.webContents.loadURL).toHaveBeenCalledWith(
      "village://app/?mode=ritual-builder",
    );
    expect(window.show).toHaveBeenCalledOnce();
    window.listeners.get("close")?.();
    window.listeners.get("close")?.();
    expect(window.contentView.removeChildView).toHaveBeenCalledOnce();
    expect(view.webContents.close).toHaveBeenCalledOnce();
  });

  it("disposes and destroys the window when loading fails", async () => {
    electron.loadError = new Error("renderer failed");
    await expect(createRitualBuilderWindow()).rejects.toThrow(
      "renderer failed",
    );
    const window = electron.windows[0]!;
    const view = electron.views[0]!;

    expect(window.contentView.removeChildView).toHaveBeenCalledOnce();
    expect(view.webContents.close).toHaveBeenCalledOnce();
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(window.show).not.toHaveBeenCalled();
  });
});
