import type { Terminal } from "@earendil-works/pi-tui";

/**
 * Wraps a terminal so a resize can be handled before the renderer reacts to it.
 *
 * `pi-tui` registers its own resize callback in `start`, and its reaction is to redraw with
 * `\x1b[2J\x1b[H\x1b[3J` — clearing the scrollback. There is no hook to run first, so the terminal
 * itself is wrapped: the hook runs, then the renderer's callback.
 *
 * Every other method delegates untouched, so the renderer sees an ordinary terminal.
 */
export class ResizeInterceptingTerminal implements Terminal {
  readonly #inner: Terminal;
  readonly #onResize: () => void;

  constructor(inner: Terminal, onResize: () => void) {
    this.#inner = inner;
    this.#onResize = onResize;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.#inner.start(onInput, () => {
      this.#onResize();
      onResize();
    });
  }

  stop(): void {
    this.#inner.stop();
  }
  drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.#inner.drainInput(maxMs, idleMs);
  }
  write(data: string): void {
    this.#inner.write(data);
  }
  get columns(): number {
    return this.#inner.columns;
  }
  get rows(): number {
    return this.#inner.rows;
  }
  get kittyProtocolActive(): boolean {
    return this.#inner.kittyProtocolActive;
  }
  moveBy(lines: number): void {
    this.#inner.moveBy(lines);
  }
  hideCursor(): void {
    this.#inner.hideCursor();
  }
  showCursor(): void {
    this.#inner.showCursor();
  }
  clearLine(): void {
    this.#inner.clearLine();
  }
  clearFromCursor(): void {
    this.#inner.clearFromCursor();
  }
  clearScreen(): void {
    this.#inner.clearScreen();
  }
  setTitle(title: string): void {
    this.#inner.setTitle(title);
  }
  setProgress(active: boolean): void {
    this.#inner.setProgress(active);
  }
}
