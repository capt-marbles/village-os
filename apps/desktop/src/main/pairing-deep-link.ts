import {
  browserSessionIdSchema,
  deviceIdSchema,
  pairingIdSchema,
  principalIdSchema,
} from "@village/contracts";

export type PairingDeepLink =
  | {
      type: "COMPLETE_PAIRING";
      principalId: string;
      pairingId: string;
    }
  | {
      type: "ATTACH_SESSION";
      principalId: string;
      deviceId: string;
      browserSessionId: string;
    };

export function parsePairingDeepLink(value: string): PairingDeepLink | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "village-pair:") return null;
  if (url.username || url.password || url.port || url.hash) return null;
  if (url.host === "complete") {
    if (
      [...url.searchParams.keys()].some(
        (key) => !["principalId", "pairingId"].includes(key),
      )
    ) {
      return null;
    }
    const principalId = principalIdSchema.safeParse(
      url.searchParams.get("principalId"),
    );
    const pairingId = pairingIdSchema.safeParse(
      url.searchParams.get("pairingId"),
    );
    return principalId.success && pairingId.success
      ? {
          type: "COMPLETE_PAIRING",
          principalId: principalId.data,
          pairingId: pairingId.data,
        }
      : null;
  }
  if (url.host === "session") {
    if (
      [...url.searchParams.keys()].some(
        (key) => !["principalId", "deviceId", "browserSessionId"].includes(key),
      )
    ) {
      return null;
    }
    const principalId = principalIdSchema.safeParse(
      url.searchParams.get("principalId"),
    );
    const deviceId = deviceIdSchema.safeParse(url.searchParams.get("deviceId"));
    const browserSessionId = browserSessionIdSchema.safeParse(
      url.searchParams.get("browserSessionId"),
    );
    return principalId.success && deviceId.success && browserSessionId.success
      ? {
          type: "ATTACH_SESSION",
          principalId: principalId.data,
          deviceId: deviceId.data,
          browserSessionId: browserSessionId.data,
        }
      : null;
  }
  return null;
}

export class PairingDeepLinkInbox {
  private readonly queued: PairingDeepLink[] = [];
  private readonly waiters = new Map<
    PairingDeepLink["type"],
    Array<(value: PairingDeepLink) => void>
  >();

  accept(value: string): boolean {
    const parsed = parsePairingDeepLink(value);
    if (!parsed) return false;
    const waiter = this.waiters.get(parsed.type)?.shift();
    if (waiter) waiter(parsed);
    else this.queued.push(parsed);
    return true;
  }

  next<T extends PairingDeepLink["type"]>(
    type: T,
  ): Promise<Extract<PairingDeepLink, { type: T }>> {
    const index = this.queued.findIndex((value) => value.type === type);
    if (index >= 0) {
      return Promise.resolve(
        this.queued.splice(index, 1)[0] as Extract<
          PairingDeepLink,
          { type: T }
        >,
      );
    }
    return new Promise((resolve) => {
      const waiters = this.waiters.get(type) ?? [];
      waiters.push((value) =>
        resolve(value as Extract<PairingDeepLink, { type: T }>),
      );
      this.waiters.set(type, waiters);
    });
  }
}
