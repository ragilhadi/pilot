import { type Component, SelectList, type SelectItem } from "@earendil-works/pi-tui";
import type { ClarificationRequest } from "@pilotrun/core";
import { sanitizeTerminalText } from "../../presentation/sanitize-terminal-text.js";
import { frameOverlay, wrapPlain } from "../render-helpers.js";
import type { PilotTheme } from "../theme.js";

const freeformValue = "__freeform__";

/**
 * Presents the agent's question with its options as a pick list. Choosing an option answers with
 * its 1-based number — the same line a user could type — so the TUI and the line-oriented CLI go
 * through one parser. Dismissing the dialog leaves the question pending so the user can type an
 * answer in the composer instead.
 */
export class QuestionDialog implements Component {
  readonly #request: ClarificationRequest;
  readonly #theme: PilotTheme;
  readonly #list: SelectList;
  onResponse?: (line: string) => void;
  onDismiss?: () => void;

  constructor(request: ClarificationRequest, theme: PilotTheme) {
    this.#request = request;
    this.#theme = theme;
    const items: SelectItem[] = [
      ...request.options.map((option, index) => ({
        value: String(index + 1),
        label: sanitizeTerminalText(option.label),
        ...(option.description === undefined
          ? {}
          : { description: sanitizeTerminalText(option.description) }),
      })),
      ...(request.allowsFreeformAnswer
        ? [
            {
              value: freeformValue,
              label: "Something else...",
              description: "Close this and type your own answer",
            },
          ]
        : []),
    ];
    this.#list = new SelectList(items, 10, theme.select);
    this.#list.onSelect = (item) => {
      if (item.value === freeformValue) this.onDismiss?.();
      else this.onResponse?.(item.value);
    };
    this.#list.onCancel = () => this.onDismiss?.();
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  handleInput(data: string): void {
    this.#list.handleInput(data);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    return frameOverlay(
      [
        this.#theme.strong("Pilot has a question"),
        ...wrapPlain(sanitizeTerminalText(this.#request.question), innerWidth, 0),
        "",
        ...this.#list.render(innerWidth),
        "",
        this.#theme.muted(
          this.#request.allowsFreeformAnswer
            ? "Enter answer  Esc type your own answer"
            : "Enter answer  Esc close (the question stays open)",
        ),
      ],
      width,
    );
  }
}
