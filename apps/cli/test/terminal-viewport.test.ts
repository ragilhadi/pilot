import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { PilotScreen } from "../src/tui/components/screen.js";
import { ChatViewport } from "../src/tui/components/viewport.js";
import {
  FullscreenTerminal,
  isMouseReport,
  wheelScrollDelta,
} from "../src/tui/fullscreen-terminal.js";
import { initialTerminalUiState, type TerminalUiState } from "../src/tui/terminal-ui-state.js";
import { createPilotTheme } from "../src/tui/theme.js";

const capabilities = {
  interactiveInput: true,
  interactiveOutput: true,
  cursorAddressing: true,
  color: false,
  unicode: false,
  columns: 80,
  rows: 24,
} as const;

const theme = createPilotTheme(capabilities);

function stub(lines: readonly string[]): Component {
  return { render: () => [...lines], invalidate: () => undefined };
}

/** A transcript long enough to overflow any viewport used in these tests. */
function longState(messageCount: number): TerminalUiState {
  return {
    ...initialTerminalUiState,
    phase: "ready",
    modelKey: "ollama/glm-5.2:cloud",
    blocks: Array.from({ length: messageCount }, (_value, index) => ({
      kind: "user" as const,
      id: `user:${index}`,
      text: `message ${index}`,
    })),
  };
}

function viewport(state: TerminalUiState, rows: number, composerLines = 1): ChatViewport {
  const screen = new PilotScreen(() => state, theme, capabilities, "C:/workspace/pilot");
  return new ChatViewport({
    screen,
    editor: stub(Array.from({ length: composerLines }, () => "> ")),
    footer: stub(["----", "ready"]),
    theme,
    capabilities,
    rows: () => rows,
  });
}

describe("fullscreen chat viewport", () => {
  it("renders exactly one screenful so nothing reaches the scrollback", () => {
    for (const rows of [12, 24, 40]) {
      expect(viewport(longState(40), rows).render(80)).toHaveLength(rows);
    }
  });

  it("rests a short transcript against the composer rather than the header", () => {
    const short: TerminalUiState = { ...longState(2), phase: "ready" };
    const frame = viewport(short, 24).render(80);

    expect(frame).toHaveLength(24);
    expect(frame.at(-3)).toBe("> ");
    expect(frame.at(-1)).toBe("ready");
    // Padding goes above the transcript, so the newest line is the one just over the composer.
    expect(frame[4]).toBe("");
    expect(frame.at(-5)).toContain("message 1");
  });

  it("follows the newest output until the reader scrolls away from it", () => {
    const view = viewport(longState(40), 24);
    view.render(80);
    expect(view.following).toBe(true);

    view.scrollPages(-1);

    expect(view.following).toBe(false);
    const frame = view.render(80);
    expect(frame).toHaveLength(24);
    expect(frame.at(-3)).toBe("> ");
    expect(frame.some((line) => line.includes("more lines below"))).toBe(true);
  });

  it("returns to following once scrolled back to the end", () => {
    const view = viewport(longState(40), 24);
    view.render(80);
    view.scrollPages(-2);
    view.render(80);
    expect(view.following).toBe(false);

    view.scrollPages(3);
    const frame = view.render(80);

    expect(view.following).toBe(true);
    expect(frame.some((line) => line.includes("more lines below"))).toBe(false);
  });

  it("cannot scroll past either end", () => {
    const view = viewport(longState(40), 24);
    view.render(80);

    view.scrollLines(-10_000);
    const top = view.render(80);
    expect(top).toHaveLength(24);
    expect(view.following).toBe(false);

    view.scrollLines(10_000);
    expect(view.following).toBe(true);
    expect(view.render(80)).toHaveLength(24);
  });

  it("keeps the composer visible when a paste makes it taller than the screen", () => {
    const frame = viewport(longState(40), 24, 60).render(80);

    expect(frame).toHaveLength(24);
    expect(frame.at(-1)).toBe("ready");
    expect(frame.at(-3)).toBe("> ");
  });

  it("stays a single screenful when the terminal is smaller than the layout", () => {
    expect(viewport(longState(40), 3).render(80).length).toBeLessThanOrEqual(6);
  });
});

describe("fullscreen terminal", () => {
  function recordingTerminal() {
    const writes: string[] = [];
    let stopped = false;
    return {
      writes,
      wasStopped: () => stopped,
      terminal: {
        start: () => undefined,
        stop: () => {
          stopped = true;
        },
        drainInput: async () => undefined,
        write: (data: string) => writes.push(data),
        columns: 80,
        rows: 24,
        kittyProtocolActive: false,
        moveBy: () => undefined,
        hideCursor: () => undefined,
        showCursor: () => undefined,
        clearLine: () => undefined,
        clearFromCursor: () => undefined,
        clearScreen: () => undefined,
        setTitle: () => undefined,
        setProgress: () => undefined,
      },
    };
  }

  it("enters the alternate screen on start and restores it on stop", () => {
    const recorder = recordingTerminal();
    const terminal = new FullscreenTerminal(recorder.terminal);

    terminal.start(
      () => undefined,
      () => undefined,
    );
    expect(recorder.writes.join("")).toContain("\u001b[?1049h");
    expect(recorder.writes.join("")).toContain("\u001b[?1000h");

    terminal.stop();
    expect(recorder.writes.join("")).toContain("\u001b[?1049l");
    expect(recorder.writes.join("")).toContain("\u001b[?1000l");
    expect(recorder.wasStopped()).toBe(true);
  });

  it("restores the terminal only once, however many times it is stopped", () => {
    const recorder = recordingTerminal();
    let hook: (() => void) | undefined;
    const terminal = new FullscreenTerminal(recorder.terminal, {
      onProcessExit: (restore) => {
        hook = restore;
      },
    });

    terminal.start(
      () => undefined,
      () => undefined,
    );
    terminal.stop();
    hook?.();

    expect(recorder.writes.filter((write) => write.includes("\u001b[?1049l"))).toHaveLength(1);
  });

  it("leaves text selection alone when mouse reporting is declined", () => {
    const recorder = recordingTerminal();
    const terminal = new FullscreenTerminal(recorder.terminal, { mouse: false });

    terminal.start(
      () => undefined,
      () => undefined,
    );

    expect(recorder.writes.join("")).toContain("\u001b[?1049h");
    expect(recorder.writes.join("")).not.toContain("\u001b[?1000h");
  });
});

describe("wheel reports", () => {
  it("reads direction from SGR wheel events", () => {
    expect(wheelScrollDelta("\u001b[<64;10;5M")).toBe(-1);
    expect(wheelScrollDelta("\u001b[<65;10;5M")).toBe(1);
    expect(wheelScrollDelta("\u001b[<65;10;5M\u001b[<65;10;6M")).toBe(2);
    expect(wheelScrollDelta("hello")).toBe(0);
  });

  it("recognizes mouse reports so they never reach the composer", () => {
    expect(isMouseReport("\u001b[<0;10;5M")).toBe(true);
    expect(isMouseReport("\u001b[<0;10;5m")).toBe(true);
    expect(isMouseReport("\u001b[<64;1;1M\u001b[<64;1;1M")).toBe(true);
    expect(isMouseReport("hello")).toBe(false);
    expect(isMouseReport("\u001b[A")).toBe(false);
  });
});
