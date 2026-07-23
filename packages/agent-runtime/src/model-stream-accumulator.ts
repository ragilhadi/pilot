import {
  JsonValueSchema,
  type JsonObject,
  type JsonValue,
  type ModelFailure,
  type ModelStreamEvent,
  type TokenUsage,
  parseModelStreamEvent,
  PilotError,
  TokenUsageSchema,
  type ToolCallId,
} from "@pilot/core";

export type StreamProtocolViolation =
  | "conflicting-duplicate"
  | "content-index-conflict"
  | "event-after-terminal"
  | "event-before-start"
  | "incomplete-tool-call"
  | "invalid-finish-reason"
  | "invalid-transition"
  | "malformed-tool-arguments"
  | "response-id-mismatch"
  | "stream-not-terminal"
  | "tool-argument-mismatch"
  | "unknown-tool-call"
  | "usage-decreased"
  | "unexpected-sequence";

export class ModelStreamProtocolError extends PilotError {
  readonly violation: StreamProtocolViolation;

  constructor(
    violation: StreamProtocolViolation,
    message: string,
    details: {
      readonly responseId?: string;
      readonly sequence?: number;
    } = {},
  ) {
    super({
      code: "PILOT_MODEL_STREAM_PROTOCOL",
      message,
      safeMessage: "The model provider returned an invalid event stream",
      metadata: {
        violation,
        ...(details.responseId === undefined ? {} : { responseId: details.responseId }),
        ...(details.sequence === undefined ? {} : { sequence: details.sequence }),
      },
    });
    this.violation = violation;
  }
}

export interface AccumulatedText {
  readonly contentIndex: number;
  readonly text: string;
}

export interface ToolCallSnapshot {
  readonly contentIndex: number;
  readonly callId: ToolCallId;
  readonly toolName: string;
  readonly argumentsText: string;
  readonly completed: boolean;
  readonly input?: JsonValue;
}

export interface CompletedToolCall {
  readonly contentIndex: number;
  readonly callId: ToolCallId;
  readonly toolName: string;
  readonly input: JsonValue;
}

export interface StreamContentSnapshot {
  readonly text: readonly AccumulatedText[];
  /** Provider-exposed reasoning is in-memory only and must not be persisted by default. */
  readonly ephemeralReasoning: readonly AccumulatedText[];
  readonly toolCalls: readonly ToolCallSnapshot[];
  readonly usage?: TokenUsage;
  readonly providerMetadata?: JsonObject;
}

export type StreamPhase = "active" | "completed" | "failed" | "idle" | "interrupted";

export interface StreamProgressSnapshot {
  readonly phase: StreamPhase;
  readonly responseId: string | undefined;
  readonly lastSequence: number | undefined;
  readonly content: StreamContentSnapshot;
}

export type ModelStreamOutcome =
  | {
      readonly status: "completed";
      readonly responseId: string;
      readonly finishReason:
        | "content-filter"
        | "error"
        | "length"
        | "stop"
        | "tool-calls"
        | "unknown";
      readonly text: readonly AccumulatedText[];
      readonly ephemeralReasoning: readonly AccumulatedText[];
      readonly toolCalls: readonly CompletedToolCall[];
      readonly usage?: TokenUsage;
      readonly providerMetadata?: JsonObject;
    }
  | {
      readonly status: "failed";
      readonly responseId: string;
      readonly error: ModelFailure;
      readonly partial: StreamContentSnapshot;
    }
  | {
      readonly status: "interrupted";
      readonly responseId: string | undefined;
      readonly reason: "cancelled" | "stream-error";
      readonly partial: StreamContentSnapshot;
    };

interface MutableToolCall {
  readonly contentIndex: number;
  readonly callId: ToolCallId;
  readonly toolName: string;
  argumentsText: string;
  completed: boolean;
  input: JsonValue | undefined;
}

const terminalPhases = new Set<StreamPhase>(["completed", "failed", "interrupted"]);
const usageFields = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningTokens",
  "estimatedCostUsd",
] as const satisfies readonly (keyof TokenUsage)[];

