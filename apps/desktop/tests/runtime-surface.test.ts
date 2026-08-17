import { describe, expect, it } from "vitest";
import { activateRuntimeSurface } from "../src/main/runtime-surface.js";

const pairingLink =
  "village-pair://complete?principalId=prn_01J00000000000000000000000&pairingId=par_01J00000000000000000000000";

describe("runtime surface", () => {
  it("opens the Steward workspace by default and keeps the browser explicit", () => {
    const actions = {
      acceptPairingLink: () => false,
      openBrowserWorkspace: () => undefined,
    };
    expect(activateRuntimeSurface(["Village"], actions)).toBe(false);
    expect(
      activateRuntimeSurface(["Village", "--browser-workspace"], actions),
    ).toBe(true);
    expect(
      activateRuntimeSurface(["Village", "--browser-workspace-evil"], actions),
    ).toBe(false);
  });

  it("opens the browser workspace for a valid cold-launch pairing link", () => {
    const acceptPairingLink = (value: string) => value === pairingLink;
    expect(
      activateRuntimeSurface(["Village", pairingLink], {
        acceptPairingLink,
        openBrowserWorkspace: () => undefined,
      }),
    ).toBe(true);
    expect(
      activateRuntimeSurface(["Village", "village-pair://complete?bad=1"], {
        acceptPairingLink,
        openBrowserWorkspace: () => undefined,
      }),
    ).toBe(false);
  });

  it("forwards a pairing link that activates an already-running app", () => {
    const accepted: string[] = [];
    let opened = 0;
    const actions = {
      acceptPairingLink: (value: string) => {
        if (value !== pairingLink) return false;
        accepted.push(value);
        return true;
      },
      openBrowserWorkspace: () => {
        opened += 1;
      },
    };

    expect(activateRuntimeSurface(["Village", pairingLink], actions)).toBe(
      true,
    );
    expect(accepted).toEqual([pairingLink]);
    expect(opened).toBe(1);

    expect(
      activateRuntimeSurface(
        ["Village", "village-pair://complete?bad=1"],
        actions,
      ),
    ).toBe(false);
    expect(accepted).toEqual([pairingLink]);
    expect(opened).toBe(1);
  });
});
