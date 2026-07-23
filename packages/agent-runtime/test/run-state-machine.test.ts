import { runId, toolCallId, type SafeErrorSnapshot, type ToolCallId } from "@pilot/core";
import { describe, expect, it } from "vitest";
import {
  allowedRunActionTypes,
  createIdleRunState,
  isTerminalRunState,
  RunStateMachine,
  RunTransitionError,
  transitionRun,
  type RunAction,
  type RunState,
} from "../src/index.js";

const callOne = toolCallId("call-1");
const callTwo = toolCallId("call-2");
const failure: SafeErrorSnapshot = Object.freeze({
  code: "PILOT_MODEL_UNAVAILABLE",
  message: "Model provider is unavailable",
  retryable: true,
  metadata: Object.freeze({ providerId: "fake" }),
});

function start(machine: RunStateMachine): void {
  machine.transition({ type: "run.start" });
  machine.transition({ type: "context.prepared", cycle: 1 });
}

function beginStream(machine: RunStateMachine, attempt = 1, responseId = "response-1"): void {
  machine.transition({
    type: "model.stream.started",
    cycle: 1,
    attempt,
    responseId,
  });
}

function completeWithTools(
  machine: RunStateMachine,
  toolCallIds: readonly ToolCallId[] = [callOne],
): void {
  machine.transition({
    type: "model.stream.completed",
    cycle: 1,
    attempt: 1,
    responseId: "response-1",
    finishReason: "tool-calls",
    toolCallIds,
  });
}

describe("RunStateMachine successful paths", () => {
  it("completes a text-only run through immutable, revisioned states", () => {
    const machine = new RunStateMachine(runId("run-1"));

    expect(machine.state).toEqual({ kind: "idle", runId: "run-1", revision: 0 });
    machine.transition({ type: "run.start" });
    expect(machine.state).toMatchObject({ kind: "preparing-context", cycle: 1, revision: 1 });
    machine.transition({ type: "context.prepared", cycle: 1 });
    expect(machine.state).toMatchObject({
      kind: "waiting-for-model",
      cycle: 1,
      attempt: 1,
      revision: 2,
    });
    beginStream(machine);
    expect(machine.state).toMatchObject({
      kind: "receiving-model-stream",
      responseId: "response-1",
      revision: 3,
    });
    machine.transition({
      type: "model.stream.completed",
      cycle: 1,
      attempt: 1,
      responseId: "response-1",
      finishReason: "stop",
      toolCallIds: [],
    });

    expect(machine.state).toEqual({
      kind: "completed",
      runId: "run-1",
      revision: 4,
      cycle: 1,
      finishReason: "stop",
    });
    expect(Object.isFrozen(machine.state)).toBe(true);
    expect(isTerminalRunState(machine.state)).toBe(true);
  });

  it("cycles through permission, execution, result processing, and fresh context", () => {
    const machine = new RunStateMachine(runId("run-tools"));
    start(machine);
    beginStream(machine);
    completeWithTools(machine, [callOne, callTwo]);
    expect(machine.state).toMatchObject({ kind: "awaiting-permission", cycle: 1 });

    machine.transition({
      type: "permissions.resolved",
      cycle: 1,
      approvedToolCallIds: [callOne],
      deniedToolCallIds: [callTwo],
    });
    expect(machine.state).toMatchObject({
      kind: "executing-tools",
      approvedToolCallIds: [callOne],
      deniedToolCallIds: [callTwo],
    });

    machine.transition({ type: "tools.completed", cycle: 1, toolCallIds: [callOne] });
    expect(machine.state).toMatchObject({
      kind: "processing-tool-results",
      toolCallIds: [callOne, callTwo],
    });
    machine.transition({
      type: "tool-results.processed",
      cycle: 1,
      toolCallIds: [callTwo, callOne],
    });

    expect(machine.state).toMatchObject({
      kind: "preparing-context",
      cycle: 2,
      revision: 7,
    });
  });

  it("skips execution when every pending tool call is denied", () => {
    const machine = new RunStateMachine(runId("run-denied"));
    start(machine);
    beginStream(machine);
    completeWithTools(machine, [callOne, callTwo]);

    machine.transition({
      type: "permissions.resolved",
      cycle: 1,
      approvedToolCallIds: [],
      deniedToolCallIds: [callOne, callTwo],
    });

    expect(machine.state).toMatchObject({
      kind: "processing-tool-results",
      toolCallIds: [callOne, callTwo],
    });
  });
});

