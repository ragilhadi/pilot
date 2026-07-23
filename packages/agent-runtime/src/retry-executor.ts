import {
  CancellationError,
  ModelContractValidationError,
  ModelError,
  type RetryPolicy,
  RetryPolicySchema,
  type SafeErrorSnapshot,
  toSafeErrorSnapshot,
} from "@pilot/core";
import { ModelStreamProtocolError } from "./model-stream-accumulator.js";

export type RetrySafety =
  | { readonly mode: "idempotent" }
  | { readonly mode: "idempotent-with-key"; readonly key: string }
  | { readonly mode: "non-idempotent" };

export type RetryClassificationReason =
  | "authentication"
  | "cancelled"
  | "context-limit"
  | "invalid-model-data"
  | "invalid-request"
  | "provider-error"
  | "rate-limit"
  | "stream-protocol"
  | "unavailable"
  | "unknown";

export interface RetryClassification {
  readonly retryable: boolean;
  readonly reason: RetryClassificationReason;
  readonly retryAfterMs?: number;
}

export type RetryClassifier = (error: unknown) => RetryClassification;

export interface RetryAttemptContext {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly idempotencyKey: string | undefined;
  readonly signal: AbortSignal;
}

export type RetryLifecycleEvent =
  | {
      readonly type: "attempt.started";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly idempotencyKey: string | undefined;
    }
  | {
      readonly type: "attempt.failed";
      readonly attempt: number;
      readonly error: SafeErrorSnapshot;
      readonly classification: RetryClassification;
    }
  | {
      readonly type: "retry.scheduled";
      readonly failedAttempt: number;
      readonly nextAttempt: number;
      readonly delayMs: number;
      readonly reason: RetryClassificationReason;
    }
  | {
      readonly type: "retry.exhausted";
      readonly attempt: number;
      readonly reason:
        | "attempt-limit"
        | "delay-exceeds-policy"
        | "non-idempotent"
        | "not-retryable";
      readonly failureReason: RetryClassificationReason;
    }
  | {
      readonly type: "retry.cancelled";
      readonly failedAttempt: number;
      readonly nextAttempt: number;
    }
  | {
      readonly type: "attempt.succeeded";
      readonly attempt: number;
    };

export type RetryObserver = (event: RetryLifecycleEvent) => void | Promise<void>;

export interface RetryExecutorDependencies {
  readonly random: () => number;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly observer?: RetryObserver;
}

export interface RetryExecutionOptions {
  readonly policy: RetryPolicy;
  readonly safety: RetrySafety;
  readonly signal: AbortSignal;
  readonly classifyError?: RetryClassifier;
}

export type RetryDelayDecision =
  | { readonly kind: "scheduled"; readonly delayMs: number }
  | { readonly kind: "exceeds-policy"; readonly requestedDelayMs: number };

export function calculateRetryDelay(
  policyInput: RetryPolicy,
  failedAttempt: number,
  randomValue: number,
  retryAfterMs?: number,
): RetryDelayDecision {
  const policy = RetryPolicySchema.parse(policyInput);
  if (!Number.isInteger(failedAttempt) || failedAttempt < 1) {
    throw new ModelContractValidationError(
      "retry attempt",
      1,
      new RangeError("Failed attempt must be a positive integer"),
    );
  }
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new ModelContractValidationError(
      "retry random source",
      1,
      new RangeError("Random values must be in the range [0, 1)"),
    );
  }
  if (retryAfterMs !== undefined) {
    if (!Number.isInteger(retryAfterMs) || retryAfterMs < 0) {
      throw new ModelContractValidationError(
        "provider retry hint",
        1,
        new RangeError("Retry hints must be non-negative integers"),
      );
    }
    if (retryAfterMs > policy.maxDelayMs) {
      return Object.freeze({ kind: "exceeds-policy", requestedDelayMs: retryAfterMs });
    }
  }

  const exponent = Math.min(failedAttempt - 1, 52);
  const exponentialDelay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const jitterMultiplier = 1 - policy.jitterRatio + randomValue * (policy.jitterRatio * 2);
  const jitteredDelay = Math.min(
    policy.maxDelayMs,
    Math.max(0, Math.round(exponentialDelay * jitterMultiplier)),
  );
  return Object.freeze({
    kind: "scheduled",
    delayMs: Math.max(jitteredDelay, retryAfterMs ?? 0),
  });
}

export function classifyModelRetryError(error: unknown): RetryClassification {
  if (error instanceof CancellationError) {
    return Object.freeze({ retryable: false, reason: "cancelled" });
  }
  if (error instanceof ModelStreamProtocolError) {
    return Object.freeze({ retryable: false, reason: "stream-protocol" });
  }
  if (error instanceof ModelContractValidationError) {
    return Object.freeze({ retryable: false, reason: "invalid-model-data" });
  }
  if (!(error instanceof ModelError)) {
    return Object.freeze({ retryable: false, reason: "unknown" });
  }

  const retryableKind =
    error.kind === "provider-error" || error.kind === "rate-limit" || error.kind === "unavailable";
  return Object.freeze({
    retryable: retryableKind && error.retryable,
    reason: error.kind,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  });
}

