import { runId } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import {
  RunBudgetError,
  RunBudgetPolicySchema,
  RunBudgetTracker,
  RunStateMachine,
  type MonotonicClock,
  type RunBudgetPolicy,
} from "../src/index.js";

const policy = {
  maxCycles: 2,
  maxModelAttempts: 3,
  maxToolCalls: 3,
  maxElapsedMs: 1_000,
  maxInputTokens: 100,
  maxOutputTokens: 50,
  maxEstimatedCostUsd: 1,
} as const satisfies RunBudgetPolicy;

function controlledClock(initial = 0): MonotonicClock & { set(value: number): void } {
  let now = initial;
  return {
    nowMilliseconds: () => now,
    set(value) {
      now = value;
    },
  };
}

function tracker(overrides: Partial<RunBudgetPolicy> = {}) {
  const clock = controlledClock();
  return {
    clock,
    budget: new RunBudgetTracker({ ...policy, ...overrides }, clock),
  };
}

describe("RunBudgetPolicy", () => {
  it("accepts independent limits and freezes the parsed policy", () => {
    const parsed = RunBudgetPolicySchema.parse({
      ...policy,
      maxCycles: 10,
      maxModelAttempts: 1,
    });

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.maxModelAttempts).toBe(1);
  });

  it.each([
    { ...policy, maxCycles: 0 },
    { ...policy, maxModelAttempts: 1.5 },
    { ...policy, maxToolCalls: -1 },
    { ...policy, maxElapsedMs: 0 },
    { ...policy, maxInputTokens: -1 },
    { ...policy, maxOutputTokens: 1.2 },
    { ...policy, maxEstimatedCostUsd: Number.NaN },
    { ...policy, unknownLimit: 1 },
  ])("rejects invalid policy %#", (invalid) => {
    expect(() => new RunBudgetTracker(invalid, controlledClock())).toThrow(RunBudgetError);
  });
});

