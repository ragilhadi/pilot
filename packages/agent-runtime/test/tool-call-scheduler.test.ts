import {
  CancellationError,
  defineTool,
  PilotError,
  runId,
  toolCallId,
  type ToolExecutionContext,
} from "@pilotrun/core";
import * as z from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  ToolCallScheduler,
  ToolCallSchedulingError,
  ToolExecutionInterruptedError,
  ToolRegistry,
  type PendingToolCall,
} from "../src/index.js";

const InputSchema = z.object({ value: z.string() }).strict().readonly();
const OutputSchema = z.object({ value: z.string() }).strict().readonly();

function call(id: string, toolName: string, value = id): PendingToolCall {
  return { callId: toolCallId(id), toolName, input: { value } };
}

function tool(
  name: string,
  concurrency: "exclusive" | "parallel-safe",
  execute: (
    input: z.output<typeof InputSchema>,
    context: ToolExecutionContext,
  ) => Promise<{ output: z.output<typeof OutputSchema> }>,
  options: { readonly timeoutMs?: number; readonly maxOutputBytes?: number } = {},
) {
  return defineTool({
    name,
    description: `Test tool ${name}`,
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    metadata: {
      risk: "read-only",
      concurrency,
      timeoutMs: options.timeoutMs ?? 1_000,
      maxOutputBytes: options.maxOutputBytes ?? 10_000,
      requiredPermissions: ["workspace.read"],
    },
    execute,
  });
}

