import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApplicationRunner, ModelRegistry, ToolRegistry } from "@pilot/agent-runtime";
import { parseModelRequest, runId } from "@pilot/core";
import { FakeLanguageModel, textResponseScript, toolCallScript } from "@pilot/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadFileTool, NodeWorkspaceBoundary } from "../src/index.js";

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(tmpdir(), "pilot-read-agent-test-"));
  await writeFile(path.join(workspacePath, "answer.txt"), "repository evidence\n");
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

describe("read-only agent checkpoint", () => {
  it("lets a fake model inspect a real workspace file and receive a correlated result", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const tools = new ToolRegistry([createReadFileTool(boundary)]);
    const model = new FakeLanguageModel({
      scripts: [
        toolCallScript({
          responseId: "response-read",
          callId: "call-read",
          toolName: "read_file",
          argumentDeltas: ['{"path":"answer.txt"}'],
          completedInput: { path: "answer.txt" },
        }),
        textResponseScript({
          responseId: "response-answer",
          deltas: ["The file contains repository evidence."],
        }),
      ],
    });
    const runner = new ApplicationRunner({
      registry: new ModelRegistry([{ model, displayName: "Read-only fake agent" }]),
      tools,
      clock: { now: () => new Date("2026-07-22T00:00:00.000Z") },
      monotonicClock: { nowMilliseconds: () => 0 },
      checkpointWriter: { write: async () => undefined },
      estimateModelCall: async () => ({ inputTokens: 10, outputTokens: 10 }),
      retry: { random: () => 0.5, sleep: async () => undefined },
    });
    const request = parseModelRequest({
      messages: [
        {
          schemaVersion: 1,
          id: "message-user",
          sessionId: "session-agent",
          runId: "run-agent",
          role: "user",
          status: "complete",
          parts: [{ type: "text", text: "Inspect answer.txt" }],
          createdAt: "2026-07-22T00:00:00.000Z",
          provenance: { kind: "user", channel: "cli" },
        },
      ],
      tools: tools.modelDefinitions(),
      maxOutputTokens: 10,
    });

    const result = await runner.run({
      runId: runId("run-agent"),
      modelKey: "fake/scripted",
      request,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      budgetPolicy: {
        maxCycles: 2,
        maxModelAttempts: 2,
        maxToolCalls: 1,
        maxElapsedMs: 1_000,
        maxInputTokens: 100,
        maxOutputTokens: 100,
      },
      signal: new AbortController().signal,
    });

    expect(result.state).toMatchObject({ kind: "completed", cycle: 2 });
    expect(result.budget).toMatchObject({ cycles: 2, modelAttempts: 2, toolCalls: 1 });
    expect(result.outcome).toMatchObject({
      status: "completed",
      text: [{ text: "The file contains repository evidence." }],
    });
    const secondRequest = model.calls[1]?.request;
    expect(secondRequest?.messages.map(({ role }) => role)).toEqual(["user", "assistant", "tool"]);
    expect(secondRequest?.messages.at(-1)).toMatchObject({
      role: "tool",
      parts: [
        {
          type: "tool-result",
          callId: "call-read",
          toolName: "read_file",
          isError: false,
          output: {
            path: "answer.txt",
            content: "repository evidence\n",
            provenance: { source: "workspace-file", path: "answer.txt", untrusted: true },
          },
        },
      ],
    });
  });
});
