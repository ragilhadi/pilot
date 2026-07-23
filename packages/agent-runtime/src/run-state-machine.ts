import {
  type FinishReason,
  PilotError,
  type RunId,
  type SafeErrorSnapshot,
  type ToolCallId,
} from "@pilot/core";

export type RunStateKind =
  | "aborted"
  | "awaiting-permission"
  | "completed"
  | "executing-tools"
  | "failed"
  | "idle"
  | "preparing-context"
  | "processing-tool-results"
  | "receiving-model-stream"
  | "waiting-for-model";

interface RunStateBase {
  readonly runId: RunId;
  readonly revision: number;
  readonly kind: RunStateKind;
}

export interface IdleRunState extends RunStateBase {
  readonly kind: "idle";
}

export interface PreparingContextRunState extends RunStateBase {
  readonly kind: "preparing-context";
  readonly cycle: number;
}

export interface WaitingForModelRunState extends RunStateBase {
  readonly kind: "waiting-for-model";
  readonly cycle: number;
  readonly attempt: number;
}

export interface ReceivingModelStreamRunState extends RunStateBase {
  readonly kind: "receiving-model-stream";
  readonly cycle: number;
  readonly attempt: number;
  readonly responseId: string;
}

export interface AwaitingPermissionRunState extends RunStateBase {
  readonly kind: "awaiting-permission";
  readonly cycle: number;
  readonly toolCallIds: readonly ToolCallId[];
}

export interface ExecutingToolsRunState extends RunStateBase {
  readonly kind: "executing-tools";
  readonly cycle: number;
  readonly toolCallIds: readonly ToolCallId[];
  readonly approvedToolCallIds: readonly ToolCallId[];
  readonly deniedToolCallIds: readonly ToolCallId[];
}

export interface ProcessingToolResultsRunState extends RunStateBase {
  readonly kind: "processing-tool-results";
  readonly cycle: number;
  readonly toolCallIds: readonly ToolCallId[];
}

export interface CompletedRunState extends RunStateBase {
  readonly kind: "completed";
  readonly cycle: number;
  readonly finishReason: Exclude<FinishReason, "error" | "tool-calls">;
}

export type RunAbortReason = "budget-exhausted" | "shutdown" | "user-cancelled";

export interface AbortedRunState extends RunStateBase {
  readonly kind: "aborted";
  readonly previousKind: Exclude<RunStateKind, "aborted" | "completed" | "failed">;
  readonly reason: RunAbortReason;
}

export interface FailedRunState extends RunStateBase {
  readonly kind: "failed";
  readonly previousKind: Exclude<RunStateKind, "aborted" | "completed" | "failed">;
  readonly error: SafeErrorSnapshot;
}

export type RunState =
  | AbortedRunState
  | AwaitingPermissionRunState
  | CompletedRunState
  | ExecutingToolsRunState
  | FailedRunState
  | IdleRunState
  | PreparingContextRunState
  | ProcessingToolResultsRunState
  | ReceivingModelStreamRunState
  | WaitingForModelRunState;

export type RunAction =
  | { readonly type: "run.start" }
  | { readonly type: "context.prepared"; readonly cycle: number }
  | {
      readonly type: "model.stream.started";
      readonly cycle: number;
      readonly attempt: number;
      readonly responseId: string;
    }
  | {
      readonly type: "model.stream.completed";
      readonly cycle: number;
      readonly attempt: number;
      readonly responseId: string;
      readonly finishReason: FinishReason;
      readonly toolCallIds: readonly ToolCallId[];
    }
  | {
      readonly type: "model.attempt.failed";
      readonly cycle: number;
      readonly attempt: number;
      readonly retry: "exhausted" | "scheduled";
      readonly error: SafeErrorSnapshot;
    }
  | {
      readonly type: "permissions.resolved";
      readonly cycle: number;
      readonly approvedToolCallIds: readonly ToolCallId[];
      readonly deniedToolCallIds: readonly ToolCallId[];
    }
  | {
      readonly type: "tools.completed";
      readonly cycle: number;
      readonly toolCallIds: readonly ToolCallId[];
    }
  | {
      readonly type: "tool-results.processed";
      readonly cycle: number;
      readonly toolCallIds: readonly ToolCallId[];
    }
  | { readonly type: "run.cancel"; readonly reason: RunAbortReason }
  | { readonly type: "run.fail"; readonly error: SafeErrorSnapshot };

export type RunActionType = RunAction["type"];

const globalActiveActions = ["run.cancel", "run.fail"] as const;

