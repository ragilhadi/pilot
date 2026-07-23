import { InvalidIdentifierError } from "./errors.js";

declare const brand: unique symbol;

/** Adds compile-time identity to a value without changing its runtime representation. */
export type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export type EventId = Brand<string, "EventId">;
export type SessionId = Brand<string, "SessionId">;
export type RunId = Brand<string, "RunId">;
export type CorrelationId = Brand<string, "CorrelationId">;
export type AgentId = Brand<string, "AgentId">;
export type MessageId = Brand<string, "MessageId">;
export type ToolCallId = Brand<string, "ToolCallId">;

type IdentifierType =
  | "AgentId"
  | "CorrelationId"
  | "EventId"
  | "MessageId"
  | "RunId"
  | "SessionId"
  | "ToolCallId";

function brandedId<Name extends IdentifierType>(value: string, type: Name): Brand<string, Name> {
  if (value.trim().length === 0) {
    throw new InvalidIdentifierError(type);
  }

  return value as Brand<string, Name>;
}

/**
 * Converts a non-empty external string into an EventId at the application's validation boundary.
 */
export function eventId(value: string): EventId {
  return brandedId(value, "EventId");
}

export function sessionId(value: string): SessionId {
  return brandedId(value, "SessionId");
}

export function runId(value: string): RunId {
  return brandedId(value, "RunId");
}

export function correlationId(value: string): CorrelationId {
  return brandedId(value, "CorrelationId");
}

export function agentId(value: string): AgentId {
  return brandedId(value, "AgentId");
}

export function messageId(value: string): MessageId {
  return brandedId(value, "MessageId");
}

export function toolCallId(value: string): ToolCallId {
  return brandedId(value, "ToolCallId");
}
