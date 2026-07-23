import { describe, expect, it } from "vitest";
import { createAppStartedEvent } from "../src/index.js";

describe("createAppStartedEvent", () => {
  it("creates a deterministic, serializable startup event with injected effects", () => {
    const values = ["00000000-0000-4000-8000-000000000000", "10000000-0000-4000-8000-000000000000"];
    const event = createAppStartedEvent({
      clock: { now: () => new Date("2026-07-20T01:02:03.000Z") },
      ids: {
        next: () => values.shift() ?? "unexpected-extra-id",
      },
    });

    expect(JSON.parse(JSON.stringify(event))).toEqual({
      schemaVersion: 1,
      id: "00000000-0000-4000-8000-000000000000",
      sequence: 1,
      type: "app.started",
      occurredAt: "2026-07-20T01:02:03.000Z",
      correlationId: "10000000-0000-4000-8000-000000000000",
      payload: {
        application: "pilot",
        version: "0.0.0",
        runtimeVersion: "0.0.0",
      },
    });
  });
});
