/**
 * `tui` is the default and means the full-screen renderer: an app-like pane on the alternate
 * screen, with a pinned banner and composer and a transcript Pilot scrolls itself. It redraws
 * freely because the alternate screen keeps those redraws away from the shell's scrollback, and
 * scrolling back through the session is `PgUp`/`PgDn`, `Shift+Up`/`Shift+Down`, or the wheel.
 *
 * `inline` is the renderer that hands scrolling to the terminal instead: finished output is
 * committed to the terminal's own scrollback and only a bounded live region is redrawn, so the
 * transcript survives Pilot exiting. It is the mode to pick when the transcript needs to stay in
 * the terminal afterwards; the cost is that the layout is a growing log rather than a pane.
 *
 * `fullscreen` is kept as an explicit spelling of the default so the flag that selected it in
 * 0.0.19 keeps working.
 */
export const presentationModes = ["auto", "tui", "fullscreen", "inline", "plain"] as const;

export type PresentationMode = (typeof presentationModes)[number];
export type ResolvedPresentationMode = "fullscreen" | "inline" | "plain" | "json";

export interface TerminalCapabilitySnapshot {
  readonly interactiveInput: boolean;
  readonly interactiveOutput: boolean;
  readonly cursorAddressing: boolean;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly reason?: string;
}

export interface PresentationSelection {
  readonly requested: PresentationMode;
  readonly json: boolean;
  readonly screenReader: boolean;
  readonly capabilities: TerminalCapabilitySnapshot;
}

export function isPresentationMode(value: string): value is PresentationMode {
  return presentationModes.includes(value as PresentationMode);
}

export function resolvePresentationMode(
  selection: PresentationSelection,
): ResolvedPresentationMode {
  if (selection.json) return "json";
  if (selection.screenReader) return "plain";
  if (selection.requested === "plain") return "plain";
  if (selection.requested !== "auto") {
    if (!supportsTui(selection.capabilities)) {
      throw new Error(
        `TUI mode is unavailable: ${selection.capabilities.reason ?? "the terminal is not interactive"}. Use --ui plain.`,
      );
    }
    return selection.requested === "inline" ? "inline" : "fullscreen";
  }
  return supportsTui(selection.capabilities) ? "fullscreen" : "plain";
}

function supportsTui(capabilities: TerminalCapabilitySnapshot): boolean {
  return (
    capabilities.interactiveInput &&
    capabilities.interactiveOutput &&
    capabilities.cursorAddressing &&
    capabilities.columns >= 40 &&
    capabilities.rows >= 10
  );
}
