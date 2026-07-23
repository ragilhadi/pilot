import { CancellationError, ModelContractValidationError, ModelError } from "@pilotrun/core";
import { describe, expect, it, vi } from "vitest";
import {
  calculateRetryDelay,
  classifyModelRetryError,
  ModelStreamProtocolError,
  RetryExecutor,
  type RetryLifecycleEvent,
} from "../src/index.js";

const policy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  jitterRatio: 0.2,
} as const;

describe("calculateRetryDelay", () => {
  it("applies exponential backoff and symmetric jitter", () => {
    expect(calculateRetryDelay(policy, 1, 0)).toEqual({ kind: "scheduled", delayMs: 80 });
    expect(calculateRetryDelay(policy, 1, 0.5)).toEqual({ kind: "scheduled", delayMs: 100 });
    expect(calculateRetryDelay(policy, 1, 0.999)).toEqual({ kind: "scheduled", delayMs: 120 });
    expect(calculateRetryDelay(policy, 2, 0.5)).toEqual({ kind: "scheduled", delayMs: 200 });
    expect(calculateRetryDelay(policy, 20, 0.999)).toEqual({
      kind: "scheduled",
      delayMs: 1_000,
    });
  });

  it("honors provider retry hints without exceeding policy", () => {
    expect(calculateRetryDelay(policy, 1, 0.5, 300)).toEqual({
      kind: "scheduled",
      delayMs: 300,
    });
    expect(calculateRetryDelay(policy, 1, 0.5, 2_000)).toEqual({
      kind: "exceeds-policy",
      requestedDelayMs: 2_000,
    });
  });

  it.each([-0.1, 1, Number.NaN])("rejects invalid random value %s", (randomValue) => {
    expect(() => calculateRetryDelay(policy, 1, randomValue)).toThrow(ModelContractValidationError);
  });
});

