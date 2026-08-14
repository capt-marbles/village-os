import { describe, expect, it } from "vitest";
import {
  OWNED_FIXTURE_ORIGIN,
  type OwnedFixtureSetupCommand,
} from "@village/contracts";
import { renderOwnedFixtureAccount } from "../account.js";
import {
  FixtureServiceError,
  LocalOwnedFixtureService,
  type FixtureCallBinding,
  type LocalOwnedFixtureServiceOptions,
} from "../local-service.js";
import { createOwnedFixtureRequestHandler } from "../request-handler.js";
import { desiredProfileSpec, setupFixtureVariants } from "../setup.js";

const binding = {
  principalId: "prn_01J00000000000000000000000",
  jobId: "job_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
  sessionKind: "OWNED_FIXTURE",
} as const satisfies FixtureCallBinding;

const effects = {
  display: "efx_01J00000000000000000000001",
  role: "efx_01J00000000000000000000002",
  focus: "efx_01J00000000000000000000003",
  finalize: "efx_01J00000000000000000000004",
  reset: "efx_01J00000000000000000000005",
  read: "efx_01J00000000000000000000006",
  ambiguous: "efx_01J00000000000000000000007",
} as const;

const effectGrants = [
  { effectId: effects.display, logicalStep: "SET_DISPLAY_NAME" },
  { effectId: effects.role, logicalStep: "SELECT_ROLE" },
  { effectId: effects.focus, logicalStep: "SET_PREFERRED_FOCUS" },
  { effectId: effects.finalize, logicalStep: "FINALIZE_SETUP" },
  { effectId: effects.reset, logicalStep: "RESET" },
  { effectId: effects.read, logicalStep: "SET_DISPLAY_NAME" },
  { effectId: effects.ambiguous, logicalStep: "SELECT_ROLE" },
] as const;

function createService(options: Partial<LocalOwnedFixtureServiceOptions> = {}) {
  return new LocalOwnedFixtureService(binding, { effectGrants, ...options });
}

function operation(
  logicalStep:
    | "SET_DISPLAY_NAME"
    | "SELECT_ROLE"
    | "SET_PREFERRED_FOCUS"
    | "FINALIZE_SETUP",
  effectId: string,
  capability: OwnedFixtureSetupCommand["capability"],
) {
  return { ...binding, logicalStep, effectId, capability };
}

async function completeFields(service: LocalOwnedFixtureService) {
  await service.execute(
    operation("SET_DISPLAY_NAME", effects.display, "REPLACE_DISPLAY_NAME"),
  );
  await service.execute(operation("SELECT_ROLE", effects.role, "SELECT_ROLE"));
  await service.execute(
    operation("SET_PREFERRED_FOCUS", effects.focus, "REPLACE_PREFERRED_FOCUS"),
  );
}

