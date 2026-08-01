import type { Terminal } from "@earendil-works/pi-tui";
import { runId, sessionId } from "@pilotrun/core";
import { afterEach, describe, expect, it } from "vitest";
import { ChatEventFactory } from "../src/index.js";
import { PiTuiLiveRegion } from "../src/tui/live-region.js";
import { liveRegionRowBudget, ScrollbackWriter } from "../src/tui/scrollback.js";
import { TerminalChatPresentation } from "../src/tui/terminal-chat-presentation.js";
import {
  initialTerminalUiState,
  reduceTerminalUi,
  type TranscriptBlock,
} from "../src/tui/terminal-ui-state.js";
import { committableBlockCount, isBlockFinal } from "../src/tui/transcript-committer.js";

/** Clears the scrollback buffer. The sequence this whole design exists to never emit. */
const eraseScrollback = "\u001b[3J";
/** Switches to the alternate screen buffer, which has no scrollback at all. */
const alternateScreen = "\u001b[?1049h";

class RecordingTerminal implements Terminal {
  columns: number;
  rows: number;
  readonly kittyProtocolActive = false;
  output = "";
  #onInput: ((data: string) => void) | undefined;
  #onResize: (() => void) | undefined;

  constructor(columns = 100, rows = 30) {
    this.columns = columns;
    this.rows = rows;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.#onInput = onInput;
    this.#onResize = onResize;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  input(data: string): void {
    this.#onInput?.(data);
  }
  resize(columns = this.columns, rows = this.rows): void {
    this.columns = columns;
    this.rows = rows;
    this.#onResize?.();
  }
}

const capabilities = {
  interactiveInput: true,
  interactiveOutput: true,
  cursorAddressing: true,
  color: false,
  unicode: true,
  columns: 100,
  rows: 30,
} as const;

