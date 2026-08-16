import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  template: [] as Array<Record<string, unknown>>,
  menu: { kind: "menu" },
  setApplicationMenu: vi.fn(),
}));

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: vi.fn((template) => {
      electron.template = template;
      return electron.menu;
    }),
    setApplicationMenu: electron.setApplicationMenu,
  },
}));

import { installRitualBuilderMenu } from "../src/main/ritual-builder-menu.js";

describe("Ritual Builder application route", () => {
  beforeEach(() => {
    electron.template = [];
    vi.clearAllMocks();
  });

  it("exposes the Ritual Builder from the ordinary application menu", async () => {
    const open = vi.fn(async () => undefined);
    installRitualBuilderMenu(open);

    const village = electron.template[0] as {
      submenu: Array<{ label?: string; click?: () => void }>;
    };
    village.submenu
      .find((item) => item.label === "Open Ritual Builder")
      ?.click?.();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(electron.setApplicationMenu).toHaveBeenCalledWith(electron.menu);
  });
});