export const allowedRunActionTypes: Readonly<Record<RunStateKind, readonly RunActionType[]>> =
  Object.freeze({
    idle: actionTypes("run.start", ...globalActiveActions),
    "preparing-context": actionTypes("context.prepared", ...globalActiveActions),
    "waiting-for-model": actionTypes(
      "model.stream.started",
      "model.attempt.failed",
      ...globalActiveActions,
    ),
    "receiving-model-stream": actionTypes(
      "model.stream.completed",
      "model.attempt.failed",
      ...globalActiveActions,
    ),
    "awaiting-permission": actionTypes("permissions.resolved", ...globalActiveActions),
    "executing-tools": actionTypes("tools.completed", ...globalActiveActions),
    "processing-tool-results": actionTypes("tool-results.processed", ...globalActiveActions),
    completed: actionTypes(),
    aborted: actionTypes(),
    failed: actionTypes(),
  });

export class RunTransitionError extends PilotError {
  readonly stateKind: RunStateKind;
  readonly actionType: RunActionType;

  constructor(state: RunState, action: RunAction, detail?: string) {
    super({
      code: "PILOT_RUN_INVALID_TRANSITION",
      message: detail ?? `Cannot apply ${action.type} while run is ${state.kind}`,
      safeMessage: "The run attempted an invalid state transition",
      metadata: {
        stateKind: state.kind,
        actionType: action.type,
        revision: state.revision,
      },
    });
    this.stateKind = state.kind;
    this.actionType = action.type;
  }
}

export function createIdleRunState(runIdentifier: RunId): IdleRunState {
  return Object.freeze({ kind: "idle", runId: runIdentifier, revision: 0 });
}

export function isTerminalRunState(
  state: RunState,
): state is AbortedRunState | CompletedRunState | FailedRunState {
  return state.kind === "aborted" || state.kind === "completed" || state.kind === "failed";
}

export function transitionRun(state: RunState, action: RunAction): RunState {
  if (isTerminalRunState(state)) {
    throw new RunTransitionError(state, action);
  }

  if (action.type === "run.cancel") {
    return Object.freeze({
      kind: "aborted",
      runId: state.runId,
      revision: state.revision + 1,
      previousKind: state.kind,
      reason: action.reason,
    });
  }
  if (action.type === "run.fail") {
    return failedState(state, action.error);
  }

  switch (state.kind) {
    case "idle":
      if (action.type === "run.start") {
        return Object.freeze({
          kind: "preparing-context",
          runId: state.runId,
          revision: state.revision + 1,
          cycle: 1,
        });
      }
      break;
    case "preparing-context":
      if (action.type === "context.prepared") {
        requireEqual(state, action, "cycle", state.cycle, action.cycle);
        return Object.freeze({
          kind: "waiting-for-model",
          runId: state.runId,
          revision: state.revision + 1,
          cycle: state.cycle,
          attempt: 1,
        });
      }
      break;
    case "waiting-for-model":
      if (action.type === "model.stream.started") {
        requireModelAttempt(state, action);
        requireNonEmpty(state, action, "responseId", action.responseId);
        return Object.freeze({
          kind: "receiving-model-stream",
          runId: state.runId,
          revision: state.revision + 1,
          cycle: state.cycle,
          attempt: state.attempt,
          responseId: action.responseId,
        });
      }
      if (action.type === "model.attempt.failed") {
        return transitionModelFailure(state, action);
      }
      break;
    case "receiving-model-stream":
      if (action.type === "model.stream.completed") {
        requireModelAttempt(state, action);
        requireEqual(state, action, "responseId", state.responseId, action.responseId);
        const toolCallIds = snapshotUniqueIds(state, action, action.toolCallIds);
        if (action.finishReason === "error") {
          throw new RunTransitionError(state, action, "An error finish cannot complete a run");
        }
        if (action.finishReason === "tool-calls") {
          if (toolCallIds.length === 0) {
            throw new RunTransitionError(state, action, "A tool-calls finish requires tool calls");
          }
          return Object.freeze({
            kind: "awaiting-permission",
            runId: state.runId,
            revision: state.revision + 1,
            cycle: state.cycle,
            toolCallIds,
          });
        }
        if (toolCallIds.length > 0) {
          throw new RunTransitionError(
            state,
            action,
            "Tool calls require a tool-calls finish reason",
          );
        }
        return Object.freeze({
          kind: "completed",
          runId: state.runId,
          revision: state.revision + 1,
          cycle: state.cycle,
          finishReason: action.finishReason,
        });
      }
      if (action.type === "model.attempt.failed") {
        return transitionModelFailure(state, action);
      }
      break;
    case "awaiting-permission":
      if (action.type === "permissions.resolved") {
        requireEqual(state, action, "cycle", state.cycle, action.cycle);
        const approved = snapshotUniqueIds(state, action, action.approvedToolCallIds);
        const denied = snapshotUniqueIds(state, action, action.deniedToolCallIds);
        requirePartition(state, action, state.toolCallIds, approved, denied);
        if (approved.length === 0) {
          return Object.freeze({
            kind: "processing-tool-results",
            runId: state.runId,
            revision: state.revision + 1,
            cycle: state.cycle,
            toolCallIds: state.toolCallIds,
          });
        }
        return Object.freeze({
          kind: "executing-tools",
          runId: state.runId,
          revision: state.revision + 1,
          cycle: state.cycle,
          toolCallIds: state.toolCallIds,
          approvedToolCallIds: approved,
          deniedToolCallIds: denied,
        });
      }
      break;
    case "executing-tools":
      if (action.type === "tools.completed") {
        requireEqual(state, action, "cycle", state.cycle, action.cycle);
        requireSameIds(state, action, state.approvedToolCallIds, action.toolCallIds);
        return Object.freeze({
          kind: "processing-tool-results",
          runId: state.runId,
          revision: state.revision + 1,
          cycle: state.cycle,
          toolCallIds: state.toolCallIds,
        });
      }
      break;
    case "processing-tool-results":
      if (action.type === "tool-results.processed") {
        requireEqual(state, action, "cycle", state.cycle, action.cycle);
        requireSameIds(state, action, state.toolCallIds, action.toolCallIds);
        return Object.freeze({
          kind: "preparing-context",
          runId: state.runId,
          revision: state.revision + 1,
          cycle: state.cycle + 1,
        });
      }
      break;
  }

  throw new RunTransitionError(state, action);
}

