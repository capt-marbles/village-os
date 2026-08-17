import { Menu } from "electron";

export function installRitualBuilderMenu(
  openRitualBuilder: () => Promise<void>,
) {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Village",
        submenu: [
          {
            label: "Open Steward",
            accelerator: "CmdOrCtrl+Shift+R",
            click: () => void openRitualBuilder(),
          },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]),
  );
}
