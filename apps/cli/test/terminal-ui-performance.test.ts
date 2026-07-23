import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { PilotScreen } from "../src/tui/terminal-chat-presentation.js";
import { type TerminalUiState, initialTerminalUiState } from "../src/tui/terminal-ui-state.js";
import { createPilotTheme } from "../src/tui/theme.js";

const capabilities = {
  interactiveInput: true,
  interactiveOutput: true,
  cursorAddressing: true,
  color: false,
  unicode: false,
  columns: 120,
  rows: 40,
} as const;

describe("terminal UI endurance budgets", () => {
  it("keeps resize/redraw p95 below 100ms for a cached 1,000-block transcript", () => {
    const state: TerminalUiState = {
      ...initialTerminalUiState,
      phase: "ready",
      modelKey: "ollama/glm-5.2:cloud",
      blocks: Array.from({ length: 1_000 }, (_, index) => ({
        kind: "user" as const,
        id: `user:${index}`,
        text: `Synthetic transcript block ${index}`,
      })),
    };
    const screen = new PilotScreen(
      () => state,
      createPilotTheme(capabilities),
      capabilities,
      "C:/workspace/pilot",
    );
    screen.render(80);
    screen.render(120);
    const samples = Array.from({ length: 100 }, (_, index) => {
      const startedAt = performance.now();
      screen.render(index % 2 === 0 ? 80 : 120);
      return performance.now() - startedAt;
    }).sort((left, right) => left - right);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY;

    expect(p95).toBeLessThan(100);
  });

  it("projects 100 turns without losing or duplicating semantic blocks", () => {
    const blocks: TerminalUiState["blocks"] = Array.from({ length: 100 }, (_, index) => [
      { kind: "user" as const, id: `user:${index}`, text: `turn ${index}` },
      {
        kind: "assistant" as const,
        id: `assistant:${index}`,
        responseId: `response:${index}`,
        text: `answer ${index}`,
        status: "completed" as const,
      },
    ]).flat();
    const state: TerminalUiState = { ...initialTerminalUiState, phase: "ready", blocks };
    const screen = new PilotScreen(
      () => state,
      createPilotTheme(capabilities),
      capabilities,
      "C:/workspace/pilot",
    );
    const frame = screen.render(120).join("\n");

    expect(state.blocks).toHaveLength(200);
    expect(frame).toContain("turn 0");
    expect(frame).toContain("answer 99");
  });
});
