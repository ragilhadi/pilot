import {
  messageId,
  parseAgentMessage,
  runId,
  sessionId,
  type AgentMessage,
  type IdSource,
} from "@pilot/core";
import { FakeLanguageModel, textResponseScript } from "@pilot/testkit";
import { describe, expect, it } from "vitest";
import {
  ApplicationRunner,
  InMemorySessionRepository,
  ModelRegistry,
  RunInterruptionQueue,
  SessionConversationRunner,
  SessionError,
} from "../src/index.js";

const retryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 0,
  maxDelayMs: 0,
  jitterRatio: 0,
} as const;

const budgetPolicy = {
  maxCycles: 1,
  maxModelAttempts: 2,
  maxToolCalls: 0,
  maxElapsedMs: 10_000,
  maxInputTokens: 1_000,
  maxOutputTokens: 100,
  maxEstimatedCostUsd: 1,
} as const;

function sequenceIds(...values: string[]): IdSource {
  let index = 0;
  return {
    next() {
      const value = values[index];
      if (value === undefined) {
        throw new Error("Test ID sequence exhausted");
      }
      index += 1;
      return value;
    },
  };
}

function userMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return parseAgentMessage({
    schemaVersion: 1,
    id: "message-user",
    sessionId: "session-1",
    runId: "run-1",
    role: "user",
    status: "complete",
    parts: [{ type: "text", text: "Hello" }],
    createdAt: "2026-07-21T05:00:00.000Z",
    provenance: { kind: "user", channel: "cli" },
    ...overrides,
  });
}

function conversationHarness(model: FakeLanguageModel) {
  const sessions = new InMemorySessionRepository();
  const clock = { now: () => new Date("2026-07-21T05:00:00.000Z") };
  const runner = new ApplicationRunner({
    registry: new ModelRegistry([{ model, displayName: "Session fake" }]),
    clock,
    monotonicClock: { nowMilliseconds: () => 0 },
    checkpointWriter: { write: async () => undefined },
    estimateModelCall: async () => ({
      inputTokens: 10,
      outputTokens: 20,
      estimatedCostUsd: 0.1,
    }),
    retry: { random: () => 0.5, sleep: async () => undefined },
  });
  return {
    sessions,
    conversation: new SessionConversationRunner({
      runner,
      sessions,
      clock,
      messageIds: sequenceIds("message-1", "message-2", "message-3", "message-4"),
      runIds: sequenceIds("run-1", "run-2", "run-3"),
    }),
  };
}

describe("InMemorySessionRepository", () => {
  it("commits a linear, revisioned message history and returns immutable snapshots", async () => {
    const sessions = new InMemorySessionRepository();
    const id = sessionId("session-1");
    const created = await sessions.create({ id, createdAt: "2026-07-21T05:00:00.000Z" });
    const first = userMessage();
    const updated = await sessions.appendMessage(first);

    expect(created).toMatchObject({ id, revision: 0, messages: [] });
    expect(updated).toMatchObject({ revision: 1, messages: [{ id: "message-user" }] });
    expect(Object.isFrozen(updated)).toBe(true);
    expect(Object.isFrozen(updated.messages)).toBe(true);
    expect(created.messages).toHaveLength(0);
  });

  it("rejects duplicate IDs, stale parents, partial messages, and timestamp regression", async () => {
    const sessions = new InMemorySessionRepository();
    await sessions.create({
      id: sessionId("session-1"),
      createdAt: "2026-07-21T05:00:00.000Z",
      initialMessages: [userMessage()],
    });

    await expect(sessions.appendMessage(userMessage())).rejects.toMatchObject({
      code: "PILOT_SESSION_CONFLICT",
      reason: "duplicate-message",
    });
    await expect(
      sessions.appendMessage(
        userMessage({
          id: messageId("message-2"),
          parentId: messageId("wrong-parent"),
          createdAt: "2026-07-21T05:01:00.000Z",
        }),
      ),
    ).rejects.toMatchObject({ reason: "parent-mismatch" });
    await expect(
      sessions.appendMessage(
        userMessage({
          id: messageId("message-3"),
          parentId: messageId("message-user"),
          status: "partial",
        }),
      ),
    ).rejects.toMatchObject({ reason: "non-terminal-message" });
    await expect(
      sessions.appendMessage(
        userMessage({
          id: messageId("message-4"),
          parentId: messageId("message-user"),
          createdAt: "2026-07-21T04:59:59.000Z",
        }),
      ),
    ).rejects.toMatchObject({ reason: "created-at-regressed" });
  });

  it("rolls back creation when an initial history is invalid", async () => {
    const sessions = new InMemorySessionRepository();
    const id = sessionId("session-1");

    await expect(
      sessions.create({
        id,
        createdAt: "2026-07-21T05:00:00.000Z",
        initialMessages: [userMessage({ status: "partial" })],
      }),
    ).rejects.toBeInstanceOf(SessionError);
    expect(await sessions.load(id)).toBeUndefined();
  });
});