export class ModelStreamAccumulator {
  #phase: StreamPhase = "idle";
  #responseId: string | undefined;
  #lastSequence: number | undefined;
  readonly #seenEvents = new Map<number, string>();
  readonly #contentKinds = new Map<number, "text" | "tool-call">();
  readonly #text = new Map<number, string>();
  readonly #reasoning = new Map<number, string>();
  readonly #toolCalls = new Map<ToolCallId, MutableToolCall>();
  #usage: TokenUsage | undefined;
  #providerMetadata: JsonObject | undefined;
  #finishReason:
    | Extract<ModelStreamEvent, { type: "response.completed" }>["finishReason"]
    | undefined;
  #failure: ModelFailure | undefined;
  #interruptionReason: "cancelled" | "stream-error" | undefined;

  get phase(): StreamPhase {
    return this.#phase;
  }

  consume(input: unknown): "accepted" | "duplicate" {
    const event = parseModelStreamEvent(input);
    const fingerprint = JSON.stringify(event);
    const previousFingerprint = this.#seenEvents.get(event.sequence);

    if (previousFingerprint !== undefined) {
      if (previousFingerprint === fingerprint) {
        return "duplicate";
      }
      throw this.#error(
        "conflicting-duplicate",
        `Sequence ${event.sequence} was received with different content`,
        event,
      );
    }

    if (terminalPhases.has(this.#phase)) {
      throw this.#error("event-after-terminal", "An event arrived after stream termination", event);
    }

    const expectedSequence = this.#lastSequence === undefined ? 0 : this.#lastSequence + 1;
    if (event.sequence !== expectedSequence) {
      throw this.#error(
        "unexpected-sequence",
        `Expected sequence ${expectedSequence}, received ${event.sequence}`,
        event,
      );
    }

