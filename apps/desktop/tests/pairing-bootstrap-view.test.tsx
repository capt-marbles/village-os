import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PairingBootstrap,
  pairingFingerprint,
} from "../src/renderer/PairingBootstrap.js";

describe("pairing bootstrap view", () => {
  it("uses the same public-key fingerprint as the control plane", async () => {
    await expect(
      pairingFingerprint({ kty: "OKP", crv: "Ed25519", x: "cHVibGljX2tleQ" }),
    ).resolves.toBe("KTFN3UR3Z9WPRM_I");
  });

  it("explains the external confirmation without accepting a secret", () => {
    const html = renderToStaticMarkup(<PairingBootstrap />);
    expect(html).toContain("Pair this Mac");
    expect(html).toContain("one-time secret never");
    expect(html).not.toContain("textarea");
    expect(html).not.toContain('type="password"');
  });
});
