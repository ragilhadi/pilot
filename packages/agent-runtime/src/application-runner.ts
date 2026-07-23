import {
  type AgentMessage,
  CancellationError,
  type Clock,
  JsonValueSchema,
  messageId,
  type ModelDescriptor,
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
  parseAgentMessage,
  parseModelRequest,
  type PermissionAction,
  type PermissionDecision,
  PilotError,
  type RetryPolicy,
  type RunId,
  type SafeErrorSnapshot,
  toSafeErrorSnapshot,
  ToolContractError,
  type UserInteraction,
} from "@pilotrun/core";
import {
  type ModelStreamOutcome,
  ModelStreamAccumulator,
  type StreamProgressSnapshot,
} from "./model-stream-accumulator.js";
import type { ModelRegistry } from "./model-registry.js";
import { PermissionPolicyEngine } from "./permission-policy.js";
import {
  interruptedToolRecovery,
  permissionDeniedRecovery,
  recoveryForToolError,
} from "./tool-recovery.js";
import { PermissionCoordinator, type PermissionResolutionMode } from "./permission-coordinator.js";
import {
  type PendingToolCall,
  type ScheduledToolResult,
  ToolCallScheduler,
  ToolExecutionInterruptedError,
  type ToolExecutionLifecycleEvent,
} from "./tool-call-scheduler.js";
import { ToolRegistry } from "./tool-registry.js";
import {
  ToolResultContextFormatter,
  type ToolResultContextFormatterPort,
} from "./tool-result-context.js";
import type {
  ModelRequestContextPreparer,
  PromptCompositionSnapshot,
} from "./prompt-composition.js";
import {
  classifyModelRetryError,
  RetryExecutor,
  type RetryClassification,
  type RetryExecutorDependencies,
  type RetryLifecycleEvent,
} from "./retry-executor.js";
import {
  type MonotonicClock,
  RunBudgetError,
  RunBudgetExceededError,
  type RunBudgetPolicy,
  type RunBudgetSnapshot,
  RunBudgetTracker,
} from "./run-budget.js";
import { type RunInterruption, RunInterruptionQueue } from "./run-interruption-queue.js";
import {
  isTerminalRunState,
  type RunAbortReason,
  type RunState,
  RunStateMachine,
} from "./run-state-machine.js";

export const runCheckpointSchemaVersion = 1 as const;

export type RunCheckpointReason =
  | "budget.exhausted"
  | "context.prepared"
  | "cycle.started"
  | "model.attempt.started"
  | "model.retry.scheduled"
  | "model.stream.event"
  | "permissions.resolved"
  | "run.started"
  | "run.terminal"
  | "tool-results.processed"
  | "tools.completed"
  | "tools.interrupted";

export interface RunCheckpoint {
  readonly schemaVersion: typeof runCheckpointSchemaVersion;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly reason: RunCheckpointReason;
  readonly state: RunState;
  readonly budget: RunBudgetSnapshot;
  readonly stream?: StreamProgressSnapshot;
}

export interface RunCheckpointWriter {
  write(checkpoint: RunCheckpoint): Promise<void>;
}

export interface ModelCallBudgetEstimate {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd?: number;
}

