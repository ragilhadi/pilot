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

  it("keeps ANSI intact and never emits the replacement character in colored output", () => {
    const theme = createPilotTheme({ ...capabilities, color: true });
    const frame = new PilotScreen(
      () => ({ ...goldenState, showToolDetails: true }),
      theme,
      { ...capabilities, color: true },
      "C:/workspace/pilot",
    )
      .render(100)
      .join("\n");
    expect(frame).toContain("\u001b[");
    expect(frame).not.toContain("\uFFFD");
  });

  it("frames fenced code blocks with a language label and stays width-safe", () => {
    const state: TerminalUiState = {
      ...goldenState,
      blocks: [
        {
          kind: "assistant",
          id: "assistant:code",
          responseId: "response:code",
          text: ["Here is the command:", "", "```bash", "g++ main.cpp -o main", "```"].join("\n"),
          status: "completed",
        },
      ],
    };
    for (const width of [60, 80, 120]) {
      const theme = createPilotTheme({ ...capabilities, columns: width });
      const frame = new PilotScreen(
        () => state,
        theme,
        { ...capabilities, columns: width },
        "C:/workspace/pilot",
      ).render(width);
      expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
      const joined = frame.join("\n");
      expect(joined).toContain("bash");
      expect(joined).toContain("g++ main.cpp -o main");
    }
  });

  it("shows the command line and exit code for an expanded run_command tool", () => {
    const state: TerminalUiState = {
      ...goldenState,
      showToolDetails: true,
      blocks: [
        {
          kind: "tool",
          id: "tool:cmd",
          callId: "call:cmd",
          name: "run_command",
          input: { command: "pnpm test validation" },
          output: { exitCode: 2 },
          commandOutput: "1 failed",
          durationMs: 900,
          status: "failed",
        },
      ],
    };
    const theme = createPilotTheme(capabilities);
    const frame = new PilotScreen(() => state, theme, capabilities, "C:/workspace/pilot")
      .render(100)
      .join("\n");
    expect(frame).toContain("$ pnpm test validation");
    expect(frame).toContain("exit 2");
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
