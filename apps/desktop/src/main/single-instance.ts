import type { App } from "electron";

export function claimVillageInstance(
  app: Pick<App, "quit" | "requestSingleInstanceLock">,
) {
  if (app.requestSingleInstanceLock()) return true;
  app.quit();
  return false;
}
