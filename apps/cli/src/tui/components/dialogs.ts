import {
  type Component,
  Key,
  matchesKey,
  SelectList,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { frameOverlay, wrapPlain } from "../render-helpers.js";
import type { PilotTheme } from "../theme.js";

export function overlayOptions(minWidth: number) {
  return {
    width: "100%" as const,
    minWidth,
    maxHeight: "80%" as const,
    anchor: "center" as const,
    margin: 0,
  };
}

export class SelectionDialog implements Component {
  readonly #list: SelectList;
  readonly #title: string;
  readonly #theme: PilotTheme;
  onSelect?: (value: string) => void;
  onClose?: () => void;

  constructor(title: string, items: readonly SelectItem[], theme: PilotTheme) {
    this.#title = title;
    this.#theme = theme;
    this.#list = new SelectList(
      items.length > 0
        ? [...items]
        : [{ value: "", label: "None available", description: "No entries were found" }],
      12,
      theme.select,
    );
    this.#list.onSelect = (item) => {
      if (item.value.length > 0) this.onSelect?.(item.value);
    };
    this.#list.onCancel = () => this.onClose?.();
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  handleInput(data: string): void {
    this.#list.handleInput(data);
  }

  render(width: number): string[] {
    return frameOverlay(
      [
        this.#theme.strong(this.#title),
        "",
        ...this.#list.render(Math.max(1, width - 4)),
        "",
        this.#theme.muted("Up/Down select  Enter confirm  Esc close"),
      ],
      width,
    );
  }
}

/**
 * A yes/no gate for an action that cannot be undone from inside the session.
 *
 * Cancel is selected first so that a stray Enter never confirms, and Esc always cancels.
 */
export class ConfirmDialog implements Component {
  readonly #list: SelectList;
  readonly #title: string;
  readonly #lines: readonly string[];
  readonly #theme: PilotTheme;
  onConfirm?: () => void;
  onCancel?: () => void;

  constructor(
    title: string,
    lines: readonly string[],
    theme: PilotTheme,
    labels: { readonly confirm: string; readonly cancel: string },
  ) {
    this.#title = title;
    this.#lines = lines;
    this.#theme = theme;
    this.#list = new SelectList(
      [
        { value: "cancel", label: labels.cancel, description: "Stay in this session" },
        { value: "confirm", label: labels.confirm, description: "This ends the session" },
      ],
      4,
      theme.select,
    );
    this.#list.onSelect = (item) => {
      if (item.value === "confirm") this.onConfirm?.();
      else this.onCancel?.();
    };
    this.#list.onCancel = () => this.onCancel?.();
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
      return;
    }
    // A bare y/n is faster than arrowing to a choice, and matches what the hint offers.
    if (data === "y" || data === "Y") {
      this.onConfirm?.();
      return;
    }
    if (data === "n" || data === "N") {
      this.onCancel?.();
      return;
    }
    this.#list.handleInput(data);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    return frameOverlay(
      [
        this.#theme.warning(this.#title),
        ...this.#lines.flatMap((line) => wrapPlain(line, innerWidth, 0)),
        "",
        ...this.#list.render(innerWidth),
        "",
        this.#theme.muted("y confirm  n/Esc cancel  Enter select"),
      ],
      width,
    );
  }
}

export class DismissableDialog implements Component {
  readonly #title: string;
  readonly #lines: readonly string[];
  readonly #theme: PilotTheme;
  onClose?: () => void;

  constructor(title: string, lines: readonly string[], theme: PilotTheme) {
    this.#title = title;
    this.#lines = lines;
    this.#theme = theme;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.ctrl("c")) ||
      data === "q"
    ) {
      this.onClose?.();
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    return frameOverlay(
      [
        this.#theme.strong(this.#title),
        "",
        ...this.#lines.flatMap((line) => wrapPlain(line, innerWidth, 0)),
        "",
        this.#theme.muted("Esc close"),
      ],
      width,
    );
  }
}