describe("classifyModelRetryError", () => {
  it.each([
    ["rate-limit", true, "rate-limit"],
    ["unavailable", true, "unavailable"],
    ["provider-error", true, "provider-error"],
    ["authentication", false, "authentication"],
    ["context-limit", false, "context-limit"],
    ["invalid-request", false, "invalid-request"],
  ] as const)("classifies %s", (kind, retryable, reason) => {
    const error = new ModelError({
      kind,
      providerId: "fake",
      modelId: "scripted",
      message: "internal",
      retryable: true,
    });

    expect(classifyModelRetryError(error)).toMatchObject({ retryable, reason });
  });

  it("never retries contract, protocol, cancellation, or unknown errors", () => {
    const errors = [
      new ModelContractValidationError("request", 1, new Error("bad")),
      new ModelStreamProtocolError("unexpected-sequence", "bad sequence"),
      new CancellationError(),
      new Error("unknown"),
    ];

    expect(errors.map((error) => classifyModelRetryError(error).retryable)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("respects a transient error explicitly marked non-retryable", () => {
    const error = new ModelError({
      kind: "provider-error",
      providerId: "fake",
      modelId: "scripted",
      message: "deterministic provider failure",
      retryable: false,
    });

    expect(classifyModelRetryError(error).retryable).toBe(false);
  });
});

describe("RetryExecutor", () => {
  it("returns immediately after a successful first attempt", async () => {
    const sleep = vi.fn(async () => undefined);
    const events: RetryLifecycleEvent[] = [];
    const executor = new RetryExecutor({
      random: () => 0.5,
      sleep,
      observer: (event) => {
        events.push(event);
      },
    });

    const value = await executor.execute(async ({ attempt }) => `attempt-${attempt}`, {
      policy,
      safety: { mode: "idempotent" },
      signal: new AbortController().signal,
    });

    expect(value).toBe("attempt-1");
    expect(sleep).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(["attempt.started", "attempt.succeeded"]);
  });

  it("retries transient failures with stable idempotency context", async () => {
    const delays: number[] = [];
    const contexts: Array<{ attempt: number; key: string | undefined }> = [];
    const events: RetryLifecycleEvent[] = [];
    const executor = new RetryExecutor({
      random: () => 0.5,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      observer: (event) => {
        events.push(event);
      },
    });

    const result = await executor.execute(
      async ({ attempt, idempotencyKey }) => {
        contexts.push({ attempt, key: idempotencyKey });
        if (attempt < 3) {
          throw new ModelError({
            kind: "unavailable",
            providerId: "fake",
            modelId: "scripted",
            message: "temporary outage",
          });
        }
        return "ok";
      },
      {
        policy,
        safety: { mode: "idempotent-with-key", key: "request-1" },
        signal: new AbortController().signal,
      },
    );

    expect(result).toBe("ok");
    expect(delays).toEqual([100, 200]);
    expect(contexts).toEqual([
      { attempt: 1, key: "request-1" },
      { attempt: 2, key: "request-1" },
      { attempt: 3, key: "request-1" },
    ]);
    expect(events.filter((event) => event.type === "retry.scheduled")).toHaveLength(2);
  });

  it("uses a provider retry hint as the minimum delay", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const executor = new RetryExecutor({
      random: () => 0.5,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await executor.execute(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new ModelError({
            kind: "rate-limit",
            providerId: "fake",
            modelId: "scripted",
            message: "429",
            retryAfterMs: 350,
          });
        }
        return "ok";
      },
      {
        policy,
        safety: { mode: "idempotent" },
        signal: new AbortController().signal,
      },
    );

    expect(delays).toEqual([350]);
  });

  it("stops at the attempt limit and rethrows the original error", async () => {
    const failure = new ModelError({
      kind: "unavailable",
      providerId: "fake",
      modelId: "scripted",
      message: "still unavailable",
    });
    const operation = vi.fn(async () => {
      throw failure;
    });
    const executor = new RetryExecutor({
      random: () => 0.5,
      sleep: async () => undefined,
    });

    await expect(
      executor.execute(operation, {
        policy,
        safety: { mode: "idempotent" },
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-idempotent work", async () => {
    const events: RetryLifecycleEvent[] = [];
    const operation = vi.fn(async () => {
      throw new ModelError({
        kind: "unavailable",
        providerId: "fake",
        modelId: "scripted",
        message: "temporary",
      });
    });
    const executor = new RetryExecutor({
      random: () => 0.5,
      sleep: async () => undefined,
      observer: (event) => {
        events.push(event);
      },
    });

    await expect(
      executor.execute(operation, {
        policy,
        safety: { mode: "non-idempotent" },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ModelError);
    expect(operation).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({
      type: "retry.exhausted",
      reason: "non-idempotent",
    });
  });

  it("refuses a provider delay beyond the configured maximum", async () => {
    const sleep = vi.fn(async () => undefined);
    const random = vi.fn(() => 0.5);
    const events: RetryLifecycleEvent[] = [];
    const failure = new ModelError({
      kind: "rate-limit",
      providerId: "fake",
      modelId: "scripted",
      message: "long rate limit",
      retryAfterMs: 5_000,
    });
    const executor = new RetryExecutor({
      random,
      sleep,
      observer: (event) => {
        events.push(event);
      },
    });

    await expect(
      executor.execute(async () => Promise.reject(failure), {
        policy,
        safety: { mode: "idempotent" },
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(failure);
    expect(sleep).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "retry.exhausted",
      reason: "delay-exceeds-policy",
    });
  });

  it("cancels before the first attempt", async () => {
    const controller = new AbortController();
    controller.abort("user request");
    const operation = vi.fn(async () => "not reached");
    const executor = new RetryExecutor({
      random: () => 0.5,
      sleep: async () => undefined,
    });

    await expect(
      executor.execute(operation, {
        policy,
        safety: { mode: "idempotent" },
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CancellationError);
    expect(operation).not.toHaveBeenCalled();
  });

  it("cancels during retry delay without starting another attempt", async () => {
    const controller = new AbortController();
    const events: RetryLifecycleEvent[] = [];
    const operation = vi.fn(async () => {
      throw new ModelError({
        kind: "unavailable",
        providerId: "fake",
        modelId: "scripted",
        message: "temporary",
      });
    });
    const executor = new RetryExecutor({
      random: () => 0.5,
      sleep: async () => {
        controller.abort("cancel during backoff");
        throw new CancellationError(controller.signal.reason);
      },
      observer: (event) => {
        events.push(event);
      },
    });

    await expect(
      executor.execute(operation, {
        policy,
        safety: { mode: "idempotent" },
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CancellationError);
    expect(operation).toHaveBeenCalledOnce();
    expect(events.at(-1)?.type).toBe("retry.cancelled");
  });

  it("reports only safe error details to observers", async () => {
    const events: RetryLifecycleEvent[] = [];
    const executor = new RetryExecutor({
      random: () => 0.5,
      sleep: async () => undefined,
      observer: (event) => {
        events.push(event);
      },
    });

    await expect(
      executor.execute(
        async () => {
          throw new ModelError({
            kind: "authentication",
            providerId: "fake",
            modelId: "scripted",
            message: "api-key=secret-value",
          });
        },
        {
          policy,
          safety: { mode: "idempotent" },
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toBeInstanceOf(ModelError);

    expect(JSON.stringify(events)).not.toContain("secret-value");
  });

  it("rejects an empty idempotency key before invoking the operation", async () => {
    const operation = vi.fn(async () => "not reached");
    const executor = new RetryExecutor({
      random: () => 0.5,
      sleep: async () => undefined,
    });

    await expect(
      executor.execute(operation, {
        policy,
        safety: { mode: "idempotent-with-key", key: " " },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ModelContractValidationError);
    expect(operation).not.toHaveBeenCalled();
  });
});
