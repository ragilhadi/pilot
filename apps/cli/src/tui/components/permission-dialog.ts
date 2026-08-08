import {
  type Component,
  Key,
  matchesKey,
  SelectList,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { PermissionApprovalRequest, PermissionApprovalScopeKind } from "@pilotrun/core";
import { sanitizeTerminalText } from "../../presentation/sanitize-terminal-text.js";
import { frameOverlay, styleDiffLine, wrapPlain } from "../render-helpers.js";
import type { PilotTheme } from "../theme.js";
import {
  permissionPreview,
  summarizePermissionAction,
  type PermissionPreview,
  type PermissionSummaryRow,
} from "./permission-summary.js";

/**
 * What a session approval actually grants, in the words of the thing being approved.
 *
 * A tool is approved by name — "don't ask again" is about the *next* file, and every write has a
 * different fingerprint — so the label names the tool. A command is approved as itself, because
 * `run_command` carries its whole command line and anything looser would approve the next command
 * too. The label has to say which of the two this is, or the user cannot tell what they granted.
 */
function sessionScopeDescription(action: PermissionApprovalRequest["action"]): string {
  return action.kind === "tool"
    ? `Any ${action.toolName} until this session ends`
    : "This same command until this session ends";
}

const scopeLabels: Readonly<Partial<Record<PermissionApprovalScopeKind, string>>> = Object.freeze({
  session: "Allow for this session",
});

export class PermissionDialog implements Component {
  readonly #request: PermissionApprovalRequest;
  readonly #theme: PilotTheme;
  readonly #summary: readonly PermissionSummaryRow[];
  readonly #preview: PermissionPreview | undefined;
  readonly #rows: number;
  #list: SelectList;
  #mode: "decision" | "preview" = "decision";
  #previewOffset = 0;
  onResponse?: (response: string) => void;
  onCancel?: () => void;

  constructor(
    request: PermissionApprovalRequest,
    theme: PilotTheme,
    capabilities?: { readonly rows: number },
  ) {
    this.#request = request;
    this.#theme = theme;
    this.#rows = capabilities?.rows ?? 30;
    this.#summary = summarizePermissionAction(request.action);
    this.#preview = permissionPreview(request.action);
    this.#list = new SelectList([], 8, theme.select);
    this.#showDecisionList();
  }

  /**
   * Every choice on one list.
   *
   * The broader scopes used to live behind a "More options..." submenu, which made the one people
   * actually want — stop asking me for the rest of this session — two keystrokes and a guess away,
   * while the prompt it was trying to escape reappeared on the very next file.
   */
  #showDecisionList(): void {
    this.#mode = "decision";
    const items: SelectItem[] = [
      { value: "allow once", label: "Allow once", description: "Approve only this action" },
      ...this.#request.availableScopes
        .filter((scope) => scope !== "once")
        .map((scope) => ({
          value: `allow ${scope}`,
          label: scopeLabels[scope] ?? `Allow for ${scope}`,
          description:
            scope === "session"
              ? sessionScopeDescription(this.#request.action)
              : `Approve for ${scope}`,
        })),
      { value: "deny once", label: "Deny", description: "Do not run this action" },
    ];
    this.#list = new SelectList(items, 8, this.#theme.select);
    this.#list.onSelect = (item) => this.onResponse?.(item.value);
    this.#list.onCancel = () => this.onCancel?.();
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  handleInput(data: string): void {
    if (this.#mode === "preview") {
      if (matchesKey(data, Key.up)) this.#previewOffset = Math.max(0, this.#previewOffset - 1);
      else if (matchesKey(data, Key.down)) this.#previewOffset += 1;
      else if (matchesKey(data, Key.pageUp))
        this.#previewOffset = Math.max(0, this.#previewOffset - 10);
      else if (matchesKey(data, Key.pageDown)) this.#previewOffset += 10;
      else if (matchesKey(data, Key.home)) this.#previewOffset = 0;
      else if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.enter) ||
        data === "q" ||
        data === "d"
      ) {
        this.#showDecisionList();
      }
      return;
    }
    if (data === "d" && this.#preview !== undefined) {
      this.#mode = "preview";
      return;
    }
    this.#list.handleInput(data);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    if (this.#mode === "preview" && this.#preview !== undefined) {
      return this.#renderPreview(width, innerWidth, this.#preview);
    }
    return frameOverlay(
      [
        this.#theme.danger("Permission required"),
        this.#theme.warning(`Risk: ${this.#request.action.risk}`),
        "",
        // One labelled row per fact that changes the answer. The payload itself lives behind `d`.
        ...this.#summary.flatMap(({ label, value }) =>
          wrapPlain(`${label.padEnd(12)}${sanitizeTerminalText(value)}`, innerWidth, 0),
        ),
        ...(this.#preview === undefined
          ? []
          : [
              "",
              this.#theme.muted(
                `Press d to review the full ${this.#preview.diff ? "diff" : "content"}`,
              ),
            ]),
        "",
        ...this.#list.render(innerWidth),
        "",
        this.#theme.muted("Enter confirm  Esc deny"),
      ],
      width,
    );
  }

  #renderPreview(width: number, innerWidth: number, preview: PermissionPreview): string[] {
    const allLines = sanitizeTerminalText(preview.text).split(/\r?\n/u);
    // pi-tui hard-truncates an overlay taller than its maxHeight, so a fixed viewport used to slice
    // the scroll hints off the bottom on a short terminal. Size it from the rows actually available
    // (70% of the screen, less this dialog's own chrome).
    const viewportLines = Math.max(6, Math.floor(this.#rows * 0.7) - 8);
    const maximumOffset = Math.max(0, allLines.length - viewportLines);
    this.#previewOffset = Math.min(this.#previewOffset, maximumOffset);
    const visible = allLines.slice(this.#previewOffset, this.#previewOffset + viewportLines);
    return frameOverlay(
      [
        this.#theme.strong(preview.title),
        this.#theme.muted(
          `Lines ${this.#previewOffset + 1}-${Math.min(allLines.length, this.#previewOffset + viewportLines)} of ${allLines.length}`,
        ),
        "",
        ...visible.flatMap((line) =>
          wrapPlain(preview.diff ? styleDiffLine(line, this.#theme) : line, innerWidth, 0),
        ),
        "",
        this.#theme.muted("Up/Down scroll  PgUp/PgDn page  Home top  d/Esc back"),
      ],
      width,
    );
  }
}
