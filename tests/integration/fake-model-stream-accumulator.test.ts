import { ModelStreamAccumulator, type ModelStreamProtocolError } from "@pilotrun/agent-runtime";
import { parseModelRequest, runId } from "@pilotrun/core";
import { FakeLanguageModel, textResponseScript, toolCallScript } from "@pilotrun/testkit";
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
      createdAt: "2026-07-20T04:00:00.000Z",
      provenance: { kind: "user", channel: "cli" },
    },
  ],
  tools: [],
});

function context() {
  return {
    runId: runId("run-1"),
    attempt: 1,
    idempotencyKey: "run-1:1",
    signal: new AbortController().signal,
  };
}

describe("FakeLanguageModel with ModelStreamAccumulator", () => {
  it("assembles a deterministic fake text response", async () => {
    const model = new FakeLanguageModel({
      scripts: [textResponseScript({ responseId: "response-1", deltas: ["Hel", "lo"] })],
    });
    const accumulator = new ModelStreamAccumulator();

    for await (const event of model.stream(request, context())) {
      accumulator.consume(event);
    }

    expect(accumulator.finalize()).toMatchObject({
      status: "completed",
      text: [{ contentIndex: 0, text: "Hello" }],
    });
  });

  it("detects an intentionally incomplete fake tool stream", async () => {
    const model = new FakeLanguageModel({
      scripts: [
        toolCallScript({
          responseId: "response-1",
          callId: "call-1",
          toolName: "read_file",
          argumentDeltas: ['{"path":'],
        }),
      ],
    });
    const accumulator = new ModelStreamAccumulator();

    await expect(async () => {
      for await (const event of model.stream(request, context())) {
        accumulator.consume(event);
      }
    }).rejects.toMatchObject<ModelStreamProtocolError>({
      violation: "incomplete-tool-call",
    });
  });
});