describe("retry, cancellation, and failure", () => {
  it("increments attempts for a scheduled retry and fails after exhaustion", () => {
    const machine = new RunStateMachine(runId("run-retry"));
    start(machine);

    machine.transition({
      type: "model.attempt.failed",
      cycle: 1,
      attempt: 1,
      retry: "scheduled",
      error: failure,
    });
    expect(machine.state).toMatchObject({ kind: "waiting-for-model", attempt: 2 });
    beginStream(machine, 2, "response-2");
    machine.transition({
      type: "model.attempt.failed",
      cycle: 1,
      attempt: 2,
      retry: "exhausted",
      error: failure,
    });

    expect(machine.state).toMatchObject({
      kind: "failed",
      previousKind: "receiving-model-stream",
      error: failure,
    });
    expect(Object.isFrozen(machine.state)).toBe(true);
    expect(machine.state.kind === "failed" && Object.isFrozen(machine.state.error)).toBe(true);
  });

  it("cancels every nonterminal state and records its previous phase", () => {
    for (const state of nonterminalStateFixtures()) {
      expect(isTerminalRunState(state)).toBe(false);
      const aborted = transitionRun(state, { type: "run.cancel", reason: "user-cancelled" });

      expect(aborted).toMatchObject({
        kind: "aborted",
        previousKind: state.kind,
        reason: "user-cancelled",
        revision: state.revision + 1,
      });
    }
  });

  it("fails safely from every nonterminal state", () => {
    for (const state of nonterminalStateFixtures()) {
      const failed = transitionRun(state, { type: "run.fail", error: failure });

      expect(failed).toMatchObject({
        kind: "failed",
        previousKind: state.kind,
        error: failure,
        revision: state.revision + 1,
      });
    }
  });

  it("snapshots safe failure metadata instead of retaining a mutable input", () => {
    const metadata: Record<string, unknown> = { providerId: "fake" };
    const error: SafeErrorSnapshot = {
      code: "PILOT_MODEL_UNAVAILABLE",
      message: "Unavailable",
      retryable: true,
      metadata,
    };
    const failed = transitionRun(createIdleRunState(runId("run-failed")), {
      type: "run.fail",
      error,
    });
    metadata.providerId = "mutated";

    expect(failed).toMatchObject({
      kind: "failed",
      previousKind: "idle",
      error: { metadata: { providerId: "fake" } },
    });
  });

  it("rejects every action after completion, abortion, or failure", () => {
    const completed = terminalStateFixtures();

    for (const state of completed) {
      expect(() => transitionRun(state, { type: "run.cancel", reason: "shutdown" })).toThrow(
        RunTransitionError,
      );
    }
  });
});

describe("transition guards", () => {
  it.each([
    ["cycle", { type: "model.stream.started", cycle: 2, attempt: 1, responseId: "response-1" }],
    ["attempt", { type: "model.stream.started", cycle: 1, attempt: 2, responseId: "response-1" }],
    ["response ID", { type: "model.stream.started", cycle: 1, attempt: 1, responseId: " " }],
  ] as const)("rejects a stale or invalid %s", (_label, action) => {
    const machine = new RunStateMachine(runId("run-stale"));
    start(machine);

    expect(() => machine.transition(action)).toThrow(RunTransitionError);
  });

  it("rejects a stale completion response identifier", () => {
    const machine = new RunStateMachine(runId("run-stale-response"));
    start(machine);
    beginStream(machine);

    expect(() =>
      machine.transition({
        type: "model.stream.completed",
        cycle: 1,
        attempt: 1,
        responseId: "different-response",
        finishReason: "stop",
        toolCallIds: [],
      }),
    ).toThrow(RunTransitionError);
  });

  it("enforces finish-reason and unique-tool-call invariants", () => {
    const createReceiving = () => {
      const machine = new RunStateMachine(runId("run-finish"));
      start(machine);
      beginStream(machine);
      return machine;
    };

    expect(() =>
      createReceiving().transition({
        type: "model.stream.completed",
        cycle: 1,
        attempt: 1,
        responseId: "response-1",
        finishReason: "tool-calls",
        toolCallIds: [],
      }),
    ).toThrow(RunTransitionError);
    expect(() =>
      createReceiving().transition({
        type: "model.stream.completed",
        cycle: 1,
        attempt: 1,
        responseId: "response-1",
        finishReason: "stop",
        toolCallIds: [callOne],
      }),
    ).toThrow(RunTransitionError);
    expect(() =>
      createReceiving().transition({
        type: "model.stream.completed",
        cycle: 1,
        attempt: 1,
        responseId: "response-1",
        finishReason: "tool-calls",
        toolCallIds: [callOne, callOne],
      }),
    ).toThrow(RunTransitionError);
    expect(() =>
      createReceiving().transition({
        type: "model.stream.completed",
        cycle: 1,
        attempt: 1,
        responseId: "response-1",
        finishReason: "error",
        toolCallIds: [],
      }),
    ).toThrow(RunTransitionError);
  });

  it("requires permission decisions to form an exact, non-overlapping partition", () => {
    const createAwaiting = () => {
      const machine = new RunStateMachine(runId("run-permissions"));
      start(machine);
      beginStream(machine);
      completeWithTools(machine, [callOne, callTwo]);
      return machine;
    };

    expect(() =>
      createAwaiting().transition({
        type: "permissions.resolved",
        cycle: 1,
        approvedToolCallIds: [callOne],
        deniedToolCallIds: [],
      }),
    ).toThrow(RunTransitionError);
    expect(() =>
      createAwaiting().transition({
        type: "permissions.resolved",
        cycle: 1,
        approvedToolCallIds: [callOne],
        deniedToolCallIds: [callOne, callTwo],
      }),
    ).toThrow(RunTransitionError);
  });

  it("requires execution and processing callbacks to match pending tool calls", () => {
    const machine = new RunStateMachine(runId("run-tools-stale"));
    start(machine);
    beginStream(machine);
    completeWithTools(machine, [callOne, callTwo]);
    machine.transition({
      type: "permissions.resolved",
      cycle: 1,
      approvedToolCallIds: [callOne],
      deniedToolCallIds: [callTwo],
    });

    expect(() =>
      machine.transition({ type: "tools.completed", cycle: 1, toolCallIds: [callTwo] }),
    ).toThrow(RunTransitionError);
    machine.transition({ type: "tools.completed", cycle: 1, toolCallIds: [callOne] });
    expect(() =>
      machine.transition({
        type: "tool-results.processed",
        cycle: 1,
        toolCallIds: [callOne],
      }),
    ).toThrow(RunTransitionError);
  });

  it("snapshots tool-call arrays before external mutation", () => {
    const machine = new RunStateMachine(runId("run-snapshot"));
    start(machine);
    beginStream(machine);
    const ids = [callOne];
    completeWithTools(machine, ids);
    ids.push(callTwo);

    expect(machine.state).toMatchObject({ toolCallIds: [callOne] });
    expect(
      machine.state.kind === "awaiting-permission" && Object.isFrozen(machine.state.toolCallIds),
    ).toBe(true);
  });
});

