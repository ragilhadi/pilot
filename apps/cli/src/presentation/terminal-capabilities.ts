import type { TerminalCapabilitySnapshot } from "./presentation-mode.js";

export interface TerminalEnvironment {
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  readonly platform?: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export function detectTerminalCapabilities(
  terminal: TerminalEnvironment,
): TerminalCapabilitySnapshot {
  const term = terminal.environment.TERM?.trim().toLowerCase();
  const interactiveInput = terminal.stdinIsTTY === true;
  const interactiveOutput = terminal.stdoutIsTTY === true;
  const cursorAddressing = interactiveOutput && term !== "dumb";
  const color =
    cursorAddressing && terminal.environment.NO_COLOR === undefined && term !== "unknown";
  const unicode = terminal.environment.PILOT_ASCII !== "1";
  const columns = normalizeDimension(terminal.columns, 80);
  const rows = normalizeDimension(terminal.rows, 24);
  const reason = capabilityReason({
    interactiveInput,
    interactiveOutput,
    cursorAddressing,
    columns,
    rows,
  });

  return Object.freeze({
    interactiveInput,
    interactiveOutput,
    cursorAddressing,
    color,
    unicode,
    columns,
    rows,
    ...(reason === undefined ? {} : { reason }),
  });
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0
    ? fallback
    : Math.floor(value);
}

function capabilityReason(input: {
  readonly interactiveInput: boolean;
  readonly interactiveOutput: boolean;
  readonly cursorAddressing: boolean;
  readonly columns: number;
  readonly rows: number;
}): string | undefined {
  if (!input.interactiveInput) return "stdin is not a TTY";
  if (!input.interactiveOutput) return "stdout is not a TTY";
  if (!input.cursorAddressing) return "TERM=dumb does not support cursor addressing";
  if (input.columns < 40 || input.rows < 10) return "the terminal is smaller than 40x10";
  return undefined;
}
