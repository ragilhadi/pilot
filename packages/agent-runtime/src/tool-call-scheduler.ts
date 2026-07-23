import {
  CancellationError,
  JsonValueSchema,
  PilotError,
  type JsonObject,
  type JsonValue,
  type RunId,
  toSafeErrorSnapshot,
  type ToolCallId,
} from "@pilotrun/core";
import type { ToolRegistry } from "./tool-registry.js";
import { recoveryForToolError } from "./tool-recovery.js";

export interface PendingToolCall {
  readonly callId: ToolCallId;
  readonly toolName: string;
  readonly input: JsonValue;
}

export interface ScheduledToolResult {
  readonly callId: ToolCallId;
  readonly toolName: string;
  readonly output: JsonValue;
  readonly isError: boolean;
  readonly metadata?: JsonObject;
}

export type ToolExecutionLifecycleEvent =
  | {
      readonly type: "tool.started";
      readonly runId: RunId;
      readonly callId: ToolCallId;
      readonly toolName: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: "tool.completed";
      readonly runId: RunId;
      readonly callId: ToolCallId;
      readonly toolName: string;
      readonly isError: boolean;
      readonly output: JsonValue;
    };

export interface ToolCallSchedulerDependencies {
  readonly registry: ToolRegistry;
  readonly observer?: (event: ToolExecutionLifecycleEvent) => void | Promise<void>;
}

export interface ScheduleToolCallsInput {
  readonly runId: RunId;
  readonly calls: readonly PendingToolCall[];
  readonly signal: AbortSignal;
}

