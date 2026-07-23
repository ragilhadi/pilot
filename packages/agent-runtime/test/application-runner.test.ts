import {
  CancellationError,
  defineTool,
  MessageValidationError,
  ModelError,
  parseAgentMessage,
  parseModelRequest,
  PilotError,
  runId,
  type ModelToolDefinition,
  type ModelRequest,
} from "@pilot/core";
import {
  delayStep,
  eventStep,
  FakeLanguageModel,
  textResponseScript,
  throwStep,
  toolCallScript,
  unsafeRawEventStep,
} from "@pilot/testkit";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";
import {
  ApplicationRunner,
  ModelRegistry,
  PermissionPolicyEngine,
  RunInterruptionQueue,
  ToolResultContextFormatter,
  ToolRegistry,
  type RunCheckpoint,
  type RunBudgetPolicy,
} from "../src/index.js";

const retryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 10,
  maxDelayMs: 100,
  jitterRatio: 0,
} as const;

const budgetPolicy = {
  maxCycles: 2,
  maxModelAttempts: 3,
  maxToolCalls: 0,
  maxElapsedMs: 1_000,
  maxInputTokens: 100,
  maxOutputTokens: 100,
  maxEstimatedCostUsd: 1,
} as const satisfies RunBudgetPolicy;

function request(maxOutputTokens = 20, tools: readonly ModelToolDefinition[] = []): ModelRequest {
  return parseModelRequest({
    messages: [
      {
        schemaVersion: 1,
        id: "message-1",
        sessionId: "session-1",
        runId: "run-1",
        role: "user",
        status: "complete",
        parts: [{ type: "text", text: "Hello" }],
        createdAt: "2026-07-21T04:00:00.000Z",
        provenance: { kind: "user", channel: "cli" },
      },
    ],
    tools,
    maxOutputTokens,
  });
}

function followUpMessage() {
  return parseAgentMessage({
    schemaVersion: 1,
    id: "message-follow-up",
    sessionId: "session-1",
    runId: "run-1",
    role: "user",
    status: "complete",
    parts: [{ type: "text", text: "Change direction" }],
    createdAt: "2026-07-21T04:01:00.000Z",
    provenance: { kind: "user", channel: "cli" },
  });
}

function harness(
  model: FakeLanguageModel,
  options: {
    readonly estimate?: { inputTokens: number; outputTokens: number; estimatedCostUsd?: number };
    readonly onModelEvent?: (event: { type: string }) => void | Promise<void>;
    readonly writeCheckpoint?: (checkpoint: RunCheckpoint) => Promise<void>;
    readonly tools?: ToolRegistry;
    readonly permissions?: PermissionPolicyEngine;
    readonly permissionMode?: "interactive" | "non-interactive-allow" | "non-interactive-deny";
    readonly onToolEvent?: (event: { type: string; callId: string }) => void | Promise<void>;
    readonly toolResultContextFormatter?: ToolResultContextFormatter;
  } = {},
) {
  const checkpoints: RunCheckpoint[] = [];
  const events: string[] = [];
  const delays: number[] = [];
  let monotonicNow = 0;
  const runner = new ApplicationRunner({
    registry: new ModelRegistry([{ model, displayName: "Scripted Fake" }]),
    clock: { now: () => new Date("2026-07-21T04:00:00.000Z") },
    monotonicClock: { nowMilliseconds: () => monotonicNow },
    checkpointWriter: {
      write: async (checkpoint) => {
        checkpoints.push(checkpoint);
        await options.writeCheckpoint?.(checkpoint);
      },
    },
    estimateModelCall: async () =>
      options.estimate ?? { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.1 },
    retry: {
      random: () => 0.5,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    },
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
    onModelEvent: async (event) => {
      events.push(event.type);
      await options.onModelEvent?.(event);
    },
    ...(options.onToolEvent === undefined ? {} : { onToolEvent: options.onToolEvent }),
    ...(options.toolResultContextFormatter === undefined
      ? {}
      : { toolResultContextFormatter: options.toolResultContextFormatter }),
  });

  return {
    runner,
    checkpoints,
    events,
    delays,
    setMonotonicNow(value: number) {
      monotonicNow = value;
    },
  };
}

