import { ModelContractValidationError, ModelError, toSafeErrorSnapshot } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import { ModelStreamAccumulator, ModelStreamProtocolError } from "../src/index.js";

function start(responseId = "response-1") {
  return { type: "response.started", sequence: 0, responseId };
}

describe("ModelStreamAccumulator", () => {
  it("assembles ordered text, ephemeral reasoning, usage, and provider metadata", () => {
    const accumulator = new ModelStreamAccumulator();
    const events = [
      start(),
      {
        type: "text.delta",
        sequence: 1,
        responseId: "response-1",
        contentIndex: 2,
        delta: "world",
      },
      {
        type: "text.delta",
        sequence: 2,
        responseId: "response-1",
        contentIndex: 0,
        delta: "Hel",
      },
      {
        type: "text.delta",
        sequence: 3,
        responseId: "response-1",
        contentIndex: 0,
        delta: "lo ",
      },
      {
        type: "reasoning.delta",
        sequence: 4,
        responseId: "response-1",
        contentIndex: 0,
        delta: "brief rationale",
      },
      {
        type: "usage.updated",
        sequence: 5,
        responseId: "response-1",
        usage: { inputTokens: 10, source: "provider" },
      },
      {
        type: "usage.updated",
        sequence: 6,
        responseId: "response-1",
        usage: { inputTokens: 10, outputTokens: 2, source: "estimated" },
      },
      {
        type: "provider.metadata",
        sequence: 7,
        responseId: "response-1",
        metadata: { region: "local" },
      },
      {
        type: "provider.metadata",
        sequence: 8,
        responseId: "response-1",
        metadata: { requestTier: "standard" },
      },
      {
        type: "response.completed",
        sequence: 9,
        responseId: "response-1",
        finishReason: "stop",
      },
    ];

    for (const event of events) {
      expect(accumulator.consume(event)).toBe("accepted");
    }

    const outcome = accumulator.finalize();
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      throw new Error("Expected a completed outcome");
    }
    expect(outcome.text).toEqual([
      { contentIndex: 0, text: "Hello " },
      { contentIndex: 2, text: "world" },
    ]);
    expect(outcome.ephemeralReasoning).toEqual([{ contentIndex: 0, text: "brief rationale" }]);
    expect(outcome.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      source: "mixed",
    });
    expect(outcome.providerMetadata).toEqual({
      region: "local",
      requestTier: "standard",
    });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.text)).toBe(true);
  });

  it("ignores identical replayed events but rejects conflicting duplicates", () => {
    const accumulator = new ModelStreamAccumulator();
    const started = start();

    expect(accumulator.consume(started)).toBe("accepted");
    expect(accumulator.consume(started)).toBe("duplicate");
    expect(() => accumulator.consume({ ...started, responseId: "different" })).toThrowError(
      expect.objectContaining({ violation: "conflicting-duplicate" }),
    );
    expect(accumulator.snapshot().lastSequence).toBe(0);
  });

  it("enforces start, contiguous sequence, response identity, and terminal boundaries", () => {
    const beforeStart = new ModelStreamAccumulator();
    expect(() =>
      beforeStart.consume({
        type: "text.delta",
        sequence: 0,
        responseId: "response-1",
        contentIndex: 0,
        delta: "bad",
      }),
    ).toThrowError(expect.objectContaining({ violation: "event-before-start" }));

    const accumulator = new ModelStreamAccumulator();
    accumulator.consume(start());
    expect(() =>
      accumulator.consume({
        type: "text.delta",
        sequence: 2,
        responseId: "response-1",
        contentIndex: 0,
        delta: "gap",
      }),
    ).toThrowError(expect.objectContaining({ violation: "unexpected-sequence" }));
    expect(() =>
      accumulator.consume({
        type: "text.delta",
        sequence: 1,
        responseId: "response-other",
        contentIndex: 0,
        delta: "wrong response",
      }),
    ).toThrowError(expect.objectContaining({ violation: "response-id-mismatch" }));

    accumulator.consume({
      type: "response.completed",
      sequence: 1,
      responseId: "response-1",
      finishReason: "stop",
    });
    expect(() =>
      accumulator.consume({
        type: "provider.metadata",
        sequence: 2,
        responseId: "response-1",
        metadata: { late: true },
      }),
    ).toThrowError(expect.objectContaining({ violation: "event-after-terminal" }));
  });

  it("assembles and validates a completed tool call", () => {
    const accumulator = new ModelStreamAccumulator();
    const events = [
      start(),
      {
        type: "tool-call.started",
        sequence: 1,
        responseId: "response-1",
        contentIndex: 0,
        callId: "call-1",
        toolName: "read_file",
      },
      {
        type: "tool-call.arguments.delta",
        sequence: 2,
        responseId: "response-1",
        callId: "call-1",
        delta: '{"path":"README.md",',
      },
      {
        type: "tool-call.arguments.delta",
        sequence: 3,
        responseId: "response-1",
        callId: "call-1",
        delta: '"range":{"end":2,"start":1}}',
      },
      {
        type: "tool-call.completed",
        sequence: 4,
        responseId: "response-1",
        callId: "call-1",
        input: { range: { start: 1, end: 2 }, path: "README.md" },
      },
      {
        type: "response.completed",
        sequence: 5,
        responseId: "response-1",
        finishReason: "tool-calls",
      },
    ];
    for (const event of events) {
      accumulator.consume(event);
    }

    const outcome = accumulator.finalize();
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.toolCalls).toEqual([
        {
          contentIndex: 0,
          callId: "call-1",
          toolName: "read_file",
          input: { range: { start: 1, end: 2 }, path: "README.md" },
        },
      ]);
    }
  });

  it.each([
    {
      name: "malformed JSON",
      argumentText: '{"path":',
      input: { path: "README.md" },
      violation: "malformed-tool-arguments",
    },
    {
      name: "a completed input mismatch",
      argumentText: '{"path":"one.md"}',
      input: { path: "two.md" },
      violation: "tool-argument-mismatch",
    },
  ])("rejects $name", ({ argumentText, input, violation }) => {
    const accumulator = new ModelStreamAccumulator();
    accumulator.consume(start());
    accumulator.consume({
      type: "tool-call.started",
      sequence: 1,
      responseId: "response-1",
      contentIndex: 0,
      callId: "call-1",
      toolName: "read_file",
    });
    accumulator.consume({
      type: "tool-call.arguments.delta",
      sequence: 2,
      responseId: "response-1",
      callId: "call-1",
      delta: argumentText,
    });

    expect(() =>
      accumulator.consume({
        type: "tool-call.completed",
        sequence: 3,
        responseId: "response-1",
        callId: "call-1",
        input,
      }),
    ).toThrowError(expect.objectContaining({ violation }));
    expect(accumulator.snapshot().lastSequence).toBe(2);
  });

  it("rejects incomplete calls and inconsistent finish reasons", () => {
    const incomplete = new ModelStreamAccumulator();
    incomplete.consume(start());
    incomplete.consume({
      type: "tool-call.started",
      sequence: 1,
      responseId: "response-1",
      contentIndex: 0,
      callId: "call-1",
      toolName: "read_file",
    });
    expect(() =>
      incomplete.consume({
        type: "response.completed",
        sequence: 2,
        responseId: "response-1",
        finishReason: "tool-calls",
      }),
    ).toThrowError(expect.objectContaining({ violation: "incomplete-tool-call" }));

    const noCalls = new ModelStreamAccumulator();
    noCalls.consume(start());
    expect(() =>
      noCalls.consume({
        type: "response.completed",
        sequence: 1,
        responseId: "response-1",
        finishReason: "tool-calls",
      }),
    ).toThrowError(expect.objectContaining({ violation: "invalid-finish-reason" }));
  });

  it("rejects decreasing cumulative usage", () => {
    const accumulator = new ModelStreamAccumulator();
    accumulator.consume(start());
    accumulator.consume({
      type: "usage.updated",
      sequence: 1,
      responseId: "response-1",
      usage: { outputTokens: 10, source: "provider" },
    });

    expect(() =>
      accumulator.consume({
        type: "usage.updated",
        sequence: 2,
        responseId: "response-1",
        usage: { outputTokens: 9, source: "provider" },
      }),
    ).toThrowError(expect.objectContaining({ violation: "usage-decreased" }));
  });

  it("returns partial content for provider failures", () => {
    const accumulator = new ModelStreamAccumulator();
    const failure = new ModelError({
      kind: "unavailable",
      providerId: "fake",
      modelId: "scripted",
      message: "internal outage",
    }).toFailure();
    accumulator.consume(start());
    accumulator.consume({
      type: "text.delta",
      sequence: 1,
      responseId: "response-1",
      contentIndex: 0,
      delta: "partial",
    });
    accumulator.consume({
      type: "response.failed",
      sequence: 2,
      responseId: "response-1",
      error: failure,
    });

    expect(accumulator.finalize()).toMatchObject({
      status: "failed",
      responseId: "response-1",
      error: { kind: "unavailable" },
      partial: { text: [{ contentIndex: 0, text: "partial" }] },
    });
  });

  it("represents interruption before or during a response", () => {
    const idle = new ModelStreamAccumulator();
    idle.interrupt("cancelled");
    expect(idle.finalize()).toMatchObject({
      status: "interrupted",
      responseId: undefined,
      reason: "cancelled",
    });

    const active = new ModelStreamAccumulator();
    active.consume(start());
    active.consume({
      type: "text.delta",
      sequence: 1,
      responseId: "response-1",
      contentIndex: 0,
      delta: "partial",
    });
    active.interrupt("stream-error");
    expect(active.finalize()).toMatchObject({
      status: "interrupted",
      responseId: "response-1",
      partial: { text: [{ text: "partial" }] },
    });
  });

  it("wraps protocol diagnostics in a safe client-facing error", () => {
    const accumulator = new ModelStreamAccumulator();
    let caught: unknown;
    try {
      accumulator.finalize();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ModelStreamProtocolError);
    expect(toSafeErrorSnapshot(caught)).toMatchObject({
      code: "PILOT_MODEL_STREAM_PROTOCOL",
      message: "The model provider returned an invalid event stream",
      metadata: { violation: "stream-not-terminal" },
    });
  });

  it("rejects malformed raw events at the validation boundary", () => {
    const accumulator = new ModelStreamAccumulator();

    expect(() =>
      accumulator.consume({
        type: "response.started",
        sequence: -1,
        responseId: "",
      }),
    ).toThrow(ModelContractValidationError);
  });
});
