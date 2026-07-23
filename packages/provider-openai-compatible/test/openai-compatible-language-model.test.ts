import { readFile } from "node:fs/promises";
import {
  CancellationError,
  ModelContractValidationError,
  ModelError,
  parseModelRequest,
  runId,
  toSafeErrorSnapshot,
  type ModelCapabilities,
  type ModelStreamEvent,
} from "@pilotrun/core";
import { describe, expect, it, vi } from "vitest";
import { type Fetch, OpenAICompatibleLanguageModel } from "../src/index.js";

const capabilities = {
  streaming: true,
  nativeToolCalling: true,
  parallelToolCalls: true,
  structuredOutput: true,
  vision: true,
  promptCaching: true,
  reasoning: true,
  configurableReasoningEffort: true,
  systemMessages: true,
  maxContextTokens: 128_000,
  maxOutputTokens: 8_192,
} as const satisfies ModelCapabilities;

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
      createdAt: "2026-07-21T02:00:00.000Z",
      provenance: { kind: "user", channel: "cli" },
    },
  ],
  tools: [],
});

function context(signal = new AbortController().signal) {
  return {
    runId: runId("run-1"),
    attempt: 1,
    idempotencyKey: "request-1",
    signal,
  };
}

function createModel(fetch: Fetch, readEnvironment = (_variable: string) => "test-secret") {
  return new OpenAICompatibleLanguageModel({
    configuration: {
      providerId: "compatible",
      type: "openai-compatible",
      baseUrl: "https://provider.example/v1",
      auth: { type: "environment", variable: "PROVIDER_API_KEY" },
    },
    modelId: "example-model",
    capabilities,
    fetch,
    readEnvironment,
    now: () => Date.parse("2026-07-21T02:00:00.000Z"),
  });
}

async function collect(model: OpenAICompatibleLanguageModel): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of model.stream(request, context())) {
    events.push(event);
  }
  return events;
}

async function fixture(name: string): Promise<string> {
  return readFile(
    new URL(`../../../fixtures/providers/openai-compatible/${name}`, import.meta.url),
    "utf8",
  );
}

function streamResponse(text: string, chunkSize = 17): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, offset + chunkSize);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("OpenAICompatibleLanguageModel", () => {
  it("sends credentials and idempotency separately from the JSON request body", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetch: Fetch = async (input, init) => {
      capturedUrl = input.toString();
      capturedInit = init;
      return streamResponse(await fixture("text-response.sse"));
    };

    await collect(createModel(fetch));

    const headers = new Headers(capturedInit?.headers);
    const body = String(capturedInit?.body);
    expect(capturedUrl).toBe("https://provider.example/v1/chat/completions");
    expect(capturedInit?.method).toBe("POST");
    expect(headers.get("Authorization")).toBe("Bearer test-secret");
    expect(headers.get("Idempotency-Key")).toBe("request-1");
    expect(body).not.toContain("test-secret");
    expect(JSON.parse(body)).toMatchObject({
      model: "example-model",
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    });
  });

  it("normalizes a fragmented recorded text, reasoning, metadata, usage, and finish stream", async () => {
    const fetch: Fetch = async () => streamResponse(await fixture("text-response.sse"), 7);

    const events = await collect(createModel(fetch));

    expect(events.map(({ type }) => type)).toEqual([
      "response.started",
      "provider.metadata",
      "text.delta",
      "reasoning.delta",
      "text.delta",
      "usage.updated",
      "response.completed",
    ]);
    expect(events).toMatchObject([
      { sequence: 0, responseId: "chatcmpl-text" },
      { metadata: { model: "example-model", systemFingerprint: "fp_test" } },
      { delta: "Hel", contentIndex: 0 },
      { delta: "brief plan", contentIndex: 0 },
      { delta: "lo", contentIndex: 0 },
      {
        usage: {
          inputTokens: 12,
          outputTokens: 5,
          cachedInputTokens: 3,
          reasoningTokens: 2,
          source: "provider",
        },
      },
      { sequence: 6, finishReason: "stop" },
    ]);
  });

  it("assembles streamed tool arguments and emits completion before the response finish", async () => {
    const fetch: Fetch = async () => streamResponse(await fixture("tool-response.sse"), 11);

    const events = await collect(createModel(fetch));

    expect(events.map(({ type }) => type)).toEqual([
      "response.started",
      "tool-call.started",
      "tool-call.arguments.delta",
      "tool-call.arguments.delta",
      "tool-call.completed",
      "response.completed",
    ]);
    expect(events[1]).toMatchObject({
      contentIndex: 1,
      callId: "call-read",
      toolName: "read_file",
    });
    expect(events[4]).toMatchObject({
      callId: "call-read",
      input: { path: "README.md" },
    });
    expect(events[5]).toMatchObject({ finishReason: "tool-calls" });
  });

  it("fails before transport when an environment credential is missing", async () => {
    const fetch = vi.fn<Fetch>();
    const model = createModel(fetch, () => undefined);

    await expect(collect(model)).rejects.toMatchObject({
      code: "PILOT_MODEL_AUTHENTICATION",
      kind: "authentication",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "authentication", undefined],
    [400, "context-limit", undefined],
    [422, "invalid-request", undefined],
    [429, "rate-limit", 2_000],
    [503, "unavailable", undefined],
  ] as const)(
    "maps HTTP %s to %s without exposing its body",
    async (status, kind, retryAfterMs) => {
      const secretBody =
        status === 400
          ? '{"error":{"code":"context_length_exceeded","message":"secret prompt"}}'
          : '{"error":{"message":"secret provider detail"}}';
      const fetch: Fetch = async () =>
        new Response(secretBody, {
          status,
          headers: status === 429 ? { "Retry-After": "2" } : undefined,
        });
      const model = createModel(fetch);

      try {
        await collect(model);
        throw new Error("Expected provider failure");
      } catch (error) {
        expect(error).toBeInstanceOf(ModelError);
        expect(error).toMatchObject({ kind, statusCode: status, retryAfterMs });
        expect(JSON.stringify(toSafeErrorSnapshot(error))).not.toContain("secret");
        expect((error as Error).message).not.toContain("secret");
      }
    },
  );

  it("maps an aborted transport to cancellation", async () => {
    const controller = new AbortController();
    controller.abort("user cancelled");
    const fetch: Fetch = async () => Promise.reject(new DOMException("aborted", "AbortError"));
    const model = createModel(fetch);

    await expect(async () => {
      for await (const _event of model.stream(request, context(controller.signal))) {
        // No event should be emitted.
      }
    }).rejects.toBeInstanceOf(CancellationError);
  });

  it("maps cancellation while reading the response stream", async () => {
    const controller = new AbortController();
    const fetch: Fetch = async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(
            new TextEncoder().encode('data: {"id":"response-1","choices":[]}\n\n'),
          );
          init?.signal?.addEventListener("abort", () => {
            streamController.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return new Response(body, { status: 200 });
    };
    const iterator = createModel(fetch)
      .stream(request, context(controller.signal))
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "response.started" },
    });
    controller.abort("user cancelled");
    await expect(iterator.next()).rejects.toBeInstanceOf(CancellationError);
  });

  it("rejects malformed JSON and premature stream endings as contract failures", async () => {
    const malformed = createModel(async () => streamResponse("data: not-json\n\n"));
    const premature = createModel(async () =>
      streamResponse('data: {"id":"response-1","choices":[]}\n\ndata: [DONE]\n\n'),
    );

    await expect(collect(malformed)).rejects.toBeInstanceOf(ModelContractValidationError);
    await expect(collect(premature)).rejects.toBeInstanceOf(ModelContractValidationError);
  });
});
