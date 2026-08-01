import type { TUI } from "@earendil-works/pi-tui";
import type { LiveRegionDiffReset } from "./scrollback.js";

/**
 * Redraws a `pi-tui` frame from scratch without clearing the screen.
 *
 * `TUI` offers exactly one redraw-from-scratch, `requestRender(true)`, and it sets the recorded
 * width and height to `-1` as well as emptying the previous frame. Both of those make `doRender`
 * take its `fullRender(true)` path, which writes `\x1b[2J\x1b[H\x1b[3J` — and `ED 3` discards the
 * terminal's scrollback buffer along with everything that was on screen before Pilot started.
 *
 * Emptying only the previous frame leaves `doRender` on its first-render path, which writes the new
 * lines at the cursor and clears nothing. That is the behaviour an inline UI needs, and there is no
 * public API for it, so the field is reset directly. It is a plain TypeScript `private` — public at
 * runtime — and the dependency is pinned, but the reset is guarded and reports whether it worked so
 * a version that renames the field degrades to a visible fallback instead of a corrupted screen.
 */
export class PiTuiLiveRegion implements LiveRegionDiffReset {
  readonly #tui: TUI;

  constructor(tui: TUI) {
    this.#tui = tui;
  }

  resetDiffState(): boolean {
    const internals = this.#tui as unknown as { previousLines?: unknown };
    if (!Array.isArray(internals.previousLines)) return false;
    internals.previousLines = [];
    return true;
  }

  /**
   * Absorb a terminal resize without letting it clear the screen.
   *
   * `doRender` compares the recorded width and height against the terminal's current ones and takes
   * the clearing full-render path when either differs — which is how a resize used to take the
   * user's scrollback with it. Recording the *new* dimensions before that comparison runs, together
   * with an empty previous frame, leaves the first-render path: redraw everything at the cursor,
   * clear nothing.
   *
   * The caller is responsible for erasing the rows the live region occupied first; this only
   * arranges for the redraw not to clear.
   */
  absorbResize(columns: number, rows: number): boolean {
    const internals = this.#tui as unknown as {
      previousLines?: unknown;
      previousWidth?: unknown;
      previousHeight?: unknown;
    };
    if (
      !Array.isArray(internals.previousLines) ||
      typeof internals.previousWidth !== "number" ||
      typeof internals.previousHeight !== "number"
    ) {
      return false;
    }
    internals.previousLines = [];
    internals.previousWidth = columns;
    internals.previousHeight = rows;
    return true;
  }

  requestRender(): void {
    this.#tui.requestRender();
  }

  /**
   * Rows the last drawn frame actually occupies on screen.
   *
   * The erase before a commit must be sized from what was *drawn*, not from what the next frame
   * would render: the pending frame can be taller than the one on screen, and erasing that many rows
   * would move the cursor up past committed output and overwrite it. Returns `undefined` when the
   * renderer's shape is unrecognised, so the caller can fall back rather than guess high.
   */
  drawnRowCount(): number | undefined {
    const internals = this.#tui as unknown as { previousLines?: unknown };
    return Array.isArray(internals.previousLines) ? internals.previousLines.length : undefined;
  }

  /**
   * Redraw everything, preferring the non-clearing path.
   *
   * Used where the whole live region changes shape — a theme switch, a detail toggle — which
   * previously went through `requestRender(true)` and took the scrollback with it.
   */
  redraw(): void {
    if (this.resetDiffState()) {
      this.#tui.requestRender();
      return;
    }
    this.#tui.requestRender(true);
  }
}
