import { describe, expect, it } from "vitest";
import { villageIdentitySessionSchema } from "../village-identity.js";

describe("Village Identity session", () => {
  it("accepts one authenticated principal without exposing provider tokens", () => {
    expect(
      villageIdentitySessionSchema.parse({
        authenticated: true,
        principalId: "prn_01J00000000000000000000000",
        provider: "CLOUDFLARE_ACCESS",
        email: "owner@example.com",
        signOutPath: "/cdn-cgi/access/logout",
      }),
    ).toEqual({
      authenticated: true,
      principalId: "prn_01J00000000000000000000000",
      provider: "CLOUDFLARE_ACCESS",
      email: "owner@example.com",
      signOutPath: "/cdn-cgi/access/logout",
    });

    expect(
      villageIdentitySessionSchema.safeParse({
        authenticated: true,
        principalId: "prn_01J00000000000000000000000",
        provider: "CLOUDFLARE_ACCESS",
        email: "owner@example.com",
        signOutPath: "/cdn-cgi/access/logout",
        accessToken: "must-not-cross-boundary",
      }).success,
    ).toBe(false);
  });
});