export interface ModelCallBudgetEstimateInput {
  readonly request: ModelRequest;
  readonly descriptor: ModelDescriptor;
  readonly cycle: number;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export type ModelCallBudgetEstimator = (
  input: ModelCallBudgetEstimateInput,
) => ModelCallBudgetEstimate | Promise<ModelCallBudgetEstimate>;

export interface ApplicationRunnerDependencies {
  readonly registry: ModelRegistry;
  readonly clock: Clock;
  readonly monotonicClock: MonotonicClock;
  readonly checkpointWriter: RunCheckpointWriter;
  readonly estimateModelCall: ModelCallBudgetEstimator;
  readonly retry: Omit<RetryExecutorDependencies, "observer">;
  readonly tools?: ToolRegistry;
  readonly permissions?: PermissionPolicyEngine;
  readonly permissionMode?: PermissionResolutionMode;
  readonly userInteraction?: UserInteraction;
  readonly onModelEvent?: (
    event: ModelStreamEvent,
    context: { readonly runId: RunId },
  ) => void | Promise<void>;
  readonly onToolEvent?: (event: ToolExecutionLifecycleEvent) => void | Promise<void>;
  readonly toolResultContextFormatter?: ToolResultContextFormatterPort;
  readonly contextPreparer?: ModelRequestContextPreparer;
  readonly onContextPrepared?: (snapshot: PromptCompositionSnapshot) => void | Promise<void>;
}

export interface ApplicationRunInput {
  readonly runId: RunId;
  readonly modelKey: string;
  readonly request: ModelRequest;
  readonly retryPolicy: RetryPolicy;
  readonly budgetPolicy: RunBudgetPolicy;
  readonly signal: AbortSignal;
  readonly interruptionQueue?: RunInterruptionQueue;
  readonly externalAbortReason?: Exclude<RunAbortReason, "budget-exhausted">;
  readonly permissionContext?: {
    readonly workspaceId?: string;
    readonly applicationId?: string;
  };
}

export interface ApplicationRunResult {
  readonly state: RunState;
  readonly budget: RunBudgetSnapshot;
  readonly outcome?: ModelStreamOutcome;
  readonly interruption?: RunInterruption;
  readonly generatedMessages: readonly AgentMessage[];
}

export class ApplicationRunnerError extends PilotError {
  constructor(providerId: string, modelId: string, message: string) {
    super({
      code: "PILOT_RUN_UNSUPPORTED_OPERATION",
      message,
      safeMessage: "The run requested an operation that is not enabled in this phase",
      metadata: { providerId, modelId },
    });
  }
}

export class ApplicationRunner {
  readonly #dependencies: ApplicationRunnerDependencies;
  readonly #toolResultContextFormatter: ToolResultContextFormatterPort;

  constructor(dependencies: ApplicationRunnerDependencies) {
    this.#dependencies = dependencies;
    this.#toolResultContextFormatter =
      dependencies.toolResultContextFormatter ??
      new ToolResultContextFormatter({ maximumBytes: 32_768 });
  }