describe("SessionConversationRunner", () => {
  it("assembles deterministic multi-turn history and commits model provenance", async () => {
    const model = new FakeLanguageModel({
      scripts: [
        textResponseScript({
          responseId: "response-1",
          deltas: ["Hello", " there"],
          usage: { inputTokens: 3, outputTokens: 2, source: "provider" },
        }),
        textResponseScript({ responseId: "response-2", deltas: ["Second answer"] }),
      ],
    });
    const { sessions, conversation } = conversationHarness(model);
    await sessions.create({
      id: sessionId("session-1"),
      createdAt: "2026-07-21T05:00:00.000Z",
    });

    const first = await conversation.runTurn({
      sessionId: sessionId("session-1"),
      text: "First question",
      channel: "cli",
      modelKey: "fake/scripted",
      request: { tools: [], maxOutputTokens: 20 },
      retryPolicy,
      budgetPolicy,
      signal: new AbortController().signal,
    });
    const second = await conversation.runTurn({
      sessionId: sessionId("session-1"),
      text: "Second question",
      channel: "cli",
      modelKey: "fake/scripted",
      request: { tools: [], maxOutputTokens: 20 },
      retryPolicy,
      budgetPolicy,
      signal: new AbortController().signal,
    });

    expect(first.runs[0]?.result.state.kind).toBe("completed");
    expect(first.assistantMessage).toMatchObject({
      id: "message-2",
      parentId: "message-1",
      parts: [{ type: "text", text: "Hello there" }],
      provenance: {
        kind: "model",
        providerId: "fake",
        modelId: "scripted",
        responseId: "response-1",
      },
      metadata: { finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2 } },
    });
    expect(second.session.messages.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(second.session.messages.map(({ parentId }) => parentId)).toEqual([
      undefined,
      "message-1",
      "message-2",
      "message-3",
    ]);
    expect(model.calls[1]?.request.messages.map(({ id }) => id)).toEqual([
      "message-1",
      "message-2",
      "message-3",
    ]);
  });

  it("consumes queued follow-ups, rebases them, and restarts with a fresh run", async () => {
    const model = new FakeLanguageModel({
      scripts: [textResponseScript({ responseId: "response-1", deltas: ["Updated answer"] })],
    });
    const { sessions, conversation } = conversationHarness(model);
    const queue = new RunInterruptionQueue();
    await sessions.create({
      id: sessionId("session-1"),
      createdAt: "2026-07-21T05:00:00.000Z",
    });
    queue.enqueue({
      type: "follow-up",
      message: userMessage({
        id: messageId("message-follow-up"),
        runId: runId("obsolete-run"),
        createdAt: "2020-01-01T00:00:00.000Z",
        parts: [{ type: "text", text: "Use this direction instead" }],
      }),
    });

    const result = await conversation.runTurn({
      sessionId: sessionId("session-1"),
      text: "Original request",
      channel: "cli",
      modelKey: "fake/scripted",
      request: { tools: [], maxOutputTokens: 20 },
      retryPolicy,
      budgetPolicy,
      signal: new AbortController().signal,
      interruptionQueue: queue,
    });

    expect(result.runs).toHaveLength(2);
    expect(result.runs.map(({ runId: id }) => id)).toEqual(["run-1", "run-2"]);
    expect(result.runs[0]?.result.state.kind).toBe("aborted");
    expect(result.runs[1]?.result.state.kind).toBe("completed");
    expect(result.session.messages).toMatchObject([
      { id: "message-1", runId: "run-1" },
      { id: "message-follow-up", runId: "run-2", parentId: "message-1" },
      { id: "message-2", runId: "run-2", parentId: "message-follow-up" },
    ]);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.request.messages.map(({ id }) => id)).toEqual([
      "message-1",
      "message-follow-up",
    ]);
    expect(queue.size).toBe(0);
  });
});
