import { describe, expect, it } from "vitest";
import {
  PairingDeepLinkInbox,
  parsePairingDeepLink,
} from "../src/main/pairing-deep-link.js";

describe("pairing deep links", () => {
  it("parses only the two closed pairing operations", () => {
    expect(
      parsePairingDeepLink(
        "village-pair://complete?principalId=prn_01J00000000000000000000000&pairingId=par_01J00000000000000000000000",
      ),
    ).toMatchObject({ type: "COMPLETE_PAIRING" });
    expect(
      parsePairingDeepLink(
        "village-pair://session?principalId=prn_01J00000000000000000000000&deviceId=dev_01J00000000000000000000000&browserSessionId=brs_01J00000000000000000000000&fixtureBrowserSessionId=brs_01J00000000000000000000001",
      ),
    ).toMatchObject({
      type: "ATTACH_SESSION",
      browserSessionId: "brs_01J00000000000000000000000",
      fixtureBrowserSessionId: "brs_01J00000000000000000000001",
    });
    expect(parsePairingDeepLink("https://evil.example/")).toBeNull();
    expect(
      parsePairingDeepLink("village-pair://complete?pairingId=short"),
    ).toBeNull();
    expect(
      parsePairingDeepLink(
        "village-pair://session?principalId=prn_01J00000000000000000000000&deviceId=dev_01J00000000000000000000000&browserSessionId=brs_01J00000000000000000000000",
      ),
    ).toEqual({
      type: "ATTACH_SESSION",
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
    });
    expect(
      parsePairingDeepLink(
        "village-pair://session?principalId=prn_01J00000000000000000000000&deviceId=dev_01J00000000000000000000000&browserSessionId=brs_01J00000000000000000000000&fixtureBrowserSessionId=brs_01J00000000000000000000000",
      ),
    ).toBeNull();
    expect(
      parsePairingDeepLink(
        "village-pair://session?principalId=prn_01J00000000000000000000000&deviceId=dev_01J00000000000000000000000&browserSessionId=brs_01J00000000000000000000000&fixtureBrowserSessionId=",
      ),
    ).toBeNull();
  });

  it("queues a link that arrives before the bootstrap waits for it", async () => {
    const inbox = new PairingDeepLinkInbox();
    inbox.accept(
      "village-pair://complete?principalId=prn_01J00000000000000000000000&pairingId=par_01J00000000000000000000000",
    );
    await expect(inbox.next("COMPLETE_PAIRING")).resolves.toMatchObject({
      type: "COMPLETE_PAIRING",
    });
  });
});
