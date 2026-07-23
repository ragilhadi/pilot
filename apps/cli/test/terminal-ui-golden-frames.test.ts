import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { PilotFooter, PilotScreen } from "../src/tui/terminal-chat-presentation.js";
import { type TerminalUiState, initialTerminalUiState } from "../src/tui/terminal-ui-state.js";
import { createPilotTheme, pilotThemeModes } from "../src/tui/theme.js";

const capabilities = {
  interactiveInput: true,
  interactiveOutput: true,
  cursorAddressing: true,
  color: false,
  unicode: false,
  columns: 100,
  rows: 30,
} as const;

const goldenState: TerminalUiState = {
  ...initialTerminalUiState,
  phase: "ready",
  modelKey: "ollama/glm-5.2:cloud",
  blocks: [
    { kind: "user", id: "user:1", text: "Fix validation and run the focused tests." },
    {
      kind: "assistant",
      id: "assistant:1",
      responseId: "response:1",
      text: "The validator is fixed and the tests pass.",
      status: "completed",
    },
    {
      kind: "tool",
      id: "tool:1",
      callId: "call:1",
      name: "run_command",
      input: { command: "pnpm test validation" },
      output: { exitCode: 0 },
      commandOutput: "12 passed",
      durationMs: 1_800,
      status: "completed",
    },
  ],
};

describe("terminal UI golden frames", () => {
  it.each([60, 80, 120, 160])("is legible and width-safe at %i columns", (width) => {
    const theme = createPilotTheme({ ...capabilities, columns: width });
    const screen = new PilotScreen(
      () => goldenState,
      theme,
      { ...capabilities, columns: width },
      "C:/workspace/pilot",
      { branch: "main", dirty: true },
    );
    const footer = new PilotFooter(() => goldenState, theme, {
      ...capabilities,
      columns: width,
    });
    const frame = [...screen.render(width), ...footer.render(width)];

    expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(frame.join("\n")).toContain("PILOT  pilot  main*");
    expect(frame.join("\n")).toContain("run_command  completed  1.8s");
    expect(frame.join("\n")).toContain("12 passed");
  });

  it.each(pilotThemeModes)("renders the %s semantic theme without losing labels", (mode) => {
    const theme = createPilotTheme({ ...capabilities, color: true }, mode);
    expect(theme.danger("failed")).toContain("failed");
    expect(theme.success("completed")).toContain("completed");
    expect(theme.accent("selected")).toContain("selected");
  });

  it("renders read, search, command, edit, failed, cancelled, truncated, and unknown tools", () => {
    const tools: TerminalUiState["blocks"] = [
      ["read_file", "completed"],
      ["search_files", "completed"],
      ["run_command", "completed"],
      ["apply_patch", "completed"],
      ["failing_tool", "failed"],
      ["cancelled_tool", "cancelled"],
      ["large_output_tool", "completed"],
      ["extension_tool", "completed"],
    ].map(([name, status], index) => ({
      kind: "tool" as const,
      id: `tool:${index}`,
      callId: `call:${index}`,
      name,
      input: { fixture: true },
      output: status === "failed" ? { error: "fixture failure" } : { ok: true },
      commandOutput: name === "run_command" ? "12 passed" : "",
      ...(name === "large_output_tool" ? { truncated: true } : {}),
      status,
    }));
    const state: TerminalUiState = { ...goldenState, blocks: tools, showToolDetails: true };
    const theme = createPilotTheme(capabilities);
    const frame = new PilotScreen(() => state, theme, capabilities, "C:/workspace/pilot")
      .render(100)
      .join("\n");

    for (const [name] of tools.map((block) => [block.kind === "tool" ? block.name : ""])) {
      expect(frame).toContain(name);
    }
    expect(frame).toContain("failed");
    expect(frame).toContain("cancelled");
    expect(frame).toContain("truncated");
  });
});
