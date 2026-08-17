import { describe, expect, it } from "vitest";
import {
  VILLAGE_UPDATE_ARTIFACT_BASE_URL,
  VILLAGE_UPDATE_ENDPOINT,
  parseUpdateManifest,
  validateUpdateCandidate,
  type UpdateTrustPolicy,
} from "../src/main/updater.js";

const trustedPolicy: UpdateTrustPolicy = {
  productId: "com.village.desktop",
  channel: "alpha",
  endpoint: VILLAGE_UPDATE_ENDPOINT,
  signerSha256:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

const trustedCandidate = {
  productId: "com.village.desktop",
  channel: "alpha",
  version: "1.1.0-alpha.1",
  requestedUrl: VILLAGE_UPDATE_ENDPOINT,
  finalUrl: VILLAGE_UPDATE_ENDPOINT,
  signerSha256: trustedPolicy.signerSha256,
  expectedSha512: "a".repeat(128),
  downloadedSha512: "a".repeat(128),
  artifactRequestedUrl: `${VILLAGE_UPDATE_ARTIFACT_BASE_URL}village-1.1.0-alpha.1-arm64.zip`,
  artifactFinalUrl: `${VILLAGE_UPDATE_ARTIFACT_BASE_URL}village-1.1.0-alpha.1-arm64.zip`,
};

describe("desktop update trust policy", () => {
  it("accepts a newer artifact matching every pinned release attribute", () => {
    expect(
      validateUpdateCandidate(trustedPolicy, "1.0.0", trustedCandidate),
    ).toEqual({ ok: true, version: "1.1.0-alpha.1" });
  });

  it.each([
    [
      "product mismatch",
      { productId: "com.attacker.desktop" },
      "PRODUCT_MISMATCH",
    ],
    ["channel mismatch", { channel: "latest" }, "CHANNEL_MISMATCH"],
    [
      "unpinned endpoint",
      { requestedUrl: "https://mirror.invalid/manifest.json" },
      "ENDPOINT_MISMATCH",
    ],
    [
      "redirect",
      { finalUrl: "https://cdn.invalid/manifest.json" },
      "REDIRECT_DENIED",
    ],
    [
      "artifact outside the pinned release directory",
      { artifactRequestedUrl: "https://cdn.invalid/village.zip" },
      "ARTIFACT_ENDPOINT_MISMATCH",
    ],
    [
      "artifact redirect",
      {
        artifactFinalUrl: `${VILLAGE_UPDATE_ARTIFACT_BASE_URL}redirected.zip`,
      },
      "ARTIFACT_REDIRECT_DENIED",
    ],
    ["wrong signer", { signerSha256: "f".repeat(64) }, "SIGNER_MISMATCH"],
    [
      "tampered artifact",
      { downloadedSha512: "b".repeat(128) },
      "CHECKSUM_MISMATCH",
    ],
    ["same version", { version: "1.0.0" }, "VERSION_NOT_NEWER"],
    ["downgrade", { version: "0.9.9" }, "VERSION_NOT_NEWER"],
    ["invalid version", { version: "next" }, "INVALID_UPDATE_METADATA"],
  ])("rejects %s", (_label, override, code) => {
    expect(
      validateUpdateCandidate(trustedPolicy, "1.0.0", {
        ...trustedCandidate,
        ...override,
      }),
    ).toEqual({ ok: false, code });
  });

  it("rejects release policy that is not the compiled Village product, channel and endpoint", () => {
    expect(
      validateUpdateCandidate(
        { ...trustedPolicy, endpoint: "https://mirror.invalid/manifest.json" },
        "1.0.0",
        trustedCandidate,
      ),
    ).toEqual({ ok: false, code: "INVALID_TRUST_POLICY" });
  });

  it("fails closed on malformed manifest input", () => {
    expect(validateUpdateCandidate(trustedPolicy, "1.0.0", null)).toEqual({
      ok: false,
      code: "INVALID_UPDATE_METADATA",
    });
  });

  it("parses only the bounded Village manifest shape", () => {
    expect(
      parseUpdateManifest({
        productId: "com.village.desktop",
        channel: "alpha",
        version: "1.1.0-alpha.1",
        artifactUrl: `${VILLAGE_UPDATE_ARTIFACT_BASE_URL}village-1.1.0-alpha.1-arm64.zip`,
        sha512: "a".repeat(128),
      }),
    ).toEqual({
      productId: "com.village.desktop",
      channel: "alpha",
      version: "1.1.0-alpha.1",
      artifactUrl: `${VILLAGE_UPDATE_ARTIFACT_BASE_URL}village-1.1.0-alpha.1-arm64.zip`,
      sha512: "a".repeat(128),
    });
    expect(
      parseUpdateManifest({
        productId: "com.village.desktop",
        channel: "alpha",
        version: "1.1.0-alpha.1",
        artifactUrl: `${VILLAGE_UPDATE_ARTIFACT_BASE_URL}village-1.1.0-alpha.1-arm64.zip`,
        sha512: "a".repeat(128),
        releaseNotes: "unbounded prose is not part of the trust boundary",
      }),
    ).toBeUndefined();
  });
});
