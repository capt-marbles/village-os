import {
  browserSessionIdSchema,
  effectIdSchema,
  isSetupCommandAllowedForStep,
  jobIdSchema,
  ownedFixtureSetupCommandSchema,
  principalIdSchema,
  setupLogicalStepSchema,
  setupObservationSchema,
  type OwnedFixtureSetupCommand,
} from "@village/contracts";
import type { SanitizedProfileSnapshot } from "./account.js";
import {
  desiredProfileSpec,
  mutationCapabilityForStep,
  setupPredicateIds,
  setupVariantById,
  type SetupLogicalStep,
} from "./setup.js";

export interface FixtureCallBinding {
  readonly principalId: string;
  readonly jobId: string;
  readonly browserSessionId: string;
  readonly sessionKind: "OWNED_FIXTURE" | "LINKEDIN";
}

export interface FixtureEffectBinding extends FixtureCallBinding {
  readonly effectId: string;
}

export interface FixtureStepBinding extends FixtureEffectBinding {
  readonly logicalStep: SetupLogicalStep;
}

export interface FixtureActionRequest extends FixtureStepBinding {
  readonly capability: OwnedFixtureSetupCommand["capability"];
}

export type FixtureFailureMode =
  "NORMAL" | "RESPONSE_LOSS" | "AMBIGUOUS_EFFECT";

export type FixtureOperationResult =
  | {
      readonly status: "APPLIED";
      readonly logicalStep: SetupLogicalStep;
      readonly effectId: string;
      readonly postcondition: "SATISFIED";
      readonly predicateIds: readonly string[];
      readonly attemptCount: number;
    }
  | {
      readonly status: "FINALIZED";
      readonly logicalStep: "FINALIZE_SETUP";
      readonly effectId: string;
      readonly finalizationId: string;
      readonly postcondition: "SATISFIED";
      readonly predicateIds: readonly string[];
      readonly attemptCount: number;
    }
  | {
      readonly status: "WAITING_FOR_USER";
      readonly logicalStep: SetupLogicalStep;
      readonly effectId: string;
      readonly reason: Exclude<
        ReturnType<typeof setupVariantById>["humanGate"],
        "NONE"
      >;
      readonly attemptCount: number;
    };

export type FixtureServiceErrorCode =
  | "INVALID_FIXTURE_BINDING"
  | "FIXTURE_BINDING_DENIED"
  | "FIXTURE_EFFECT_DENIED"
  | "INVALID_EFFECT_ID"
  | "INVALID_SETUP_ACTION"
  | "EFFECT_BINDING_CONFLICT"
  | "PROFILE_INCOMPLETE"
  | "PROFILE_ALREADY_FINALIZED"
  | "ATTEMPT_BUDGET_EXHAUSTED"
  | "RESPONSE_LOST_AFTER_EFFECT"
  | "AMBIGUOUS_EFFECT_REQUIRES_OWNER";

export class FixtureServiceError extends Error {
  readonly code: FixtureServiceErrorCode;

  constructor(code: FixtureServiceErrorCode) {
    super(code);
    this.name = "FixtureServiceError";
    this.code = code;
  }
}

interface LocalProfile {
  displayName?: string;
  role?: (typeof desiredProfileSpec.roleOptions)[number];
  preferredFocus?: (typeof desiredProfileSpec.focusOptions)[number];
  finalized: boolean;
}

interface EffectRecord {
  readonly principalId: string;
  readonly jobId: string;
  readonly browserSessionId: string;
  readonly grantedStep: SetupLogicalStep | "RESET";
  logicalStep?: SetupLogicalStep;
  capability?: OwnedFixtureSetupCommand["capability"] | "RESET";
  attempts: number;
  ambiguous: boolean;
  result?: FixtureOperationResult | FixtureResetResult;
}

export interface LocalOwnedFixtureServiceOptions {
  readonly effectGrants: readonly FixtureEffectGrant[];
  readonly variantId?: string;
  readonly maxAttemptsPerEffect?: number;
  readonly createFinalizationId?: () => string;
  readonly diagnostic?: (code: FixtureServiceErrorCode) => void;
}

export interface FixtureEffectGrant {
  readonly effectId: string;
  readonly logicalStep: SetupLogicalStep | "RESET";
}

export interface FixtureResetResult {
  readonly status: "RESET";
  readonly effectId: string;
  readonly attemptCount: number;
}

function sameBinding(
  record: EffectRecord,
  binding: FixtureCallBinding,
): boolean {
  return (
    record.principalId === binding.principalId &&
    record.jobId === binding.jobId &&
    record.browserSessionId === binding.browserSessionId
  );
}