export class ToolCallSchedulingError extends PilotError {
  constructor(
    code:
      | "PILOT_TOOL_CALL_CONFLICT"
      | "PILOT_TOOL_EXECUTION_FAILED"
      | "PILOT_TOOL_OUTPUT_TOO_LARGE"
      | "PILOT_TOOL_TIMEOUT",
    message: string,
    metadata: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super({
      code,
      message,
      safeMessage:
        code === "PILOT_TOOL_TIMEOUT"
          ? "The tool exceeded its execution timeout"
          : code === "PILOT_TOOL_OUTPUT_TOO_LARGE"
            ? "The tool result exceeded its output limit"
            : code === "PILOT_TOOL_CALL_CONFLICT"
              ? "A tool-call identifier was reused with conflicting data"
              : "The tool could not be executed",
      metadata,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

export class ToolExecutionInterruptedError extends CancellationError {
  readonly completedResults: readonly ScheduledToolResult[];

  constructor(completedResults: readonly ScheduledToolResult[], cause?: unknown) {
    super(cause);
    this.completedResults = Object.freeze([...completedResults]);
  }
}

interface ExecutionRecord {
  readonly fingerprint: string;
  readonly promise: Promise<ScheduledToolResult>;
}

/**
 * Executes parallel-safe calls concurrently while treating every exclusive call as a full barrier.
 * Results retain request order and each run/call identifier is executed at most once.
 */
export class ToolCallScheduler {
  readonly #dependencies: ToolCallSchedulerDependencies;
  readonly #executions = new Map<string, ExecutionRecord>();

  constructor(dependencies: ToolCallSchedulerDependencies) {
    this.#dependencies = dependencies;
  }

  async execute(input: ScheduleToolCallsInput): Promise<readonly ScheduledToolResult[]> {
    throwIfCancelled(input.signal);
    assertUniqueCalls(input.calls);
    const results = new Map<ToolCallId, ScheduledToolResult>();
    let parallelBatch: PendingToolCall[] = [];

    const flushParallel = async () => {
      if (parallelBatch.length === 0) return;
      const batch = parallelBatch;
      parallelBatch = [];
      const settled = await Promise.allSettled(
        batch.map((call) => this.#executeAtMostOnce(input.runId, call, input.signal)),
      );
      let failure: unknown;
      for (const outcome of settled) {
        if (outcome.status === "fulfilled") results.set(outcome.value.callId, outcome.value);
        else failure ??= outcome.reason;
      }
      if (failure !== undefined) throw failure;
    };

    try {
      for (const call of input.calls) {
        const registered = this.#dependencies.registry.has(call.toolName)
          ? this.#dependencies.registry.resolve(call.toolName)
          : undefined;
        if (registered?.definition.metadata.concurrency === "parallel-safe") {
          parallelBatch.push(call);
          continue;
        }
        await flushParallel();
        const result = await this.#executeAtMostOnce(input.runId, call, input.signal);
        results.set(result.callId, result);
      }
      await flushParallel();
      throwIfCancelled(input.signal);
    } catch (error) {
      if (error instanceof CancellationError || input.signal.aborted) {
        throw new ToolExecutionInterruptedError(
          [...results.values()],
          input.signal.reason ?? error,
        );
      }
      throw error;
    }
    return Object.freeze(
      input.calls.map((call) => {
        const result = results.get(call.callId);
        if (result === undefined) {
          throw new ToolCallSchedulingError(
            "PILOT_TOOL_EXECUTION_FAILED",
            `Tool call ${call.callId} completed without a correlated result`,
            { callId: call.callId, toolName: call.toolName },
          );
        }
        return result;
      }),
    );
  }

  #executeAtMostOnce(
    runId: RunId,
    call: PendingToolCall,
    signal: AbortSignal,
  ): Promise<ScheduledToolResult> {
    const key = `${runId}\u0000${call.callId}`;
    const fingerprint = JSON.stringify([call.toolName, call.input]);
    const existing = this.#executions.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new ToolCallSchedulingError(
          "PILOT_TOOL_CALL_CONFLICT",
          `Tool call ${call.callId} was replayed with different input`,
          { runId, callId: call.callId, toolName: call.toolName },
        );
      }
      return existing.promise;
    }
    const promise = this.#executeOne(runId, call, signal);
    this.#executions.set(key, { fingerprint, promise });
    return promise;
  }

  async #executeOne(
    runId: RunId,
    call: PendingToolCall,
    signal: AbortSignal,
  ): Promise<ScheduledToolResult> {
    throwIfCancelled(signal);
    await this.#dependencies.observer?.({
      type: "tool.started",
      runId,
      callId: call.callId,
      toolName: call.toolName,
      input: call.input,
    });
    let result: ScheduledToolResult;
    try {
      const registered = this.#dependencies.registry.resolve(call.toolName);
      const input = this.#dependencies.registry.parseInput(call.toolName, call.input);
      const execution = await withTimeout(
        (toolSignal) =>
          registered.definition.execute(input, {
            runId,
            callId: call.callId,
            signal: toolSignal,
          }),
        registered.definition.metadata.timeoutMs,
        signal,
        call,
      );
      const output = this.#dependencies.registry.parseOutput(call.toolName, execution.output);
      const parsedOutput = JsonValueSchema.parse(output);
      const serializedBytes = Buffer.byteLength(JSON.stringify(parsedOutput), "utf8");
      if (serializedBytes > registered.definition.metadata.maxOutputBytes) {
        throw new ToolCallSchedulingError(
          "PILOT_TOOL_OUTPUT_TOO_LARGE",
          `Tool ${call.toolName} returned ${serializedBytes} bytes`,
          {
            callId: call.callId,
            toolName: call.toolName,
            maximumBytes: registered.definition.metadata.maxOutputBytes,
            observedBytes: serializedBytes,
          },
        );
      }
      result = Object.freeze({
        callId: call.callId,
        toolName: call.toolName,
        output: parsedOutput,
        isError: false,
        ...(execution.metadata === undefined ? {} : { metadata: execution.metadata }),
      });
    } catch (error) {
      if (error instanceof CancellationError || signal.aborted) {
        throw new CancellationError(signal.reason ?? error);
      }
      const snapshot = toSafeErrorSnapshot(error);
      const errorOutput = JsonValueSchema.parse({
        error: {
          code: snapshot.code,
          message: snapshot.message,
          retryable: snapshot.retryable,
          metadata: snapshot.metadata,
        },
        recovery: recoveryForToolError(snapshot.code),
      });
      result = Object.freeze({
        callId: call.callId,
        toolName: call.toolName,
        output: errorOutput,
        isError: true,
      });
    }
    await this.#dependencies.observer?.({
      type: "tool.completed",
      runId,
      callId: call.callId,
      toolName: call.toolName,
      isError: result.isError,
      output: result.output,
    });
    return result;
  }
}

function assertUniqueCalls(calls: readonly PendingToolCall[]): void {
  const identifiers = new Set<ToolCallId>();
  for (const call of calls) {
    if (identifiers.has(call.callId)) {
      throw new ToolCallSchedulingError(
        "PILOT_TOOL_CALL_CONFLICT",
        `Tool call ${call.callId} appears more than once in one schedule`,
        { callId: call.callId },
      );
    }
    identifiers.add(call.callId);
  }
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  call: PendingToolCall,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(
        new ToolCallSchedulingError(
          "PILOT_TOOL_TIMEOUT",
          `Tool ${call.toolName} exceeded ${timeoutMs}ms`,
          { callId: call.callId, toolName: call.toolName, timeoutMs },
        ),
      );
      controller.abort("tool execution timeout");
    }, timeoutMs);
    abortListener = () => {
      controller.abort(signal.reason);
      reject(new CancellationError(signal.reason));
    };
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    if (signal.aborted) abortListener?.();
    return await Promise.race([operation(controller.signal), boundary]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancellationError(signal.reason);
}
