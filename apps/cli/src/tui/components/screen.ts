import path from "node:path";
import { type Component, Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import type { JsonValue } from "@pilotrun/core";
import type { TerminalCapabilitySnapshot } from "../../presentation/presentation-mode.js";
import { sanitizeTerminalText } from "../../presentation/sanitize-terminal-text.js";
import {
  formatDuration,
  patchFromInput,
  previewLines,
  safeJson,
  styleDiffLine,
  wrapPlain,
  wrapStyled,
} from "../render-helpers.js";
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
    let previous: TranscriptBlock | undefined;
    for (const block of state.blocks) {
      if (block.kind === "user" && previous !== undefined) {
        const divider = this.#capabilities.unicode ? "┄" : "-";
        lines.push(this.#theme.muted(divider.repeat(Math.min(Math.max(1, width), 32))), "");
      }
      lines.push(...this.#renderBlockCached(block, width, state.showToolDetails), "");
      previous = block;
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
      const label = this.#capabilities.unicode ? "› You" : "You";
      return [this.#theme.accent(label), ...wrapPlain(block.text, width, 2)];
    }
    if (block.kind === "assistant") {
      const marker = this.#capabilities.unicode ? "◆ " : "";
      const status =
        block.status === "streaming"
          ? this.#theme.muted(this.#capabilities.unicode ? "  ● working" : "  working")
          : "";
      const markdown = new Markdown(sanitizeTerminalText(block.text), 1, 0, this.#theme.markdown);
      return [`${this.#theme.strong(`${marker}Pilot`)}${status}`, ...markdown.render(width)];
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
        lines.push(...wrapStyled(`  command ${command.command}  ${details}`, width, 0, decorate));
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
    return wrapStyled(block.text, width, 0, decorate);
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
  const detail = expanded || block.status === "failed" || block.status === "cancelled";
  if (block.name === "run_command") {
    lines.push(...renderCommandBody(block, width, theme, detail));
  } else if (block.name === "apply_patch") {
    lines.push(...renderPatchBody(block, width, theme, detail));
  } else if (block.name === "read_file" || block.name === "write_file") {
    lines.push(...renderFileBody(block, width, theme, detail));
  } else {
    lines.push(...renderGenericBody(block, width, theme, detail));
  }
  return lines;
}

/** Reconstruct a human-readable command line from a run_command tool input. */
function commandLine(input: JsonValue): string | undefined {
  const record = objectValue(input);
  if (record === undefined) return undefined;
  if (typeof record.command === "string") return record.command;
  const command = objectValue(record.command);
  if (command === undefined) return undefined;
  if (command.mode === "shell" && typeof command.command === "string") return command.command;
  if (command.mode === "direct" && typeof command.executable === "string") {
    const args = Array.isArray(command.args)
      ? command.args.filter((value): value is string => typeof value === "string")
      : [];
    return [command.executable, ...args].join(" ");
  }
  return undefined;
}

function renderCommandBody(
  block: ToolTranscriptBlock,
  width: number,
  theme: PilotTheme,
  detail: boolean,
): string[] {
  const lines: string[] = [];
  const command = commandLine(block.input);
  if (command !== undefined) lines.push(...wrapStyled(`$ ${command}`, width, 2, theme.accent));
  const output = block.commandOutput.trim();
  if (detail) {
    if (command === undefined) {
      lines.push(...wrapStyled(`input ${safeJson(block.input)}`, width, 2, theme.muted));
    }
    if (output.length > 0) {
      lines.push(...previewLines(output, width - 2, 12).map((line) => `  ${line}`));
    }
    const exitCode = numberField(block.output, "exitCode");
    if (exitCode !== undefined) {
      lines.push((exitCode === 0 ? theme.success : theme.danger)(`  exit ${exitCode}`));
    }
  } else if (output.length > 0) {
    const summary = output.split(/\r?\n/u).at(-1) ?? "";
    if (summary.length > 0) lines.push(...wrapStyled(summary, width, 2, theme.muted));
  }
  return lines;
}

function renderPatchBody(
  block: ToolTranscriptBlock,
  width: number,
  theme: PilotTheme,
  detail: boolean,
): string[] {
  const patch = patchFromInput(block.input);
  if (patch === undefined) return renderGenericBody(block, width, theme, detail);
  const diffLines = patch.split("\n");
  const maxLines = detail ? diffLines.length : 6;
  const lines = diffLines
    .slice(0, maxLines)
    .map((line) => truncateToWidth(`  ${styleDiffLine(sanitizeTerminalText(line), theme)}`, width));
  if (diffLines.length > maxLines) {
    lines.push(theme.muted(`  … ${diffLines.length - maxLines} more lines`));
  }
  return lines;
}

function renderFileBody(
  block: ToolTranscriptBlock,
  width: number,
  theme: PilotTheme,
  detail: boolean,
): string[] {
  const path = stringField(block.input, "path") ?? stringField(block.input, "file");
  const lines: string[] = [];
  if (path !== undefined) lines.push(...wrapStyled(path, width, 2, theme.muted));
  if (detail) {
    lines.push(...renderGenericBody(block, width, theme, path === undefined));
  }
  return lines;
}

function renderGenericBody(
  block: ToolTranscriptBlock,
  width: number,
  theme: PilotTheme,
  detail: boolean,
): string[] {
  if (!detail) return [];
  const lines = [...wrapStyled(`input ${safeJson(block.input)}`, width, 2, theme.muted)];
  if (block.output !== undefined) {
    lines.push(...wrapStyled(`output ${safeJson(block.output)}`, width, 2, theme.muted));
  }
  if (block.commandOutput.length > 0) {
    lines.push(...previewLines(block.commandOutput, width - 2, 12).map((line) => `  ${line}`));
  }
  return lines;
}

function objectValue(
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : undefined;
}

function stringField(value: JsonValue, key: string): string | undefined {
  const field = objectValue(value)?.[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: JsonValue | undefined, key: string): number | undefined {
  if (value === undefined) return undefined;
  const field = objectValue(value)?.[key];
  return typeof field === "number" ? field : undefined;
}
