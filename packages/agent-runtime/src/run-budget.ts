import { PilotError, type TokenUsage, TokenUsageSchema } from "@pilotrun/core";
import * as z from "zod";

export const RunBudgetPolicySchema = z
  .object({
    maxCycles: z.number().int().positive(),
    maxModelAttempts: z.number().int().positive(),
    maxToolCalls: z.number().int().nonnegative(),
    maxElapsedMs: z.number().int().positive(),
    maxInputTokens: z.number().int().nonnegative().optional(),
    maxOutputTokens: z.number().int().nonnegative().optional(),
    maxEstimatedCostUsd: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .readonly();

export type RunBudgetPolicy = z.output<typeof RunBudgetPolicySchema>;

export interface MonotonicClock {
  nowMilliseconds(): number;
}

export interface ModelAttemptReservation {
  readonly callId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd?: number;
}

export type RunBudgetResource =
  | "cycles"
  | "elapsed-time"
  | "estimated-cost"
  | "estimated-cost-unavailable"
  | "input-tokens"
  | "model-attempts"
  | "output-tokens"
  | "tool-calls";

export interface RunBudgetExhaustion {
  readonly resource: RunBudgetResource;
  readonly limit: number;
  readonly observed: number | undefined;
}

export interface RunBudgetSnapshot {
  readonly policy: RunBudgetPolicy;
  readonly elapsedMs: number;
  readonly cycles: number;
  readonly modelAttempts: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly activeModelAttempts: number;
  readonly exhaustion?: RunBudgetExhaustion;
}

export type RunBudgetDecision =
  | { readonly allowed: true; readonly snapshot: RunBudgetSnapshot }
  | {
      readonly allowed: false;
      readonly exhaustion: RunBudgetExhaustion;
      readonly snapshot: RunBudgetSnapshot;
    };

interface AttemptRecord {
  readonly reservation: Readonly<ModelAttemptReservation>;
  usage: TokenUsage | undefined;
  settled: boolean;
}

const usageFields = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningTokens",
  "estimatedCostUsd",
] as const satisfies readonly (keyof TokenUsage)[];

export class RunBudgetError extends PilotError {
  constructor(message: string, metadata: Readonly<Record<string, unknown>> = {}, cause?: unknown) {
    super({
      code: "PILOT_RUN_BUDGET_INVALID",
      message,
      safeMessage: "The run budget configuration or accounting operation is invalid",
      metadata,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

export class RunBudgetExceededError extends PilotError {
  readonly exhaustion: RunBudgetExhaustion;

  constructor(exhaustion: RunBudgetExhaustion) {
    super({
      code: "PILOT_RUN_BUDGET_EXHAUSTED",
      message: `Run budget exhausted: ${exhaustion.resource}`,
      safeMessage: "The run stopped because its resource budget was exhausted",
      metadata: { exhaustion },
    });
    this.exhaustion = exhaustion;
  }
}

export class RunBudgetTracker {
  readonly policy: RunBudgetPolicy;
  readonly #clock: MonotonicClock;
  readonly #startedAtMs: number;
  readonly #attempts = new Map<string, AttemptRecord>();
  #lastObservedMs: number;
  #cycles = 0;
  #modelAttempts = 0;
  #toolCalls = 0;
  #exhaustion: RunBudgetExhaustion | undefined;

  constructor(policyInput: RunBudgetPolicy, clock: MonotonicClock) {
    const parsed = RunBudgetPolicySchema.safeParse(policyInput);
    if (!parsed.success) {
      throw new RunBudgetError(
        `Run budget policy validation failed with ${parsed.error.issues.length} issue(s)`,
        { issueCount: parsed.error.issues.length },
        parsed.error,
      );
    }
    this.policy = parsed.data;
    this.#clock = clock;
    this.#startedAtMs = this.#readClock();
    this.#lastObservedMs = this.#startedAtMs;
  }

  snapshot(): RunBudgetSnapshot {
    return this.#snapshot(this.#elapsed());
  }

  checkTime(): RunBudgetDecision {
    const sticky = this.#stickyDecision();
    if (sticky !== undefined) {
      return sticky;
    }
    const elapsedMs = this.#elapsed();
    if (elapsedMs >= this.policy.maxElapsedMs) {
      return this.#deny("elapsed-time", this.policy.maxElapsedMs, elapsedMs, elapsedMs);
    }
    return this.#allow(elapsedMs);
  }

  startCycle(): RunBudgetDecision {
    const ready = this.#readyForOperation();
    if (!ready.allowed) {
      return ready;
    }
    const projected = this.#cycles + 1;
    if (projected > this.policy.maxCycles) {
      return this.#deny("cycles", this.policy.maxCycles, projected, ready.snapshot.elapsedMs);
    }
    this.#cycles = projected;
    return this.#allow(ready.snapshot.elapsedMs);
  }

  startModelAttempt(reservationInput: ModelAttemptReservation): RunBudgetDecision {
    const reservation = parseReservation(reservationInput);
    if (this.#attempts.has(reservation.callId)) {
      throw new RunBudgetError("Model-attempt call identifiers must be unique", {
        callId: reservation.callId,
      });
    }
    if ([...this.#attempts.values()].some((attempt) => !attempt.settled)) {
      throw new RunBudgetError("A single-agent run cannot have concurrent model attempts");
    }

    const ready = this.#readyForOperation();
    if (!ready.allowed) {
      return ready;
    }
    const projectedAttempts = this.#modelAttempts + 1;
    if (projectedAttempts > this.policy.maxModelAttempts) {
      return this.#deny(
        "model-attempts",
        this.policy.maxModelAttempts,
        projectedAttempts,
        ready.snapshot.elapsedMs,
      );
    }
    const projectedInput = ready.snapshot.inputTokens + reservation.inputTokens;
    if (this.policy.maxInputTokens !== undefined && projectedInput > this.policy.maxInputTokens) {
      return this.#deny(
        "input-tokens",
        this.policy.maxInputTokens,
        projectedInput,
        ready.snapshot.elapsedMs,
      );
    }
    const projectedOutput = ready.snapshot.outputTokens + reservation.outputTokens;
    if (
      this.policy.maxOutputTokens !== undefined &&
      projectedOutput > this.policy.maxOutputTokens
    ) {
      return this.#deny(
        "output-tokens",
        this.policy.maxOutputTokens,
        projectedOutput,
        ready.snapshot.elapsedMs,
      );
    }
    if (
      this.policy.maxEstimatedCostUsd !== undefined &&
      reservation.estimatedCostUsd === undefined
    ) {
      return this.#deny(
        "estimated-cost-unavailable",
        this.policy.maxEstimatedCostUsd,
        undefined,
        ready.snapshot.elapsedMs,
      );
    }
    const projectedCost = ready.snapshot.estimatedCostUsd + (reservation.estimatedCostUsd ?? 0);
    if (
      this.policy.maxEstimatedCostUsd !== undefined &&
      projectedCost > this.policy.maxEstimatedCostUsd
    ) {
      return this.#deny(
        "estimated-cost",
        this.policy.maxEstimatedCostUsd,
        projectedCost,
        ready.snapshot.elapsedMs,
      );
    }

    this.#attempts.set(reservation.callId, {
      reservation,
      usage: undefined,
      settled: false,
    });
    this.#modelAttempts = projectedAttempts;
    return this.#allow(ready.snapshot.elapsedMs);
  }

  recordModelUsage(callId: string, usageInput: TokenUsage): RunBudgetDecision {
    const record = this.#activeAttempt(callId);
    const parsed = TokenUsageSchema.safeParse(usageInput);
    if (!parsed.success) {
      throw new RunBudgetError(
        `Model usage validation failed with ${parsed.error.issues.length} issue(s)`,
        { callId, issueCount: parsed.error.issues.length },
        parsed.error,
      );
    }
    record.usage = mergeCumulativeUsage(callId, record.usage, parsed.data);
    return this.#evaluateCurrentUsage();
  }

  settleModelAttempt(callId: string): RunBudgetDecision {
    const record = this.#activeAttempt(callId);
    record.settled = true;
    return this.#evaluateCurrentUsage();
  }

  startToolCalls(count: number): RunBudgetDecision {
    if (!Number.isInteger(count) || count < 0) {
      throw new RunBudgetError("Tool-call count must be a non-negative integer", { count });
    }
    const ready = this.#readyForOperation();
    if (!ready.allowed) {
      return ready;
    }
    const projected = this.#toolCalls + count;
    if (projected > this.policy.maxToolCalls) {
      return this.#deny(
        "tool-calls",
        this.policy.maxToolCalls,
        projected,
        ready.snapshot.elapsedMs,
      );
    }
    this.#toolCalls = projected;
    return this.#allow(ready.snapshot.elapsedMs);
  }

  #activeAttempt(callId: string): AttemptRecord {
    const record = this.#attempts.get(callId);
    if (record === undefined) {
      throw new RunBudgetError("Model usage referenced an unknown call identifier", { callId });
    }
    if (record.settled) {
      throw new RunBudgetError("A settled model attempt cannot be modified", { callId });
    }
    return record;
  }

  #readyForOperation(): RunBudgetDecision {
    const sticky = this.#stickyDecision();
    return sticky ?? this.checkTime();
  }

  #evaluateCurrentUsage(): RunBudgetDecision {
    const sticky = this.#stickyDecision();
    if (sticky !== undefined) {
      return sticky;
    }
    const elapsedMs = this.#elapsed();
    if (elapsedMs >= this.policy.maxElapsedMs) {
      return this.#deny("elapsed-time", this.policy.maxElapsedMs, elapsedMs, elapsedMs);
    }
    const snapshot = this.#snapshot(elapsedMs);
    if (
      this.policy.maxInputTokens !== undefined &&
      snapshot.inputTokens > this.policy.maxInputTokens
    ) {
      return this.#deny(
        "input-tokens",
        this.policy.maxInputTokens,
        snapshot.inputTokens,
        elapsedMs,
      );
    }
    if (
      this.policy.maxOutputTokens !== undefined &&
      snapshot.outputTokens > this.policy.maxOutputTokens
    ) {
      return this.#deny(
        "output-tokens",
        this.policy.maxOutputTokens,
        snapshot.outputTokens,
        elapsedMs,
      );
    }
    if (
      this.policy.maxEstimatedCostUsd !== undefined &&
      snapshot.estimatedCostUsd > this.policy.maxEstimatedCostUsd
    ) {
      return this.#deny(
        "estimated-cost",
        this.policy.maxEstimatedCostUsd,
        snapshot.estimatedCostUsd,
        elapsedMs,
      );
    }
    return this.#allow(elapsedMs);
  }

  #stickyDecision(): RunBudgetDecision | undefined {
    if (this.#exhaustion === undefined) {
      return undefined;
    }
    const snapshot = this.#snapshot(this.#elapsed());
    return Object.freeze({ allowed: false, exhaustion: this.#exhaustion, snapshot });
  }

  #allow(elapsedMs: number): RunBudgetDecision {
    return Object.freeze({ allowed: true, snapshot: this.#snapshot(elapsedMs) });
  }

  #deny(
    resource: RunBudgetResource,
    limit: number,
    observed: number | undefined,
    elapsedMs: number,
  ): RunBudgetDecision {
    this.#exhaustion = Object.freeze({ resource, limit, observed });
    const snapshot = this.#snapshot(elapsedMs);
    return Object.freeze({ allowed: false, exhaustion: this.#exhaustion, snapshot });
  }

  #snapshot(elapsedMs: number): RunBudgetSnapshot {
    const totals = this.#usageTotals();
    return Object.freeze({
      policy: this.policy,
      elapsedMs,
      cycles: this.#cycles,
      modelAttempts: this.#modelAttempts,
      toolCalls: this.#toolCalls,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      estimatedCostUsd: totals.estimatedCostUsd,
      activeModelAttempts: [...this.#attempts.values()].filter((attempt) => !attempt.settled)
        .length,
      ...(this.#exhaustion === undefined ? {} : { exhaustion: this.#exhaustion }),
    });
  }

  #usageTotals(): {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCostUsd: number;
  } {
    let inputTokens = 0;
    let outputTokens = 0;
    let estimatedCostUsd = 0;
    for (const record of this.#attempts.values()) {
      inputTokens += chargedValue(
        record.reservation.inputTokens,
        record.usage?.inputTokens,
        record.settled,
      );
      outputTokens += chargedValue(
        record.reservation.outputTokens,
        record.usage?.outputTokens,
        record.settled,
      );
      estimatedCostUsd += chargedValue(
        record.reservation.estimatedCostUsd ?? 0,
        record.usage?.estimatedCostUsd,
        record.settled,
      );
    }
    return { inputTokens, outputTokens, estimatedCostUsd };
  }

  #elapsed(): number {
    const now = this.#readClock();
    if (now < this.#lastObservedMs) {
      throw new RunBudgetError("Monotonic clock moved backwards", {
        previous: this.#lastObservedMs,
        current: now,
      });
    }
    this.#lastObservedMs = now;
    return now - this.#startedAtMs;
  }

  #readClock(): number {
    const value = this.#clock.nowMilliseconds();
    if (!Number.isFinite(value) || value < 0) {
      throw new RunBudgetError("Monotonic clock must return a non-negative finite number");
    }
    return value;
  }
}

