import {
  CancellationError,
  JsonValueSchema,
  type LanguageModel,
  type ModelCallContext,
  type ModelCapabilities,
  ModelContractValidationError,
  ModelError,
  type ModelFailureKind,
  type ModelRequest,
  type ModelStreamEvent,
  parseModelCapabilities,
  parseModelKey,
  parseModelRequest,
  parseModelStreamEvent,
  parseProviderConfiguration,
  type ProviderConfiguration,
} from "@pilotrun/core";
import * as z from "zod";
import {
  type EnvironmentReader,
  processEnvironmentReader,
  resolveBearerToken,
} from "./credentials.js";
import { createChatCompletionsRequest } from "./request.js";
import { parseServerSentEvents, readableStreamChunks } from "./sse.js";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OpenAICompatibleLanguageModelOptions {
  readonly configuration: ProviderConfiguration;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  readonly fetch?: Fetch;
  readonly readEnvironment?: EnvironmentReader;
  readonly now?: () => number;
}

const ToolCallDeltaSchema = z
  .object({
    index: z.number().int().nonnegative(),
    id: z.string().min(1).optional(),
    function: z
      .object({
        name: z.string().optional(),
        arguments: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const StreamChunkSchema = z
  .object({
    id: z.string().min(1),
    model: z.string().min(1).optional(),
    system_fingerprint: z.string().nullable().optional(),
    choices: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            delta: z
              .object({
                content: z.string().nullable().optional(),
                reasoning: z.string().nullable().optional(),
                reasoning_content: z.string().nullable().optional(),
                tool_calls: z.array(ToolCallDeltaSchema).optional(),
              })
              .passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        prompt_tokens_details: z
          .object({ cached_tokens: z.number().int().nonnegative().optional() })
          .passthrough()
          .optional(),
        completion_tokens_details: z
          .object({ reasoning_tokens: z.number().int().nonnegative().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

interface ToolCallState {
  readonly index: number;
  id?: string;
  name: string;
  arguments: string;
  emittedArgumentLength: number;
  sawArgumentsField: boolean;
  started: boolean;
  completed: boolean;
}

export class OpenAICompatibleLanguageModel implements LanguageModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;

  readonly #configuration: ProviderConfiguration;
  readonly #endpoint: URL;
  readonly #fetch: Fetch;
  readonly #readEnvironment: EnvironmentReader;
  readonly #now: () => number;

  constructor(options: OpenAICompatibleLanguageModelOptions) {
    this.#configuration = parseProviderConfiguration(options.configuration);
    if (this.#configuration.type !== "openai-compatible" && this.#configuration.type !== "openai") {
      throw contractError("OpenAI-compatible provider configuration has an incompatible type");
    }

    this.providerId = this.#configuration.providerId;
    this.modelId = options.modelId;
    parseModelKey(`${this.providerId}/${this.modelId}`);
    this.capabilities = parseModelCapabilities(options.capabilities);

    const baseUrl =
      this.#configuration.baseUrl ??
      (this.#configuration.type === "openai" ? "https://api.openai.com/v1" : undefined);
    if (baseUrl === undefined) {
      throw contractError("An OpenAI-compatible provider requires a base URL");
    }
    this.#endpoint = new URL("chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#readEnvironment = options.readEnvironment ?? processEnvironmentReader;
    this.#now = options.now ?? Date.now;
  }

  async *stream(
    requestInput: ModelRequest,
    context: ModelCallContext,
  ): AsyncIterable<ModelStreamEvent> {
    const request = parseModelRequest(requestInput);
    const token = resolveBearerToken(
      this.#configuration.auth,
      this.providerId,
      this.modelId,
      this.#readEnvironment,
    );
    const headers = new Headers({
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "Idempotency-Key": context.idempotencyKey,
    });
    if (token !== undefined) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    let response: Response;
    try {
      const fetch = this.#fetch;
      response = await fetch(this.#endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(createChatCompletionsRequest(this.modelId, request)),
        signal: context.signal,
      });
    } catch (error) {
      if (context.signal.aborted) {
        throw new CancellationError(error);
      }
      throw new ModelError({
        kind: "unavailable",
        providerId: this.providerId,
        modelId: this.modelId,
        message: "OpenAI-compatible request failed before receiving a response",
        cause: error,
      });
    }

    if (!response.ok) {
      try {
        throw await this.#httpError(response);
      } catch (error) {
        if (context.signal.aborted && !(error instanceof CancellationError)) {
          throw new CancellationError(error);
        }
        throw error;
      }
    }
    if (response.body === null) {
      throw new ModelError({
        kind: "provider-error",
        providerId: this.providerId,
        modelId: this.modelId,
        message: "OpenAI-compatible response did not contain a stream body",
        retryable: false,
      });
    }

    const normalizer = new ChatCompletionStreamNormalizer();
    try {
      for await (const event of parseServerSentEvents(readableStreamChunks(response.body))) {
        if (event.data.trim() === "[DONE]") {
          for (const normalized of normalizer.finish()) {
            yield normalized;
          }
          return;
        }

        let input: unknown;
        try {
          input = JSON.parse(event.data);
        } catch (error) {
          throw contractError("OpenAI-compatible SSE data was not valid JSON", error);
        }

        if (isProviderErrorPayload(input)) {
          throw new ModelError({
            kind: "provider-error",
            providerId: this.providerId,
            modelId: this.modelId,
            message: "OpenAI-compatible stream contained an error payload",
          });
        }

        const parsed = StreamChunkSchema.safeParse(input);
        if (!parsed.success) {
          throw new ModelContractValidationError(
            "OpenAI-compatible stream chunk",
            parsed.error.issues.length,
            parsed.error,
          );
        }
        for (const normalized of normalizer.consume(parsed.data)) {
          yield normalized;
        }
      }

      for (const normalized of normalizer.finish()) {
        yield normalized;
      }
    } catch (error) {
      if (context.signal.aborted && !(error instanceof CancellationError)) {
        throw new CancellationError(error);
      }
      throw error;
    }
  }

  async #httpError(response: Response): Promise<ModelError> {
    const body = await readResponseTextLimited(response, 65_536);
    const kind = classifyHttpFailure(response.status, body);
    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"), this.#now());
    return new ModelError({
      kind,
      providerId: this.providerId,
      modelId: this.modelId,
      message: `OpenAI-compatible provider returned HTTP ${response.status}`,
      statusCode: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
}

class ChatCompletionStreamNormalizer {
  readonly #toolCalls = new Map<number, ToolCallState>();
  readonly #metadata = new Map<string, string>();
  #sequence = 0;
  #responseId: string | undefined;
  #finishReason: string | undefined;
  #finished = false;

  consume(chunk: z.output<typeof StreamChunkSchema>): readonly ModelStreamEvent[] {
    if (this.#finished) {
      throw contractError("OpenAI-compatible stream emitted data after completion");
    }
    const events: ModelStreamEvent[] = [];
    if (this.#responseId === undefined) {
      this.#responseId = chunk.id;
      events.push(this.#event({ type: "response.started" }));
    } else if (chunk.id !== this.#responseId) {
      throw contractError("OpenAI-compatible stream changed response identifiers");
    }

    const metadata: Record<string, string> = {};
    if (chunk.model !== undefined && this.#metadata.get("model") !== chunk.model) {
      metadata.model = chunk.model;
      this.#metadata.set("model", chunk.model);
    }
    if (
      chunk.system_fingerprint !== undefined &&
      chunk.system_fingerprint !== null &&
      this.#metadata.get("systemFingerprint") !== chunk.system_fingerprint
    ) {
      metadata.systemFingerprint = chunk.system_fingerprint;
      this.#metadata.set("systemFingerprint", chunk.system_fingerprint);
    }
    if (Object.keys(metadata).length > 0) {
      events.push(this.#event({ type: "provider.metadata", metadata }));
    }

    for (const choice of chunk.choices) {
      if (choice.index !== 0) {
        throw contractError("OpenAI-compatible stream returned multiple choices");
      }
      if (this.#finishReason !== undefined && hasDeltaContent(choice.delta)) {
        throw contractError("OpenAI-compatible stream emitted content after a finish reason");
      }

      if (choice.delta.content !== undefined && choice.delta.content !== null) {
        if (choice.delta.content.length > 0) {
          events.push(
            this.#event({ type: "text.delta", contentIndex: 0, delta: choice.delta.content }),
          );
        }
      }
      const reasoning = choice.delta.reasoning_content ?? choice.delta.reasoning;
      if (reasoning !== undefined && reasoning !== null && reasoning.length > 0) {
        events.push(this.#event({ type: "reasoning.delta", contentIndex: 0, delta: reasoning }));
      }
      for (const toolDelta of choice.delta.tool_calls ?? []) {
        this.#consumeToolDelta(toolDelta, events);
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (this.#finishReason !== undefined) {
          throw contractError("OpenAI-compatible stream emitted multiple finish reasons");
        }
        this.#finishReason = choice.finish_reason;
        this.#completeTools(events);
      }
    }

    if (chunk.usage !== undefined && chunk.usage !== null) {
      const usage = {
        ...(chunk.usage.prompt_tokens === undefined
          ? {}
          : { inputTokens: chunk.usage.prompt_tokens }),
        ...(chunk.usage.completion_tokens === undefined
          ? {}
          : { outputTokens: chunk.usage.completion_tokens }),
        ...(chunk.usage.prompt_tokens_details?.cached_tokens === undefined
          ? {}
          : { cachedInputTokens: chunk.usage.prompt_tokens_details.cached_tokens }),
        ...(chunk.usage.completion_tokens_details?.reasoning_tokens === undefined
          ? {}
          : { reasoningTokens: chunk.usage.completion_tokens_details.reasoning_tokens }),
        source: "provider" as const,
      };
      if (Object.keys(usage).length > 1) {
        events.push(this.#event({ type: "usage.updated", usage }));
      }
    }
    return Object.freeze(events);
  }

  finish(): readonly ModelStreamEvent[] {
    if (this.#finished) {
      return Object.freeze([]);
    }
    if (this.#responseId === undefined || this.#finishReason === undefined) {
      throw contractError("OpenAI-compatible stream ended before a finish reason");
    }
    this.#finished = true;
    return Object.freeze([
      this.#event({
        type: "response.completed",
        finishReason: normalizeFinishReason(this.#finishReason),
      }),
    ]);
  }

  #consumeToolDelta(delta: z.output<typeof ToolCallDeltaSchema>, events: ModelStreamEvent[]): void {
    let state = this.#toolCalls.get(delta.index);
    if (state === undefined) {
      state = {
        index: delta.index,
        name: "",
        arguments: "",
        emittedArgumentLength: 0,
        sawArgumentsField: false,
        started: false,
        completed: false,
      };
      this.#toolCalls.set(delta.index, state);
    }
    if (state.completed) {
      throw contractError("OpenAI-compatible stream extended a completed tool call");
    }
    if (delta.id !== undefined) {
      if (state.id !== undefined && state.id !== delta.id) {
        throw contractError("OpenAI-compatible stream changed a tool-call identifier");
      }
      state.id = delta.id;
    }
    state.name += delta.function?.name ?? "";
    state.arguments += delta.function?.arguments ?? "";
    state.sawArgumentsField ||= delta.function?.arguments !== undefined;
    this.#flushToolState(state, events);
  }

  #flushToolState(state: ToolCallState, events: ModelStreamEvent[], forceStart = false): void {
    if (
      !state.started &&
      state.id !== undefined &&
      state.name.length > 0 &&
      (state.sawArgumentsField || forceStart)
    ) {
      state.started = true;
      events.push(
        this.#event({
          type: "tool-call.started",
          contentIndex: state.index + 1,
          callId: state.id,
          toolName: state.name,
        }),
      );
    }
    if (state.started && state.arguments.length > state.emittedArgumentLength) {
      const delta = state.arguments.slice(state.emittedArgumentLength);
      state.emittedArgumentLength = state.arguments.length;
      events.push(
        this.#event({
          type: "tool-call.arguments.delta",
          callId: state.id,
          delta,
        }),
      );
    }
  }

  #completeTools(events: ModelStreamEvent[]): void {
    for (const state of [...this.#toolCalls.values()].sort(
      (left, right) => left.index - right.index,
    )) {
      this.#flushToolState(state, events, true);
      if (!state.started || state.id === undefined) {
        throw contractError("OpenAI-compatible tool call ended without an identifier and name");
      }
      let input: unknown;
      try {
        input = JSON.parse(state.arguments);
      } catch (error) {
        throw contractError("OpenAI-compatible tool arguments were not valid JSON", error);
      }
      const parsed = JsonValueSchema.safeParse(input);
      if (!parsed.success) {
        throw new ModelContractValidationError(
          "OpenAI-compatible tool arguments",
          parsed.error.issues.length,
          parsed.error,
        );
      }
      state.completed = true;
      events.push(
        this.#event({ type: "tool-call.completed", callId: state.id, input: parsed.data }),
      );
    }
  }

  #event(event: Record<string, unknown>): ModelStreamEvent {
    if (this.#responseId === undefined) {
      throw contractError("Cannot emit an event before receiving a response identifier");
    }
    return parseModelStreamEvent({
      ...event,
      sequence: this.#sequence++,
      responseId: this.#responseId,
    });
  }
}

function contractError(message: string, cause: unknown = new Error(message)) {
  return new ModelContractValidationError("OpenAI-compatible response", 1, cause);
}

function hasDeltaContent(
  delta: z.output<typeof StreamChunkSchema>["choices"][number]["delta"],
): boolean {
  return (
    (delta.content !== undefined && delta.content !== null && delta.content.length > 0) ||
    (delta.reasoning !== undefined && delta.reasoning !== null && delta.reasoning.length > 0) ||
    (delta.reasoning_content !== undefined &&
      delta.reasoning_content !== null &&
      delta.reasoning_content.length > 0) ||
    (delta.tool_calls?.length ?? 0) > 0
  );
}

function normalizeFinishReason(reason: string) {
  switch (reason) {
    case "stop":
      return "stop" as const;
    case "length":
      return "length" as const;
    case "tool_calls":
    case "function_call":
      return "tool-calls" as const;
    case "content_filter":
      return "content-filter" as const;
    default:
      return "unknown" as const;
  }
}

function isProviderErrorPayload(input: unknown): boolean {
  return typeof input === "object" && input !== null && "error" in input;
}

function classifyHttpFailure(status: number, body: string): ModelFailureKind {
  if (status === 401 || status === 403) {
    return "authentication";
  }
  if (status === 429) {
    return "rate-limit";
  }
  if (status === 408 || status === 409 || status === 425 || status >= 500) {
    return "unavailable";
  }
  if (status === 400 && /context[_ -]?(?:length|window)|maximum context/iu.test(body)) {
    return "context-limit";
  }
  if (status >= 400 && status < 500) {
    return "invalid-request";
  }
  return "provider-error";
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

async function readResponseTextLimited(response: Response, limit: number): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    return text.slice(0, limit);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
