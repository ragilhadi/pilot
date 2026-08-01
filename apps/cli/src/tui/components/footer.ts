import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { TokenCountConfidence } from "@pilotrun/core";
import type { TerminalCapabilitySnapshot } from "../../presentation/presentation-mode.js";
import { compactNumber, phaseLabel } from "../render-helpers.js";
import type { TerminalUiState, TerminalUsageState } from "../terminal-ui-state.js";
import type { PilotTheme } from "../theme.js";

/**
 * Marks how well the occupancy figure is known, so it never claims more precision than it has.
 * An exact count from the model's own tokenizer is bare; anything else is visibly qualified.
 */
function confidenceMarker(confidence: TokenCountConfidence | undefined): string {
  if (confidence === "heuristic") return "~";
  if (confidence === "calibrated") return "≈";
  return "";
}

/**
 * Renders context occupancy as `ctx ~38.4k/116k (33%)` — a level with a denominator, not a bare
 * running number. The bare figure was the prompt tokens of the latest request, which readers
 * naturally mistook for the cost of whatever tool had just run.
 *
 * The numerator is Pilot's own measurement of the payload about to be sent, not the provider's
 * reported prompt tokens: a KV-cached runner reports only the tokens it evaluated, which shrinks as
 * the conversation grows and made this figure fall mid-session.
 */
function formatContextUsage(usage: TerminalUsageState): string | undefined {
  if (usage.contextTokens === undefined) return undefined;
  const used = `${confidenceMarker(usage.contextConfidence)}${compactNumber(usage.contextTokens)}`;
  if (usage.contextWindowTokens === undefined) return `ctx ${used}`;
  const percent = Math.round((usage.contextTokens / usage.contextWindowTokens) * 100);
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
