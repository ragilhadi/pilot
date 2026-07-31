import {
  type AgentMessage,
  chatTemplateOverheads,
  type JsonObject,
  type JsonValue,
  type ModelRequest,
  messageTextContent,
  type RequestPayloadDescription,
  type RequestPayloadSegment,
  type ToolCallPart,
} from "@pilotrun/core";

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

/**
 * Describe what a request will occupy in the context window, walking the *same* body
 * {@link createChatCompletionsRequest} produces.
 *
 * Deriving the description from the serialized body rather than from the `ModelRequest` is the whole
 * point: the two shapes differ, and the difference is where the tool schemas used to vanish. A field
 * added to the body is a field that shows up here without anyone remembering to add it.
 */
export function describeChatCompletionsPayload(
  modelId: string,
  request: ModelRequest,
): RequestPayloadDescription {
  const body = createChatCompletionsRequest(modelId, request);
  const segments: RequestPayloadSegment[] = [];

  if (body.tools !== undefined) {
    segments.push({
      kind: "tool-definitions",
      text: JSON.stringify(body.tools),
      overheadTokens: chatTemplateOverheads.perToolCall,
    });
  }

  for (const message of body.messages) {
    if (message.role === "tool") {
      segments.push({
        kind: "tool-result",
        text: message.content,
        overheadTokens: chatTemplateOverheads.perMessage + chatTemplateOverheads.perToolCall,
      });
      continue;
    }

    const toolCalls = message.role === "assistant" ? (message.tool_calls ?? []) : [];
    const parts: string[] = [];
    let imageCount = 0;
    if (typeof message.content === "string") {
      parts.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text") parts.push(part.text);
        else imageCount += 1;
      }
    }
    for (const call of toolCalls) {
      parts.push(call.function.name, call.function.arguments);
    }

    segments.push({
      kind: message.role === "system" ? "system" : "message",
      text: parts.join("\n"),
      overheadTokens:
        chatTemplateOverheads.perMessage + toolCalls.length * chatTemplateOverheads.perToolCall,
    });
    if (imageCount > 0) {
      segments.push({
        kind: "image",
        text: "",
        overheadTokens: imageCount * chatTemplateOverheads.perImage,
      });
    }
  }

  if (body.response_format !== undefined) {
    segments.push({
      kind: "response-format",
      text: JSON.stringify(body.response_format),
      overheadTokens: 0,
    });
  }

  return Object.freeze({
    segments: Object.freeze(segments),
    generationPromptTokens: chatTemplateOverheads.generationPrompt,
  });
}

function toOpenAIMessage(message: AgentMessage): OpenAIMessage {
  switch (message.role) {
    case "system":
      return Object.freeze({ role: "system", content: messageTextContent(message) });
    case "user":
      return userMessage(message);
    case "assistant": {
      const calls = message.parts.filter((part): part is ToolCallPart => part.type === "tool-call");
      const content = messageTextContent(message);
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
    return Object.freeze({ role: "user", content: messageTextContent(message) });
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

function serializeToolOutput(output: JsonValue): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}