export class RunStateMachine {
  #state: RunState;

  constructor(runIdentifier: RunId) {
    this.#state = createIdleRunState(runIdentifier);
  }

  get state(): RunState {
    return this.#state;
  }

  transition(action: RunAction): RunState {
    this.#state = transitionRun(this.#state, action);
    return this.#state;
  }
}

function transitionModelFailure(
  state: WaitingForModelRunState | ReceivingModelStreamRunState,
  action: Extract<RunAction, { type: "model.attempt.failed" }>,
): RunState {
  requireModelAttempt(state, action);
  if (action.retry === "scheduled") {
    return Object.freeze({
      kind: "waiting-for-model",
      runId: state.runId,
      revision: state.revision + 1,
      cycle: state.cycle,
      attempt: state.attempt + 1,
    });
  }
  return failedState(state, action.error);
}

function failedState(
  state: Exclude<RunState, AbortedRunState | CompletedRunState | FailedRunState>,
  input: SafeErrorSnapshot,
): FailedRunState {
  const error = Object.freeze({
    code: input.code,
    message: input.message,
    retryable: input.retryable,
    metadata: Object.freeze({ ...input.metadata }),
  });
  return Object.freeze({
    kind: "failed",
    runId: state.runId,
    revision: state.revision + 1,
    previousKind: state.kind,
    error,
  });
}

function requireModelAttempt(
  state: WaitingForModelRunState | ReceivingModelStreamRunState,
  action: RunAction,
): void {
  if (!("cycle" in action) || !("attempt" in action)) {
    throw new RunTransitionError(state, action);
  }
  requireEqual(state, action, "cycle", state.cycle, action.cycle);
  requireEqual(state, action, "attempt", state.attempt, action.attempt);
}

function requireEqual(
  state: RunState,
  action: RunAction,
  field: string,
  expected: number | string,
  actual: number | string,
): void {
  if (actual !== expected) {
    throw new RunTransitionError(
      state,
      action,
      `Stale ${action.type}: expected ${field} ${expected}, received ${actual}`,
    );
  }
}

function requireNonEmpty(state: RunState, action: RunAction, field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new RunTransitionError(state, action, `${field} must not be empty`);
  }
}

function snapshotUniqueIds(
  state: RunState,
  action: RunAction,
  ids: readonly ToolCallId[],
): readonly ToolCallId[] {
  if (ids.some((id) => id.trim().length === 0) || new Set(ids).size !== ids.length) {
    throw new RunTransitionError(
      state,
      action,
      "Tool-call identifiers must be non-empty and unique",
    );
  }
  return Object.freeze([...ids]);
}

function requirePartition(
  state: RunState,
  action: RunAction,
  expected: readonly ToolCallId[],
  approved: readonly ToolCallId[],
  denied: readonly ToolCallId[],
): void {
  const combined = [...approved, ...denied];
  if (new Set(combined).size !== combined.length || !sameIds(expected, combined)) {
    throw new RunTransitionError(
      state,
      action,
      "Permission decisions must partition every pending tool call exactly once",
    );
  }
}

function requireSameIds(
  state: RunState,
  action: RunAction,
  expected: readonly ToolCallId[],
  actualInput: readonly ToolCallId[],
): void {
  const actual = snapshotUniqueIds(state, action, actualInput);
  if (!sameIds(expected, actual)) {
    throw new RunTransitionError(state, action, "Tool-call identifiers do not match pending work");
  }
}

function sameIds(left: readonly ToolCallId[], right: readonly ToolCallId[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function actionTypes(...types: RunActionType[]): readonly RunActionType[] {
  return Object.freeze(types);
}
