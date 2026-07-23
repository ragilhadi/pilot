import {
  ModelCapabilitiesSchema,
  ModelContractValidationError,
  ModelError,
  ModelRequestSchema,
  ModelResponseSchema,
  ModelStreamEventSchema,
  parseAgentMessage,
  parseModelKey,
  parseModelRequest,
  parseModelStreamEvent,
  parseProviderConfiguration,
  RetryPolicySchema,
  TokenUsageSchema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const capabilities = {
  streaming: true,
  nativeToolCalling: true,
  parallelToolCalls: false,
  structuredOutput: true,
  vision: false,
  promptCaching: false,
  reasoning: true,
  configurableReasoningEffort: false,
  systemMessages: true,
  maxContextTokens: 128_000,
  maxOutputTokens: 8_192,
};

function userMessage() {
  return parseAgentMessage({
    schemaVersion: 1,
    id: "message-user-1",
    sessionId: "session-1",
    runId: "run-1",
    role: "user",
    status: "complete",
    parts: [{ type: "text", text: "Read the file" }],
    createdAt: "2026-07-20T03:00:00.000Z",
    provenance: { kind: "user", channel: "cli" },
  });
}

function assistantMessage() {
  return parseAgentMessage({
    schemaVersion: 1,
    id: "message-assistant-1",
    sessionId: "session-1",
    runId: "run-1",
    parentId: "message-user-1",
    role: "assistant",
    status: "complete",
    parts: [{ type: "text", text: "Done" }],
    createdAt: "2026-07-20T03:01:00.000Z",
    provenance: { kind: "model", providerId: "fake", modelId: "scripted" },
  });
}

describe("model selection and capabilities", () => {
  it("splits a stable model key only at the first slash", () => {
    expect(parseModelKey("openrouter/vendor/model-name")).toEqual({
      key: "openrouter/vendor/model-name",
      providerId: "openrouter",
      modelId: "vendor/model-name",
    });
  });

  it.each(["missing-model", "/model", "Provider/model", "provider/", "provider/model name"])(
    "rejects invalid model key %s",
    (key) => {
      expect(() => parseModelKey(key)).toThrow(ModelContractValidationError);
    },
  );

  it("freezes capabilities and rejects invalid token limits", () => {
    const parsed = ModelCapabilitiesSchema.parse(capabilities);

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      ModelCapabilitiesSchema.safeParse({ ...capabilities, maxContextTokens: 0 }).success,
    ).toBe(false);
  });
});

describe("ModelRequest", () => {
  const request = {
    messages: [userMessage()],
    tools: [
      {
        name: "read_file",
        description: "Read a UTF-8 file inside the workspace.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
    maxOutputTokens: 1_024,
    toolChoice: "auto",
    responseFormat: { type: "text" },
  };

  it("parses and freezes provider-neutral requests", () => {
    const parsed = parseModelRequest(request);

    expect(ModelRequestSchema.parse(parsed)).toEqual(parsed);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.messages)).toBe(true);
    expect(Object.isFrozen(parsed.tools[0]?.inputSchema)).toBe(true);
  });

  it("rejects non-JSON tool schemas and unsupported request fields", () => {
    expect(
      ModelRequestSchema.safeParse({
        ...request,
        tools: [{ ...request.tools[0], inputSchema: { invalid: Number.NaN } }],
      }).success,
    ).toBe(false);
    expect(ModelRequestSchema.safeParse({ ...request, providerSpecificOption: true }).success).toBe(
      false,
    );
  });

  it("rejects contradictory capability combinations", () => {
    expect(
      ModelCapabilitiesSchema.safeParse({
        ...capabilities,
        nativeToolCalling: false,
        parallelToolCalls: true,
      }).success,
    ).toBe(false);
    expect(
      ModelCapabilitiesSchema.safeParse({
        ...capabilities,
        reasoning: false,
        configurableReasoningEffort: true,
      }).success,
    ).toBe(false);
  });
});

