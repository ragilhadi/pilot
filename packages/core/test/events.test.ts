import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AppEvent,
  type AppStartedEvent,
  correlationId,
  eventId,
  eventSchemaVersion,
} from "../src/index.js";

describe("AppStartedEvent", () => {
  it("uses the first event schema version and a stable discriminator", () => {
    const event: AppStartedEvent = {
      schemaVersion: eventSchemaVersion,
      id: eventId("evt-1"),
      sequence: 1,
      type: "app.started",
      occurredAt: "2026-07-20T00:00:00.000Z",
      correlationId: correlationId("correlation-1"),
      payload: {
        application: "pilot",
        version: "0.0.0",
        runtimeVersion: "0.0.0",
      },
    };

    expect(event).toMatchObject({
      schemaVersion: 1,
      sequence: 1,
      type: "app.started",
    });
    expectTypeOf(event).toMatchTypeOf<AppEvent>();
  });
});