  async run(input: ApplicationRunInput): Promise<ApplicationRunResult> {
    const machine = new RunStateMachine(input.runId);
    const budget = new RunBudgetTracker(input.budgetPolicy, this.#dependencies.monotonicClock);
    const controller = new AbortController();
    const queue = input.interruptionQueue ?? new RunInterruptionQueue();
    let checkpointSequence = 0;
    let finalOutcome: ModelStreamOutcome | undefined;
    let terminalCheckpointWritten = false;
    const generatedMessages: AgentMessage[] = [];
    const tools = this.#dependencies.tools ?? new ToolRegistry();
    const permissions =
      this.#dependencies.permissions ??
      new PermissionPolicyEngine({ clock: this.#dependencies.clock });
    const permissionCoordinator = new PermissionCoordinator({
      policy: permissions,
      mode: this.#dependencies.permissionMode ?? "non-interactive-deny",
      ...(this.#dependencies.userInteraction === undefined
        ? {}
        : { interaction: this.#dependencies.userInteraction }),
    });
    const scheduler = new ToolCallScheduler({
      registry: tools,
      ...(this.#dependencies.onToolEvent === undefined
        ? {}
        : { observer: this.#dependencies.onToolEvent }),
    });

    const abortFromExternal = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", abortFromExternal, { once: true });
    const unsubscribe = queue.subscribe(() => controller.abort("run interruption"));
    if (input.signal.aborted) {
      abortFromExternal();
    }
    if (queue.peek() !== undefined) {
      controller.abort("queued run interruption");
    }

    const checkpoint = async (
      reason: RunCheckpointReason,
      stream?: StreamProgressSnapshot,
    ): Promise<void> => {
      checkpointSequence += 1;
      await this.#dependencies.checkpointWriter.write(
        Object.freeze({
          schemaVersion: runCheckpointSchemaVersion,
          sequence: checkpointSequence,
          occurredAt: this.#dependencies.clock.now().toISOString(),
          reason,
          state: machine.state,
          budget: budget.snapshot(),
          ...(stream === undefined ? {} : { stream }),
        }),
      );
      if (reason === "run.terminal") {
        terminalCheckpointWritten = true;
      }
    };

    try {
      machine.transition({ type: "run.start" });
      await checkpoint("run.started");
      throwIfInterrupted(controller.signal);

      let request = parseModelRequest(input.request);
      let cycle = 1;
      while (true) {
        const cycleDecision = budget.startCycle();
        if (!cycleDecision.allowed) {
          await checkpoint("budget.exhausted");
          throw new RunBudgetExceededError(cycleDecision.exhaustion);
        }
        await checkpoint("cycle.started");

        let resolved = this.#dependencies.registry.resolve(input.modelKey, request);
        if (this.#dependencies.contextPreparer !== undefined) {
          const prepared = await this.#dependencies.contextPreparer.prepare({
            request,
            descriptor: resolved.descriptor,
            runId: input.runId,
            cycle,
            signal: controller.signal,
          });
          request = parseModelRequest(prepared.request);
          resolved = this.#dependencies.registry.resolve(input.modelKey, request);
          await this.#dependencies.onContextPrepared?.(prepared.snapshot);
        }
        machine.transition({ type: "context.prepared", cycle });
        await checkpoint("context.prepared");

        const errorsByAttempt = new Map<number, SafeErrorSnapshot>();
        const retryExecutor = new RetryExecutor({
          ...this.#dependencies.retry,
          observer: async (event) => {
            await this.#observeRetryEvent(event, cycle, machine, errorsByAttempt, checkpoint);
          },
        });
        const idempotencyKey = `${input.runId}:cycle:${cycle}`;

        const completed = await retryExecutor.execute(
          async ({ attempt, signal }) => {
            const estimate = await this.#dependencies.estimateModelCall({
              request,
              descriptor: resolved.descriptor,
              cycle,
              attempt,
              signal,
            });
            if (
              request.maxOutputTokens !== undefined &&
              estimate.outputTokens < request.maxOutputTokens
            ) {
              throw new RunBudgetError(
                "Model output reservation must cover the request maximum output tokens",
                {
                  requested: request.maxOutputTokens,
                  reserved: estimate.outputTokens,
                },
              );
            }
            const modelCallId = `${idempotencyKey}:attempt:${attempt}`;
            const decision = budget.startModelAttempt({ callId: modelCallId, ...estimate });
            if (!decision.allowed) {
              await checkpoint("budget.exhausted");
              throw new RunBudgetExceededError(decision.exhaustion);
            }
            await checkpoint("model.attempt.started");

            let outcome: ModelStreamOutcome | undefined;
            let caught: unknown;
            const accumulator = new ModelStreamAccumulator();
            const attemptController = new AbortController();
            const abortAttempt = () => attemptController.abort(signal.reason);
            signal.addEventListener("abort", abortAttempt, { once: true });
            if (signal.aborted) abortAttempt();
            try {
              for await (const event of resolved.model.stream(request, {
                runId: input.runId,
                attempt,
                idempotencyKey,
                signal: attemptController.signal,
              })) {
                throwIfInterrupted(signal);
                const consumption = accumulator.consume(event);
                if (consumption === "duplicate") continue;
                if (event.type === "response.started") {
                  machine.transition({
                    type: "model.stream.started",
                    cycle,
                    attempt,
                    responseId: event.responseId,
                  });
                }
                const timeDecision = budget.checkTime();
                if (!timeDecision.allowed) {
                  attemptController.abort("elapsed-time budget exhausted");
                  await checkpoint("budget.exhausted", accumulator.snapshot());
                  throw new RunBudgetExceededError(timeDecision.exhaustion);
                }
                if (event.type === "usage.updated") {
                  const usageDecision = budget.recordModelUsage(modelCallId, event.usage);
                  if (!usageDecision.allowed) {
                    attemptController.abort("model usage budget exhausted");
                    await checkpoint("budget.exhausted", accumulator.snapshot());
                    throw new RunBudgetExceededError(usageDecision.exhaustion);
                  }
                }
                await checkpoint("model.stream.event", accumulator.snapshot());
                throwIfInterrupted(signal);
                await this.#dependencies.onModelEvent?.(event, { runId: input.runId });
              }
              outcome = accumulator.finalize();
              if (outcome.status === "failed") throw modelErrorFromFailure(outcome.error);
            } catch (error) {
              caught = error;
            } finally {
              signal.removeEventListener("abort", abortAttempt);
            }

            const settlement = budget.settleModelAttempt(modelCallId);
            if (!settlement.allowed && !(caught instanceof RunBudgetExceededError)) {
              caught = new RunBudgetExceededError(settlement.exhaustion);
            }
            if (caught !== undefined) throw caught;
            if (outcome === undefined) {
              throw new Error("Model attempt completed without an outcome");
            }
            return Object.freeze({ attempt, outcome });
          },
          {
            policy: input.retryPolicy,
            safety: { mode: "idempotent-with-key", key: idempotencyKey },
            signal: controller.signal,
            classifyError: (error) => classifyRunnerRetry(error, machine.state),
          },
        );

        throwIfInterrupted(controller.signal);
        finalOutcome = completed.outcome;
        if (finalOutcome.status !== "completed") {
          throw new Error("Retry executor returned a non-completed model outcome");
        }
        const toolCallIds = finalOutcome.toolCalls.map(({ callId }) => callId);
        machine.transition({
          type: "model.stream.completed",
          cycle,
          attempt: completed.attempt,
          responseId: finalOutcome.responseId,
          finishReason: finalOutcome.finishReason,
          toolCallIds,
        });
        if (finalOutcome.finishReason !== "tool-calls") {
          await checkpoint("run.terminal");
          break;
        }

        const toolBudgetDecision = budget.startToolCalls(finalOutcome.toolCalls.length);
        if (!toolBudgetDecision.allowed) {
          await checkpoint("budget.exhausted");
          throw new RunBudgetExceededError(toolBudgetDecision.exhaustion);
        }
        const pending = finalOutcome.toolCalls.map(toPendingToolCall);
        const sessionId = request.messages.at(-1)?.sessionId;
        const evaluated: { call: PendingToolCall; decision: PermissionDecision }[] = [];
        const rejected: { call: PendingToolCall; result: ScheduledToolResult }[] = [];
        for (const call of pending) {
          throwIfInterrupted(controller.signal);
          try {
            const decision = await permissionCoordinator.authorize({
              action: permissionActionFor(tools, call),
              context: {
                runId: input.runId,
                callId: call.callId,
                ...(sessionId === undefined ? {} : { sessionId }),
                ...(input.permissionContext?.workspaceId === undefined
                  ? {}
                  : { workspaceId: input.permissionContext.workspaceId }),
                ...(input.permissionContext?.applicationId === undefined
                  ? {}
                  : { applicationId: input.permissionContext.applicationId }),
              },
              signal: controller.signal,
            });
            evaluated.push({ call, decision });
          } catch (error) {
            if (error instanceof CancellationError || controller.signal.aborted) throw error;
            if (!(error instanceof ToolContractError)) throw error;
            rejected.push({ call, result: failedToolResult(call, error) });
          }
        }
        const approved = evaluated.filter(({ decision }) => decision.effect === "allow");
        const denied = evaluated.filter(({ decision }) => decision.effect !== "allow");
        machine.transition({
          type: "permissions.resolved",
          cycle,
          approvedToolCallIds: approved.map(({ call }) => call.callId),
          deniedToolCallIds: [
            ...denied.map(({ call }) => call.callId),
            ...rejected.map(({ call }) => call.callId),
          ],
        });
        await checkpoint("permissions.resolved");

        let executed: readonly ScheduledToolResult[] = [];
        try {
          executed =
            approved.length === 0
              ? []
              : await scheduler.execute({
                  runId: input.runId,
                  calls: approved.map(({ call }) => call),
                  signal: controller.signal,
                });
        } catch (error) {
          if (!(error instanceof ToolExecutionInterruptedError)) throw error;
          const completedIds = new Set(error.completedResults.map(({ callId }) => callId));
          const interrupted = approved
            .filter(({ call }) => !completedIds.has(call.callId))
            .map(({ call }) => interruptedToolResult(tools, call));
          const correlated = correlateToolResults(
            pending,
            error.completedResults,
            interrupted,
            denied.map(({ call, decision }) => deniedToolResult(call, decision)),
            rejected.map(({ result }) => result),
          );
          generatedMessages.push(
            ...createToolCycleMessages({
              runId: input.runId,
              cycle,
              request,
              outcome: finalOutcome,
              results: correlated,
              providerId: resolved.model.providerId,
              modelId: resolved.model.modelId,
              occurredAt: this.#dependencies.clock.now().toISOString(),
              toolResultContextFormatter: this.#toolResultContextFormatter,
            }),
          );
          await checkpoint("tools.interrupted");
          throw error;
        }
        if (approved.length > 0) {
          machine.transition({
            type: "tools.completed",
            cycle,
            toolCallIds: approved.map(({ call }) => call.callId),
          });
          await checkpoint("tools.completed");
        }
        const correlatedResults = correlateToolResults(
          pending,
          executed,
          denied.map(({ call, decision }) => deniedToolResult(call, decision)),
          rejected.map(({ result }) => result),
        );
        const cycleMessages = createToolCycleMessages({
          runId: input.runId,
          cycle,
          request,
          outcome: finalOutcome,
          results: correlatedResults,
          providerId: resolved.model.providerId,
          modelId: resolved.model.modelId,
          occurredAt: this.#dependencies.clock.now().toISOString(),
          toolResultContextFormatter: this.#toolResultContextFormatter,
        });
        generatedMessages.push(...cycleMessages);
        machine.transition({
          type: "tool-results.processed",
          cycle,
          toolCallIds,
        });
        await checkpoint("tool-results.processed");
        request = parseModelRequest({
          ...request,
          messages: [...request.messages, ...cycleMessages],
        });
        cycle += 1;
      }
    } catch (error) {
      const interruption = queue.dequeue();
      if (!isTerminalRunState(machine.state)) {
        if (error instanceof RunBudgetExceededError) {
          machine.transition({ type: "run.cancel", reason: "budget-exhausted" });
        } else if (error instanceof CancellationError || controller.signal.aborted) {
          machine.transition({
            type: "run.cancel",
            reason: abortReason(interruption, input.externalAbortReason),
          });
        } else {
          machine.transition({ type: "run.fail", error: toSafeErrorSnapshot(error) });
        }
        await checkpoint("run.terminal");
      } else if (!terminalCheckpointWritten) {
        await checkpoint("run.terminal");
      }
      return result(
        machine.state,
        budget.snapshot(),
        generatedMessages,
        finalOutcome,
        interruption,
      );
    } finally {
      unsubscribe();
      input.signal.removeEventListener("abort", abortFromExternal);
    }

    return result(machine.state, budget.snapshot(), generatedMessages, finalOutcome);
  }

  async #observeRetryEvent(
    event: RetryLifecycleEvent,
    cycle: number,
    machine: RunStateMachine,
    errorsByAttempt: Map<number, SafeErrorSnapshot>,
    checkpoint: (reason: RunCheckpointReason) => Promise<void>,
  ): Promise<void> {
    switch (event.type) {
      case "attempt.failed":
        errorsByAttempt.set(event.attempt, event.error);
        break;
      case "retry.scheduled": {
        const error = errorsByAttempt.get(event.failedAttempt);
        if (error === undefined) {
          throw new Error("Retry scheduling has no recorded attempt failure");
        }
        machine.transition({
          type: "model.attempt.failed",
          cycle,
          attempt: event.failedAttempt,
          retry: "scheduled",
          error,
        });
        await checkpoint("model.retry.scheduled");
        break;
      }
      case "retry.exhausted": {
        const error = errorsByAttempt.get(event.attempt);
        if (
          error !== undefined &&
          error.code !== "PILOT_CANCELLED" &&
          error.code !== "PILOT_RUN_BUDGET_EXHAUSTED" &&
          !isTerminalRunState(machine.state)
        ) {
          machine.transition({
            type: "model.attempt.failed",
            cycle,
            attempt: event.attempt,
            retry: "exhausted",
            error,
          });
        }
        break;
      }
    }
  }
}

function toPendingToolCall(
  call: Extract<ModelStreamOutcome, { status: "completed" }>["toolCalls"][number],
): PendingToolCall {
  return Object.freeze({ callId: call.callId, toolName: call.toolName, input: call.input });
}

function permissionActionFor(registry: ToolRegistry, call: PendingToolCall): PermissionAction {
  const registered = registry.has(call.toolName) ? registry.resolve(call.toolName) : undefined;
  const metadata = registered?.definition.metadata;
  if (registered?.definition.permissionAction !== undefined) {
    const parsedInput = registry.parseInput(call.toolName, call.input);
    return registered.definition.permissionAction(parsedInput);
  }
  return {
    kind: "tool",
    toolName: call.toolName,
    risk: metadata?.risk ?? "unknown",
    requiredPermissions: metadata?.requiredPermissions ?? [],
    input: call.input,
  };
}

function deniedToolResult(
  call: PendingToolCall,
  decision: PermissionDecision,
): ScheduledToolResult {
  return Object.freeze({
    callId: call.callId,
    toolName: call.toolName,
    output: JsonValueSchema.parse({
      error: {
        code: "PILOT_TOOL_EXECUTION_FAILED",
        message:
          decision.effect === "ask"
            ? "The tool requires user approval before it can run"
            : "The permission policy denied the tool",
        retryable: false,
        metadata: {
          permissionEffect: decision.effect,
          permissionReason: decision.reason,
          actionFingerprint: decision.actionFingerprint,
          ...(decision.ruleId === undefined ? {} : { ruleId: decision.ruleId }),
        },
      },
      recovery: permissionDeniedRecovery(
        decision.source === "cli" && decision.reason.includes("interactive approval"),
      ),
    }),
    isError: true,
  });
}

function failedToolResult(call: PendingToolCall, error: unknown): ScheduledToolResult {
  const snapshot = toSafeErrorSnapshot(error);
  return Object.freeze({
    callId: call.callId,
    toolName: call.toolName,
    output: JsonValueSchema.parse({
      error: Object.freeze({
        code: snapshot.code,
        message: snapshot.message,
        retryable: snapshot.retryable,
        metadata: snapshot.metadata,
      }),
      recovery: recoveryForToolError(snapshot.code),
    }),
    isError: true,
  });
}

function interruptedToolResult(registry: ToolRegistry, call: PendingToolCall): ScheduledToolResult {
  const risk = registry.has(call.toolName)
    ? registry.resolve(call.toolName).definition.metadata.risk
    : "unknown";
  return Object.freeze({
    callId: call.callId,
    toolName: call.toolName,
    output: JsonValueSchema.parse({
      error: {
        code: "PILOT_CANCELLED",
        message: "Tool execution was interrupted before a result was confirmed",
        retryable: false,
        metadata: { executionStatus: "interrupted" },
      },
      recovery: interruptedToolRecovery(risk),
    }),
    isError: true,
  });
}

function correlateToolResults(
  calls: readonly PendingToolCall[],
  ...groups: readonly (readonly ScheduledToolResult[])[]
): readonly ScheduledToolResult[] {
  const byId = new Map(groups.flat().map((result) => [result.callId, result]));
  return Object.freeze(
    calls.map((call) => {
      const correlated = byId.get(call.callId);
      if (correlated === undefined || correlated.toolName !== call.toolName) {
        throw new ApplicationRunnerError(
          "runtime",
          "tool-scheduler",
          `Tool call ${call.callId} has no matching result`,
        );
      }
      return correlated;
    }),
  );
}

interface ToolCycleMessageInput {
  readonly runId: RunId;
  readonly cycle: number;
  readonly request: ModelRequest;
  readonly outcome: Extract<ModelStreamOutcome, { status: "completed" }>;
  readonly results: readonly ScheduledToolResult[];
  readonly providerId: string;
  readonly modelId: string;
  readonly occurredAt: string;
  readonly toolResultContextFormatter: ToolResultContextFormatterPort;
}

function createToolCycleMessages(input: ToolCycleMessageInput): readonly AgentMessage[] {
  const sessionId = input.request.messages.at(-1)?.sessionId;
  if (sessionId === undefined) {
    throw new ApplicationRunnerError(
      input.providerId,
      input.modelId,
      "Tool execution requires a session-correlated model request",
    );
  }
  const textParts = input.outcome.text
    .filter(({ text }) => text.length > 0)
    .map(({ text }) => Object.freeze({ type: "text" as const, text }));
  const toolCallParts = input.outcome.toolCalls.map((call) =>
    Object.freeze({
      type: "tool-call" as const,
      callId: call.callId,
      toolName: call.toolName,
      input: call.input,
    }),
  );
  let parentId = input.request.messages.at(-1)?.id;
  const assistant = parseAgentMessage({
    schemaVersion: 1,
    id: messageId(`${input.runId}:cycle:${input.cycle}:assistant`),
    sessionId,
    runId: input.runId,
    ...(parentId === undefined ? {} : { parentId }),
    role: "assistant",
    status: "complete",
    parts: [...textParts, ...toolCallParts],
    createdAt: input.occurredAt,
    provenance: {
      kind: "model",
      providerId: input.providerId,
      modelId: input.modelId,
      responseId: input.outcome.responseId,
    },
  });
  const messages: AgentMessage[] = [assistant];
  parentId = assistant.id;
  for (const [index, toolResult] of input.results.entries()) {
    const contextResult = input.toolResultContextFormatter.format({
      callId: toolResult.callId,
      toolName: toolResult.toolName,
      output: toolResult.output,
    });
    const contextTruncation =
      contextResult.truncation === undefined
        ? undefined
        : JsonValueSchema.parse(contextResult.truncation);
    const metadata =
      toolResult.metadata === undefined && contextTruncation === undefined
        ? undefined
        : Object.freeze({
            ...toolResult.metadata,
            ...(contextTruncation === undefined ? {} : { contextTruncation }),
          });
    const message = parseAgentMessage({
      schemaVersion: 1,
      id: messageId(`${input.runId}:cycle:${input.cycle}:tool:${index + 1}`),
      sessionId,
      runId: input.runId,
      parentId,
      role: "tool",
      status: toolResult.isError ? "failed" : "complete",
      parts: [
        {
          type: "tool-result",
          callId: toolResult.callId,
          toolName: toolResult.toolName,
          output: contextResult.output,
          isError: toolResult.isError,
        },
      ],
      createdAt: input.occurredAt,
      provenance: {
        kind: "tool",
        callId: toolResult.callId,
        toolName: toolResult.toolName,
      },
      ...(metadata === undefined ? {} : { metadata }),
    });
    messages.push(message);
    parentId = message.id;
  }
  return Object.freeze(messages);
}

function classifyRunnerRetry(error: unknown, state: RunState): RetryClassification {
  const classification = classifyModelRetryError(error);
  if (state.kind === "receiving-model-stream" && classification.retryable) {
    return Object.freeze({ ...classification, retryable: false });
  }
  return classification;
}

function modelErrorFromFailure(
  failure: Extract<ModelStreamOutcome, { status: "failed" }>["error"],
): ModelError {
  return new ModelError({
    kind: failure.kind,
    providerId: failure.providerId,
    modelId: failure.modelId,
    message: failure.message,
    retryable: failure.retryable,
    ...(failure.statusCode === undefined ? {} : { statusCode: failure.statusCode }),
    ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
  });
}

function throwIfInterrupted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CancellationError(signal.reason);
  }
}

function abortReason(
  interruption: RunInterruption | undefined,
  external: Exclude<RunAbortReason, "budget-exhausted"> | undefined,
): Exclude<RunAbortReason, "budget-exhausted"> {
  if (interruption?.type === "cancel") {
    return interruption.reason;
  }
  return external ?? "user-cancelled";
}

function result(
  state: RunState,
  budget: RunBudgetSnapshot,
  generatedMessages: readonly AgentMessage[],
  outcome?: ModelStreamOutcome,
  interruption?: RunInterruption,
): ApplicationRunResult {
  return Object.freeze({
    state,
    budget,
    generatedMessages: Object.freeze([...generatedMessages]),
    ...(outcome === undefined ? {} : { outcome }),
    ...(interruption === undefined ? {} : { interruption }),
  });
}
