import type { Terminal } from "@earendil-works/pi-tui";

const csi = "\u001b[";
const enterAlternateScreen = `${csi}?1049h${csi}2J${csi}H`;
const leaveAlternateScreen = `${csi}?1049l`;
/** Button tracking plus SGR coordinates: the only combination that reports wheel events. */
const enableMouseReporting = `${csi}?1000h${csi}?1006h`;
const disableMouseReporting = `${csi}?1006l${csi}?1000l`;

// Built from a string rather than written as literals so the escape byte stays out of the source,
// the way sanitizeTerminalText and clipboard.ts already handle control characters.
const csiPattern = "\\u001b\\[";
/** An SGR wheel event, `ESC [ < 64;col;rowM` for up and `65` for down. */
const wheelEvent = new RegExp(`${csiPattern}<(6[45]);\\d+;\\d+[Mm]`, "gu");
/** A chunk made up entirely of SGR mouse reports and nothing else. */
const mouseReportOnly = new RegExp(`^(?:${csiPattern}<\\d+;\\d+;\\d+[Mm])+$`, "u");

export interface FullscreenTerminalOptions {
  /** Report wheel events so the transcript can scroll. Disables terminal-native text selection. */
  readonly mouse?: boolean;
  /** Registers the terminal-restoring exit hook. Injectable so tests do not touch the process. */
  readonly onProcessExit?: (restore: () => void) => void;
}

/**
 * Wraps a {@link Terminal} so the UI draws on the alternate screen buffer.
 *
 * The alternate screen is what makes the layout a real full-screen application: the frame is the
 * whole terminal, nothing is appended to the scrollback, and the shell's own history is untouched
 * and restored on exit.
 */
export class FullscreenTerminal implements Terminal {
  readonly #terminal: Terminal;
  readonly #mouse: boolean;
  #active = false;

  constructor(terminal: Terminal, options: FullscreenTerminalOptions = {}) {
    this.#terminal = terminal;
    this.#mouse = options.mouse ?? true;
    // A crash between start() and stop() would otherwise leave the shell on the alternate screen
    // with mouse reporting still on, which looks like a hung terminal.
    options.onProcessExit?.(() => this.#restore());
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.#terminal.start(onInput, onResize);
    this.#active = true;
    this.#terminal.write(`${enterAlternateScreen}${this.#mouse ? enableMouseReporting : ""}`);
  }

  stop(): void {
    this.#restore();
    this.#terminal.stop();
  }

  #restore(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#terminal.write(`${this.#mouse ? disableMouseReporting : ""}${leaveAlternateScreen}`);
  }

  drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.#terminal.drainInput(maxMs, idleMs);
  }

  write(data: string): void {
    this.#terminal.write(data);
  }

  get columns(): number {
    return this.#terminal.columns;
  }

  get rows(): number {
    return this.#terminal.rows;
  }

  get kittyProtocolActive(): boolean {
    return this.#terminal.kittyProtocolActive;
  }

  moveBy(lines: number): void {
    this.#terminal.moveBy(lines);
  }

  hideCursor(): void {
    this.#terminal.hideCursor();
  }

  showCursor(): void {
    this.#terminal.showCursor();
  }

  clearLine(): void {
    this.#terminal.clearLine();
  }

  clearFromCursor(): void {
    this.#terminal.clearFromCursor();
  }

  clearScreen(): void {
    this.#terminal.clearScreen();
  }

  setTitle(title: string): void {
    this.#terminal.setTitle(title);
  }

  setProgress(active: boolean): void {
    this.#terminal.setProgress(active);
  }
}

/**
 * Net wheel movement in an input chunk: negative scrolls toward older output. Returns 0 when the
 * chunk carries no wheel events, so callers can leave unrelated input alone.
 */
export function wheelScrollDelta(data: string): number {
  let delta = 0;
  for (const match of data.matchAll(wheelEvent)) delta += match[1] === "64" ? -1 : 1;
  return delta;
}

/** True when the chunk is only mouse reports, which must never reach the composer. */
export function isMouseReport(data: string): boolean {
  return mouseReportOnly.test(data);
}
