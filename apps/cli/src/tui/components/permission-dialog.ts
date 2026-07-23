import {
  type Component,
  Key,
  matchesKey,
  SelectList,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { PermissionApprovalRequest } from "@pilotrun/core";
import { sanitizeTerminalText } from "../../presentation/sanitize-terminal-text.js";
import {
  frameOverlay,
  patchFromInput,
  previewLines,
  safeJson,
  styleDiffLine,
  wrapPlain,
} from "../render-helpers.js";
import type { PilotTheme } from "../theme.js";

export class PermissionDialog implements Component {
  readonly #request: PermissionApprovalRequest;
  readonly #theme: PilotTheme;
  readonly #patch: string | undefined;
  #list: SelectList;
  #mode: "decision" | "diff" | "more" = "decision";
  #diffOffset = 0;
  onResponse?: (response: string) => void;
  onCancel?: () => void;

  constructor(request: PermissionApprovalRequest, theme: PilotTheme) {
    this.#request = request;
    this.#theme = theme;
    this.#patch =
      request.action.kind === "tool" && request.action.toolName === "apply_patch"
        ? patchFromInput(request.action.input)
        : undefined;
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
              description: "Review broader policy-supported scopes",
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
          description: "Broader approval permitted by policy",
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
    if (this.#mode === "diff") {
      if (matchesKey(data, Key.up)) this.#diffOffset = Math.max(0, this.#diffOffset - 1);
      else if (matchesKey(data, Key.down)) this.#diffOffset += 1;
      else if (matchesKey(data, Key.pageUp)) this.#diffOffset = Math.max(0, this.#diffOffset - 10);
      else if (matchesKey(data, Key.pageDown)) this.#diffOffset += 10;
      else if (matchesKey(data, Key.home)) this.#diffOffset = 0;
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
    if (data === "d" && this.#patch !== undefined) {
      this.#mode = "diff";
      return;
    }
    this.#list.handleInput(data);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    if (this.#mode === "diff" && this.#patch !== undefined) {
      return this.#renderDiff(width, innerWidth);
    }
    const action = this.#request.action;
    const target =
      action.kind === "command"
        ? `${action.executable} ${action.args.join(" ")}`.trim()
        : `${action.toolName} ${safeJson(action.input)}`;
    return frameOverlay(
      [
        this.#theme.danger("Permission required"),
        ...wrapPlain(this.#request.policyDecision.reason, innerWidth, 0),
        this.#theme.warning(`Risk: ${action.risk}`),
        ...wrapPlain(sanitizeTerminalText(target), innerWidth, 0),
        ...(this.#patch === undefined
          ? []
          : [
              "",
              this.#theme.strong("Proposed diff"),
              ...previewLines(this.#patch, innerWidth, 5),
              this.#theme.muted("Press d to inspect and scroll the complete diff"),
            ]),
        "",
        ...(this.#mode === "more"
          ? [this.#theme.warning("Broader scopes persist beyond this action")]
          : []),
        ...this.#list.render(innerWidth),
        "",
        this.#theme.muted(
          this.#mode === "more" ? "Enter confirm  Esc back" : "Enter confirm  Esc deny",
        ),
      ],
      width,
    );
  }

  #renderDiff(width: number, innerWidth: number): string[] {
    const allLines = sanitizeTerminalText(this.#patch ?? "").split(/\r?\n/u);
    const viewportLines = 14;
    const maximumOffset = Math.max(0, allLines.length - viewportLines);
    this.#diffOffset = Math.min(this.#diffOffset, maximumOffset);
    const visible = allLines.slice(this.#diffOffset, this.#diffOffset + viewportLines);
    return frameOverlay(
      [
        this.#theme.strong("Proposed diff"),
        this.#theme.muted(
          `Lines ${this.#diffOffset + 1}-${Math.min(allLines.length, this.#diffOffset + viewportLines)} of ${allLines.length}`,
        ),
        "",
        ...visible.flatMap((line) => wrapPlain(styleDiffLine(line, this.#theme), innerWidth, 0)),
        "",
        this.#theme.muted("Up/Down scroll  PgUp/PgDn page  Home top  d/Esc back"),
      ],
      width,
    );
  }
}