describe("explicit transition table", () => {
  it("is immutable and lists no outgoing terminal actions", () => {
    expect(Object.isFrozen(allowedRunActionTypes)).toBe(true);
    expect(new Set(allStateFixtures().map(({ kind }) => kind))).toEqual(
      new Set(Object.keys(allowedRunActionTypes)),
    );
    for (const kind of ["completed", "aborted", "failed"] as const) {
      expect(allowedRunActionTypes[kind]).toEqual([]);
      expect(Object.isFrozen(allowedRunActionTypes[kind])).toBe(true);
    }
  });

  it("rejects every state/action pair absent from the table", () => {
    const actions = actionFixtures();
    for (const state of allStateFixtures()) {
      const allowed = new Set(allowedRunActionTypes[state.kind]);
      for (const action of actions) {
        if (!allowed.has(action.type)) {
          expect(
            () => transitionRun(state, action),
            `${state.kind} unexpectedly accepted ${action.type}`,
          ).toThrow(RunTransitionError);
        }
      }
    }
  });
});

function nonterminalStateFixtures(): readonly RunState[] {
  const states: RunState[] = [];
  const machine = new RunStateMachine(runId("run-fixture"));
  states.push(machine.state);
  machine.transition({ type: "run.start" });
  states.push(machine.state);
  machine.transition({ type: "context.prepared", cycle: 1 });
  states.push(machine.state);
  beginStream(machine);
  states.push(machine.state);
  completeWithTools(machine);
  states.push(machine.state);
  machine.transition({
    type: "permissions.resolved",
    cycle: 1,
    approvedToolCallIds: [callOne],
    deniedToolCallIds: [],
  });
  states.push(machine.state);
  machine.transition({ type: "tools.completed", cycle: 1, toolCallIds: [callOne] });
  states.push(machine.state);
  return states;
}

function terminalStateFixtures(): readonly RunState[] {
  const idle = createIdleRunState(runId("run-terminal"));
  const completedMachine = new RunStateMachine(runId("run-completed"));
  start(completedMachine);
  beginStream(completedMachine);
  completedMachine.transition({
    type: "model.stream.completed",
    cycle: 1,
    attempt: 1,
    responseId: "response-1",
    finishReason: "stop",
    toolCallIds: [],
  });
  return [
    completedMachine.state,
    transitionRun(idle, { type: "run.cancel", reason: "shutdown" }),
    transitionRun(idle, { type: "run.fail", error: failure }),
  ];
}

function allStateFixtures(): readonly RunState[] {
  return [...nonterminalStateFixtures(), ...terminalStateFixtures()];
}

function actionFixtures(): readonly RunAction[] {
  return [
    { type: "run.start" },
    { type: "context.prepared", cycle: 1 },
    {
      type: "model.stream.started",
      cycle: 1,
      attempt: 1,
      responseId: "response-1",
    },
    {
      type: "model.stream.completed",
      cycle: 1,
      attempt: 1,
      responseId: "response-1",
      finishReason: "stop",
      toolCallIds: [],
    },
    {
      type: "model.attempt.failed",
      cycle: 1,
      attempt: 1,
      retry: "scheduled",
      error: failure,
    },
    {
      type: "permissions.resolved",
      cycle: 1,
      approvedToolCallIds: [callOne],
      deniedToolCallIds: [],
    },
    { type: "tools.completed", cycle: 1, toolCallIds: [callOne] },
    { type: "tool-results.processed", cycle: 1, toolCallIds: [callOne] },
    { type: "run.cancel", reason: "user-cancelled" },
    { type: "run.fail", error: failure },
  ];
}
