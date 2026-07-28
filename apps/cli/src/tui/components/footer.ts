import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { TerminalCapabilitySnapshot } from "../../presentation/presentation-mode.js";
import { compactNumber, phaseLabel } from "../render-helpers.js";
import type { TerminalUiState, TerminalUsageState } from "../terminal-ui-state.js";
import type { PilotTheme } from "../theme.js";

/**
 * Renders context occupancy as `ctx 38.4k/128k (30%)` — a level with a denominator, not a bare
 * running number. The bare figure was the prompt tokens of the latest request, which readers
 * naturally mistook for the cost of whatever tool had just run.
 */
function formatContextUsage(usage: TerminalUsageState): string | undefined {
  if (usage.inputTokens === undefined) return undefined;
  const prefix = usage.estimated === true ? "~" : "";
  const used = `${prefix}${compactNumber(usage.inputTokens)}`;
  if (usage.contextWindowTokens === undefined) return `ctx ${used}`;
  const percent = Math.round((usage.inputTokens / usage.contextWindowTokens) * 100);
  return `ctx ${used}/${compactNumber(usage.contextWindowTokens)} (${percent}%)`;
}

export class PilotFooter implements Component {
  readonly #state: () => TerminalUiState;
  readonly #theme: PilotTheme;
  readonly #capabilities: TerminalCapabilitySnapshot;

  constructor(
    state: () => TerminalUiState,
    theme: PilotTheme,
    capabilities: TerminalCapabilitySnapshot,
  ) {
    this.#state = state;
    this.#theme = theme;
    this.#capabilities = capabilities;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.#state();
    const usage = state.usage;
    const parts = [phaseLabel(state.phase, this.#capabilities.unicode)];
    if (state.activeToolCount > 0) parts.push(`${state.activeToolCount} tool`);
    if (state.queuedInputCount > 0) parts.push(`${state.queuedInputCount} queued`);
    const contextLabel = formatContextUsage(usage);
    if (contextLabel !== undefined) parts.push(contextLabel);
    if (usage.outputTokens !== undefined) parts.push(`${compactNumber(usage.outputTokens)} out`);
    if (usage.estimatedCostUsd !== undefined) parts.push(`$${usage.estimatedCostUsd.toFixed(4)}`);
    const summary = state.lastTurnSummary;
    if (summary !== undefined && summary.changedFiles.length > 0) {
      parts.push(`${summary.changedFiles.length} changed`);
    }
    if (summary !== undefined && summary.commands.length > 0) {
      const failed = summary.commands.filter(({ status }) => status !== "completed").length;
      parts.push(
        failed === 0 ? `${summary.commands.length} command ok` : `${failed} command failed`,
      );
    }
    const hints =
      width >= 100
        ? "Enter send  Ctrl+J newline  Ctrl+Y copy  Esc cancel  Ctrl+C twice exit"
        : width >= 80
          ? "Enter send  Ctrl+J newline  Esc cancel  Ctrl+C twice exit"
          : "Enter send  Esc cancel";
    return [
      this.#theme.muted("─".repeat(Math.max(1, width))),
      truncateToWidth(`${parts.join("  ")}  ${this.#theme.muted(hints)}`, width),
    ];
  }
}
