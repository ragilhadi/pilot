/** The slice of a terminal a scrollback writer needs. Narrow so tests can record every byte. */
export interface ScrollbackTerminal {
  write(data: string): void;
  get rows(): number;
}

/**
 * Resets a live-region renderer's diff state so its next frame is drawn from scratch at the current
 * cursor, without clearing anything above.
 *
 * This exists because the only redraw-from-scratch a `pi-tui` `TUI` offers is
 * `requestRender(true)`, which also marks the width and height as changed and therefore takes the
 * `\x1b[2J\x1b[H\x1b[3J` path — and `ED 3` discards the terminal's scrollback buffer, which is
 * precisely what committed output lives in.
 */
export interface LiveRegionDiffReset {
  /** Forget the previously drawn frame, keeping the recorded width and height. */
  resetDiffState(): boolean;
  requestRender(): void;
}

/**
 * Appends finished output to the terminal's own scrollback.
 *
 * Committed lines are written exactly once and never repainted, so the terminal owns them the way it
 * owns any other program's output: the scroll wheel reaches them, `Shift+PgUp` reaches them, tmux
 * copy-mode reaches them, and they survive Pilot exiting. The cost is that they keep the width they
 * were written at — reflowing them would mean rewriting them, which is the thing that destroys
 * scrollback in the first place.
 *
 * A commit lands *through* the live region: the region's rows are erased, the finished lines are
 * written in their place (scrolling the screen naturally), and the live region is redrawn below.
 */
export class ScrollbackWriter {
  readonly #terminal: ScrollbackTerminal;
  readonly #live: LiveRegionDiffReset | undefined;
  #committedRowCount = 0;
  #liveRowCount = 0;

  constructor(terminal: ScrollbackTerminal, live?: LiveRegionDiffReset) {
    this.#terminal = terminal;
    this.#live = live;
  }

  /** Rows handed to the terminal so far. Diagnostics, and the write-once assertion in tests. */
  get committedRowCount(): number {
    return this.#committedRowCount;
  }

  /**
   * Record how many rows the live region currently occupies.
   *
   * The renderer knows this; the writer needs it to place the cursor at the top of the region before
   * writing. A stale value would either clobber committed rows or leave a hole, so it is recorded on
   * every frame rather than inferred.
   */
  setLiveRowCount(rows: number): void {
    this.#liveRowCount = Math.max(0, rows);
  }

  /**
   * Erase the rows the live region occupies, leaving the cursor at the top of where it was.
   *
   * Only ever moves up by the live region's own height, so committed rows above it are never
   * touched. Exposed for the resize path, which has to clear the old layout before the region is
   * redrawn at the new width.
   */
  eraseLiveRegion(): void {
    if (this.#liveRowCount === 0) return;
    let buffer = "\x1b[?2026h";
    if (this.#liveRowCount > 1) buffer += `\x1b[${this.#liveRowCount - 1}A`;
    buffer += "\r\x1b[J\x1b[?2026l";
    this.#terminal.write(buffer);
  }

  commit(lines: readonly string[]): void {
    if (lines.length === 0) return;

    let buffer = "\x1b[?2026h";
    // Move to the first row of the live region and erase from there down. Without this the commit
    // would be written over whatever the live region had already drawn.
    if (this.#liveRowCount > 1) buffer += `\x1b[${this.#liveRowCount - 1}A`;
    if (this.#liveRowCount > 0) buffer += "\r\x1b[J";
    buffer += lines.join("\r\n");
    buffer += "\r\n";
    buffer += "\x1b[?2026l";
    this.#terminal.write(buffer);
    this.#committedRowCount += lines.length;

    // The live region's previous frame is gone from the screen, so its diff state has to go too or
    // the next render will diff against rows that no longer exist.
    this.#live?.resetDiffState();
    this.#live?.requestRender();
  }
}

/**
 * The number of rows the live region may occupy.
 *
 * Bounded so a frame costs the same on turn one and turn five hundred, and so a resize never has to
 * repaint more than one screen. The floor keeps the composer and footer usable on a very short
 * terminal even though the arithmetic would otherwise leave no room.
 */
export function liveRegionRowBudget(rows: number): number {
  return Math.max(8, rows - 2);
}