describe("owned fixture setup service", () => {
  it("starts fresh and exposes only versioned bounded predicates", async () => {
    const service = createService();
    const observation = await service.observe({
      ...binding,
      logicalStep: "SET_DISPLAY_NAME",
      effectId: effects.read,
    });

    expect(observation).toEqual({
      schemaVersion: 1,
      source: "BROWSER_UNTRUSTED",
      workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
      workflowVersion: 1,
      logicalStep: "SET_DISPLAY_NAME",
      effectId: effects.read,
      predicateIds: ["setup-display-name-v1", "setup-human-gate-v1"],
      facts: [
        { id: "DISPLAY_NAME_MATCH", value: "MISSING" },
        { id: "HUMAN_GATE", value: "NONE" },
      ],
    });
    expect(JSON.stringify(observation)).not.toContain(
      desiredProfileSpec.displayName,
    );
    expect(
      service.profileSnapshot({ ...binding, effectId: effects.read }),
    ).toEqual({
      presentFields: [],
      finalized: false,
    });
  });

  it("resolves every semantic field value locally and proves its postcondition", async () => {
    const service = createService();
    for (const [logicalStep, effectId, capability, factId] of [
      [
        "SET_DISPLAY_NAME",
        effects.display,
        "REPLACE_DISPLAY_NAME",
        "DISPLAY_NAME_MATCH",
      ],
      ["SELECT_ROLE", effects.role, "SELECT_ROLE", "ROLE_MATCH"],
      [
        "SET_PREFERRED_FOCUS",
        effects.focus,
        "REPLACE_PREFERRED_FOCUS",
        "PREFERRED_FOCUS_MATCH",
      ],
    ] as const) {
      const result = await service.execute(
        operation(logicalStep, effectId, capability),
      );
      expect(result).toMatchObject({
        status: "APPLIED",
        logicalStep,
        effectId,
        postcondition: "SATISFIED",
      });
      expect(JSON.stringify(result)).not.toContain(
        desiredProfileSpec[
          logicalStep === "SET_DISPLAY_NAME"
            ? "displayName"
            : logicalStep === "SELECT_ROLE"
              ? "role"
              : "preferredFocus"
        ],
      );
      const verified = await service.verify({
        ...binding,
        logicalStep,
        effectId,
      });
      expect(verified.facts).toContainEqual({ id: factId, value: "MATCH" });
    }
  });

  it("keeps multi-option choices semantic across layout variants", () => {
    expect(desiredProfileSpec.roleOptions).toHaveLength(2);
    expect(desiredProfileSpec.focusOptions).toHaveLength(2);
    const safeVariants = setupFixtureVariants.filter(
      (variant) => variant.humanGate === "NONE",
    );
    const rendered = safeVariants.map((variant) =>
      renderOwnedFixtureAccount({
        variant,
        profile: { presentFields: [], finalized: false },
      }),
    );
    expect(new Set(safeVariants.map((variant) => variant.layout))).toEqual(
      new Set(["STACKED", "SPLIT", "COMPACT"]),
    );
    for (const html of rendered) {
      expect(html).toContain('data-action="SELECT_ROLE"');
      expect(html).toContain('data-action="VERIFY_SETUP"');
      expect(html).not.toContain("selector=");
      expect(html).not.toContain("Runtime.evaluate");
    }
  });

  it("returns the original singleton finalization result on exact replay", async () => {
    const service = createService({
      createFinalizationId: () => "local-finalization-1",
    });
    await completeFields(service);
    const request = operation(
      "FINALIZE_SETUP",
      effects.finalize,
      "FINALIZE_SETUP",
    );
    const incomplete = createService({
      createFinalizationId: () => "local-finalization-incomplete",
    });
    await expect(incomplete.execute(request)).rejects.toMatchObject({
      code: "PROFILE_INCOMPLETE",
    });
    const first = await service.execute(request);
    const replay = await service.execute(request);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(service.execute(request)).resolves.toEqual(first);
    }

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: "FINALIZED",
      effectId: effects.finalize,
      finalizationId: "local-finalization-1",
      postcondition: "SATISFIED",
    });
    expect(
      service.profileSnapshot({ ...binding, effectId: effects.read }),
    ).toEqual({
      presentFields: ["DISPLAY_NAME", "ROLE", "PREFERRED_FOCUS"],
      finalized: true,
    });
    expect(
      (await service.attempts({ ...binding, effectId: effects.finalize }))
        .count,
    ).toBe(3);
    for (const value of [
      desiredProfileSpec.displayName,
      desiredProfileSpec.role,
      desiredProfileSpec.preferredFocus,
    ]) {
      expect(JSON.stringify(first)).not.toContain(value);
    }
  });

  it("fails closed for conflicting replay and every forged identity", async () => {
    const service = createService();
    await service.execute(
      operation("SET_DISPLAY_NAME", effects.display, "REPLACE_DISPLAY_NAME"),
    );
    await expect(
      service.execute(operation("SELECT_ROLE", effects.display, "SELECT_ROLE")),
    ).rejects.toMatchObject({ code: "EFFECT_BINDING_CONFLICT" });
    await expect(
      service.observe({
        ...binding,
        logicalStep: "SET_DISPLAY_NAME",
        effectId: "efx_01J00000000000000000000008",
      }),
    ).rejects.toMatchObject({ code: "FIXTURE_EFFECT_DENIED" });

    for (const forged of [
      { ...binding, principalId: "prn_01J00000000000000000000001" },
      { ...binding, jobId: "job_01J00000000000000000000001" },
      { ...binding, browserSessionId: "brs_01J00000000000000000000001" },
      { ...binding, sessionKind: "LINKEDIN" as const },
    ]) {
      await expect(
        service.observe({
          ...forged,
          logicalStep: "SET_DISPLAY_NAME",
          effectId: effects.read,
        }),
      ).rejects.toBeInstanceOf(FixtureServiceError);
      await expect(
        service.reset({ ...forged, effectId: effects.reset }),
      ).rejects.toMatchObject({ code: "FIXTURE_BINDING_DENIED" });
      await expect(
        service.attempts({ ...forged, effectId: effects.display }),
      ).rejects.toMatchObject({ code: "FIXTURE_BINDING_DENIED" });
    }
  });

  it("resets the one local profile only for a new bound effect", async () => {
    const service = createService();
    await completeFields(service);
    await service.execute(
      operation("FINALIZE_SETUP", effects.finalize, "FINALIZE_SETUP"),
    );
    const reset = await service.reset({ ...binding, effectId: effects.reset });
    expect(reset).toEqual({
      status: "RESET",
      effectId: effects.reset,
      attemptCount: 1,
    });
    expect(
      service.profileSnapshot({ ...binding, effectId: effects.read }),
    ).toEqual({
      presentFields: [],
      finalized: false,
    });
    await expect(
      service.reset({ ...binding, effectId: effects.finalize }),
    ).rejects.toMatchObject({ code: "EFFECT_BINDING_CONFLICT" });
  });

  it("fences every owner-only challenge before mutation", async () => {
    for (const variant of setupFixtureVariants.filter(
      (candidate) => candidate.humanGate !== "NONE",
    )) {
      const service = createService({
        variantId: variant.id,
      });
      const result = await service.execute(
        operation("SET_DISPLAY_NAME", effects.display, "REPLACE_DISPLAY_NAME"),
      );
      expect(result).toMatchObject({
        status: "WAITING_FOR_USER",
        reason: variant.humanGate,
      });
      expect(
        service.profileSnapshot({ ...binding, effectId: effects.read })
          .presentFields,
      ).toEqual([]);
    }
  });

  it("survives response loss, fences ambiguous effects, and bounds attempts", async () => {
    const diagnostics: string[] = [];
    const service = createService({
      diagnostic: (code) => diagnostics.push(code),
      maxAttemptsPerEffect: 3,
    });
    const request = operation(
      "SET_DISPLAY_NAME",
      effects.display,
      "REPLACE_DISPLAY_NAME",
    );
    await expect(
      service.execute(request, { mode: "RESPONSE_LOSS" }),
    ).rejects.toMatchObject({ code: "RESPONSE_LOST_AFTER_EFFECT" });
    await expect(service.execute(request)).resolves.toMatchObject({
      status: "APPLIED",
      effectId: effects.display,
    });
    expect(
      (await service.attempts({ ...binding, effectId: effects.display })).count,
    ).toBe(2);

    await expect(
      service.execute(
        operation("SELECT_ROLE", effects.ambiguous, "SELECT_ROLE"),
        { mode: "AMBIGUOUS_EFFECT" },
      ),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_EFFECT_REQUIRES_OWNER" });
    await expect(
      service.execute(
        operation("SELECT_ROLE", effects.ambiguous, "SELECT_ROLE"),
      ),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_EFFECT_REQUIRES_OWNER" });
    expect(
      (await service.attempts({ ...binding, effectId: effects.ambiguous }))
        .count,
    ).toBeLessThanOrEqual(3);
    expect(diagnostics).toEqual([
      "RESPONSE_LOST_AFTER_EFFECT",
      "AMBIGUOUS_EFFECT_REQUIRES_OWNER",
    ]);
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(desiredProfileSpec.displayName);
    expect(serialized).not.toContain(desiredProfileSpec.role);
    expect(serialized).not.toContain(desiredProfileSpec.preferredFocus);
  });
});

