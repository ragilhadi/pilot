import {
  CancellationError,
  ModelContractValidationError,
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
  parseAgentMessage,
  parseModelRequest,
  parseModelStreamEvent,
  runId,
} from "@pilot/core";
import { describe, expect, it } from "vitest";
import {
  delayStep,
  eventStep,
  FakeLanguageModel,
  textResponseScript,
  throwStep,
  toolCallScript,
  unsafeRawEventStep,
} from "../src/index.js";

function request(): ModelRequest {
  return parseModelRequest({
    messages: [
      parseAgentMessage({
        schemaVersion: 1,
        id: "message-1",
        sessionId: "session-1",
        runId: "run-1",
        role: "user",
        status: "complete",
        parts: [{ type: "text", text: "Hello" }],
        createdAt: "2026-07-20T04:00:00.000Z",
        provenance: { kind: "user", channel: "cli" },
      }),
    ],
    tools: [],
  });
}

function context(signal = new AbortController().signal) {
  return {
    runId: runId("run-1"),
    attempt: 1,
    idempotencyKey: "run-1:attempt-1",
    signal,
    deadline: "2026-07-20T04:01:00.000Z",
  };
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("FakeLanguageModel", () => {
  it("streams predefined text and records an immutable request", async () => {
    const model = new FakeLanguageModel({
      scripts: [
        textResponseScript({
          responseId: "response-1",
          deltas: ["Hel", "lo"],
          usage: { inputTokens: 4, outputTokens: 2, source: "provider" },
        }),
      ],
    });

    const events = await collect(model.stream(request(), context()));

    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "text.delta",
      "text.delta",
      "usage.updated",
      "response.completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(model.remainingScripts).toBe(0);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.context).toEqual({
      runId: "run-1",
      attempt: 1,
      idempotencyKey: "run-1:attempt-1",
      deadline: "2026-07-20T04:01:00.000Z",
    });
    expect(Object.isFrozen(model.calls)).toBe(true);
    expect(Object.isFrozen(model.calls[0])).toBe(true);
  });

  it("produces complete and intentionally incomplete tool-call streams", async () => {
    const model = new FakeLanguageModel({
      scripts: [
        toolCallScript({
          responseId: "response-valid",
          callId: "call-1",
          toolName: "read_file",
          argumentDeltas: ['{"path":', '"README.md"}'],
          completedInput: { path: "README.md" },
        }),
        toolCallScript({
          responseId: "response-malformed",
          callId: "call-2",
          toolName: "read_file",
          argumentDeltas: ['{"path":'],
        }),
      ],
    });

    const complete = await collect(model.stream(request(), context()));
    const incomplete = await collect(model.stream(request(), context()));

    expect(complete.some((event) => event.type === "tool-call.completed")).toBe(true);
    expect(incomplete.some((event) => event.type === "tool-call.completed")).toBe(false);
    expect(incomplete.at(-1)).toMatchObject({
      type: "response.completed",
      finishReason: "tool-calls",
    });
  });

  it("throws an injected rate limit after selected events", async () => {
    const rateLimit = new ModelError({
      kind: "rate-limit",
      providerId: "fake",
      modelId: "scripted",
      message: "internal 429 response",
      retryAfterMs: 500,
    });
    const model = new FakeLanguageModel({
      scripts: [
        {
          steps: [
            eventStep({ type: "response.started", sequence: 0, responseId: "response-1" }),
            eventStep({
              type: "text.delta",
              sequence: 1,
              responseId: "response-1",
              contentIndex: 0,
              delta: "partial",
            }),
            throwStep(rateLimit),
          ],
        },
      ],
    });
    const received: ModelStreamEvent[] = [];
    let caught: unknown;

    try {
      for await (const event of model.stream(request(), context())) {
        received.push(event);
      }
    } catch (error) {
      caught = error;
    }

    expect(received).toHaveLength(2);
    expect(caught).toBe(rateLimit);
  });

  it("honors cancellation during a scripted delay", async () => {
    const controller = new AbortController();
    const model = new FakeLanguageModel({
      scripts: [{ steps: [delayStep(10_000)] }],
    });

    const result = collect(model.stream(request(), context(controller.signal)));
    controller.abort("user cancelled");

    await expect(result).rejects.toBeInstanceOf(CancellationError);
  });

  it("can emit malformed raw data only through the explicit unsafe step", async () => {
    const model = new FakeLanguageModel({
      scripts: [
        {
          steps: [
            unsafeRawEventStep({
              type: "text.delta",
              sequence: -1,
              responseId: "",
              delta: 42,
            }),
          ],
        },
      ],
    });

    const [malformed] = await collect(model.stream(request(), context()));

    expect(() => parseModelStreamEvent(malformed)).toThrow(ModelContractValidationError);
  });

  it("fails predictably when scripts are exhausted", async () => {
    const model = new FakeLanguageModel({ scripts: [] });
    const result = collect(model.stream(request(), context()));

    await expect(result).rejects.toMatchObject<ModelError>({
      code: "PILOT_MODEL_FAILED",
      retryable: false,
    });
    expect(model.calls).toHaveLength(1);
  });

  it("rejects invalid delay configuration during construction", () => {
    expect(() => new FakeLanguageModel({ scripts: [{ steps: [delayStep(Number.NaN)] }] })).toThrow(
      ModelContractValidationError,
    );
  });

  it("snapshots scripts so later caller mutation cannot change a run", async () => {
    const steps = [eventStep({ type: "response.started", sequence: 0, responseId: "response-1" })];
    const model = new FakeLanguageModel({ scripts: [{ steps }] });

    steps.push(
      eventStep({
        type: "response.completed",
        sequence: 1,
        responseId: "response-1",
        finishReason: "stop",
      }),
    );

    expect(await collect(model.stream(request(), context()))).toHaveLength(1);
  });
});
