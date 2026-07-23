import type { AgentMessage, JsonObject, JsonValue, ModelRequest, ToolCallPart } from "@pilot/core";

export interface OpenAIChatCompletionsRequest {
  readonly model: string;
  readonly stream: true;
  readonly stream_options: { readonly include_usage: true };
  readonly messages: readonly OpenAIMessage[];
  readonly tools?: readonly OpenAITool[];
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly tool_choice?: "auto" | "none" | "required";
  readonly parallel_tool_calls?: boolean;
  readonly response_format?: JsonObject;
  readonly reasoning_effort?: "minimal" | "low" | "medium" | "high";
}

type OpenAIContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image_url";
      readonly image_url: { readonly url: string };
    };

type OpenAIMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string | readonly OpenAIContentPart[] }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?: readonly OpenAIToolCall[];
    }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

interface OpenAIToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

interface OpenAITool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonObject;
  };
}

export function createChatCompletionsRequest(
  modelId: string,
  request: ModelRequest,
): OpenAIChatCompletionsRequest {
  return Object.freeze({
    model: modelId,
    stream: true,
    stream_options: Object.freeze({ include_usage: true }),
    messages: Object.freeze(request.messages.map(toOpenAIMessage)),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: Object.freeze(
            request.tools.map((tool) =>
              Object.freeze({
                type: "function" as const,
                function: Object.freeze({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                }),
              }),
            ),
          ),
        }),
    ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.toolChoice === undefined ? {} : { tool_choice: request.toolChoice }),
    ...(request.allowParallelToolCalls === undefined
      ? {}
      : { parallel_tool_calls: request.allowParallelToolCalls }),
    ...(request.reasoningEffort === undefined ? {} : { reasoning_effort: request.reasoningEffort }),
    ...(request.responseFormat?.type !== "json-schema"
      ? {}
      : {
          response_format: Object.freeze({
            type: "json_schema",
            json_schema: Object.freeze({
              name: request.responseFormat.name,
              schema: request.responseFormat.schema,
              strict: request.responseFormat.strict,
            }),
          }),
        }),
  });
}

function toOpenAIMessage(message: AgentMessage): OpenAIMessage {
  switch (message.role) {
    case "system":
      return Object.freeze({ role: "system", content: textContent(message) });
    case "user":
      return userMessage(message);
    case "assistant": {
      const calls = message.parts.filter((part): part is ToolCallPart => part.type === "tool-call");
      const content = textContent(message);
      return Object.freeze({
        role: "assistant",
        content: content.length === 0 ? null : content,
        ...(calls.length === 0
          ? {}
          : {
              tool_calls: Object.freeze(
                calls.map((call) =>
                  Object.freeze({
                    id: call.callId,
                    type: "function" as const,
                    function: Object.freeze({
                      name: call.toolName,
                      arguments: JSON.stringify(call.input),
                    }),
                  }),
                ),
              ),
            }),
      });
    }
    case "tool": {
      const result = message.parts.find((part) => part.type === "tool-result");
      if (result === undefined || result.type !== "tool-result") {
        throw new TypeError("Validated tool message has no tool result");
      }
      return Object.freeze({
        role: "tool",
        tool_call_id: result.callId,
        content: serializeToolOutput(result.output),
      });
    }
  }
}

function userMessage(message: AgentMessage): OpenAIMessage {
  const hasImage = message.parts.some((part) => part.type === "image");
  if (!hasImage) {
    return Object.freeze({ role: "user", content: textContent(message) });
  }

  const content: OpenAIContentPart[] = [];
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        content.push(Object.freeze({ type: "text", text: part.text }));
        break;
      case "image":
        content.push(
          Object.freeze({
            type: "image_url",
            image_url: Object.freeze({
              url:
                part.source.kind === "url"
                  ? part.source.url
                  : `data:${part.mediaType};base64,${part.source.data}`,
            }),
          }),
        );
        break;
      case "redacted":
        content.push(Object.freeze({ type: "text", text: "[redacted]" }));
        break;
    }
  }
  return Object.freeze({ role: "user", content: Object.freeze(content) });
}

function textContent(message: AgentMessage): string {
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") {
        return [part.text];
      }
      if (part.type === "redacted") {
        return ["[redacted]"];
      }
      return [];
    })
    .join("\n");
}

function serializeToolOutput(output: JsonValue): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}
