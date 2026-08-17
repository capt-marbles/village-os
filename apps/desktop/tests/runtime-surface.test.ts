import { describe, expect, it } from "vitest";
import {
  activateRuntimeSurface,
  resolveRuntimeSurface,
} from "../src/main/runtime-surface.js";

const pairingLink =
  "village-pair://complete?principalId=prn_01J00000000000000000000000&pairingId=par_01J00000000000000000000000";

describe("runtime surface", () => {
  it("opens the Steward workspace by default and keeps the browser explicit", () => {
    expect(resolveRuntimeSurface(["Village"])).toBe("RITUAL_BUILDER");
    expect(resolveRuntimeSurface(["Village", "--ritual-builder"])).toBe(
      "RITUAL_BUILDER",
    );
    expect(resolveRuntimeSurface(["Village", "--browser-workspace"])).toBe(
      "WORKSPACE",
    );
    expect(resolveRuntimeSurface(["Village", "--browser-workspace-evil"])).toBe(
      "RITUAL_BUILDER",
    );
  });

  it("opens the browser workspace for a valid cold-launch pairing link", () => {
    expect(resolveRuntimeSurface(["Village", pairingLink])).toBe("WORKSPACE");
    expect(
      resolveRuntimeSurface(["Village", "village-pair://complete?bad=1"]),
    ).toBe("RITUAL_BUILDER");
  });

  it("forwards a pairing link that activates an already-running app", () => {
    const accepted: string[] = [];
    let opened = 0;

    expect(
      activateRuntimeSurface(["Village", pairingLink], {
        acceptPairingLink: (value) => accepted.push(value),
        openWorkspace: () => {
          opened += 1;
        },
      }),
    ).toBe(true);
    expect(accepted).toEqual([pairingLink]);
    expect(opened).toBe(1);

    expect(
      activateRuntimeSurface(["Village", "village-pair://complete?bad=1"], {
        acceptPairingLink: (value) => accepted.push(value),
        openWorkspace: () => {
          opened += 1;
        },
      }),
    ).toBe(false);
    expect(accepted).toEqual([pairingLink]);
    expect(opened).toBe(1);
  });
});
