import {
  messageId,
  parseAgentMessage,
  runId,
  sessionId,
  toolCallId,
  type AgentMessage,
} from "@pilot/core";
import { describe, expect, it, vi } from "vitest";
import {
  ConversationCompactionError,
  ConversationCompactor,
  rehydrateConversationView,
  rehydrateConversationSummary,
  type ConversationSummarizer,
  type ConversationSummaryRequest,
} from "../src/index.js";

const tokenEstimator = {
  estimate(content: AgentMessage | string) {
    return { tokens: typeof content === "string" ? 2 : 10, method: "fixture" };
  },
};

function faithfulSummarizer(
  implementation?: (request: ConversationSummaryRequest) => string,
): ConversationSummarizer {
  return {
    async summarize(request) {
      return {
        text: implementation?.(request) ?? "The user requested work and the assistant responded.",
        sourceMessageIds: request.sourceMessageIds,
        sourceDigest: request.sourceDigest,
      };
    },
  };
}

function options(history: readonly AgentMessage[]) {
  return {
    history,
    maximumConversationTokens: 35,
    maximumSummaryTokens: 5,
    preserveRecentMessages: 2,
    summaryMessageId: messageId("summary-1"),
    signal: new AbortController().signal,
  };
}

describe("ConversationCompactor", () => {
  it("replaces a safe prefix with a traceable summary and rehydrates exact messages", async () => {
    const history = linearConversation(6);
    const summarize = vi.fn(faithfulSummarizer().summarize);
    const compactor = new ConversationCompactor({
      summarizer: { summarize },
      tokenEstimator,
    });

    const result = await compactor.compact(options(history));

    expect(summarize).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      compacted: true,
      originalTokens: 60,
      compactedTokens: 30,
      savedTokens: 30,
      sourceMessageIds: ["message-1", "message-2", "message-3", "message-4"],
      sourceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(result.messages.map(({ id }) => id)).toEqual(["summary-1", "message-5", "message-6"]);
    expect(result.summary).toMatchObject({
      role: "system",
      provenance: {
        kind: "compaction",
        sourceMessageIds: ["message-1", "message-2", "message-3", "message-4"],
      },
      metadata: {
        compaction: {
          schemaVersion: 1,
          sourceCount: 4,
          semanticVerification: "unverified",
          rehydrationRequiredForExactDetails: true,
        },
      },
    });
    if (result.summary === undefined) throw new Error("Expected a compaction summary");
    expect((result.summary.parts[0] as { text: string }).text).toContain(
      "rehydrate source messages for exact details",
    );
    await expect(rehydrateConversationSummary(result.summary, history)).resolves.toEqual(
      history.slice(0, 4),
    );
    await expect(rehydrateConversationView(result.messages, history)).resolves.toEqual(history);
    expect(Object.isFrozen(result.messages)).toBe(true);
  });

  it("does not summarize a conversation that already fits", async () => {
    const summarize = vi.fn(faithfulSummarizer().summarize);
    const history = linearConversation(3);
    const result = await new ConversationCompactor({
      summarizer: { summarize },
      tokenEstimator,
    }).compact({ ...options(history), maximumConversationTokens: 30 });

    expect(result).toMatchObject({ compacted: false, originalTokens: 30, savedTokens: 0 });
    expect(result.messages).toEqual(history);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("never splits an assistant tool call from its correlated tool result", async () => {
    const history = conversationWithToolExchange();
    const compactor = new ConversationCompactor({
      summarizer: faithfulSummarizer(),
      tokenEstimator,
    });

    await expect(
      compactor.compact({ ...options(history), preserveRecentMessages: 4 }),
    ).rejects.toMatchObject({ code: "PILOT_CONTEXT_COMPACTION" });

    const result = await compactor.compact({
      ...options(history),
      maximumConversationTokens: 45,
      preserveRecentMessages: 3,
    });
    expect(result.sourceMessageIds).toEqual(["message-1", "message-2", "message-3"]);
  });

  it("rejects summarizer lineage drift and oversized summaries", async () => {
    const history = linearConversation(6);
    const wrongLineage = new ConversationCompactor({
      tokenEstimator,
      summarizer: {
        async summarize(request) {
          return {
            text: "summary",
            sourceMessageIds: [...request.sourceMessageIds].reverse(),
            sourceDigest: request.sourceDigest,
          };
        },
      },
    });
    await expect(wrongLineage.compact(options(history))).rejects.toThrowError(
      ConversationCompactionError,
    );

    const largeSummaryEstimator = {
      estimate(content: AgentMessage | string) {
        return { tokens: typeof content === "string" ? 20 : 10, method: "fixture" };
      },
    };
    await expect(
      new ConversationCompactor({
        summarizer: faithfulSummarizer(),
        tokenEstimator: largeSummaryEstimator,
      }).compact(options(history)),
    ).rejects.toMatchObject({ code: "PILOT_CONTEXT_COMPACTION" });
  });

  it("detects source mutation during rehydration", async () => {
    const history = linearConversation(6);
    const result = await new ConversationCompactor({
      summarizer: faithfulSummarizer(),
      tokenEstimator,
    }).compact(options(history));
    const changed = history.map((message, index) =>
      index === 1
        ? parseAgentMessage({
            ...message,
            parts: [{ type: "text", text: "tampered detail" }],
          })
        : message,
    );

    await expect(
      rehydrateConversationSummary(result.summary as AgentMessage, changed),
    ).rejects.toMatchObject({
      code: "PILOT_CONTEXT_COMPACTION",
      metadata: {
        expectedDigest: expect.stringMatching(/^sha256:/u),
        actualDigest: expect.stringMatching(/^sha256:/u),
      },
    });
  });

  it("rejects recursive summary compaction and honors cancellation", async () => {
    const history = linearConversation(6);
    const compactor = new ConversationCompactor({
      summarizer: faithfulSummarizer(),
      tokenEstimator,
    });
    const first = await compactor.compact(options(history));
    const summary = first.summary as AgentMessage;
    const nestedHistory = [
      summary,
      parseAgentMessage({
        ...history[4],
        parentId: summary.id,
      }),
      history[5],
    ];
    nestedHistory[2] = parseAgentMessage({ ...nestedHistory[2], parentId: nestedHistory[1]?.id });
    await expect(
      compactor.compact({ ...options(nestedHistory), maximumConversationTokens: 1 }),
    ).rejects.toMatchObject({ code: "PILOT_CONTEXT_COMPACTION" });

    const controller = new AbortController();
    controller.abort("stop");
    await expect(
      compactor.compact({ ...options(history), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "PILOT_CANCELLED" });
  });
});

function linearConversation(count: number): readonly AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = 1; index <= count; index += 1) {
    const previous = messages.at(-1);
    const role = index % 2 === 1 ? "user" : "assistant";
    messages.push(
      parseAgentMessage({
        schemaVersion: 1,
        id: `message-${index}`,
        sessionId: "session-1",
        runId: `run-${Math.ceil(index / 2)}`,
        ...(previous === undefined ? {} : { parentId: previous.id }),
        role,
        status: "complete",
        parts: [{ type: "text", text: `${role} message ${index}` }],
        createdAt: `2026-07-22T00:00:0${index}.000Z`,
        provenance:
          role === "user"
            ? { kind: "user", channel: "cli" }
            : { kind: "model", providerId: "fake", modelId: "test" },
      }),
    );
  }
  return Object.freeze(messages);
}

function conversationWithToolExchange(): readonly AgentMessage[] {
  const callId = toolCallId("call-1");
  const session = sessionId("session-1");
  const run = runId("run-1");
  const first = parseAgentMessage({
    schemaVersion: 1,
    id: "message-1",
    sessionId: session,
    runId: run,
    role: "user",
    status: "complete",
    parts: [{ type: "text", text: "Inspect the file" }],
    createdAt: "2026-07-22T00:00:01.000Z",
    provenance: { kind: "user", channel: "cli" },
  });
  const call = parseAgentMessage({
    schemaVersion: 1,
    id: "message-2",
    sessionId: session,
    runId: run,
    parentId: first.id,
    role: "assistant",
    status: "complete",
    parts: [{ type: "tool-call", callId, toolName: "read_file", input: { path: "a.ts" } }],
    createdAt: "2026-07-22T00:00:02.000Z",
    provenance: { kind: "model", providerId: "fake", modelId: "test" },
  });
  const tool = parseAgentMessage({
    schemaVersion: 1,
    id: "message-3",
    sessionId: session,
    runId: run,
    parentId: call.id,
    role: "tool",
    status: "complete",
    parts: [
      {
        type: "tool-result",
        callId,
        toolName: "read_file",
        output: { content: "x" },
        isError: false,
      },
    ],
    createdAt: "2026-07-22T00:00:03.000Z",
    provenance: { kind: "tool", callId, toolName: "read_file" },
  });
  const tail = linearConversation(3).map((message, index) =>
    parseAgentMessage({
      ...message,
      id: `message-${index + 4}`,
      parentId: index === 0 ? tool.id : `message-${index + 3}`,
      createdAt: `2026-07-22T00:00:0${index + 4}.000Z`,
    }),
  );
  return Object.freeze([first, call, tool, ...tail]);
}
