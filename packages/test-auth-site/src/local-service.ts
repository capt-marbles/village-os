import {
  browserSessionIdSchema,
  effectIdSchema,
  humanGateReasonSchema,
  isSetupCommandAllowedForStep,
  jobIdSchema,
  ownedFixtureSetupCommandSchema,
  principalIdSchema,
  setupLogicalStepSchema,
  setupObservationSchema,
  type OwnedFixtureSetupCommand,
} from "@village/contracts";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  | "AMBIGUOUS_EFFECT_REQUIRES_OWNER"
  | "FIXTURE_STATE_CORRUPT";

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

export interface OwnerFixtureValues {
  readonly displayName: string;
  readonly role: string;
  readonly preferredFocus: string;
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

export interface PersistentOwnedFixtureServiceOptions extends LocalOwnedFixtureServiceOptions {
  readonly stateFilePath: string;
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

interface PersistedEffectRecord extends EffectRecord {
  readonly effectId: string;
}

interface PersistedFixtureState {
  readonly schemaVersion: 1;
  readonly binding: FixtureCallBinding;
  readonly profile: LocalProfile;
  readonly effects: readonly PersistedEffectRecord[];
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate)
  );
}

function hasOnlyKeys(
  candidate: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(candidate).every((key) => allowed.includes(key));
}

