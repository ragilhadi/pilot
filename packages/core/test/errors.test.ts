import { describe, expect, it } from "vitest";
import {
  EventDeliveryError,
  InvalidIdentifierError,
  PilotError,
  toSafeErrorSnapshot,
} from "../src/index.js";

describe("PilotError", () => {
  it("keeps stable machine data separate from an internal cause", () => {
    const secretCause = new Error("token=secret-value");
    const error = new EventDeliveryError(2, secretCause);

    expect(error).toBeInstanceOf(PilotError);
    expect(error.code).toBe("PILOT_EVENT_DELIVERY_FAILED");
    expect(error.failureCount).toBe(2);
    expect(error.cause).toBe(secretCause);
    expect(toSafeErrorSnapshot(error)).toEqual({
      code: "PILOT_EVENT_DELIVERY_FAILED",
      message: "One or more event subscribers failed",
      retryable: false,
      metadata: { failureCount: 2 },
    });
    expect(JSON.stringify(toSafeErrorSnapshot(error))).not.toContain("secret-value");
  });

  it("maps unknown errors to a safe generic snapshot", () => {
    expect(toSafeErrorSnapshot(new Error("database password"))).toEqual({
      code: "PILOT_UNEXPECTED_ERROR",
      message: "An unexpected error occurred",
      retryable: false,
      metadata: {},
    });
  });

  it("does not include the invalid identifier value in metadata", () => {
    const error = new InvalidIdentifierError("SessionId");

    expect(error.metadata).toEqual({ identifierType: "SessionId" });
  });
});
