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
 * What each broader scope actually grants.
 *
 * These are deliberately concrete. "Broader approval permitted by policy" told the user nothing
 * about breadth or duration, which matters: every scope below is bound to this exact action, and
 * only differs in how long the approval survives.
 */
const scopeDescriptions: Readonly<Record<PermissionApprovalScopeKind, string>> = Object.freeze({
  once: "Just this call",
  "exact-action": "This same action, whenever it recurs",
  session: "This same action, for the rest of this session",
  tool: "Any use of this tool, for the rest of this session",
  workspace: "This same action, anywhere in this workspace",
  application: "This same action, everywhere Pilot runs",
});

export class PermissionDialog implements Component {
  readonly #request: PermissionApprovalRequest;
  readonly #theme: PilotTheme;
  readonly #summary: readonly PermissionSummaryRow[];
  readonly #preview: PermissionPreview | undefined;
  readonly #rows: number;
  #list: SelectList;
  #mode: "decision" | "preview" | "more" = "decision";
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

  #showDecisionList(): void {
    this.#mode = "decision";
    const items: SelectItem[] = [
      { value: "allow once", label: "Allow once", description: "Approve only this action" },
      { value: "deny once", label: "Deny", description: "Do not run this action" },
      ...(this.#request.availableScopes.some((scope) => scope !== "once")
        ? [
            {
              value: "more",
              label: "More options...",
              description: "Approve for longer than this one call",
            },
          ]
        : []),
    ];
    this.#list = new SelectList(items, 8, this.#theme.select);
    this.#list.onSelect = (item) => {
      if (item.value === "more") this.#showMoreList();
      else this.onResponse?.(item.value);
    };
    this.#list.onCancel = () => this.onCancel?.();
  }

  #showMoreList(): void {
    this.#mode = "more";
    const items: SelectItem[] = [
      ...this.#request.availableScopes
        .filter((scope) => scope !== "once")
        .map((scope) => ({
          value: `allow ${scope}`,
          label: `Allow for ${scope}`,
          description: scopeDescriptions[scope],
        })),
      { value: "back", label: "Back", description: "Return without approving" },
    ];
    this.#list = new SelectList(items, 8, this.#theme.select);
    this.#list.onSelect = (item) => {
      if (item.value === "back") this.#showDecisionList();
      else this.onResponse?.(item.value);
    };
    this.#list.onCancel = () => this.#showDecisionList();
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
          : ["", this.#theme.muted(`Press d to review the full ${this.#preview.diff ? "diff" : "content"}`)]),
        "",
        ...this.#list.render(innerWidth),
        "",
        this.#theme.muted(
          this.#mode === "more" ? "Enter confirm  Esc back" : "Enter confirm  Esc deny",
        ),
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