function runInput(
  overrides: Partial<{
    request: ModelRequest;
    budgetPolicy: RunBudgetPolicy;
    signal: AbortSignal;
    interruptionQueue: RunInterruptionQueue;
    externalAbortReason: "shutdown" | "user-cancelled";
  }> = {},
) {
  return {
    runId: runId("run-1"),
    modelKey: "fake/scripted",
    request: overrides.request ?? request(),
    retryPolicy,
    budgetPolicy: overrides.budgetPolicy ?? budgetPolicy,
    signal: overrides.signal ?? new AbortController().signal,
    ...(overrides.interruptionQueue === undefined
      ? {}
      : { interruptionQueue: overrides.interruptionQueue }),
    ...(overrides.externalAbortReason === undefined
      ? {}
      : { externalAbortReason: overrides.externalAbortReason }),
  };
}

describe("ApplicationRunner success and checkpoints", () => {
  it("coordinates registry, state, stream, usage, checkpoints, and observers", async () => {
    const model = new FakeLanguageModel({
      scripts: [
        textResponseScript({
          responseId: "response-1",
          deltas: ["Hel", "lo"],
          usage: {
            inputTokens: 8,
            outputTokens: 2,
            estimatedCostUsd: 0.02,
            source: "provider",
          },
        }),
      ],
    });
    const { runner, checkpoints, events } = harness(model);

    const result = await runner.run(runInput());

    expect(result.state).toMatchObject({
      kind: "completed",
      cycle: 1,
      finishReason: "stop",
    });
    expect(result.outcome).toMatchObject({
      status: "completed",
      text: [{ contentIndex: 0, text: "Hello" }],
    });
    expect(result.budget).toMatchObject({
      cycles: 1,
      modelAttempts: 1,
      inputTokens: 8,
      outputTokens: 2,
      estimatedCostUsd: 0.02,
      activeModelAttempts: 0,
    });
    expect(events).toEqual([
      "response.started",
      "text.delta",
      "text.delta",
      "usage.updated",
      "response.completed",
    ]);
    expect(checkpoints.map(({ reason }) => reason)).toEqual([
      "run.started",
      "cycle.started",
      "context.prepared",
      "model.attempt.started",
      "model.stream.event",
      "model.stream.event",
      "model.stream.event",
      "model.stream.event",
      "model.stream.event",
      "run.terminal",
    ]);
    expect(checkpoints.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(checkpoints[4]).toMatchObject({
      state: { kind: "receiving-model-stream", responseId: "response-1" },
      stream: { phase: "active", lastSequence: 0 },
    });
    expect(checkpoints.at(-1)).toMatchObject({ state: { kind: "completed" } });
    expect(checkpoints.every(Object.isFrozen)).toBe(true);
    expect(model.calls[0]?.context).toEqual({
      runId: "run-1",
      attempt: 1,
      idempotencyKey: "run-1:cycle:1",
    });
  });

  it("ignores exact duplicate stream events without publishing or accounting twice", async () => {
    const started = eventStep({
      type: "response.started",
      sequence: 0,
      responseId: "response-duplicate",
    });
    const model = new FakeLanguageModel({
      scripts: [
        {
          steps: [
            started,
            started,
            eventStep({
              type: "response.completed",
              sequence: 1,
              responseId: "response-duplicate",
              finishReason: "stop",
            }),
          ],
        },
      ],
    });
    const { runner, events } = harness(model);

    const result = await runner.run(runInput());

    expect(result.state.kind).toBe("completed");
    expect(events).toEqual(["response.started", "response.completed"]);
  });

  it("fails safely and writes a terminal checkpoint when a stream checkpoint fails", async () => {
    let failedOnce = false;
    const model = new FakeLanguageModel({
      scripts: [textResponseScript({ responseId: "response-checkpoint", deltas: ["Hello"] })],
    });
    const { runner, checkpoints } = harness(model, {
      writeCheckpoint: async (checkpoint) => {
        if (checkpoint.reason === "model.stream.event" && !failedOnce) {
          failedOnce = true;
          throw new Error("storage unavailable");
        }
      },
    });

    const result = await runner.run(runInput());

    expect(result.state).toMatchObject({
      kind: "failed",
      error: { code: "PILOT_UNEXPECTED_ERROR" },
    });
    expect(checkpoints.at(-1)).toMatchObject({
      reason: "run.terminal",
      state: { kind: "failed" },
    });
  });
});

describe("ApplicationRunner retry safety", () => {
  it("retries a transient pre-stream failure with stable idempotency", async () => {
    const model = new FakeLanguageModel({
      scripts: [
        {
          steps: [
            throwStep(
              new ModelError({
                kind: "rate-limit",
                providerId: "fake",
                modelId: "scripted",
                message: "temporary",
                retryAfterMs: 25,
              }),
            ),
          ],
        },
        textResponseScript({ responseId: "response-2", deltas: ["Recovered"] }),
      ],
    });
    const { runner, checkpoints, delays } = harness(model);

    const result = await runner.run(runInput());

    expect(result.state).toMatchObject({ kind: "completed" });
    expect(result.budget.modelAttempts).toBe(2);
    expect(delays).toEqual([25]);
    expect(model.calls.map(({ context }) => context.idempotencyKey)).toEqual([
      "run-1:cycle:1",
      "run-1:cycle:1",
    ]);
    expect(model.calls.map(({ context }) => context.attempt)).toEqual([1, 2]);
    expect(checkpoints).toContainEqual(
      expect.objectContaining({
        reason: "model.retry.scheduled",
        state: expect.objectContaining({ kind: "waiting-for-model", attempt: 2 }),
      }),
    );
  });

  it("never retries a transient failure after a response becomes visible", async () => {
    const model = new FakeLanguageModel({
      scripts: [
        {
          steps: [
            eventStep({ type: "response.started", sequence: 0, responseId: "response-1" }),
            eventStep({
              type: "text.delta",
              sequence: 1,
              responseId: "response-1",
              contentIndex: 0,
              delta: "Visible",
            }),
            throwStep(
              new ModelError({
                kind: "unavailable",
                providerId: "fake",
                modelId: "scripted",
                message: "connection dropped",
              }),
            ),
          ],
        },
        textResponseScript({ responseId: "must-not-run", deltas: ["duplicate"] }),
      ],
    });
    const { runner, delays, events } = harness(model);

    const result = await runner.run(runInput());

    expect(result.state).toMatchObject({
      kind: "failed",
      previousKind: "receiving-model-stream",
      error: { code: "PILOT_MODEL_UNAVAILABLE" },
    });
    expect(model.calls).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(events).toEqual(["response.started", "text.delta"]);
  });

  it("fails malformed streams without retrying", async () => {
    const model = new FakeLanguageModel({
      scripts: [
        {
          steps: [
            eventStep({ type: "response.started", sequence: 0, responseId: "response-1" }),
            unsafeRawEventStep({
              type: "text.delta",
              sequence: 2,
              responseId: "response-1",
              contentIndex: 0,
              delta: "gap",
            }),
          ],
        },
      ],
    });
    const { runner } = harness(model);

    const result = await runner.run(runInput());

    expect(result.state).toMatchObject({
      kind: "failed",
      error: { code: "PILOT_MODEL_STREAM_PROTOCOL" },
    });
    expect(model.calls).toHaveLength(1);
  });
});

describe("ApplicationRunner budgets and unsupported operations", () => {
  it("aborts before transport when a model reservation exceeds budget", async () => {
    const model = new FakeLanguageModel({
      scripts: [textResponseScript({ responseId: "unused", deltas: ["unused"] })],
    });
    const { runner, checkpoints } = harness(model);

    const result = await runner.run(
      runInput({ budgetPolicy: { ...budgetPolicy, maxOutputTokens: 10 } }),
    );

    expect(result.state).toMatchObject({ kind: "aborted", reason: "budget-exhausted" });
    expect(result.budget).toMatchObject({
      modelAttempts: 0,
      exhaustion: { resource: "output-tokens", observed: 20 },
    });
    expect(model.calls).toHaveLength(0);
    expect(checkpoints.map(({ reason }) => reason)).toContain("budget.exhausted");
  });

  it("aborts an active stream when reported usage exceeds budget", async () => {
    const model = new FakeLanguageModel({
      scripts: [
        textResponseScript({
          responseId: "response-overrun",
          deltas: ["Too much"],
          usage: { outputTokens: 12, source: "provider" },
        }),
      ],
    });
    const { runner, events } = harness(model, {
      estimate: { inputTokens: 1, outputTokens: 5, estimatedCostUsd: 0 },
    });

    const result = await runner.run(
      runInput({
        request: request(5),
        budgetPolicy: { ...budgetPolicy, maxOutputTokens: 10 },
      }),
    );

    expect(result.state).toMatchObject({
      kind: "aborted",
      previousKind: "receiving-model-stream",
      reason: "budget-exhausted",
    });
    expect(result.budget).toMatchObject({
      outputTokens: 12,
      exhaustion: { resource: "output-tokens", observed: 12 },
    });
    expect(events).toEqual(["response.started", "text.delta"]);
  });

  it("fails when an estimator under-reserves the requested output maximum", async () => {
    const model = new FakeLanguageModel({
      scripts: [textResponseScript({ responseId: "unused", deltas: ["unused"] })],
    });
    const { runner } = harness(model, {
      estimate: { inputTokens: 1, outputTokens: 19, estimatedCostUsd: 0 },
    });

    const result = await runner.run(runInput());

    expect(result.state).toMatchObject({
      kind: "failed",
      error: { code: "PILOT_RUN_BUDGET_INVALID" },
    });
    expect(model.calls).toHaveLength(0);
  });

  it("charges model-requested tools against the run budget before execution", async () => {
    const model = new FakeLanguageModel({
      scripts: [
        toolCallScript({
          responseId: "response-tool",
          callId: "call-1",
          toolName: "read_file",
          argumentDeltas: ['{"path":"README.md"}'],
          completedInput: { path: "README.md" },
        }),
      ],
    });
    const { runner } = harness(model);

    const result = await runner.run(runInput());

    expect(result.state).toMatchObject({
      kind: "aborted",
      previousKind: "awaiting-permission",
      reason: "budget-exhausted",
    });
    expect(result.budget).toMatchObject({
      toolCalls: 0,
      exhaustion: { resource: "tool-calls", limit: 0, observed: 1 },
    });
    expect(result.outcome).toMatchObject({ status: "completed", finishReason: "tool-calls" });
  });

  it("executes a read-only tool, correlates its message, and continues the model loop", async () => {
    const EchoInput = z.object({ value: z.string() }).strict().readonly();
    const EchoOutput = z.object({ echoed: z.string() }).strict().readonly();
    const echo = defineTool({
      name: "echo_read",
      description: "Echo a value as a read-only test tool",
      inputSchema: EchoInput,
      outputSchema: EchoOutput,
      metadata: {
        risk: "read-only",
        concurrency: "parallel-safe",
        timeoutMs: 1_000,
        maxOutputBytes: 10_000,
        requiredPermissions: ["workspace.read"],
      },
      execute: async ({ value }) => ({ output: { echoed: value } }),
    });
    const tools = new ToolRegistry([echo]);
    const permissions = new PermissionPolicyEngine({
      clock: { now: () => new Date("2026-07-21T04:00:00.000Z") },
    });
    const model = new FakeLanguageModel({
      scripts: [
        toolCallScript({
          responseId: "response-tool",
          callId: "call-echo",
          toolName: "echo_read",
          argumentDeltas: ['{"value":"hello"}'],
          completedInput: { value: "hello" },
        }),
        textResponseScript({ responseId: "response-final", deltas: ["Inspected repository"] }),
      ],
    });
    const toolEvents: string[] = [];
    const { runner, checkpoints } = harness(model, {
      tools,
      permissions,
      onToolEvent: (event) => toolEvents.push(`${event.type}:${event.callId}`),
    });

    const result = await runner.run(
      runInput({
        request: request(20, tools.modelDefinitions()),
        budgetPolicy: { ...budgetPolicy, maxToolCalls: 2 },
      }),
    );

    expect(result.state).toMatchObject({ kind: "completed", cycle: 2, finishReason: "stop" });
    expect(result.budget).toMatchObject({ cycles: 2, modelAttempts: 2, toolCalls: 1 });
    expect(result.outcome).toMatchObject({
      status: "completed",
      responseId: "response-final",
      text: [{ contentIndex: 0, text: "Inspected repository" }],
    });
    expect(result.generatedMessages).toHaveLength(2);
    expect(result.generatedMessages[0]).toMatchObject({
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          callId: "call-echo",
          toolName: "echo_read",
          input: { value: "hello" },
        },
      ],
    });
    expect(result.generatedMessages[1]).toMatchObject({
      role: "tool",
      status: "complete",
      parts: [
        {
          type: "tool-result",
          callId: "call-echo",
          toolName: "echo_read",
          output: { echoed: "hello" },
          isError: false,
        },
      ],
      provenance: { kind: "tool", callId: "call-echo", toolName: "echo_read" },
    });
    expect(model.calls[1]?.request.messages.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(model.calls.map(({ context }) => context.idempotencyKey)).toEqual([
      "run-1:cycle:1",
      "run-1:cycle:2",
    ]);
    expect(toolEvents).toEqual(["tool.started:call-echo", "tool.completed:call-echo"]);
    expect(permissions.auditEntries()).toMatchObject([
      {
        context: { runId: "run-1", callId: "call-echo", sessionId: "session-1" },
        action: { kind: "tool", risk: "read-only", name: "echo_read" },
        decision: { effect: "allow", ruleId: "builtin.read-only.allow" },
      },
    ]);
    expect(
      checkpoints.map(({ reason }) => reason).filter((reason) => reason.includes("tool")),
    ).toEqual(["tools.completed", "tool-results.processed"]);
  });

  it("bounds the model-facing tool result while retaining explicit retrieval metadata", async () => {
    const LargeInput = z.object({}).strict().readonly();
    const LargeOutput = z.object({ content: z.string() }).strict().readonly();
    const large = defineTool({
      name: "large_read",
      description: "Return a large read-only fixture",
      inputSchema: LargeInput,
      outputSchema: LargeOutput,
      metadata: {
        risk: "read-only",
        concurrency: "parallel-safe",
        timeoutMs: 1_000,
        maxOutputBytes: 10_000,
        requiredPermissions: ["workspace.read"],
      },
      execute: async () => ({ output: { content: `HEAD${"x".repeat(4_000)}TAIL` } }),
    });
    const tools = new ToolRegistry([large]);
    const model = new FakeLanguageModel({
      scripts: [
        toolCallScript({
          responseId: "response-large-tool",
          callId: "call-large",
          toolName: "large_read",
          argumentDeltas: ["{}"],
          completedInput: {},
        }),
        textResponseScript({ responseId: "response-after-large", deltas: ["done"] }),
      ],
    });
    const { runner } = harness(model, {
      tools,
      toolResultContextFormatter: new ToolResultContextFormatter({ maximumBytes: 700 }),
    });

    const result = await runner.run(
      runInput({
        request: request(20, tools.modelDefinitions()),
        budgetPolicy: { ...budgetPolicy, maxToolCalls: 1 },
      }),
    );

    const toolMessage = result.generatedMessages[1];
    const toolPart = toolMessage?.parts[0];
    expect(toolPart).toMatchObject({
      type: "tool-result",
      output: {
        head: expect.stringContaining("HEAD"),
        tail: expect.stringContaining("TAIL"),
        pilotTruncation: {
          strategy: "head-tail",
          retrieval: { action: "request-narrower-result", callId: "call-large" },
        },
      },
    });
    expect(toolMessage?.metadata).toMatchObject({
      contextTruncation: { maximumBytes: 700, untrusted: true },
    });
    expect(
      new TextEncoder().encode(
        JSON.stringify(toolPart?.type === "tool-result" ? toolPart.output : null),
      ).byteLength,
    ).toBeLessThanOrEqual(700);
    expect(model.calls[1]?.request.messages.at(-1)).toEqual(toolMessage);
  });

  it("denies non-read-only tools without invoking them and returns the denial to the model", async () => {
    const MutationInput = z.object({ path: z.string() }).strict().readonly();
    const MutationOutput = z.object({ changed: z.boolean() }).strict().readonly();
    const execute = vi.fn(async () => ({ output: { changed: true } }));
    const mutation = defineTool({
      name: "write_file",
      description: "Mutation fixture",
      inputSchema: MutationInput,
      outputSchema: MutationOutput,
      metadata: {
        risk: "workspace-write",
        concurrency: "exclusive",
        timeoutMs: 1_000,
        maxOutputBytes: 10_000,
        requiredPermissions: ["workspace.write"],
      },
      execute,
    });
    const tools = new ToolRegistry([mutation]);
    const model = new FakeLanguageModel({
      scripts: [
        toolCallScript({
          responseId: "response-write",
          callId: "call-write",
          toolName: "write_file",
          argumentDeltas: ['{"path":"unsafe.txt"}'],
          completedInput: { path: "unsafe.txt" },
        }),
        textResponseScript({ responseId: "response-denied", deltas: ["Write denied"] }),
      ],
    });
    const { runner } = harness(model, { tools });

    const result = await runner.run(
      runInput({
        request: request(20, tools.modelDefinitions()),
        budgetPolicy: { ...budgetPolicy, maxToolCalls: 1 },
      }),
    );

    expect(result.state).toMatchObject({ kind: "completed", cycle: 2 });
    expect(execute).not.toHaveBeenCalled();
    expect(result.generatedMessages[1]).toMatchObject({
      role: "tool",
      status: "failed",
      parts: [
        {
          type: "tool-result",
          callId: "call-write",
          isError: true,
          output: {
            error: {
              code: "PILOT_TOOL_EXECUTION_FAILED",
              metadata: {
                permissionEffect: "deny",
                ruleId: "cli.permission-1",
              },
            },
            recovery: {
              kind: "permission-denied",
              action: "request-permission",
              sideEffects: "none",
            },
          },
        },
      ],
    });
  });

  it("hard-denies a destructive command intent even in explicit unattended allow mode", async () => {
    const execute = vi.fn(async () => ({ output: { executed: true } }));
    const danger = defineTool({
      name: "danger_fixture",
      description: "Destructive command permission fixture",
      inputSchema: z.object({}).strict().readonly(),
      outputSchema: z.object({ executed: z.boolean() }).strict().readonly(),
      metadata: {
        risk: "unknown",
        concurrency: "exclusive",
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
        requiredPermissions: ["process.execute"],
      },
      permissionAction: () => ({
        kind: "command",
        executable: "git",
        args: ["push", "--force"],
        cwd: ".",
        environment: {},
        risk: "destructive",
        requiredPermissions: ["process.execute", "system.destructive"],
      }),
      execute,
    });
    const tools = new ToolRegistry([danger]);
    const model = new FakeLanguageModel({
      scripts: [
        toolCallScript({
          responseId: "response-danger",
          callId: "call-danger",
          toolName: "danger_fixture",
          argumentDeltas: ["{}"],
          completedInput: {},
        }),
        textResponseScript({ responseId: "response-denied", deltas: ["Command denied"] }),
      ],
    });
    const { runner } = harness(model, { tools, permissionMode: "non-interactive-allow" });

    const result = await runner.run(
      runInput({
        request: request(20, tools.modelDefinitions()),
        budgetPolicy: { ...budgetPolicy, maxToolCalls: 1 },
      }),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.generatedMessages[1]).toMatchObject({
      role: "tool",
      parts: [
        {
          type: "tool-result",
          isError: true,
          output: {
            error: {
              metadata: {
                permissionEffect: "deny",
                ruleId: "builtin.destructive.deny",
              },
            },
            recovery: {
              kind: "permission-denied",
              action: "revise-request",
              sideEffects: "none",
            },
          },
        },
      ],
    });
  });

  it("returns malformed custom permission-intent input to the model without prompting or executing", async () => {
    const execute = vi.fn(async () => ({ output: { executed: true } }));
    const tool = defineTool({
      name: "validated_intent",
      description: "Permission input validation fixture",
      inputSchema: z.object({ value: z.string() }).strict().readonly(),
      outputSchema: z.object({ executed: z.boolean() }).strict().readonly(),
      metadata: {
        risk: "unknown",
        concurrency: "exclusive",
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
        requiredPermissions: ["process.execute"],
      },
      permissionAction: () => ({
        kind: "command",
        executable: "fixture",
        args: [],
        cwd: ".",
        environment: {},
        risk: "unknown",
        requiredPermissions: ["process.execute"],
      }),
      execute,
    });
    const tools = new ToolRegistry([tool]);
    const model = new FakeLanguageModel({
      scripts: [
        toolCallScript({
          responseId: "response-invalid-intent",
          callId: "call-invalid-intent",
          toolName: "validated_intent",
          argumentDeltas: ["{}"],
          completedInput: {},
        }),
        textResponseScript({ responseId: "response-recovered", deltas: ["Input rejected"] }),
      ],
    });
    const { runner } = harness(model, { tools, permissionMode: "interactive" });

    const result = await runner.run(
      runInput({
        request: request(20, tools.modelDefinitions()),
        budgetPolicy: { ...budgetPolicy, maxToolCalls: 1 },
      }),
    );

    expect(result.state).toMatchObject({ kind: "completed", cycle: 2 });
    expect(execute).not.toHaveBeenCalled();
    expect(result.generatedMessages[1]).toMatchObject({
      role: "tool",
      parts: [
        {
          type: "tool-result",
          isError: true,
          output: {
            error: { code: "PILOT_TOOL_INPUT_INVALID" },
            recovery: { kind: "invalid-input", action: "revise-request" },
          },
        },
      ],
    });
  });

  it("returns a patch conflict recovery to the model and continues the run", async () => {
    const conflict = defineTool({
      name: "patch_conflict",
      description: "Patch conflict recovery fixture",
      inputSchema: z.object({}).strict().readonly(),
      outputSchema: z.object({ changed: z.boolean() }).strict().readonly(),
      metadata: {
        risk: "read-only",
        concurrency: "parallel-safe",
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
        requiredPermissions: ["workspace.read"],
      },
      execute: async () => {
        throw new PilotError({
          code: "PILOT_PATCH_BASE_MISMATCH",
          message: "stale base",
        });
      },
    });
    const tools = new ToolRegistry([conflict]);
    const model = new FakeLanguageModel({
      scripts: [
        toolCallScript({
          responseId: "response-conflict",
          callId: "call-conflict",
          toolName: "patch_conflict",
          argumentDeltas: ["{}"],
          completedInput: {},
        }),
        textResponseScript({ responseId: "response-recover", deltas: ["I will re-read it"] }),
      ],
    });
    const { runner } = harness(model, { tools });

    const result = await runner.run(
      runInput({
        request: request(20, tools.modelDefinitions()),
        budgetPolicy: { ...budgetPolicy, maxToolCalls: 1 },
      }),
    );

    expect(result.state).toMatchObject({ kind: "completed", cycle: 2 });
    expect(result.generatedMessages[1]).toMatchObject({
      role: "tool",
      parts: [
        {
          type: "tool-result",
          output: {
            error: { code: "PILOT_PATCH_BASE_MISMATCH" },
            recovery: { kind: "patch-conflict", action: "re-read-file", retryable: true },
          },
        },
      ],
    });
  });
});