    if (this.#phase === "idle") {
      if (event.type !== "response.started") {
        throw this.#error("event-before-start", "The first event must start a response", event);
      }
      this.#responseId = event.responseId;
      this.#phase = "active";
    } else {
      if (event.responseId !== this.#responseId) {
        throw this.#error(
          "response-id-mismatch",
          `Expected response ${this.#responseId}, received ${event.responseId}`,
          event,
        );
      }
      this.#consumeActiveEvent(event);
    }

    this.#seenEvents.set(event.sequence, fingerprint);
    this.#lastSequence = event.sequence;
    return "accepted";
  }

  interrupt(reason: "cancelled" | "stream-error"): void {
    if (terminalPhases.has(this.#phase)) {
      throw this.#error("invalid-transition", `Cannot interrupt a ${this.#phase} stream`);
    }
    this.#phase = "interrupted";
    this.#interruptionReason = reason;
  }

  snapshot(): StreamProgressSnapshot {
    return Object.freeze({
      phase: this.#phase,
      responseId: this.#responseId,
      lastSequence: this.#lastSequence,
      content: this.#contentSnapshot(),
    });
  }

  finalize(): ModelStreamOutcome {
    if (this.#phase === "completed") {
      const responseId = this.#requiredResponseId();
      const finishReason = this.#finishReason;
      if (finishReason === undefined) {
        throw this.#error("stream-not-terminal", "Completed stream has no finish reason");
      }
      const content = this.#contentSnapshot();
      const toolCalls = content.toolCalls.map((toolCall): CompletedToolCall => {
        if (!toolCall.completed || toolCall.input === undefined) {
          throw this.#error("incomplete-tool-call", `Tool call ${toolCall.callId} is incomplete`);
        }
        return Object.freeze({
          contentIndex: toolCall.contentIndex,
          callId: toolCall.callId,
          toolName: toolCall.toolName,
          input: toolCall.input,
        });
      });
      return Object.freeze({
        status: "completed",
        responseId,
        finishReason,
        text: content.text,
        ephemeralReasoning: content.ephemeralReasoning,
        toolCalls: Object.freeze(toolCalls),
        ...(content.usage === undefined ? {} : { usage: content.usage }),
        ...(content.providerMetadata === undefined
          ? {}
          : { providerMetadata: content.providerMetadata }),
      });
    }

    if (this.#phase === "failed") {
      const error = this.#failure;
      if (error === undefined) {
        throw this.#error("stream-not-terminal", "Failed stream has no failure details");
      }
      return Object.freeze({
        status: "failed",
        responseId: this.#requiredResponseId(),
        error,
        partial: this.#contentSnapshot(),
      });
    }

    if (this.#phase === "interrupted") {
      const reason = this.#interruptionReason;
      if (reason === undefined) {
        throw this.#error("stream-not-terminal", "Interrupted stream has no reason");
      }
      return Object.freeze({
        status: "interrupted",
        responseId: this.#responseId,
        reason,
        partial: this.#contentSnapshot(),
      });
    }

    throw this.#error("stream-not-terminal", `Cannot finalize a ${this.#phase} stream`);
  }

  #consumeActiveEvent(event: ModelStreamEvent): void {
    switch (event.type) {
      case "response.started":
        throw this.#error("invalid-transition", "A response can only start once", event);
      case "text.delta":
        this.#appendText(event.contentIndex, event.delta, event);
        break;
      case "reasoning.delta":
        this.#reasoning.set(
          event.contentIndex,
          `${this.#reasoning.get(event.contentIndex) ?? ""}${event.delta}`,
        );
        break;
      case "tool-call.started":
        this.#startToolCall(event);
        break;
      case "tool-call.arguments.delta":
        this.#appendToolArguments(event.callId, event.delta, event);
        break;
      case "tool-call.completed":
        this.#completeToolCall(event.callId, event.input, event);
        break;
      case "usage.updated":
        this.#mergeUsage(event.usage, event);
        break;
      case "provider.metadata":
        this.#providerMetadata = Object.freeze({
          ...this.#providerMetadata,
          ...event.metadata,
        });
        break;
      case "response.completed":
        this.#completeResponse(event.finishReason, event);
        break;
      case "response.failed":
        this.#failure = event.error;
        this.#phase = "failed";
        break;
    }
  }

  #appendText(contentIndex: number, delta: string, event: ModelStreamEvent): void {
    const contentKind = this.#contentKinds.get(contentIndex);
    if (contentKind === "tool-call") {
      throw this.#error(
        "content-index-conflict",
        `Content index ${contentIndex} is already a tool call`,
        event,
      );
    }
    this.#contentKinds.set(contentIndex, "text");
    this.#text.set(contentIndex, `${this.#text.get(contentIndex) ?? ""}${delta}`);
  }

  #startToolCall(event: Extract<ModelStreamEvent, { type: "tool-call.started" }>): void {
    if (this.#toolCalls.has(event.callId)) {
      throw this.#error("invalid-transition", `Tool call ${event.callId} started twice`, event);
    }
    if (this.#contentKinds.has(event.contentIndex)) {
      throw this.#error(
        "content-index-conflict",
        `Content index ${event.contentIndex} is already occupied`,
        event,
      );
    }
    this.#contentKinds.set(event.contentIndex, "tool-call");
    this.#toolCalls.set(event.callId, {
      contentIndex: event.contentIndex,
      callId: event.callId,
      toolName: event.toolName,
      argumentsText: "",
      completed: false,
      input: undefined,
    });
  }

  #appendToolArguments(callId: ToolCallId, delta: string, event: ModelStreamEvent): void {
    const toolCall = this.#toolCalls.get(callId);
    if (toolCall === undefined) {
      throw this.#error("unknown-tool-call", `Unknown tool call ${callId}`, event);
    }
    if (toolCall.completed) {
      throw this.#error(
        "invalid-transition",
        `Tool arguments arrived after ${callId} completed`,
        event,
      );
    }
    toolCall.argumentsText += delta;
  }

  #completeToolCall(callId: ToolCallId, input: JsonValue, event: ModelStreamEvent): void {
    const toolCall = this.#toolCalls.get(callId);
    if (toolCall === undefined) {
      throw this.#error("unknown-tool-call", `Unknown tool call ${callId}`, event);
    }
    if (toolCall.completed) {
      throw this.#error("invalid-transition", `Tool call ${callId} completed twice`, event);
    }

    if (toolCall.argumentsText.length > 0) {
      let streamedInput: JsonValue;
      try {
        streamedInput = JsonValueSchema.parse(JSON.parse(toolCall.argumentsText));
      } catch {
        throw new ModelStreamProtocolError(
          "malformed-tool-arguments",
          `Tool call ${callId} streamed malformed JSON`,
          { responseId: event.responseId, sequence: event.sequence },
        );
      }
      if (!jsonEquals(streamedInput, input)) {
        throw this.#error(
          "tool-argument-mismatch",
          `Tool call ${callId} completed with input different from its argument stream`,
          event,
        );
      }
    }

    toolCall.completed = true;
    toolCall.input = input;
  }

  #mergeUsage(update: TokenUsage, event: ModelStreamEvent): void {
    const current = this.#usage;
    if (current === undefined) {
      this.#usage = update;
      return;
    }

    const merged: Record<string, unknown> = {
      source: current.source === update.source ? current.source : "mixed",
    };
    for (const field of usageFields) {
      const previousValue = current[field];
      const nextValue = update[field];
      if (previousValue !== undefined && nextValue !== undefined && nextValue < previousValue) {
        throw this.#error("usage-decreased", `Cumulative usage field ${field} decreased`, event);
      }
      const value = nextValue ?? previousValue;
      if (value !== undefined) {
        merged[field] = value;
      }
    }
    this.#usage = TokenUsageSchema.parse(merged);
  }

  #completeResponse(
    finishReason: Extract<ModelStreamEvent, { type: "response.completed" }>["finishReason"],
    event: ModelStreamEvent,
  ): void {
    const incomplete = [...this.#toolCalls.values()].find((toolCall) => !toolCall.completed);
    if (incomplete !== undefined) {
      throw this.#error(
        "incomplete-tool-call",
        `Tool call ${incomplete.callId} did not complete`,
        event,
      );
    }
    if (this.#toolCalls.size > 0 && finishReason !== "tool-calls") {
      throw this.#error(
        "invalid-finish-reason",
        "A response containing tool calls must finish with tool-calls",
        event,
      );
    }
    if (this.#toolCalls.size === 0 && finishReason === "tool-calls") {
      throw this.#error(
        "invalid-finish-reason",
        "A tool-calls finish requires at least one tool call",
        event,
      );
    }
    this.#finishReason = finishReason;
    this.#phase = "completed";
  }

  #contentSnapshot(): StreamContentSnapshot {
    const text = sortedText(this.#text);
    const ephemeralReasoning = sortedText(this.#reasoning);
    const toolCalls = [...this.#toolCalls.values()]
      .sort((left, right) => left.contentIndex - right.contentIndex)
      .map(
        (toolCall): ToolCallSnapshot =>
          Object.freeze({
            contentIndex: toolCall.contentIndex,
            callId: toolCall.callId,
            toolName: toolCall.toolName,
            argumentsText: toolCall.argumentsText,
            completed: toolCall.completed,
            ...(toolCall.input === undefined ? {} : { input: toolCall.input }),
          }),
      );
    return Object.freeze({
      text,
      ephemeralReasoning,
      toolCalls: Object.freeze(toolCalls),
      ...(this.#usage === undefined ? {} : { usage: this.#usage }),
      ...(this.#providerMetadata === undefined ? {} : { providerMetadata: this.#providerMetadata }),
    });
  }

  #requiredResponseId(): string {
    if (this.#responseId === undefined) {
      throw this.#error("stream-not-terminal", "Stream has no response identifier");
    }
    return this.#responseId;
  }

  #error(
    violation: StreamProtocolViolation,
    message: string,
    event?: Pick<ModelStreamEvent, "responseId" | "sequence">,
  ): ModelStreamProtocolError {
    return new ModelStreamProtocolError(violation, message, {
      ...(event?.responseId === undefined ? {} : { responseId: event.responseId }),
      ...(event?.sequence === undefined ? {} : { sequence: event.sequence }),
    });
  }
}

function sortedText(values: ReadonlyMap<number, string>): readonly AccumulatedText[] {
  return Object.freeze(
    [...values.entries()]
      .sort(([left], [right]) => left - right)
      .map(([contentIndex, text]) => Object.freeze({ contentIndex, text })),
  );
}

function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEquals(value, right[index] as JsonValue))
    );
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && jsonEquals(left[key] as JsonValue, right[key] as JsonValue),
      )
    );
  }
  return false;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
