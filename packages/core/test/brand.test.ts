import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type EventId,
  eventId,
  InvalidIdentifierError,
  type MessageId,
  messageId,
  type SessionId,
  sessionId,
} from "../src/index.js";

describe("eventId", () => {
  it("brands a non-empty string without changing its runtime value", () => {
    const id = eventId("evt-123");

    expect(id).toBe("evt-123");
    expectTypeOf(id).toEqualTypeOf<EventId>();
    expectTypeOf("evt-123").not.toMatchTypeOf<EventId>();
    expectTypeOf(id).not.toMatchTypeOf<SessionId>();
  });

  it.each(["", "   ", "\t\n"])("rejects an empty value %#", (value) => {
    expect(() => eventId(value)).toThrowError(InvalidIdentifierError);
    expect(() => eventId(value)).toThrowError("EventId must not be empty");
  });

  it("keeps identifier domains distinct", () => {
    const session = sessionId("session-1");

    expect(session).toBe("session-1");
    expectTypeOf(session).toEqualTypeOf<SessionId>();
    expectTypeOf(session).not.toMatchTypeOf<EventId>();
  });

  it("brands message identifiers independently", () => {
    const message = messageId("message-1");

    expectTypeOf(message).toEqualTypeOf<MessageId>();
    expectTypeOf(message).not.toMatchTypeOf<EventId>();
    expectTypeOf(message).not.toMatchTypeOf<SessionId>();
  });
});