function parseReservation(input: ModelAttemptReservation): Readonly<ModelAttemptReservation> {
  if (input.callId.trim().length === 0) {
    throw new RunBudgetError("Model-attempt call identifier must not be empty");
  }
  for (const [field, value] of [
    ["inputTokens", input.inputTokens],
    ["outputTokens", input.outputTokens],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RunBudgetError(`${field} reservation must be a non-negative integer`, { value });
    }
  }
  if (
    input.estimatedCostUsd !== undefined &&
    (!Number.isFinite(input.estimatedCostUsd) || input.estimatedCostUsd < 0)
  ) {
    throw new RunBudgetError("Estimated cost reservation must be non-negative and finite");
  }
  return Object.freeze({
    callId: input.callId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    ...(input.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: input.estimatedCostUsd }),
  });
}

function mergeCumulativeUsage(
  callId: string,
  current: TokenUsage | undefined,
  update: TokenUsage,
): TokenUsage {
  if (current === undefined) {
    return update;
  }
  const merged: Record<string, unknown> = {
    source: current.source === update.source ? current.source : "mixed",
  };
  for (const field of usageFields) {
    const previous = current[field];
    const next = update[field];
    if (previous !== undefined && next !== undefined && next < previous) {
      throw new RunBudgetError("Cumulative model usage cannot decrease", {
        callId,
        field,
        previous,
        next,
      });
    }
    const value = next ?? previous;
    if (value !== undefined) {
      merged[field] = value;
    }
  }
  return TokenUsageSchema.parse(merged);
}

function chargedValue(reserved: number, actual: number | undefined, settled: boolean): number {
  if (settled) {
    return actual ?? reserved;
  }
  return Math.max(reserved, actual ?? 0);
}
