import { parseAgentMessage, parseModelRequest } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import { createChatCompletionsRequest } from "../src/index.js";

const common = {
  schemaVersion: 1,
  sessionId: "session-1",
  runId: "run-1",
  status: "complete",
  createdAt: "2026-07-21T02:00:00.000Z",
} as const;

describe("createChatCompletionsRequest", () => {
  it("translates provider-neutral messages, tools, images, and output settings", () => {
    const messages = [
      parseAgentMessage({
        ...common,
        id: "system-1",
        role: "system",
        parts: [{ type: "text", text: "Be precise" }],
        provenance: { kind: "system", source: "builtin" },
      }),
      parseAgentMessage({
        ...common,
        id: "user-1",
        role: "user",
        parts: [
          { type: "text", text: "Inspect this" },
          {
            type: "image",
            mediaType: "image/png",
            source: { kind: "base64", data: "YWJj" },
          },
        ],
        provenance: { kind: "user", channel: "cli" },
      }),
      parseAgentMessage({
        ...common,
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "text", text: "I will read it" },
          {
            type: "tool-call",
            callId: "call-1",
            toolName: "read_file",
            input: { path: "README.md" },
          },
        ],
        provenance: { kind: "model", providerId: "compatible", modelId: "example" },
      }),
      parseAgentMessage({
        ...common,
        id: "tool-1",
        role: "tool",
        parts: [
          {
            type: "tool-result",
            callId: "call-1",
            toolName: "read_file",
            output: { content: "hello" },
            isError: false,
          },
        ],
        provenance: { kind: "tool", callId: "call-1", toolName: "read_file" },
      }),
    ];
    const request = parseModelRequest({
      messages,
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      maxOutputTokens: 2_048,
      temperature: 0.2,
      toolChoice: "auto",
      allowParallelToolCalls: false,
      reasoningEffort: "medium",
      responseFormat: {
        type: "json-schema",
        name: "answer",
        schema: { type: "object" },
        strict: true,
      },
    });

    const translated = createChatCompletionsRequest("example", request);

    expect(translated).toMatchObject({
      model: "example",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 2_048,
      temperature: 0.2,
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning_effort: "medium",
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer", schema: { type: "object" }, strict: true },
      },
    });
    expect(translated.messages).toEqual([
      { role: "system", content: "Be precise" },
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
        ],
      },
      {
        role: "assistant",
        content: "I will read it",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: '{"content":"hello"}' },
    ]);
    expect(translated.tools?.[0]).toMatchObject({
      type: "function",
      function: { name: "read_file" },
    });
  });
});