describe("owned fixture request handler", () => {
  it("serves only the exact HTTPS fixture origin in its bound fixture session", async () => {
    const service = createService({
      variantId: "setup-split",
    });
    const handler = createOwnedFixtureRequestHandler({ service, binding });
    const page = await handler(
      new Request(`${OWNED_FIXTURE_ORIGIN}/setup?effectId=${effects.read}`),
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-layout="SPLIT"');

    for (const url of [
      "http://fixture.village.test/setup",
      "https://fixture.village.test.evil.invalid/setup",
      "https://attacker.invalid/setup",
      `${OWNED_FIXTURE_ORIGIN}:444/setup`,
    ]) {
      expect((await handler(new Request(url))).status).toBe(403);
    }
    expect(
      (
        await handler({
          url: "https://user:password@fixture.village.test/setup",
          method: "GET",
        } as Request)
      ).status,
    ).toBe(403);

    const forgedHandler = createOwnedFixtureRequestHandler({
      service,
      binding: {
        ...binding,
        browserSessionId: "brs_01J00000000000000000000001",
      },
    });
    expect(
      (
        await forgedHandler(
          new Request(
            `${OWNED_FIXTURE_ORIGIN}/api/observe?logicalStep=SET_DISPLAY_NAME&effectId=${effects.read}`,
          ),
        )
      ).status,
    ).toBe(403);
  });

  it("accepts semantic actions without selectors, destinations, or values", async () => {
    const service = createService();
    const handler = createOwnedFixtureRequestHandler({ service, binding });
    const response = await handler(
      new Request(`${OWNED_FIXTURE_ORIGIN}/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          logicalStep: "SET_DISPLAY_NAME",
          effectId: effects.display,
          capability: "REPLACE_DISPLAY_NAME",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ status: "APPLIED" });
    expect(JSON.stringify(receipt)).not.toContain(
      desiredProfileSpec.displayName,
    );

    const attempts = await handler(
      new Request(
        `${OWNED_FIXTURE_ORIGIN}/api/attempts?effectId=${effects.display}`,
      ),
    );
    expect(await attempts.json()).toMatchObject({ count: 1, maximum: 3 });

    const reset = await handler(
      new Request(`${OWNED_FIXTURE_ORIGIN}/api/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ effectId: effects.reset }),
      }),
    );
    expect(await reset.json()).toEqual({
      status: "RESET",
      effectId: effects.reset,
      attemptCount: 1,
    });

    const unsafe = await handler(
      new Request(`${OWNED_FIXTURE_ORIGIN}/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          logicalStep: "SELECT_ROLE",
          effectId: effects.role,
          capability: "SELECT_ROLE",
          selector: "#admin",
        }),
      }),
    );
    expect(unsafe.status).toBe(400);
    expect(await unsafe.json()).toEqual({ code: "INVALID_FIXTURE_REQUEST" });
  });

  it("renders hostile content as inert text and denies hostile navigation", async () => {
    const service = createService({
      variantId: "hostile-navigation",
    });
    const handler = createOwnedFixtureRequestHandler({ service, binding });
    const response = await handler(
      new Request(`${OWNED_FIXTURE_ORIGIN}/setup?effectId=${effects.read}`),
    );
    const html = await response.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("https://attacker.invalid/");
    expect(
      (await handler(new Request("https://attacker.invalid/steal"))).status,
    ).toBe(403);
  });
});
