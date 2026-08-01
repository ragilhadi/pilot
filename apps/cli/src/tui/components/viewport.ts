import { type Component, Container, truncateToWidth } from "@earendil-works/pi-tui";
import type { TerminalCapabilitySnapshot } from "../../presentation/presentation-mode.js";
import type { PilotTheme } from "../theme.js";
import type { PilotScreen } from "./screen.js";

/** Below this the layout has no room to be a layout; the transcript is simply dropped. */
const minimumRows = 6;

export interface ChatViewportOptions {
  readonly screen: PilotScreen;
  readonly editor: Component;
  readonly footer: Component;
  readonly theme: PilotTheme;
  readonly capabilities: TerminalCapabilitySnapshot;
  /** Current terminal height, read on every frame so a resize is picked up immediately. */
  readonly rows: () => number;
}

/**
 * Fixed-height layout for the alternate screen: a pinned banner, a scrolling transcript, then the
 * composer and footer pinned to the bottom rows.
 *
 * Fullscreen mode previously drew the whole transcript into the live buffer and let it run past the
 * bottom of the screen, so the terminal owned the scroll position while Pilot kept rewriting the
 * lines underneath it — which is why scrolling never landed where you left it. Here the frame is
 * always exactly as tall as the terminal, so the renderer only ever touches the visible rows and
 * the offset below is the only scroll position there is.
 *
 * This is the app-like pane; `inline` remains the default and hands scrolling to the terminal.
 */
export class ChatViewport extends Container {
  readonly #screen: PilotScreen;
  readonly #editor: Component;
  readonly #footer: Component;
  readonly #theme: PilotTheme;
  readonly #capabilities: TerminalCapabilitySnapshot;
  readonly #rows: () => number;
  /** Lines of transcript hidden above the viewport. Meaningless while #follow is set. */
  #offset = 0;
  #follow = true;
  #maximumOffset = 0;
  #visibleRows = 1;

  constructor(options: ChatViewportOptions) {
    super();
    this.#screen = options.screen;
    this.#editor = options.editor;
    this.#footer = options.footer;
    this.#theme = options.theme;
    this.#capabilities = options.capabilities;
    this.#rows = options.rows;
    this.addChild(options.screen);
    this.addChild(options.editor);
    this.addChild(options.footer);
  }

  /** True while the viewport is pinned to the newest output. */
  get following(): boolean {
    return this.#follow;
  }

  /** Scrolls by whole lines; negative moves toward older output. */
  scrollLines(delta: number): void {
    const target = (this.#follow ? this.#maximumOffset : this.#offset) + delta;
    this.#offset = Math.max(0, Math.min(target, this.#maximumOffset));
    this.#follow = this.#offset >= this.#maximumOffset;
  }

  /** Scrolls by screenfuls, keeping two lines of overlap for continuity. */
  scrollPages(delta: number): void {
    this.scrollLines(delta * Math.max(1, this.#visibleRows - 2));
  }

  scrollToBottom(): void {
    this.#offset = this.#maximumOffset;
    this.#follow = true;
  }

  override render(width: number): string[] {
    const rows = Math.max(minimumRows, this.#rows());
    const banner = this.#screen.renderBanner(width);
    const footer = this.#footer.render(width);
    const fixedRows = banner.length + footer.length;
    // A large paste can make the composer taller than the screen. Keeping its tail keeps the
    // caret — which is at the end of what was just typed — on screen.
    const composerLimit = Math.max(1, rows - fixedRows - 1);
    const rendered = this.#editor.render(width);
    const composer =
      rendered.length > composerLimit ? rendered.slice(rendered.length - composerLimit) : rendered;
    const body = this.#screen.renderTranscript(width);
    const available = Math.max(0, rows - fixedRows - composer.length);
    return [...banner, ...this.#visibleTranscript(body, available, width), ...composer, ...footer];
  }

  #visibleTranscript(body: readonly string[], available: number, width: number): string[] {
    this.#visibleRows = Math.max(1, available);
    this.#maximumOffset = Math.max(0, body.length - available);
    if (this.#follow) this.#offset = this.#maximumOffset;
    else this.#offset = Math.min(this.#offset, this.#maximumOffset);
    if (available === 0) return [];
    const scrolled = this.#offset < this.#maximumOffset;
    const shown = scrolled ? available - 1 : available;
    const lines = body.slice(this.#offset, this.#offset + shown);
    // A transcript shorter than the viewport is padded above, not below, so it sits against the
    // composer. Otherwise the first message to overflow the screen would jump the whole
    // conversation up by a screenful.
    while (lines.length < shown) lines.unshift("");
    if (scrolled) lines.push(this.#scrollHint(body.length - (this.#offset + shown), width));
    return lines;
  }

  #scrollHint(hiddenBelow: number, width: number): string {
    const unicode = this.#capabilities.unicode;
    const rule = unicode ? "─" : "-";
    const separator = unicode ? "·" : "-";
    const label = ` ${hiddenBelow} more line${hiddenBelow === 1 ? "" : "s"} below ${separator} PgDn to follow `;
    const padding = Math.max(0, width - label.length - 2);
    return truncateToWidth(
      this.#theme.muted(`${rule.repeat(2)}${label}${rule.repeat(padding)}`),
      width,
    );
  }
}
