import {
  AgentMessageSchema,
  type AgentMessage,
  MessageValidationError,
  parseAgentMessage,
  toSafeErrorSnapshot,
} from "../src/index.js";
import { describe, expect, expectTypeOf, it } from "vitest";

function userMessageInput(): unknown {
  return {
    schemaVersion: 1,
    id: "message-1",
    sessionId: "session-1",
    role: "user",
    status: "complete",
    parts: [{ type: "text", text: "Fix the failing test" }],
    createdAt: "2026-07-20T02:00:00.000Z",
    provenance: { kind: "user", channel: "cli" },
    metadata: { interactive: true, attempt: 1 },
  };
}

describe("AgentMessageSchema", () => {
  it("parses serialized input into deeply frozen provider-neutral data", () => {
    const message = parseAgentMessage(userMessageInput());

    expectTypeOf(message).toEqualTypeOf<AgentMessage>();
    expect(message.id).toBe("message-1");
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.parts)).toBe(true);
    expect(Object.isFrozen(message.parts[0])).toBe(true);
    expect(Object.isFrozen(message.provenance)).toBe(true);
    expect(Object.isFrozen(message.metadata)).toBe(true);
    expect(() => Object.assign(message, { status: "failed" })).toThrow(TypeError);
  });

  it("rejects unknown fields and non-serializable JSON values", () => {
    const input = {
      ...(userMessageInput() as Record<string, unknown>),
      unknownField: "future data without a schema version",
      metadata: { invalidNumber: Number.NaN },
    };

    const result = AgentMessageSchema.safeParse(input);

    expect(result.success).toBe(false);
  });

  it.each([
    {
      name: "a tool call in a user message",
      patch: {
        parts: [{ type: "tool-call", callId: "call-1", toolName: "read_file", input: {} }],
      },
    },
    {
      name: "model provenance on a user message",
      patch: {
        provenance: { kind: "model", providerId: "fake", modelId: "test" },
      },
    },
    {
      name: "raw reasoning content",
      patch: {
        parts: [{ type: "reasoning", text: "private reasoning" }],
      },
    },
  ])("rejects $name", ({ patch }) => {
    const input = { ...(userMessageInput() as Record<string, unknown>), ...patch };

    expect(AgentMessageSchema.safeParse(input).success).toBe(false);
  });

  it("correlates a tool result with its provenance", () => {
    const valid = {
      schemaVersion: 1,
      id: "message-tool-1",
      sessionId: "session-1",
      runId: "run-1",
      role: "tool",
      status: "complete",
      parts: [
        {
          type: "tool-result",
          callId: "call-1",
          toolName: "read_file",
          output: { text: "contents" },
          isError: false,
        },
      ],
      createdAt: "2026-07-20T02:01:00.000Z",
      provenance: { kind: "tool", callId: "call-1", toolName: "read_file" },
    };

    expect(AgentMessageSchema.safeParse(valid).success).toBe(true);
    expect(
      AgentMessageSchema.safeParse({
        ...valid,
        provenance: { kind: "tool", callId: "different-call", toolName: "read_file" },
      }).success,
    ).toBe(false);
  });

  it("accepts remote image URLs but rejects local-resource schemes", () => {
    const imageMessage = {
      ...(userMessageInput() as Record<string, unknown>),
      parts: [
        {
          type: "image",
          mediaType: "image/png",
          source: { kind: "url", url: "https://example.com/image.png" },
        },
      ],
    };

    expect(AgentMessageSchema.safeParse(imageMessage).success).toBe(true);
    expect(
      AgentMessageSchema.safeParse({
        ...imageMessage,
        parts: [
          {
            type: "image",
            mediaType: "image/png",
            source: { kind: "url", url: "file:///private/secret.png" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate tool-call identifiers within one assistant message", () => {
    const toolCall = {
      type: "tool-call",
      callId: "call-1",
      toolName: "read_file",
      input: { path: "README.md" },
    };
    const result = AgentMessageSchema.safeParse({
      schemaVersion: 1,
      id: "message-2",
      sessionId: "session-1",
      role: "assistant",
      status: "complete",
      parts: [toolCall, toolCall],
      createdAt: "2026-07-20T02:02:00.000Z",
      provenance: { kind: "model", providerId: "fake", modelId: "test" },
    });

    expect(result.success).toBe(false);
  });

  it("wraps detailed Zod failures in a safe typed error", () => {
    let caught: unknown;

    try {
      parseAgentMessage({ secret: "do-not-expose", role: "invalid" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MessageValidationError);
    expect(toSafeErrorSnapshot(caught)).toMatchObject({
      code: "PILOT_INVALID_MESSAGE",
      message: "The message has an invalid structure",
      retryable: false,
    });
    expect(JSON.stringify(toSafeErrorSnapshot(caught))).not.toContain("do-not-expose");
  });
});