export class RetryExecutor {
  readonly #random: () => number;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #observer: RetryObserver | undefined;

  constructor(dependencies: RetryExecutorDependencies) {
    this.#random = dependencies.random;
    this.#sleep = dependencies.sleep;
    this.#observer = dependencies.observer;
  }

  async execute<Value>(
    operation: (context: RetryAttemptContext) => Promise<Value>,
    options: RetryExecutionOptions,
  ): Promise<Value> {
    const policy = RetryPolicySchema.parse(options.policy);
    const idempotencyKey = validateSafety(options.safety);
    const classifier = options.classifyError ?? classifyModelRetryError;

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      throwIfAborted(options.signal);
      await this.#emit({
        type: "attempt.started",
        attempt,
        maxAttempts: policy.maxAttempts,
        idempotencyKey,
      });

      try {
        const value = await operation({
          attempt,
          maxAttempts: policy.maxAttempts,
          idempotencyKey,
          signal: options.signal,
        });
        await this.#emit({ type: "attempt.succeeded", attempt });
        return value;
      } catch (caught) {
        const error = options.signal.aborted
          ? new CancellationError(options.signal.reason)
          : caught;
        const classification = validateClassification(classifier(error));
        await this.#emit({
          type: "attempt.failed",
          attempt,
          error: toSafeErrorSnapshot(error),
          classification,
        });

        const exhaustionReason = retryExhaustionReason(
          classification,
          options.safety,
          attempt,
          policy.maxAttempts,
        );
        if (exhaustionReason !== undefined) {
          await this.#emit({
            type: "retry.exhausted",
            attempt,
            reason: exhaustionReason,
            failureReason: classification.reason,
          });
          throw error;
        }

        if (
          classification.retryAfterMs !== undefined &&
          classification.retryAfterMs > policy.maxDelayMs
        ) {
          await this.#emit({
            type: "retry.exhausted",
            attempt,
            reason: "delay-exceeds-policy",
            failureReason: classification.reason,
          });
          throw error;
        }

        const randomValue = policy.jitterRatio === 0 ? 0.5 : this.#random();
        const delay = calculateRetryDelay(
          policy,
          attempt,
          randomValue,
          classification.retryAfterMs,
        );
        if (delay.kind === "exceeds-policy") {
          await this.#emit({
            type: "retry.exhausted",
            attempt,
            reason: "delay-exceeds-policy",
            failureReason: classification.reason,
          });
          throw error;
        }

        await this.#emit({
          type: "retry.scheduled",
          failedAttempt: attempt,
          nextAttempt: attempt + 1,
          delayMs: delay.delayMs,
          reason: classification.reason,
        });
        try {
          await this.#sleep(delay.delayMs, options.signal);
        } catch (sleepError) {
          if (options.signal.aborted || sleepError instanceof CancellationError) {
            await this.#emit({
              type: "retry.cancelled",
              failedAttempt: attempt,
              nextAttempt: attempt + 1,
            });
            throw new CancellationError(options.signal.reason);
          }
          throw sleepError;
        }
      }
    }

    throw new ModelContractValidationError(
      "retry executor",
      1,
      new Error("Retry loop exited without returning or throwing"),
    );
  }

  async #emit(event: RetryLifecycleEvent): Promise<void> {
    await this.#observer?.(Object.freeze(event));
  }
}

function retryExhaustionReason(
  classification: RetryClassification,
  safety: RetrySafety,
  attempt: number,
  maxAttempts: number,
): "attempt-limit" | "non-idempotent" | "not-retryable" | undefined {
  if (!classification.retryable) {
    return "not-retryable";
  }
  if (safety.mode === "non-idempotent") {
    return "non-idempotent";
  }
  if (attempt >= maxAttempts) {
    return "attempt-limit";
  }
  return undefined;
}

function validateSafety(safety: RetrySafety): string | undefined {
  if (safety.mode === "idempotent-with-key") {
    if (safety.key.trim().length === 0) {
      throw new ModelContractValidationError(
        "retry safety",
        1,
        new Error("Idempotency keys must not be empty"),
      );
    }
    return safety.key;
  }
  return undefined;
}

function validateClassification(classification: RetryClassification): RetryClassification {
  if (
    classification.retryAfterMs !== undefined &&
    (!Number.isInteger(classification.retryAfterMs) || classification.retryAfterMs < 0)
  ) {
    throw new ModelContractValidationError(
      "retry classification",
      1,
      new RangeError("Retry-after values must be non-negative integers"),
    );
  }
  return Object.freeze({ ...classification });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CancellationError(signal.reason);
  }
}
