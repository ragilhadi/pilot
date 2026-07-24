import path from "node:path";
import { type Component, Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import type { TerminalCapabilitySnapshot } from "../../presentation/presentation-mode.js";
import { sanitizeTerminalText } from "../../presentation/sanitize-terminal-text.js";
import { formatDuration, previewLines, safeJson, wrapPlain } from "../render-helpers.js";
import type {
  TerminalUiState,
  ToolTranscriptBlock,
  TranscriptBlock,
} from "../terminal-ui-state.js";
import type { PilotTheme } from "../theme.js";

export interface RepositoryDisplayState {
  readonly branch: string;
  readonly dirty: boolean;
}

export class PilotScreen implements Component {
  readonly #state: () => TerminalUiState;
  readonly #theme: PilotTheme;
  readonly #capabilities: TerminalCapabilitySnapshot;
  readonly #workspacePath: string;
  readonly #repository: RepositoryDisplayState | undefined;
  readonly #blockCache = new Map<
    string,
    { readonly block: TranscriptBlock; readonly lines: readonly string[] }
  >();

  constructor(
    state: () => TerminalUiState,
    theme: PilotTheme,
    capabilities: TerminalCapabilitySnapshot,
    workspacePath: string,
    repository?: RepositoryDisplayState,
  ) {
    this.#state = state;
    this.#theme = theme;
    this.#capabilities = capabilities;
    this.#workspacePath = workspacePath;
    this.#repository = repository;
  }

  invalidate(): void {
    this.#blockCache.clear();
  }

  render(width: number): string[] {
    const state = this.#state();
    const workspace = path.basename(this.#workspacePath) || this.#workspacePath;
    const brand = this.#theme.strong(this.#capabilities.unicode ? "◆ PILOT" : "PILOT");
    const model = state.modelKey ?? "starting";
    const session =
      width >= 120 && state.sessionId !== undefined ? `  ${state.sessionId.slice(0, 12)}` : "";
    const branch =
      this.#repository === undefined
        ? ""
        : `  ${this.#repository.branch}${this.#repository.dirty ? "*" : ""}`;
    const header = truncateToWidth(
      `${brand}${session}  ${workspace}${branch}  ${this.#theme.muted(model)}  ${this.#theme.warning("Manual")}`,
      width,
    );
    const lines = [header, this.#theme.muted("─".repeat(Math.max(1, width))), ""];
    for (const block of state.blocks) {
      lines.push(...this.#renderBlockCached(block, width, state.showToolDetails), "");
    }
    if (this.#blockCache.size > state.blocks.length * 3 + 30) {
      const activeIds = new Set(state.blocks.map(({ id }) => id));
      for (const key of this.#blockCache.keys()) {
        if (!activeIds.has(key.split("\0", 1)[0] ?? "")) this.#blockCache.delete(key);
      }
    }
    if (state.blocks.length === 0) {
      lines.push(
        this.#theme.muted("Ask Pilot to inspect, explain, or change this repository."),
        "",
      );
    }
    return lines;
  }

  #renderBlockCached(
    block: TranscriptBlock,
    width: number,
    showToolDetails: boolean,
  ): readonly string[] {
    const key = `${block.id}\0${width}\0${showToolDetails ? "details" : "compact"}`;
    const cached = this.#blockCache.get(key);
    if (cached?.block === block) return cached.lines;
    const lines = this.#renderBlock(block, width);
    this.#blockCache.set(key, { block, lines });
    return lines;
  }

  #renderBlock(block: TranscriptBlock, width: number): string[] {
    if (block.kind === "user") {
      return [this.#theme.accent("You"), ...wrapPlain(block.text, width, 2)];
    }
    if (block.kind === "assistant") {
      const status = block.status === "streaming" ? this.#theme.muted("  working") : "";
      const markdown = new Markdown(sanitizeTerminalText(block.text), 1, 0, this.#theme.markdown);
      return [`${this.#theme.strong("Pilot")}${status}`, ...markdown.render(width)];
    }
    if (block.kind === "tool") {
      return renderTool(
        block,
        width,
        this.#theme,
        this.#capabilities,
        this.#state().showToolDetails,
      );
    }
    if (block.kind === "summary") {
      const summary = block.summary;
      const lines = [
        this.#theme.strong("Turn summary"),
        this.#theme.muted(
          `${summary.outcome}${summary.elapsedMs === undefined ? "" : `  ${formatDuration(summary.elapsedMs)}`}  ${summary.runCount} run${summary.runCount === 1 ? "" : "s"}  ${summary.toolCount} tool${summary.toolCount === 1 ? "" : "s"}${summary.failedToolCount > 0 ? `  ${summary.failedToolCount} failed` : ""}`,
        ),
      ];
      for (const file of summary.changedFiles) {
        const changes =
          file.additions === undefined && file.deletions === undefined
            ? ""
            : `  +${file.additions ?? 0} -${file.deletions ?? 0}`;
        lines.push(this.#theme.success(`  changed ${file.path}${changes}`));
      }
      for (const command of summary.commands) {
        const details = [
          command.status,
          command.exitCode === undefined ? undefined : `exit ${command.exitCode ?? "signal"}`,
          command.durationMs === undefined ? undefined : formatDuration(command.durationMs),
          command.truncated ? "truncated" : undefined,
        ]
          .filter((value): value is string => value !== undefined)
          .join(", ");
        const decorate = command.status === "completed" ? this.#theme.success : this.#theme.danger;
        lines.push(...wrapPlain(decorate(`  command ${command.command}  ${details}`), width, 0));
      }
      if (summary.tests.length > 0) {
        const failedTests = summary.tests.filter(({ status }) => status !== "completed").length;
        lines.push(
          (failedTests === 0 ? this.#theme.success : this.#theme.danger)(
            `  tests ${failedTests === 0 ? "passed" : `${failedTests} failed`} (${summary.tests.length} command${summary.tests.length === 1 ? "" : "s"})`,
          ),
        );
      }
      if (summary.error !== undefined) lines.push(this.#theme.warning(`  ${summary.error}`));
      const usage = summary.usage;
      if (
        usage.inputTokens !== undefined ||
        usage.outputTokens !== undefined ||
        usage.estimatedCostUsd !== undefined
      ) {
        lines.push(
          this.#theme.muted(
            `  usage ${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out${usage.estimatedCostUsd === undefined ? "" : ` / $${usage.estimatedCostUsd.toFixed(4)}`}`,
          ),
        );
      }
      return lines;
    }
    const decorate =
      block.tone === "danger"
        ? this.#theme.danger
        : block.tone === "warning"
          ? this.#theme.warning
          : block.tone === "success"
            ? this.#theme.success
            : this.#theme.info;
    return wrapPlain(decorate(block.text), width, 0);
  }
}

function renderTool(
  block: ToolTranscriptBlock,
  width: number,
  theme: PilotTheme,
  capabilities: TerminalCapabilitySnapshot,
  expanded: boolean,
): string[] {
  const symbol =
    block.status === "running"
      ? capabilities.unicode
        ? "●"
        : "*"
      : block.status === "failed" || block.status === "cancelled"
        ? capabilities.unicode
          ? "✗"
          : "x"
        : capabilities.unicode
          ? "✓"
          : "+";
  const decorate =
    block.status === "failed"
      ? theme.danger
      : block.status === "cancelled"
        ? theme.warning
        : block.status === "completed"
          ? theme.success
          : theme.info;
  const duration = block.durationMs === undefined ? "" : `  ${formatDuration(block.durationMs)}`;
  const truncated = block.truncated ? "  truncated" : "";
  const lines = [
    truncateToWidth(
      decorate(`${symbol} ${block.name}  ${block.status}${duration}${truncated}`),
      width,
    ),
  ];
  if (block.status === "failed" || block.status === "cancelled" || expanded) {
    lines.push(...wrapPlain(theme.muted(`input ${safeJson(block.input)}`), width, 2));
    if (block.output !== undefined) {
      lines.push(...wrapPlain(theme.muted(`output ${safeJson(block.output)}`), width, 2));
    }
    if (block.commandOutput.length > 0) {
      lines.push(...previewLines(block.commandOutput, width - 2, 12).map((line) => `  ${line}`));
    }
  } else if (block.commandOutput.length > 0) {
    const summary = block.commandOutput.trim().split(/\r?\n/u).at(-1) ?? "";
    if (summary.length > 0) lines.push(...wrapPlain(theme.muted(summary), width, 2));
  }
  return lines;
}
