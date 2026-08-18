import type { GmailCredentialOperations } from "../gmail/gmail-oauth-controller.js";

export interface RitualShutdownServices {
  scheduler: { close(): Promise<void> };
  controller: { close(): Promise<void> };
  gmailCredentials: Pick<GmailCredentialOperations, "close">;
}

export function createRitualShutdownHandler(
  application: { quit(): void },
  current: () => RitualShutdownServices | undefined,
  clear: () => void,
): (event: { preventDefault(): void }) => void {
  let shutdown: Promise<void> | undefined;
  let complete = false;
  return (event) => {
    if (complete) return;
    const active = current();
    if (!active) {
      complete = true;
      return;
    }
    event.preventDefault();
    if (shutdown) return;
    clear();
    shutdown = active.scheduler
      .close()
      .then(() => active.controller.close())
      .then(() => active.gmailCredentials.close())
      .catch(() => undefined)
      .then(() => {
        complete = true;
        application.quit();
      });
  };
}