describe("ToolCallScheduler", () => {
  it("runs parallel-safe calls together, uses exclusive barriers, and preserves result order", async () => {
    const lifecycle: string[] = [];
    let activeParallel = 0;
    let maximumParallel = 0;
    const parallel = tool("parallel_read", "parallel-safe", async ({ value }) => {
      lifecycle.push(`start:${value}`);
      activeParallel += 1;
      maximumParallel = Math.max(maximumParallel, activeParallel);
      await delay(value === "slow" ? 20 : 5);
      activeParallel -= 1;
      lifecycle.push(`end:${value}`);
      return { output: { value } };
    });
    const exclusive = tool("exclusive_read", "exclusive", async ({ value }) => {
      expect(activeParallel).toBe(0);
      lifecycle.push(`start:${value}`);
      await delay(2);
      lifecycle.push(`end:${value}`);
      return { output: { value } };
    });
    const scheduler = new ToolCallScheduler({
      registry: new ToolRegistry([parallel, exclusive]),
    });

    const results = await scheduler.execute({
      runId: runId("run-schedule"),
      calls: [
        call("call-1", "parallel_read", "slow"),
        call("call-2", "parallel_read", "fast"),
        call("call-3", "exclusive_read", "barrier"),
        call("call-4", "parallel_read", "after"),
      ],
      signal: new AbortController().signal,
    });

    expect(maximumParallel).toBe(2);
    expect(lifecycle.indexOf("start:barrier")).toBeGreaterThan(lifecycle.indexOf("end:slow"));
    expect(lifecycle.indexOf("start:after")).toBeGreaterThan(lifecycle.indexOf("end:barrier"));
    expect(results.map(({ callId }) => callId)).toEqual(["call-1", "call-2", "call-3", "call-4"]);
    expect(results.map(({ output }) => output)).toEqual([
      { value: "slow" },
      { value: "fast" },
      { value: "barrier" },
      { value: "after" },
    ]);
  });

  it("executes the same run/call identity at most once and rejects conflicting replay", async () => {
    const execute = vi.fn(async ({ value }: { value: string }) => ({ output: { value } }));
    const scheduler = new ToolCallScheduler({
      registry: new ToolRegistry([tool("cached_read", "parallel-safe", execute)]),
    });
    const input = {
      runId: runId("run-replay"),
      calls: [call("call-cached", "cached_read", "same")],
      signal: new AbortController().signal,
    };

    const first = await scheduler.execute(input);
    const replay = await scheduler.execute(input);

    expect(replay).toEqual(first);
    expect(execute).toHaveBeenCalledOnce();
    await expect(
      scheduler.execute({
        ...input,
        calls: [call("call-cached", "cached_read", "different")],
      }),
    ).rejects.toBeInstanceOf(ToolCallSchedulingError);
  });

  it("rejects duplicate call identities before any tool starts", async () => {
    const execute = vi.fn(async ({ value }: { value: string }) => ({ output: { value } }));
    const scheduler = new ToolCallScheduler({
      registry: new ToolRegistry([tool("duplicate_read", "parallel-safe", execute)]),
    });

    await expect(
      scheduler.execute({
        runId: runId("run-duplicate"),
        calls: [
          call("same-call", "duplicate_read", "one"),
          call("same-call", "duplicate_read", "two"),
        ],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "PILOT_TOOL_CALL_CONFLICT" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns correlated safe errors for unknown tools, invalid input, failures, and invalid output", async () => {
    const throwing = tool("throwing_read", "parallel-safe", async () => {
      throw new Error("private failure detail");
    });
    const invalidOutput = defineTool({
      name: "invalid_output",
      description: "Invalid output fixture",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      metadata: {
        risk: "read-only",
        concurrency: "parallel-safe",
        timeoutMs: 1_000,
        maxOutputBytes: 10_000,
        requiredPermissions: ["workspace.read"],
      },
      execute: async () => ({ output: { wrong: true } as never }),
    });
    const scheduler = new ToolCallScheduler({
      registry: new ToolRegistry([throwing, invalidOutput]),
    });

    const results = await scheduler.execute({
      runId: runId("run-errors"),
      calls: [
        call("unknown", "not_registered"),
        { callId: toolCallId("invalid"), toolName: "throwing_read", input: { extra: true } },
        call("throws", "throwing_read"),
        call("bad-output", "invalid_output"),
      ],
      signal: new AbortController().signal,
    });

    expect(results).toHaveLength(4);
    expect(results.every(({ isError }) => isError)).toBe(true);
    expect(results.map(({ callId }) => callId)).toEqual([
      "unknown",
      "invalid",
      "throws",
      "bad-output",
    ]);
    expect(results[0]?.output).toMatchObject({ error: { code: "PILOT_TOOL_NOT_FOUND" } });
    expect(results[1]?.output).toMatchObject({ error: { code: "PILOT_TOOL_INPUT_INVALID" } });
    expect(results[2]?.output).toMatchObject({ error: { code: "PILOT_UNEXPECTED_ERROR" } });
    expect(results[3]?.output).toMatchObject({ error: { code: "PILOT_TOOL_OUTPUT_INVALID" } });
  });

  it("enforces output bytes and tool deadlines as correlated errors", async () => {
    let timeoutSignalAborted = false;
    const oversized = tool(
      "oversized_read",
      "parallel-safe",
      async () => ({ output: { value: "x".repeat(100) } }),
      { maxOutputBytes: 20 },
    );
    const timed = tool(
      "timed_read",
      "parallel-safe",
      async (_input, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              timeoutSignalAborted = true;
              resolve({ output: { value: "late" } });
            },
            { once: true },
          );
        }),
      { timeoutMs: 5 },
    );
    const scheduler = new ToolCallScheduler({
      registry: new ToolRegistry([oversized, timed]),
    });

    const results = await scheduler.execute({
      runId: runId("run-limits"),
      calls: [call("large", "oversized_read"), call("timeout", "timed_read")],
      signal: new AbortController().signal,
    });

    expect(results[0]).toMatchObject({
      callId: "large",
      isError: true,
      output: {
        error: { code: "PILOT_TOOL_OUTPUT_TOO_LARGE" },
        recovery: { kind: "execution-failure", action: "inspect-workspace" },
      },
    });
    expect(results[1]).toMatchObject({
      callId: "timeout",
      isError: true,
      output: {
        error: { code: "PILOT_TOOL_TIMEOUT" },
        recovery: { kind: "timeout", sideEffects: "unknown", retryable: false },
      },
    });
    expect(timeoutSignalAborted).toBe(true);
  });

  it("propagates cancellation to every active parallel tool", async () => {
    const controller = new AbortController();
    const aborted: string[] = [];
    const waiting = tool("waiting_read", "parallel-safe", async ({ value }, context) => {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => {
            aborted.push(value);
            reject(new CancellationError(context.signal.reason));
          },
          { once: true },
        );
      });
      return { output: { value } };
    });
    const scheduler = new ToolCallScheduler({ registry: new ToolRegistry([waiting]) });
    const execution = scheduler.execute({
      runId: runId("run-cancel"),
      calls: [call("wait-1", "waiting_read"), call("wait-2", "waiting_read")],
      signal: controller.signal,
    });
    await delay(2);
    controller.abort("cancel tools");

    await expect(execution).rejects.toBeInstanceOf(CancellationError);
    expect(aborted.sort()).toEqual(["wait-1", "wait-2"]);
  });

  it("retains completed parallel results when another tool is interrupted", async () => {
    const controller = new AbortController();
    const mixed = tool("mixed_read", "parallel-safe", async ({ value }, context) => {
      if (value === "fast") return { output: { value } };
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => reject(new CancellationError(context.signal.reason)),
          { once: true },
        );
      });
      return { output: { value } };
    });
    const scheduler = new ToolCallScheduler({ registry: new ToolRegistry([mixed]) });
    const pending = scheduler.execute({
      runId: runId("run-partial"),
      calls: [call("fast", "mixed_read", "fast"), call("waiting", "mixed_read", "waiting")],
      signal: controller.signal,
    });
    await delay(5);
    controller.abort("interrupt batch");

    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolExecutionInterruptedError);
    expect((caught as ToolExecutionInterruptedError).completedResults).toMatchObject([
      { callId: "fast", output: { value: "fast" }, isError: false },
    ]);
  });

  it("maps patch conflicts to a fresh-read recovery directive", async () => {
    const conflict = tool("conflict_read", "parallel-safe", async () => {
      throw new PilotError({
        code: "PILOT_PATCH_BASE_MISMATCH",
        message: "stale",
      });
    });
    const scheduler = new ToolCallScheduler({ registry: new ToolRegistry([conflict]) });

    const [result] = await scheduler.execute({
      runId: runId("run-conflict"),
      calls: [call("conflict", "conflict_read")],
      signal: new AbortController().signal,
    });

    expect(result?.output).toMatchObject({
      error: { code: "PILOT_PATCH_BASE_MISMATCH" },
      recovery: {
        kind: "patch-conflict",
        action: "re-read-file",
        sideEffects: "none",
        retryable: true,
      },
    });
  });

  it("emits lifecycle events with exact call correlation", async () => {
    const events: string[] = [];
    const scheduler = new ToolCallScheduler({
      registry: new ToolRegistry([
        tool("observed_read", "parallel-safe", async ({ value }) => ({ output: { value } })),
      ]),
      observer: (event) => events.push(`${event.type}:${event.callId}`),
    });

    await scheduler.execute({
      runId: runId("run-events"),
      calls: [call("observed", "observed_read")],
      signal: new AbortController().signal,
    });

    expect(events).toEqual(["tool.started:observed", "tool.completed:observed"]);
  });
});

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