describe("ApplicationRunner interruption and cancellation", () => {
  it("persists an uncertain recovery result when a mutating tool is interrupted", async () => {
    const controller = new AbortController();
    const mutation = defineTool({
      name: "interrupt_write",
      description: "Interrupted mutation fixture",
      inputSchema: z.object({ path: z.string() }).strict().readonly(),
      outputSchema: z.object({ changed: z.boolean() }).strict().readonly(),
      metadata: {
        risk: "workspace-write",
        concurrency: "exclusive",
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
        requiredPermissions: ["workspace.write"],
      },
      execute: async (_input, context) => {
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new CancellationError(context.signal.reason));
          context.signal.addEventListener("abort", abort, { once: true });
          if (context.signal.aborted) abort();
        });
        return { output: { changed: true } };
      },
    });
    const tools = new ToolRegistry([mutation]);
    const model = new FakeLanguageModel({
      scripts: [
        toolCallScript({
          responseId: "response-interrupt-tool",
          callId: "call-interrupt-tool",
          toolName: "interrupt_write",
          argumentDeltas: ['{"path":"file.txt"}'],
          completedInput: { path: "file.txt" },
        }),
      ],
    });
    const { runner, checkpoints } = harness(model, {
      tools,
      permissionMode: "non-interactive-allow",
      onToolEvent: (event) => {
        if (event.type === "tool.started") setTimeout(() => controller.abort("stop tool"), 5);
      },
    });

    const result = await runner.run(
      runInput({
        request: request(20, tools.modelDefinitions()),
        budgetPolicy: { ...budgetPolicy, maxToolCalls: 1 },
        signal: controller.signal,
      }),
    );

    expect(result.state).toMatchObject({
      kind: "aborted",
      previousKind: "executing-tools",
      reason: "user-cancelled",
    });
    expect(result.generatedMessages).toHaveLength(2);
    expect(result.generatedMessages[1]).toMatchObject({
      role: "tool",
      status: "failed",
      parts: [
        {
          type: "tool-result",
          callId: "call-interrupt-tool",
          isError: true,
          output: {
            error: { code: "PILOT_CANCELLED", metadata: { executionStatus: "interrupted" } },
            recovery: {
              kind: "interrupted",
              action: "inspect-workspace",
              sideEffects: "unknown",
              retryable: false,
            },
          },
        },
      ],
    });
    expect(checkpoints.map(({ reason }) => reason)).toContain("tools.interrupted");
  });

  it("returns a prequeued follow-up without calling the model", async () => {
    const queue = new RunInterruptionQueue();
    queue.enqueue({ type: "follow-up", message: followUpMessage() });
    const model = new FakeLanguageModel({
      scripts: [textResponseScript({ responseId: "unused", deltas: ["unused"] })],
    });
    const { runner } = harness(model);

    const result = await runner.run(runInput({ interruptionQueue: queue }));

    expect(result.state).toMatchObject({
      kind: "aborted",
      previousKind: "preparing-context",
      reason: "user-cancelled",
    });
    expect(result.interruption).toMatchObject({
      type: "follow-up",
      message: { id: "message-follow-up" },
    });
    expect(queue.size).toBe(0);
    expect(model.calls).toHaveLength(0);
  });

  it("interrupts an active stream as soon as a follow-up is enqueued", async () => {
    const queue = new RunInterruptionQueue();
    const model = new FakeLanguageModel({
      scripts: [
        {
          steps: [
            eventStep({ type: "response.started", sequence: 0, responseId: "response-1" }),
            delayStep(1_000),
          ],
        },
      ],
    });
    const { runner } = harness(model, {
      onModelEvent: (event) => {
        if (event.type === "response.started") {
          queue.enqueue({ type: "follow-up", message: followUpMessage() });
        }
      },
    });

    const result = await runner.run(runInput({ interruptionQueue: queue }));

    expect(result.state).toMatchObject({
      kind: "aborted",
      previousKind: "receiving-model-stream",
      reason: "user-cancelled",
    });
    expect(result.interruption?.type).toBe("follow-up");
  });

  it("propagates external cancellation into an in-flight model", async () => {
    const controller = new AbortController();
    const model = new FakeLanguageModel({ scripts: [{ steps: [delayStep(1_000)] }] });
    const { runner } = harness(model, {
      writeCheckpoint: async (checkpoint) => {
        if (checkpoint.reason === "model.attempt.started") {
          controller.abort("test shutdown");
        }
      },
    });

    const result = await runner.run(
      runInput({ signal: controller.signal, externalAbortReason: "shutdown" }),
    );

    expect(result.state).toMatchObject({
      kind: "aborted",
      previousKind: "waiting-for-model",
      reason: "shutdown",
    });
    expect(model.calls).toHaveLength(1);
  });
});

describe("RunInterruptionQueue", () => {
  it("preserves FIFO order, snapshots messages, and supports unsubscribe", () => {
    const queue = new RunInterruptionQueue();
    const listener = vi.fn();
    const unsubscribe = queue.subscribe(listener);
    const message = followUpMessage();

    queue.enqueue({ type: "follow-up", message });
    unsubscribe();
    queue.enqueue({ type: "cancel", reason: "shutdown" });

    expect(listener).toHaveBeenCalledOnce();
    expect(queue.peek()).toMatchObject({ type: "follow-up" });
    expect(queue.dequeue()).toMatchObject({ type: "follow-up" });
    expect(queue.dequeue()).toEqual({ type: "cancel", reason: "shutdown" });
    expect(queue.dequeue()).toBeUndefined();
  });

  it("validates unsafe follow-up messages at the enqueue boundary", () => {
    const queue = new RunInterruptionQueue();

    expect(() => queue.enqueue({ type: "follow-up", message: { role: "user" } as never })).toThrow(
      MessageValidationError,
    );
    expect(queue.size).toBe(0);
  });
});