export class LocalOwnedFixtureService {
  private profile: LocalProfile = { finalized: false };
  private readonly effects = new Map<string, EffectRecord>();
  private readonly effectGrants = new Map<string, SetupLogicalStep | "RESET">();
  private readonly expectedBinding: FixtureCallBinding;
  private readonly variant: ReturnType<typeof setupVariantById>;
  private readonly maxAttemptsPerEffect: number;
  private readonly createFinalizationId: () => string;
  private readonly diagnostic:
    ((code: FixtureServiceErrorCode) => void) | undefined;

  constructor(
    binding: FixtureCallBinding,
    options: LocalOwnedFixtureServiceOptions,
  ) {
    this.expectedBinding = this.parseInitialBinding(binding);
    this.variant = setupVariantById(options.variantId ?? null);
    this.maxAttemptsPerEffect = Math.min(
      10,
      Math.max(1, options.maxAttemptsPerEffect ?? 3),
    );
    this.createFinalizationId =
      options.createFinalizationId ??
      (() => `local-finalization-${crypto.randomUUID()}`);
    this.diagnostic = options.diagnostic;
    for (const grant of options.effectGrants) {
      let effectId: string;
      let logicalStep: SetupLogicalStep | "RESET";
      try {
        effectId = effectIdSchema.parse(grant.effectId);
        logicalStep =
          grant.logicalStep === "RESET"
            ? "RESET"
            : setupLogicalStepSchema.parse(grant.logicalStep);
      } catch {
        throw new FixtureServiceError("INVALID_FIXTURE_BINDING");
      }
      if (this.effectGrants.has(effectId)) {
        throw new FixtureServiceError("INVALID_FIXTURE_BINDING");
      }
      this.effectGrants.set(effectId, logicalStep);
    }
    if (this.effectGrants.size === 0) {
      throw new FixtureServiceError("INVALID_FIXTURE_BINDING");
    }
  }

  async observe(candidate: FixtureStepBinding) {
    const binding = this.requireStepBinding(candidate);
    const record = this.requireEffectRecord(binding);
    if (record.grantedStep !== binding.logicalStep) {
      throw new FixtureServiceError("EFFECT_BINDING_CONFLICT");
    }
    const fact = this.factForStep(binding.logicalStep);
    return setupObservationSchema.parse({
      schemaVersion: 1,
      source: "BROWSER_UNTRUSTED",
      workflowKind: desiredProfileSpec.workflowKind,
      workflowVersion: desiredProfileSpec.workflowVersion,
      logicalStep: binding.logicalStep,
      effectId: binding.effectId,
      predicateIds: [
        setupPredicateIds[binding.logicalStep],
        setupPredicateIds.HUMAN_GATE,
      ],
      facts: [fact, { id: "HUMAN_GATE", value: this.variant.humanGate }],
    });
  }

  async verify(candidate: FixtureStepBinding) {
    return this.observe(candidate);
  }

  profileSnapshot(candidate: FixtureEffectBinding): SanitizedProfileSnapshot {
    const binding = this.requireEffectBinding(candidate);
    this.requireEffectRecord(binding);
    const presentFields: SanitizedProfileSnapshot["presentFields"][number][] =
      [];
    if (this.profile.displayName !== undefined)
      presentFields.push("DISPLAY_NAME");
    if (this.profile.role !== undefined) presentFields.push("ROLE");
    if (this.profile.preferredFocus !== undefined)
      presentFields.push("PREFERRED_FOCUS");
    return { presentFields, finalized: this.profile.finalized };
  }

  async execute(
    candidate: FixtureActionRequest,
    options: { readonly mode?: FixtureFailureMode } = {},
  ): Promise<FixtureOperationResult> {
    const binding = this.requireAction(candidate);
    const record = this.requireEffectRecord(binding);
    if (record.grantedStep !== binding.logicalStep) {
      throw new FixtureServiceError("EFFECT_BINDING_CONFLICT");
    }
    if (
      record.logicalStep !== undefined &&
      record.logicalStep !== binding.logicalStep
    ) {
      throw new FixtureServiceError("EFFECT_BINDING_CONFLICT");
    }
    if (
      record.capability !== undefined &&
      record.capability !== binding.capability
    ) {
      throw new FixtureServiceError("EFFECT_BINDING_CONFLICT");
    }
    record.logicalStep = binding.logicalStep;
    record.capability = binding.capability;
    if (record.ambiguous) {
      throw new FixtureServiceError("AMBIGUOUS_EFFECT_REQUIRES_OWNER");
    }
    if (record.result && record.result.status !== "RESET") {
      this.recordReplay(record);
      return record.result;
    }
    this.beginAttempt(record);

    const mode = options.mode ?? "NORMAL";
    if (mode === "AMBIGUOUS_EFFECT") {
      record.ambiguous = true;
      this.emitDiagnostic("AMBIGUOUS_EFFECT_REQUIRES_OWNER");
      throw new FixtureServiceError("AMBIGUOUS_EFFECT_REQUIRES_OWNER");
    }

    if (this.variant.humanGate !== "NONE") {
      const result = {
        status: "WAITING_FOR_USER",
        logicalStep: binding.logicalStep,
        effectId: binding.effectId,
        reason: this.variant.humanGate,
        attemptCount: record.attempts,
      } as const;
      record.result = result;
      return result;
    }
    if (this.profile.finalized) {
      throw new FixtureServiceError("PROFILE_ALREADY_FINALIZED");
    }

    const result = this.applyAction(binding, record.attempts);
    record.result = result;
    if (mode === "RESPONSE_LOSS") {
      this.emitDiagnostic("RESPONSE_LOST_AFTER_EFFECT");
      throw new FixtureServiceError("RESPONSE_LOST_AFTER_EFFECT");
    }
    return result;
  }