/**
 * Wait past `pi-tui`'s minimum render interval.
 *
 * Too short a wait makes every assertion below vacuous: nothing has been drawn yet, so of course no
 * clearing sequence appears. The resize test guards against that directly by requiring the
 * fullscreen renderer to *fail* the same assertion.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("transcript commit rules", () => {
  const user: TranscriptBlock = { kind: "user", id: "u1", text: "hello" };
  const streaming: TranscriptBlock = {
    kind: "assistant",
    id: "a1",
    responseId: "r1",
    text: "part",
    status: "streaming",
  };
  const finished: TranscriptBlock = { ...streaming, id: "a2", status: "completed" };
  const running: TranscriptBlock = {
    kind: "tool",
    id: "t1",
    callId: "c1",
    name: "read_file",
    input: {},
    commandOutput: "",
    status: "running",
  };

  it("treats only terminal statuses as final", () => {
    expect(isBlockFinal(user)).toBe(true);
    expect(isBlockFinal(finished)).toBe(true);
    expect(isBlockFinal(streaming)).toBe(false);
    expect(isBlockFinal(running)).toBe(false);
    expect(isBlockFinal({ ...running, status: "cancelled" })).toBe(true);
  });

  it("stops at the first block that is still moving, because scrollback is append-only", () => {
    // The finished block after the streaming one cannot be committed: it is drawn below something
    // that is still changing, and committed rows can never be revisited.
    expect(committableBlockCount([user, streaming, finished], 0)).toBe(1);
    expect(committableBlockCount([user, finished, streaming], 0)).toBe(2);
    expect(committableBlockCount([user, finished], 2)).toBe(2);
  });

  it("never moves the commit count backwards", () => {
    const state = { ...initialTerminalUiState, blocks: [user, finished], committedBlockCount: 2 };
    expect(
      reduceTerminalUi(state, { type: "ui.blocks-committed", count: 1 }).committedBlockCount,
    ).toBe(2);
  });

  it("never commits past the end of the transcript", () => {
    const state = { ...initialTerminalUiState, blocks: [user] };
    expect(
      reduceTerminalUi(state, { type: "ui.blocks-committed", count: 9 }).committedBlockCount,
    ).toBe(1);
  });
});

describe("ScrollbackWriter", () => {
  it("erases the live region before writing, and never clears the scrollback", () => {
    const terminal = new RecordingTerminal();
    const writer = new ScrollbackWriter(terminal);
    writer.setLiveRowCount(4);
    writer.commit(["first", "second"]);

    // Up to the top of the live region, erase from there down, then the committed rows.
    expect(terminal.output).toContain("\u001b[3A");
    expect(terminal.output).toContain("\r\u001b[J");
    expect(terminal.output).toContain("first\r\nsecond\r\n");
    expect(terminal.output).not.toContain(eraseScrollback);
    expect(writer.committedRowCount).toBe(2);
  });

  it("wraps a commit in synchronized output so it cannot tear against a redraw", () => {
    const terminal = new RecordingTerminal();
    const writer = new ScrollbackWriter(terminal);
    writer.commit(["line"]);
    expect(terminal.output.startsWith("\u001b[?2026h")).toBe(true);
    expect(terminal.output.endsWith("\u001b[?2026l")).toBe(true);
  });

  it("writes nothing at all for an empty commit", () => {
    const terminal = new RecordingTerminal();
    const writer = new ScrollbackWriter(terminal);
    writer.commit([]);
    expect(terminal.output).toBe("");
  });

  it("resets the live region's diff state so the next frame is not diffed against erased rows", () => {
    const terminal = new RecordingTerminal();
    let resets = 0;
    let renders = 0;
    const writer = new ScrollbackWriter(terminal, {
      resetDiffState: () => {
        resets += 1;
        return true;
      },
      requestRender: () => {
        renders += 1;
      },
    });
    writer.commit(["line"]);
    expect(resets).toBe(1);
    expect(renders).toBe(1);
  });

  it("bounds the live region so a commit never erases more than a screen", () => {
    expect(liveRegionRowBudget(30)).toBe(28);
    // Never so small that the composer and footer become unusable on a short terminal.
    expect(liveRegionRowBudget(4)).toBe(8);
  });
});

describe("inline presentation", () => {
  const presentations: TerminalChatPresentation[] = [];
  afterEach(async () => {
    await Promise.all(presentations.splice(0).map((presentation) => presentation.close()));
  });

  const start = (terminal: RecordingTerminal) => {
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
      renderMode: "inline",
    });
    presentations.push(presentation);
    return presentation;
  };

  const factory = () => new ChatEventFactory({ now: () => new Date("2026-07-22T12:00:00.000Z") });

  /** Drive a presentation through two resizes and return everything it wrote. */
  const recordResizes = async (renderMode: "inline" | "fullscreen"): Promise<string> => {
    const terminal = new RecordingTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
      renderMode,
    });
    presentations.push(presentation);
    const events = factory();
    presentation.render(
      events.create({
        type: "chat.started",
        sessionId: sessionId(`session-${renderMode}`),
        payload: { modelKey: "fake/test" },
      }),
    );
    await settle();
    terminal.resize(72, 24);
    await settle();
    terminal.resize(120, 40);
    await settle();
    return terminal.output;
  };

  it("never erases the scrollback or enters the alternate screen, even across a resize", async () => {
    const inline = await recordResizes("inline");
    expect(inline).not.toContain(eraseScrollback);
    expect(inline).not.toContain(alternateScreen);
  });

  it("proves that assertion is not vacuous: the fullscreen renderer does erase it", async () => {
    // Same events, same waits, opposite result. If the inline assertion above ever starts passing
    // because nothing was drawn, this one fails alongside it.
    const fullscreen = await recordResizes("fullscreen");
    expect(fullscreen).toContain(eraseScrollback);
  });

  it("does not clear the scrollback when the whole live region is redrawn", async () => {
    const terminal = new RecordingTerminal();
    const presentation = start(terminal);
    const events = factory();
    presentation.render(
      events.create({
        type: "chat.started",
        sessionId: sessionId("session-toggle"),
        payload: { modelKey: "fake/test" },
      }),
    );
    await settle();
    // Ctrl+T toggles tool details, which reshapes every block and previously forced the clearing
    // full-redraw path.
    terminal.input("\u0014");
    await settle();
    terminal.input("\u0014");
    await settle();

    expect(terminal.output).not.toContain(eraseScrollback);
  });

  it("commits a finished turn to scrollback and stops redrawing it", async () => {
    const terminal = new RecordingTerminal();
    const presentation = start(terminal);
    const events = factory();
    presentation.render(
      events.create({
        type: "chat.started",
        sessionId: sessionId("session-2"),
        payload: { modelKey: "fake/test" },
      }),
    );
    await settle();

    presentation.render(
      events.create({
        type: "tool.execution",
        sessionId: sessionId("session-2"),
        runId: runId("run-1"),
        payload: {
          event: {
            type: "tool.started",
            runId: runId("run-1"),
            callId: "call-1",
            toolName: "read_file",
            input: { path: "README.md" },
            occurredAt: "2026-07-22T12:00:00.000Z",
          },
        },
      }),
    );
    await settle();
    presentation.render(
      events.create({
        type: "tool.execution",
        sessionId: sessionId("session-2"),
        runId: runId("run-1"),
        payload: {
          event: {
            type: "tool.completed",
            runId: runId("run-1"),
            callId: "call-1",
            toolName: "read_file",
            output: { content: "hi" },
            isError: false,
            occurredAt: "2026-07-22T12:00:01.000Z",
          },
        },
      }),
    );
    await settle();

    // A settled tool call is final, so it now belongs to the terminal's scrollback.
    expect(terminal.output).toContain("read_file");
    const committedOnce = terminal.output.split("read_file").length - 1;

    // Further frames redraw the live region only. The committed block must not reappear in any of
    // them — that is what "the terminal owns it now" means.
    for (let index = 0; index < 3; index += 1) {
      presentation.render(
        events.create({
          type: "chat.input.queued",
          sessionId: sessionId("session-2"),
          payload: { messageId: `m-${index}` },
        }),
      );
      await settle();
    }

    expect(terminal.output.split("read_file").length - 1).toBe(committedOnce);
    expect(terminal.output).not.toContain(eraseScrollback);
  });

  it("never lets the live region grow past the screen", async () => {
    const terminal = new RecordingTerminal(100, 20);
    const presentation = start(terminal);
    const events = factory();
    presentation.render(
      events.create({
        type: "chat.started",
        sessionId: sessionId("session-long"),
        payload: { modelKey: "fake/test" },
      }),
    );
    await settle();

    // A response far taller than the terminal. If the region rendered all of it, the top would
    // scroll into the scrollback uncommitted and be written a second time on commit.
    presentation.render(
      events.create({
        type: "model.stream",
        sessionId: sessionId("session-long"),
        runId: runId("run-long"),
        payload: {
          event: {
            type: "text.delta",
            sequence: 1,
            responseId: "response-long",
            delta: Array.from({ length: 200 }, (_value, index) => `line ${index}`).join("\n"),
          },
        },
      }),
    );
    await settle();

    const frame = terminal.output.slice(terminal.output.lastIndexOf("\u001b[?2026h"));
    expect(frame.split("\r\n").length).toBeLessThanOrEqual(terminal.rows);
    // The newest output is what stays visible.
    expect(terminal.output).toContain("line 199");
  });

  it("prints the banner once instead of on every frame", async () => {
    const terminal = new RecordingTerminal();
    const presentation = start(terminal);
    const events = factory();
    for (let index = 0; index < 4; index += 1) {
      presentation.render(
        events.create({
          type: "chat.input.queued",
          sessionId: sessionId("session-3"),
          payload: { messageId: `m-${index}` },
        }),
      );
      await settle();
    }
    expect(terminal.output.split("PILOT").length - 1).toBe(1);
  });
});