describe("model stream events", () => {
  const failure = new ModelError({
    kind: "unavailable",
    providerId: "fake",
    modelId: "scripted",
    message: "internal outage details",
  }).toFailure();

  const events = [
    { type: "response.started", sequence: 0, responseId: "response-1" },
    {
      type: "text.delta",
      sequence: 1,
      responseId: "response-1",
      contentIndex: 0,
      delta: "Hello",
    },
    {
      type: "reasoning.delta",
      sequence: 2,
      responseId: "response-1",
      contentIndex: 0,
      delta: "provider-exposed summary",
    },
    {
      type: "tool-call.started",
      sequence: 3,
      responseId: "response-1",
      contentIndex: 1,
      callId: "call-1",
      toolName: "read_file",
    },
    {
      type: "tool-call.arguments.delta",
      sequence: 4,
      responseId: "response-1",
      callId: "call-1",
      delta: '{"path":',
    },
    {
      type: "tool-call.completed",
      sequence: 5,
      responseId: "response-1",
      callId: "call-1",
      input: { path: "README.md" },
    },
    {
      type: "usage.updated",
      sequence: 6,
      responseId: "response-1",
      usage: { inputTokens: 10, outputTokens: 4, source: "provider" },
    },
    {
      type: "provider.metadata",
      sequence: 7,
      responseId: "response-1",
      metadata: { region: "local" },
    },
    {
      type: "response.completed",
      sequence: 8,
      responseId: "response-1",
      finishReason: "tool-calls",
    },
    { type: "response.failed", sequence: 9, responseId: "response-2", error: failure },
  ];

  it.each(events)("parses and freezes $type", (event) => {
    const parsed = parseModelStreamEvent(event);

    expect(ModelStreamEventSchema.parse(parsed)).toEqual(parsed);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("rejects unknown events and non-JSON provider metadata", () => {
    expect(
      ModelStreamEventSchema.safeParse({
        type: "provider.raw-event",
        sequence: 0,
        responseId: "response-1",
      }).success,
    ).toBe(false);
    expect(
      ModelStreamEventSchema.safeParse({
        type: "provider.metadata",
        sequence: 0,
        responseId: "response-1",
        metadata: { invalid: Number.POSITIVE_INFINITY },
      }).success,
    ).toBe(false);
  });
});

describe("usage, retry, configuration, and final response contracts", () => {
  it("validates partial usage updates but requires a measurement", () => {
    expect(TokenUsageSchema.safeParse({ outputTokens: 3, source: "estimated" }).success).toBe(true);
    expect(TokenUsageSchema.safeParse({ source: "provider" }).success).toBe(false);
    expect(TokenUsageSchema.safeParse({ inputTokens: -1, source: "provider" }).success).toBe(false);
  });

  it("rejects retry policies with inverted delays", () => {
    expect(
      RetryPolicySchema.safeParse({
        maxAttempts: 3,
        baseDelayMs: 2_000,
        maxDelayMs: 1_000,
        jitterRatio: 0.2,
      }).success,
    ).toBe(false);
  });

  it("accepts environment credential references and rejects raw API keys", () => {
    const configuration = parseProviderConfiguration({
      providerId: "openrouter",
      type: "openai-compatible",
      baseUrl: "https://openrouter.example/v1",
      auth: { type: "environment", variable: "OPENROUTER_API_KEY" },
    });

    expect(configuration.auth).toEqual({
      type: "environment",
      variable: "OPENROUTER_API_KEY",
    });
    expect(() =>
      parseProviderConfiguration({
        providerId: "openrouter",
        type: "openai-compatible",
        auth: { type: "environment", variable: "OPENROUTER_API_KEY" },
        apiKey: "secret",
      }),
    ).toThrow(ModelContractValidationError);
  });

  it("validates a final response independently from stream assembly", () => {
    const response = ModelResponseSchema.parse({
      responseId: "response-1",
      message: assistantMessage(),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 2, source: "provider" },
      providerMetadata: { region: "local" },
    });

    expect(Object.isFrozen(response)).toBe(true);
    expect(
      ModelResponseSchema.safeParse({
        responseId: "response-2",
        message: userMessage(),
        finishReason: "stop",
      }).success,
    ).toBe(false);
  });
});