  async reset(candidate: FixtureEffectBinding): Promise<FixtureResetResult> {
    const binding = this.requireEffectBinding(candidate);
    const record = this.requireEffectRecord(binding);
    if (record.grantedStep !== "RESET") {
      throw new FixtureServiceError("EFFECT_BINDING_CONFLICT");
    }
    if (record.capability !== undefined && record.capability !== "RESET") {
      throw new FixtureServiceError("EFFECT_BINDING_CONFLICT");
    }
    record.capability = "RESET";
    if (record.result?.status === "RESET") {
      this.recordReplay(record);
      return record.result;
    }
    this.beginAttempt(record);
    this.profile = { finalized: false };
    const result = {
      status: "RESET",
      effectId: binding.effectId,
      attemptCount: record.attempts,
    } as const;
    record.result = result;
    return result;
  }

  async attempts(candidate: FixtureEffectBinding) {
    const binding = this.requireEffectBinding(candidate);
    if (!this.effectGrants.has(binding.effectId)) {
      throw new FixtureServiceError("FIXTURE_EFFECT_DENIED");
    }
    const record = this.effects.get(binding.effectId);
    if (record && !sameBinding(record, binding)) {
      throw new FixtureServiceError("FIXTURE_BINDING_DENIED");
    }
    return {
      effectId: binding.effectId,
      count: record?.attempts ?? 0,
      maximum: this.maxAttemptsPerEffect,
      exhausted: (record?.attempts ?? 0) >= this.maxAttemptsPerEffect,
    } as const;
  }

  accountView(candidate: FixtureEffectBinding) {
    return {
      variant: this.variant,
      profile: this.profileSnapshot(candidate),
    } as const;
  }

  assertBoundSession(candidate: FixtureCallBinding): void {
    this.requireBinding(candidate);
  }

  private parseInitialBinding(binding: FixtureCallBinding): FixtureCallBinding {
    try {
      if (binding.sessionKind !== "OWNED_FIXTURE") throw new Error();
      return {
        principalId: principalIdSchema.parse(binding.principalId),
        jobId: jobIdSchema.parse(binding.jobId),
        browserSessionId: browserSessionIdSchema.parse(
          binding.browserSessionId,
        ),
        sessionKind: "OWNED_FIXTURE",
      };
    } catch {
      throw new FixtureServiceError("INVALID_FIXTURE_BINDING");
    }
  }

  private requireBinding(binding: FixtureCallBinding): void {
    let valid = false;
    try {
      valid =
        binding.sessionKind === "OWNED_FIXTURE" &&
        principalIdSchema.parse(binding.principalId) ===
          this.expectedBinding.principalId &&
        jobIdSchema.parse(binding.jobId) === this.expectedBinding.jobId &&
        browserSessionIdSchema.parse(binding.browserSessionId) ===
          this.expectedBinding.browserSessionId;
    } catch {
      valid = false;
    }
    if (!valid) throw new FixtureServiceError("FIXTURE_BINDING_DENIED");
  }

  private requireEffectBinding(
    candidate: FixtureEffectBinding,
  ): FixtureEffectBinding {
    this.requireBinding(candidate);
    try {
      return {
        ...candidate,
        effectId: effectIdSchema.parse(candidate.effectId),
      };
    } catch {
      throw new FixtureServiceError("INVALID_EFFECT_ID");
    }
  }

  private requireStepBinding(
    candidate: FixtureStepBinding,
  ): FixtureStepBinding {
    const binding = this.requireEffectBinding(candidate);
    try {
      return {
        ...binding,
        logicalStep: setupLogicalStepSchema.parse(candidate.logicalStep),
      };
    } catch {
      throw new FixtureServiceError("INVALID_SETUP_ACTION");
    }
  }

  private requireAction(candidate: FixtureActionRequest): FixtureActionRequest {
    const binding = this.requireStepBinding(candidate);
    const command = ownedFixtureSetupCommandSchema.safeParse({
      capability: candidate.capability,
    });
    if (
      !command.success ||
      mutationCapabilityForStep[binding.logicalStep] !==
        command.data.capability ||
      !isSetupCommandAllowedForStep(binding.logicalStep, command.data)
    ) {
      throw new FixtureServiceError("INVALID_SETUP_ACTION");
    }
    return { ...binding, capability: command.data.capability };
  }

