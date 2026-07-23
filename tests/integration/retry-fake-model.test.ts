import { ModelStreamAccumulator, RetryExecutor } from "@pilotrun/agent-runtime";
import { ModelError, parseModelRequest, runId } from "@pilotrun/core";
import { FakeLanguageModel, textResponseScript, throwStep } from "@pilotrun/testkit";
import { describe, expect, it } from "vitest";

const request = parseModelRequest({
  messages: [
    {
      schemaVersion: 1,
      id: "message-1",
      sessionId: "session-1",
      runId: "run-1",
      role: "user",
      status: "complete",
      parts: [{ type: "text", text: "Hello" }],
      createdAt: "2026-07-20T05:00:00.000Z",
      provenance: { kind: "user", channel: "cli" },
    },
  ],
  tools: [],
});

describe("RetryExecutor with FakeLanguageModel", () => {
  it("retries a rate limit and assembles the next successful response", async () => {
    const delays: number[] = [];
    const rateLimit = new ModelError({
      kind: "rate-limit",
      providerId: "fake",
      modelId: "scripted",
      message: "temporary 429",
      retryAfterMs: 250,
    });
    const model = new FakeLanguageModel({
      scripts: [
        { steps: [throwStep(rateLimit)] },
        textResponseScript({ responseId: "response-2", deltas: ["Recovered"] }),
      ],
    });
    const executor = new RetryExecutor({
      random: () => 0.5,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    const outcome = await executor.execute(
      async ({ attempt, idempotencyKey, signal }) => {
        const accumulator = new ModelStreamAccumulator();
        for await (const event of model.stream(request, {
          runId: runId("run-1"),
          attempt,
          idempotencyKey: idempotencyKey ?? "missing-key",
          signal,
        })) {
          accumulator.consume(event);
        }
        return accumulator.finalize();
      },
      {
        policy: {
          maxAttempts: 2,
          baseDelayMs: 100,
          maxDelayMs: 1_000,
          jitterRatio: 0,
        },
        safety: { mode: "idempotent-with-key", key: "model-call-1" },
        signal: new AbortController().signal,
      },
    );

    expect(outcome).toMatchObject({
      status: "completed",
      responseId: "response-2",
      text: [{ text: "Recovered" }],
    });
    expect(delays).toEqual([250]);
    expect(model.calls.map((call) => call.context)).toEqual([
      {
        runId: "run-1",
        attempt: 1,
        idempotencyKey: "model-call-1",
      },
      {
        runId: "run-1",
        attempt: 2,
        idempotencyKey: "model-call-1",
      },
    ]);
  });
});