describe("count and elapsed-time budgets", () => {
  it("allows cycles at the exact limit and makes exhaustion sticky", () => {
    const { budget } = tracker();

    expect(budget.startCycle().allowed).toBe(true);
    expect(budget.startCycle().allowed).toBe(true);
    const denied = budget.startCycle();

    expect(denied).toMatchObject({
      allowed: false,
      exhaustion: { resource: "cycles", limit: 2, observed: 3 },
      snapshot: { cycles: 2 },
    });
    expect(budget.startToolCalls(1)).toMatchObject({
      allowed: false,
      exhaustion: { resource: "cycles" },
      snapshot: { toolCalls: 0 },
    });
  });

  it("counts model attempts globally across settled retries", () => {
    const { budget } = tracker({
      maxInputTokens: undefined,
      maxOutputTokens: undefined,
      maxEstimatedCostUsd: undefined,
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(
        budget.startModelAttempt({
          callId: `attempt-${attempt}`,
          inputTokens: 0,
          outputTokens: 0,
        }).allowed,
      ).toBe(true);
      expect(budget.settleModelAttempt(`attempt-${attempt}`).allowed).toBe(true);
    }

    expect(
      budget.startModelAttempt({ callId: "attempt-4", inputTokens: 0, outputTokens: 0 }),
    ).toMatchObject({
      allowed: false,
      exhaustion: { resource: "model-attempts", limit: 3, observed: 4 },
      snapshot: { modelAttempts: 3 },
    });
  });

  it("reserves tool calls atomically and never partially consumes a rejected batch", () => {
    const { budget } = tracker();

    expect(budget.startToolCalls(2)).toMatchObject({
      allowed: true,
      snapshot: { toolCalls: 2 },
    });
    expect(budget.startToolCalls(1)).toMatchObject({
      allowed: true,
      snapshot: { toolCalls: 3 },
    });
    expect(budget.startToolCalls(2)).toMatchObject({
      allowed: false,
      exhaustion: { resource: "tool-calls", limit: 3, observed: 5 },
      snapshot: { toolCalls: 3 },
    });
  });

  it("allows time before the deadline and refuses work at the exact deadline", () => {
    const { budget, clock } = tracker();
    clock.set(999);
    expect(budget.checkTime().allowed).toBe(true);

    clock.set(1_000);
    expect(budget.checkTime()).toMatchObject({
      allowed: false,
      exhaustion: { resource: "elapsed-time", limit: 1_000, observed: 1_000 },
    });
  });

  it("enforces the deadline during in-flight usage accounting", () => {
    const { budget, clock } = tracker();
    budget.startModelAttempt({
      callId: "call-long-running",
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: 0,
    });
    clock.set(1_000);

    expect(
      budget.recordModelUsage("call-long-running", {
        outputTokens: 1,
        source: "provider",
      }),
    ).toMatchObject({
      allowed: false,
      exhaustion: { resource: "elapsed-time", observed: 1_000 },
    });
  });

  it("rejects an invalid or backwards monotonic clock", () => {
    expect(() => new RunBudgetTracker(policy, { nowMilliseconds: () => Number.NaN })).toThrow(
      RunBudgetError,
    );

    const { budget, clock } = tracker();
    clock.set(10);
    budget.snapshot();
    clock.set(9);
    expect(() => budget.snapshot()).toThrow(RunBudgetError);
  });
});

describe("model token and cost reservations", () => {
  it("charges active reservations, then releases unused capacity on settlement", () => {
    const { budget } = tracker();

    expect(
      budget.startModelAttempt({
        callId: "call-1",
        inputTokens: 60,
        outputTokens: 40,
        estimatedCostUsd: 0.5,
      }),
    ).toMatchObject({
      allowed: true,
      snapshot: {
        inputTokens: 60,
        outputTokens: 40,
        estimatedCostUsd: 0.5,
        activeModelAttempts: 1,
      },
    });
    budget.recordModelUsage("call-1", {
      inputTokens: 55,
      outputTokens: 20,
      estimatedCostUsd: 0.3,
      source: "provider",
    });
    expect(budget.snapshot()).toMatchObject({
      inputTokens: 60,
      outputTokens: 40,
      estimatedCostUsd: 0.5,
    });

    expect(budget.settleModelAttempt("call-1")).toMatchObject({
      allowed: true,
      snapshot: {
        inputTokens: 55,
        outputTokens: 20,
        estimatedCostUsd: 0.3,
        activeModelAttempts: 0,
      },
    });
    expect(
      budget.startModelAttempt({
        callId: "call-2",
        inputTokens: 45,
        outputTokens: 30,
        estimatedCostUsd: 0.7,
      }),
    ).toMatchObject({
      allowed: true,
      snapshot: { inputTokens: 100, outputTokens: 50, estimatedCostUsd: 1 },
    });
  });

  it("merges cumulative stream usage instead of double-counting updates", () => {
    const { budget } = tracker();
    budget.startModelAttempt({
      callId: "call-cumulative",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    });

    budget.recordModelUsage("call-cumulative", {
      inputTokens: 10,
      outputTokens: 4,
      estimatedCostUsd: 0.1,
      source: "provider",
    });
    budget.recordModelUsage("call-cumulative", {
      inputTokens: 15,
      outputTokens: 7,
      estimatedCostUsd: 0.15,
      source: "provider",
    });

    expect(budget.snapshot()).toMatchObject({
      inputTokens: 15,
      outputTokens: 7,
      estimatedCostUsd: 0.15,
    });
  });

  it("retains reservations for usage fields a provider does not measure", () => {
    const { budget } = tracker();
    budget.startModelAttempt({
      callId: "call-partial",
      inputTokens: 40,
      outputTokens: 25,
      estimatedCostUsd: 0.2,
    });
    budget.recordModelUsage("call-partial", { outputTokens: 10, source: "provider" });

    expect(budget.settleModelAttempt("call-partial")).toMatchObject({
      allowed: true,
      snapshot: { inputTokens: 40, outputTokens: 10, estimatedCostUsd: 0.2 },
    });
  });

  it("refuses an attempt when configured cost cannot be estimated", () => {
    const { budget } = tracker();

    expect(
      budget.startModelAttempt({ callId: "call-no-cost", inputTokens: 1, outputTokens: 1 }),
    ).toMatchObject({
      allowed: false,
      exhaustion: { resource: "estimated-cost-unavailable", limit: 1, observed: undefined },
      snapshot: { modelAttempts: 0, activeModelAttempts: 0 },
    });
  });

  it.each([
    ["input-tokens", { inputTokens: 101, outputTokens: 1, estimatedCostUsd: 0 }],
    ["output-tokens", { inputTokens: 1, outputTokens: 51, estimatedCostUsd: 0 }],
    ["estimated-cost", { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 1.01 }],
  ] as const)("refuses a projected %s excess before transport", (resource, reservation) => {
    const { budget } = tracker();

    expect(budget.startModelAttempt({ callId: `call-${resource}`, ...reservation })).toMatchObject({
      allowed: false,
      exhaustion: { resource },
      snapshot: { modelAttempts: 0 },
    });
  });

  it("detects provider usage that exceeds its reservation and limit", () => {
    const { budget } = tracker({ maxOutputTokens: 10 });
    budget.startModelAttempt({
      callId: "call-overrun",
      inputTokens: 1,
      outputTokens: 5,
      estimatedCostUsd: 0,
    });

    expect(
      budget.recordModelUsage("call-overrun", {
        outputTokens: 12,
        source: "provider",
      }),
    ).toMatchObject({
      allowed: false,
      exhaustion: { resource: "output-tokens", limit: 10, observed: 12 },
      snapshot: { outputTokens: 12 },
    });
  });
});

describe("accounting guards and run-state integration", () => {
  it("rejects duplicate, concurrent, unknown, settled, and decreasing accounting", () => {
    const { budget } = tracker();
    budget.startModelAttempt({
      callId: "call-1",
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: 0,
    });

    expect(() =>
      budget.startModelAttempt({
        callId: "call-1",
        inputTokens: 1,
        outputTokens: 1,
        estimatedCostUsd: 0,
      }),
    ).toThrow(RunBudgetError);
    expect(() =>
      budget.startModelAttempt({
        callId: "call-2",
        inputTokens: 1,
        outputTokens: 1,
        estimatedCostUsd: 0,
      }),
    ).toThrow(RunBudgetError);
    expect(() =>
      budget.recordModelUsage("missing", { outputTokens: 1, source: "provider" }),
    ).toThrow(RunBudgetError);

    budget.recordModelUsage("call-1", { outputTokens: 1, source: "provider" });
    expect(() =>
      budget.recordModelUsage("call-1", { outputTokens: 0, source: "provider" }),
    ).toThrow(RunBudgetError);
    budget.settleModelAttempt("call-1");
    expect(() =>
      budget.recordModelUsage("call-1", { outputTokens: 2, source: "provider" }),
    ).toThrow(RunBudgetError);
  });

  it.each([
    { callId: "", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    { callId: "call", inputTokens: -1, outputTokens: 0, estimatedCostUsd: 0 },
    { callId: "call", inputTokens: 0.5, outputTokens: 0, estimatedCostUsd: 0 },
    { callId: "call", inputTokens: 0, outputTokens: -1, estimatedCostUsd: 0 },
    { callId: "call", inputTokens: 0, outputTokens: 0, estimatedCostUsd: Number.NaN },
  ])("rejects invalid reservation %#", (reservation) => {
    const { budget } = tracker();
    expect(() => budget.startModelAttempt(reservation)).toThrow(RunBudgetError);
  });

  it("maps exhaustion to the state machine's budget-exhausted terminal reason", () => {
    const { budget } = tracker({ maxCycles: 1 });
    const machine = new RunStateMachine(runId("run-budget"));
    machine.transition({ type: "run.start" });
    expect(budget.startCycle().allowed).toBe(true);

    const denied = budget.startCycle();
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      machine.transition({ type: "run.cancel", reason: "budget-exhausted" });
    }

    expect(machine.state).toMatchObject({
      kind: "aborted",
      previousKind: "preparing-context",
      reason: "budget-exhausted",
    });
  });

  it("returns deeply stable top-level snapshots", () => {
    const { budget } = tracker();
    const snapshot = budget.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.policy)).toBe(true);
  });
});