  private requireEffectRecord(binding: FixtureEffectBinding): EffectRecord {
    const existing = this.effects.get(binding.effectId);
    if (existing) {
      if (!sameBinding(existing, binding)) {
        throw new FixtureServiceError("FIXTURE_BINDING_DENIED");
      }
      return existing;
    }
    const grantedStep = this.effectGrants.get(binding.effectId);
    if (!grantedStep) {
      throw new FixtureServiceError("FIXTURE_EFFECT_DENIED");
    }
    const created: EffectRecord = {
      principalId: binding.principalId,
      jobId: binding.jobId,
      browserSessionId: binding.browserSessionId,
      grantedStep,
      attempts: 0,
      ambiguous: false,
    };
    this.effects.set(binding.effectId, created);
    return created;
  }

  private beginAttempt(record: EffectRecord): void {
    if (record.attempts >= this.maxAttemptsPerEffect) {
      throw new FixtureServiceError("ATTEMPT_BUDGET_EXHAUSTED");
    }
    record.attempts += 1;
  }

  private recordReplay(record: EffectRecord): void {
    record.attempts = Math.min(this.maxAttemptsPerEffect, record.attempts + 1);
  }

  private applyAction(
    binding: FixtureActionRequest,
    attemptCount: number,
  ): FixtureOperationResult {
    if (binding.capability === "REPLACE_DISPLAY_NAME") {
      this.profile.displayName = desiredProfileSpec.displayName;
    } else if (binding.capability === "SELECT_ROLE") {
      this.profile.role = desiredProfileSpec.role;
    } else if (binding.capability === "REPLACE_PREFERRED_FOCUS") {
      this.profile.preferredFocus = desiredProfileSpec.preferredFocus;
    } else if (binding.capability === "FINALIZE_SETUP") {
      if (!this.completeProfilePredicate()) {
        throw new FixtureServiceError("PROFILE_INCOMPLETE");
      }
      const finalizationId = this.safeFinalizationId();
      this.profile.finalized = true;
      return {
        status: "FINALIZED",
        logicalStep: "FINALIZE_SETUP",
        effectId: binding.effectId,
        finalizationId,
        postcondition: "SATISFIED",
        predicateIds: [setupPredicateIds.FINALIZE_SETUP],
        attemptCount,
      };
    }
    return {
      status: "APPLIED",
      logicalStep: binding.logicalStep,
      effectId: binding.effectId,
      postcondition: "SATISFIED",
      predicateIds: [setupPredicateIds[binding.logicalStep]],
      attemptCount,
    };
  }

  private completeProfilePredicate(): boolean {
    return (
      this.profile.displayName === desiredProfileSpec.displayName &&
      this.profile.role === desiredProfileSpec.role &&
      this.profile.preferredFocus === desiredProfileSpec.preferredFocus
    );
  }

  private safeFinalizationId(): string {
    const id = this.createFinalizationId();
    if (!/^local-finalization-[A-Za-z0-9-]{1,64}$/.test(id)) {
      throw new FixtureServiceError("INVALID_FIXTURE_BINDING");
    }
    return id;
  }

  private factForStep(logicalStep: SetupLogicalStep) {
    if (logicalStep === "SET_DISPLAY_NAME") {
      return {
        id: "DISPLAY_NAME_MATCH" as const,
        value:
          this.profile.displayName === undefined
            ? ("MISSING" as const)
            : this.profile.displayName === desiredProfileSpec.displayName
              ? ("MATCH" as const)
              : ("MISMATCH" as const),
      };
    }
    if (logicalStep === "SELECT_ROLE") {
      return {
        id: "ROLE_MATCH" as const,
        value:
          this.profile.role === undefined
            ? ("MISSING" as const)
            : this.profile.role === desiredProfileSpec.role
              ? ("MATCH" as const)
              : ("MISMATCH" as const),
      };
    }
    if (logicalStep === "SET_PREFERRED_FOCUS") {
      return {
        id: "PREFERRED_FOCUS_MATCH" as const,
        value:
          this.profile.preferredFocus === undefined
            ? ("MISSING" as const)
            : this.profile.preferredFocus === desiredProfileSpec.preferredFocus
              ? ("MATCH" as const)
              : ("MISMATCH" as const),
      };
    }
    return {
      id: "FINALIZATION_STATE" as const,
      value: this.profile.finalized
        ? ("FINALIZED" as const)
        : ("NOT_FINALIZED" as const),
    };
  }

  private emitDiagnostic(code: FixtureServiceErrorCode): void {
    this.diagnostic?.(code);
  }
}