function isExactStringArray(
  candidate: unknown,
  expected: readonly string[],
): boolean {
  return (
    Array.isArray(candidate) &&
    candidate.length === expected.length &&
    candidate.every((value, index) => value === expected[index])
  );
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
  private stateFilePath: string | undefined;
  private persistenceTail = Promise.resolve();

  static async open(
    binding: FixtureCallBinding,
    options: PersistentOwnedFixtureServiceOptions,
  ): Promise<LocalOwnedFixtureService> {
    const service = new LocalOwnedFixtureService(binding, options);
    if (!options.stateFilePath || !options.stateFilePath.startsWith("/")) {
      throw new FixtureServiceError("INVALID_FIXTURE_BINDING");
    }
    service.stateFilePath = options.stateFilePath;
    await service.restore();
    return service;
  }

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
      await this.persist();
      return record.result;
    }
    this.beginAttempt(record);

    const mode = options.mode ?? "NORMAL";
    if (mode === "AMBIGUOUS_EFFECT") {
      record.ambiguous = true;
      await this.persist();
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
      await this.persist();
      return result;
    }
    if (this.profile.finalized) {
      throw new FixtureServiceError("PROFILE_ALREADY_FINALIZED");
    }

    const result = this.applyAction(binding, record.attempts);
    record.result = result;
    await this.persist();
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
      await this.persist();
      return record.result;
    }
    this.beginAttempt(record);
    this.profile = { finalized: false };
    this.effects.clear();
    this.effects.set(binding.effectId, record);
    const result = {
      status: "RESET",
      effectId: binding.effectId,
      attemptCount: record.attempts,
    } as const;
    record.result = result;
    await this.persist();
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
      localValues: { ...this.profile },
    } as const;
  }

  async applyOwnerState(
    candidate: FixtureStepBinding,
    values: OwnerFixtureValues,
  ) {
    const binding = this.requireStepBinding(candidate);
    this.requireEffectRecord(binding);
    const displayName = values.displayName.trim();
    if (
      displayName.length === 0 ||
      displayName.length > 80 ||
      !desiredProfileSpec.roleOptions.includes(values.role as never) ||
      !desiredProfileSpec.focusOptions.includes(values.preferredFocus as never)
    ) {
      throw new FixtureServiceError("INVALID_SETUP_ACTION");
    }
    this.profile = {
      ...this.profile,
      displayName,
      role: values.role as (typeof desiredProfileSpec.roleOptions)[number],
      preferredFocus:
        values.preferredFocus as (typeof desiredProfileSpec.focusOptions)[number],
    };
    await this.persist();
    return this.observe(binding);
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

  private async restore(): Promise<void> {
    if (!this.stateFilePath) return;
    let raw: string;
    try {
      raw = await readFile(this.stateFilePath, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
    }
    if (raw.length > 131_072) {
      throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(raw) as unknown;
    } catch {
      throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
    }
    const state = this.parsePersistedState(candidate);
    this.profile = state.profile;
    this.effects.clear();
    for (const { effectId, ...record } of state.effects) {
      this.effects.set(effectId, record);
    }
  }

  private parsePersistedState(candidate: unknown): PersistedFixtureState {
    if (
      !isObject(candidate) ||
      !hasOnlyKeys(candidate, [
        "schemaVersion",
        "binding",
        "profile",
        "effects",
      ]) ||
      candidate.schemaVersion !== 1 ||
      !isObject(candidate.binding) ||
      !isObject(candidate.profile) ||
      !Array.isArray(candidate.effects) ||
      candidate.effects.length > this.effectGrants.size
    ) {
      throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
    }
    const binding = candidate.binding as unknown as FixtureCallBinding;
    try {
      this.requireBinding(binding);
    } catch {
      throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
    }
    const profile = this.parsePersistedProfile(candidate.profile);
    const seen = new Set<string>();
    const effects = candidate.effects.map((effect) => {
      const parsed = this.parsePersistedEffect(effect);
      if (seen.has(parsed.effectId)) {
        throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
      }
      seen.add(parsed.effectId);
      return parsed;
    });
    if (
      effects.some((effect) => effect.result?.status === "FINALIZED") !==
      profile.finalized
    ) {
      throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
    }
    return { schemaVersion: 1, binding, profile, effects };
  }

  private parsePersistedProfile(
    candidate: Record<string, unknown>,
  ): LocalProfile {
    if (
      !hasOnlyKeys(candidate, [
        "displayName",
        "role",
        "preferredFocus",
        "finalized",
      ]) ||
      typeof candidate.finalized !== "boolean" ||
      (candidate.displayName !== undefined &&
        (typeof candidate.displayName !== "string" ||
          candidate.displayName.trim().length === 0 ||
          candidate.displayName.length > 80)) ||
      (candidate.role !== undefined &&
        !desiredProfileSpec.roleOptions.includes(candidate.role as never)) ||
      (candidate.preferredFocus !== undefined &&
        !desiredProfileSpec.focusOptions.includes(
          candidate.preferredFocus as never,
        ))
    ) {
      throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
    }
    const profile: LocalProfile = {
      finalized: candidate.finalized,
      ...(candidate.displayName === undefined
        ? {}
        : { displayName: candidate.displayName as string }),
      ...(candidate.role === undefined
        ? {}
        : {
            role: candidate.role as (typeof desiredProfileSpec.roleOptions)[number],
          }),
      ...(candidate.preferredFocus === undefined
        ? {}
        : {
            preferredFocus:
              candidate.preferredFocus as (typeof desiredProfileSpec.focusOptions)[number],
          }),
    };
    if (
      profile.finalized &&
      (profile.displayName !== desiredProfileSpec.displayName ||
        profile.role !== desiredProfileSpec.role ||
        profile.preferredFocus !== desiredProfileSpec.preferredFocus)
    ) {
      throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
    }
    return profile;
  }

  private parsePersistedEffect(candidate: unknown): PersistedEffectRecord {
    if (
      !isObject(candidate) ||
      !hasOnlyKeys(candidate, [
        "effectId",
        "principalId",
        "jobId",
        "browserSessionId",
        "grantedStep",
        "logicalStep",
        "capability",
        "attempts",
        "ambiguous",
        "result",
      ]) ||
      !effectIdSchema.safeParse(candidate.effectId).success ||
      !Number.isInteger(candidate.attempts) ||
      (candidate.attempts as number) < 0 ||
      (candidate.attempts as number) > this.maxAttemptsPerEffect ||
      typeof candidate.ambiguous !== "boolean"
    ) {
      throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
    }
    const effectId = candidate.effectId as string;
    const grantedStep = this.effectGrants.get(effectId);
    if (
      !grantedStep ||
      candidate.grantedStep !== grantedStep ||
      candidate.principalId !== this.expectedBinding.principalId ||
      candidate.jobId !== this.expectedBinding.jobId ||
      candidate.browserSessionId !== this.expectedBinding.browserSessionId
    ) {
      throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
    }
    const logicalStep =
      candidate.logicalStep === undefined
        ? undefined
        : setupLogicalStepSchema.safeParse(candidate.logicalStep).data;
    if (
      (candidate.logicalStep !== undefined && !logicalStep) ||
      (logicalStep !== undefined && logicalStep !== grantedStep)
    ) {
      throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
    }
    let capability: EffectRecord["capability"];
    if (candidate.capability === "RESET") {
      capability = "RESET";
    } else if (candidate.capability !== undefined) {
      const parsed = ownedFixtureSetupCommandSchema.safeParse({
        capability: candidate.capability,
      });
      if (!parsed.success) {
        throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
      }
      capability = parsed.data.capability;
    }
    if (
      (capability === "RESET" && grantedStep !== "RESET") ||
      (capability !== undefined &&
        capability !== "RESET" &&
        (logicalStep === undefined ||
          mutationCapabilityForStep[logicalStep] !== capability))
    ) {
      throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
    }
    const record: PersistedEffectRecord = {
      effectId,
      principalId: this.expectedBinding.principalId,
      jobId: this.expectedBinding.jobId,
      browserSessionId: this.expectedBinding.browserSessionId,
      grantedStep,
      attempts: candidate.attempts as number,
      ambiguous: candidate.ambiguous,
      ...(logicalStep === undefined ? {} : { logicalStep }),
      ...(capability === undefined ? {} : { capability }),
    };
    if (candidate.result !== undefined) {
      record.result = this.parsePersistedResult(candidate.result, record);
    }
    return record;
  }

  private parsePersistedResult(
    candidate: unknown,
    record: PersistedEffectRecord,
  ): FixtureOperationResult | FixtureResetResult {
    if (!isObject(candidate) || candidate.effectId !== record.effectId) {
      throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
    }
    if (
      !Number.isInteger(candidate.attemptCount) ||
      (candidate.attemptCount as number) < 1 ||
      (candidate.attemptCount as number) > record.attempts
    ) {
      throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
    }
    if (
      candidate.status === "RESET" &&
      record.grantedStep === "RESET" &&
      hasOnlyKeys(candidate, ["status", "effectId", "attemptCount"])
    ) {
      return {
        status: "RESET",
        effectId: record.effectId,
        attemptCount: candidate.attemptCount as number,
      };
    }
    if (
      candidate.status === "APPLIED" &&
      record.logicalStep !== undefined &&
      record.logicalStep !== "FINALIZE_SETUP" &&
      candidate.logicalStep === record.logicalStep &&
      candidate.postcondition === "SATISFIED" &&
      isExactStringArray(candidate.predicateIds, [
        setupPredicateIds[record.logicalStep],
      ]) &&
      hasOnlyKeys(candidate, [
        "status",
        "logicalStep",
        "effectId",
        "postcondition",
        "predicateIds",
        "attemptCount",
      ])
    ) {
      return {
        status: "APPLIED",
        logicalStep: record.logicalStep,
        effectId: record.effectId,
        postcondition: "SATISFIED",
        predicateIds: [setupPredicateIds[record.logicalStep]],
        attemptCount: candidate.attemptCount as number,
      };
    }
    if (
      candidate.status === "FINALIZED" &&
      record.logicalStep === "FINALIZE_SETUP" &&
      candidate.logicalStep === "FINALIZE_SETUP" &&
      candidate.postcondition === "SATISFIED" &&
      isExactStringArray(candidate.predicateIds, [
        setupPredicateIds.FINALIZE_SETUP,
      ]) &&
      typeof candidate.finalizationId === "string" &&
      /^local-finalization-[A-Za-z0-9-]{1,64}$/.test(
        candidate.finalizationId,
      ) &&
      hasOnlyKeys(candidate, [
        "status",
        "logicalStep",
        "effectId",
        "finalizationId",
        "postcondition",
        "predicateIds",
        "attemptCount",
      ])
    ) {
      return {
        status: "FINALIZED",
        logicalStep: "FINALIZE_SETUP",
        effectId: record.effectId,
        finalizationId: candidate.finalizationId,
        postcondition: "SATISFIED",
        predicateIds: [setupPredicateIds.FINALIZE_SETUP],
        attemptCount: candidate.attemptCount as number,
      };
    }
    const reason = humanGateReasonSchema.safeParse(candidate.reason);
    if (
      candidate.status === "WAITING_FOR_USER" &&
      record.logicalStep !== undefined &&
      candidate.logicalStep === record.logicalStep &&
      reason.success &&
      hasOnlyKeys(candidate, [
        "status",
        "logicalStep",
        "effectId",
        "reason",
        "attemptCount",
      ])
    ) {
      return {
        status: "WAITING_FOR_USER",
        logicalStep: record.logicalStep,
        effectId: record.effectId,
        reason: reason.data,
        attemptCount: candidate.attemptCount as number,
      };
    }
    throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
  }

  private async persist(): Promise<void> {
    if (!this.stateFilePath) return;
    const path = this.stateFilePath;
    const serialized = JSON.stringify({
      schemaVersion: 1,
      binding: this.expectedBinding,
      profile: this.profile,
      effects: [...this.effects].map(([effectId, record]) => ({
        effectId,
        ...record,
      })),
    } satisfies PersistedFixtureState);
    const operation = this.persistenceTail.then(async () => {
      const directory = dirname(path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temporary = `${path}.tmp-${crypto.randomUUID()}`;
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    });
    this.persistenceTail = operation.catch(() => undefined);
    try {
      await operation;
    } catch {
      throw new FixtureServiceError("FIXTURE_STATE_CORRUPT");
    }
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
