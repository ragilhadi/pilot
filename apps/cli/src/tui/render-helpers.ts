import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../presentation/sanitize-terminal-text.js";
import type { TerminalUiPhase } from "./terminal-ui-state.js";
import type { PilotTheme } from "./theme.js";

export function wrapPlain(text: string, width: number, padding: number): string[] {
  const available = Math.max(1, width - padding);
  const prefix = " ".repeat(padding);
  return sanitizeTerminalText(text)
    .split("\n")
    .flatMap((line) => wrapTextWithAnsi(line, available).map((wrapped) => prefix + wrapped));
}

/**
 * Wrap raw (unstyled) text and apply a color function to each wrapped line.
 *
 * Styling must happen after wrapping because {@link wrapPlain} sanitizes control
 * bytes — including the ESC that starts ANSI codes — so pre-styled text passed
 * through it would have its color sequences corrupted. Sanitizing the raw text
 * first and coloring afterward keeps both the safety guarantee and the color.
 */
export function wrapStyled(
  text: string,
  width: number,
  padding: number,
  style: (line: string) => string,
): string[] {
  return wrapPlain(text, width, padding).map((line) => style(line));
}

export function safeJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable value]";
  }
}

export function frameOverlay(lines: readonly string[], width: number): string[] {
  const frameWidth = Math.max(8, width);
  const innerWidth = frameWidth - 4;
  const border = `+${"-".repeat(frameWidth - 2)}+`;
  return [
    border,
    ...lines.map((line) => {
      const content = truncateToWidth(line, innerWidth, "");
      return `| ${content}${" ".repeat(Math.max(0, innerWidth - visibleWidth(content)))} |`;
    }),
    border,
  ];
}

export function previewLines(text: string, width: number, maximumLines: number): string[] {
  const lines = sanitizeTerminalText(text)
    .split(/\r?\n/u)
    .flatMap((line) => wrapPlain(line, width, 0));
  if (lines.length <= maximumLines) return lines;
  return [...lines.slice(0, maximumLines), `… ${lines.length - maximumLines} more lines`];
}

export function styleDiffLine(line: string, theme: PilotTheme): string {
  if (line.startsWith("@@")) return theme.accent(line);
  if (line.startsWith("+++") || line.startsWith("---")) return theme.info(line);
  if (line.startsWith("+")) return theme.success(line);
  if (line.startsWith("-")) return theme.danger(line);
  return theme.muted(line);
}

export function formatDuration(durationMs: number): string {
  return durationMs >= 1_000
    ? `${(durationMs / 1_000).toFixed(1)}s`
    : `${Math.round(durationMs)}ms`;
}

export function compactNumber(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

export function phaseLabel(phase: TerminalUiPhase, unicode: boolean): string {
  const marker = unicode ? "●" : "*";
  return `${marker} ${phase.replace("-", " ")}`;
}

export function patchFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const patch = (input as Readonly<Record<string, unknown>>).patch;
  return typeof patch === "string" ? patch : undefined;
}
