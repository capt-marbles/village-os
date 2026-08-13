import { describe, expect, it } from "vitest";
import { SensitiveActionAuthorizer } from "../src/main/sensitive-action-authorizer.js";

const binding = {
  principalId: "usr_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  browserSessionId: "bsn_01J00000000000000000000000",
  operation: "TAKEOVER" as const,
};

describe("sensitive action authorization", () => {
  it("consumes an exact operation-bound authorization only once", () => {
    let now = 1_000;
    const authorizer = new SensitiveActionAuthorizer(() => now);
    const authorization = authorizer.mint(binding, 5_000);

    expect(authorizer.consume(authorization.token, binding)).toEqual({
      ok: true,
    });
    expect(authorizer.consume(authorization.token, binding)).toEqual({
      ok: false,
      code: "AUTHORIZATION_REPLAYED",
    });
    now += 10_000;
  });

  it.each([
    ["principalId", "usr_01J00000000000000000000001"],
    ["deviceId", "dev_01J00000000000000000000001"],
    ["browserSessionId", "bsn_01J00000000000000000000001"],
    ["operation", "FORGET_SESSION"],
  ] as const)("rejects a wrong %s binding", (key, value) => {
    const authorizer = new SensitiveActionAuthorizer(() => 1_000);
    const authorization = authorizer.mint(binding, 5_000);
    expect(
      authorizer.consume(authorization.token, { ...binding, [key]: value }),
    ).toEqual({ ok: false, code: "AUTHORIZATION_BINDING_MISMATCH" });
  });

  it("rejects an expired authorization", () => {
    let now = 1_000;
    const authorizer = new SensitiveActionAuthorizer(() => now);
    const authorization = authorizer.mint(binding, 1_000);
    now = 2_001;
    expect(authorizer.consume(authorization.token, binding)).toEqual({
      ok: false,
      code: "AUTHORIZATION_EXPIRED",
    });
  });
});