describe("PiTuiLiveRegion", () => {
  it("redraws by forgetting the previous frame, not by clearing the screen", () => {
    const calls: Array<boolean | undefined> = [];
    const fake = {
      previousLines: ["a", "b"],
      requestRender(force?: boolean) {
        calls.push(force);
      },
    };
    const region = new PiTuiLiveRegion(
      fake as unknown as ConstructorParameters<typeof PiTuiLiveRegion>[0],
    );

    region.redraw();

    expect(fake.previousLines).toEqual([]);
    // `requestRender(true)` is the clearing path; the redraw must not reach for it.
    expect(calls).toEqual([undefined]);
  });

  it("falls back to the forcing redraw when the renderer's shape is unrecognised", () => {
    const calls: Array<boolean | undefined> = [];
    const fake = {
      requestRender(force?: boolean) {
        calls.push(force);
      },
    };
    const region = new PiTuiLiveRegion(
      fake as unknown as ConstructorParameters<typeof PiTuiLiveRegion>[0],
    );

    expect(region.resetDiffState()).toBe(false);
    region.redraw();
    // Visibly degraded rather than silently corrupt: a cleared screen beats a torn one.
    expect(calls).toEqual([true]);
  });
});

describe("fullscreen presentation", () => {
  const presentations: TerminalChatPresentation[] = [];
  afterEach(async () => {
    await Promise.all(presentations.splice(0).map((presentation) => presentation.close()));
  });

  it("keeps redrawing the banner, which is what the inline mode exists to avoid", async () => {
    const terminal = new RecordingTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
      renderMode: "fullscreen",
    });
    presentations.push(presentation);
    const events = new ChatEventFactory({ now: () => new Date("2026-07-22T12:00:00.000Z") });
    presentation.render(
      events.create({
        type: "chat.started",
        sessionId: sessionId("session-4"),
        payload: { modelKey: "fake/test" },
      }),
    );
    await settle();
    expect(terminal.output).toContain("PILOT");
  });
});
