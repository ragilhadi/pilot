import { messageId, parseAgentMessage, runId, sessionId, toolCallId } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import {
  ChatEventFactory,
  initialTerminalUiState,
  reduceTerminalUi,
  type TerminalUiState,
} from "../src/index.js";

const id = sessionId("session-ui");
const run = runId("run-ui");

function fixture() {
  const factory = new ChatEventFactory({ now: () => new Date("2026-07-22T12:00:00.000Z") });
  let state: TerminalUiState = initialTerminalUiState;
  return {
    state: () => state,
    dispatch(input: Parameters<ChatEventFactory["create"]>[0]) {
      state = reduceTerminalUi(state, { type: "chat.event", event: factory.create(input) });
    },
    submit(text: string) {
      state = reduceTerminalUi(state, { type: "composer.submitted", id: "local:1", text });
    },
  };
}

describe("terminal UI reducer", () => {
  it("ignores replayed or older events and does not duplicate response blocks", () => {
    const factory = new ChatEventFactory({ now: () => new Date("2026-07-22T12:00:00.000Z") });
    const started = factory.create({
      type: "chat.started",
      sessionId: id,
      payload: { modelKey: "fake/test" },
    });
    const response = factory.create({
      type: "model.stream",
      sessionId: id,
      runId: run,
      payload: { event: { type: "response.started", sequence: 0, responseId: "response-replay" } },
    });
    let state = reduceTerminalUi(initialTerminalUiState, { type: "chat.event", event: started });
    state = reduceTerminalUi(state, { type: "chat.event", event: response });
    state = reduceTerminalUi(state, { type: "chat.event", event: response });
    state = reduceTerminalUi(state, { type: "chat.event", event: started });

    expect(state.lastEventSequence).toBe(2);
    expect(state.blocks).toEqual([
      expect.objectContaining({ kind: "assistant", responseId: "response-replay" }),
    ]);
  });

  it("projects streaming text and usage into deterministic view state", () => {
    const ui = fixture();
    ui.dispatch({
      type: "chat.started",
      sessionId: id,
      payload: { modelKey: "ollama/glm-5.2:cloud" },
    });
    ui.submit("Explain this repository");
    ui.dispatch({
      type: "model.stream",
      sessionId: id,
      runId: run,
      payload: { event: { type: "response.started", sequence: 0, responseId: "response-1" } },
    });
    ui.dispatch({
      type: "model.stream",
      sessionId: id,
      runId: run,
      payload: {
        event: {
          type: "text.delta",
          sequence: 1,
          responseId: "response-1",
          contentIndex: 0,
          delta: "Hello",
        },
      },
    });
    ui.dispatch({
      type: "model.stream",
      sessionId: id,
      runId: run,
      payload: {
        event: {
          type: "usage.updated",
          sequence: 2,
          responseId: "response-1",
          usage: {
            inputTokens: 1_200,
            outputTokens: 42,
            estimatedCostUsd: 0.002,
            source: "provider",
          },
        },
      },
    });

    expect(ui.state()).toMatchObject({
      phase: "streaming",
      modelKey: "ollama/glm-5.2:cloud",
      usage: { inputTokens: 1_200, outputTokens: 42, estimatedCostUsd: 0.002 },
      blocks: [
        { kind: "user", text: "Explain this repository" },
        { kind: "assistant", responseId: "response-1", text: "Hello", status: "streaming" },
      ],
    });
  });

  it("correlates tool lifecycle and streamed command output", () => {
    const ui = fixture();
    const callId = toolCallId("call-ui");
    ui.dispatch({
      type: "tool.execution",
      sessionId: id,
      runId: run,
      payload: {
        event: {
          type: "tool.started",
          runId: run,
          callId,
          toolName: "run_command",
          input: { command: "pnpm test" },
        },
      },
    });
    ui.dispatch({
      type: "command.output",
      sessionId: id,
      runId: run,
      payload: { event: { stream: "stdout", chunk: "12 tests passed\n" } },
    });
    ui.dispatch({
      type: "tool.execution",
      sessionId: id,
      runId: run,
      payload: {
        event: {
          type: "tool.completed",
          runId: run,
          callId,
          toolName: "run_command",
          output: { exitCode: 0 },
          isError: false,
        },
      },
    });

    expect(ui.state()).toMatchObject({
      activeToolCount: 0,
      blocks: [
        {
          kind: "tool",
          callId: "call-ui",
          status: "completed",
          commandOutput: "12 tests passed\n",
          output: { exitCode: 0 },
        },
      ],
    });
  });

  it("derives a fact-based turn summary from completed edits, commands, usage, and durations", () => {
    const ui = fixture();
    ui.submit("Fix and test the validator");
    const patchCall = toolCallId("call-patch");
    ui.dispatch({
      type: "tool.execution",
      sessionId: id,
      runId: run,
      payload: {
        event: {
          type: "tool.started",
          runId: run,
          callId: patchCall,
          toolName: "apply_patch",
          input: { path: "src/validation.ts", patch: "@@ -1 +1 @@" },
        },
      },
    });
    ui.dispatch({
      type: "tool.execution",
      sessionId: id,
      runId: run,
      payload: {
        durationMs: 12,
        event: {
          type: "tool.completed",
          runId: run,
          callId: patchCall,
          toolName: "apply_patch",
          isError: false,
          output: {
            path: "src/validation.ts",
            preview: { additions: 3, deletions: 1 },
          },
        },
      },
    });
    const commandCall = toolCallId("call-command");
    ui.dispatch({
      type: "tool.execution",
      sessionId: id,
      runId: run,
      payload: {
        event: {
          type: "tool.started",
          runId: run,
          callId: commandCall,
          toolName: "run_command",
          input: {
            command: { mode: "direct", executable: "pnpm", args: ["test"] },
          },
        },
      },
    });
    ui.dispatch({
      type: "tool.execution",
      sessionId: id,
      runId: run,
      payload: {
        durationMs: 1_250,
        event: {
          type: "tool.completed",
          runId: run,
          callId: commandCall,
          toolName: "run_command",
          isError: false,
          output: {
            status: "completed",
            exitCode: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        },
      },
    });
    ui.dispatch({
      type: "model.stream",
      sessionId: id,
      runId: run,
      payload: {
        event: {
          type: "usage.updated",
          sequence: 0,
          responseId: "response-summary",
          usage: {
            inputTokens: 800,
            outputTokens: 120,
            estimatedCostUsd: 0.004,
            source: "provider",
          },
        },
      },
    });
    ui.dispatch({
      type: "chat.turn.completed",
      sessionId: id,
      runId: run,
      payload: {
        runCount: 2,
        durationMs: 1_600,
        assistantMessage: parseAgentMessage({
          schemaVersion: 1,
          id: messageId("message-summary"),
          sessionId: id,
          runId: run,
          role: "assistant",
          status: "complete",
          parts: [{ type: "text", text: "Done" }],
          createdAt: "2026-07-22T12:00:00.000Z",
          provenance: { kind: "model", providerId: "fake", modelId: "test" },
        }),
      },
    });

    expect(ui.state().lastTurnSummary).toEqual({
      outcome: "completed",
      runCount: 2,
      toolCount: 2,
      failedToolCount: 0,
      changedFiles: [{ path: "src/validation.ts", additions: 3, deletions: 1 }],
      commands: [
        {
          command: "pnpm test",
          status: "completed",
          exitCode: 0,
          durationMs: 1_250,
          truncated: false,
        },
      ],
      tests: [
        {
          command: "pnpm test",
          status: "completed",
          exitCode: 0,
          durationMs: 1_250,
          truncated: false,
        },
      ],
      usage: { inputTokens: 800, outputTokens: 120, estimatedCostUsd: 0.004 },
      elapsedMs: 1_600,
    });
    expect(ui.state().blocks.at(-1)).toMatchObject({ kind: "summary" });
  });
});
