/**
 * `tui` is the inline renderer: finished output goes to the terminal's scrollback and only a bounded
 * live region is redrawn. `fullscreen` keeps the whole transcript in the live buffer, which needs to
 * clear the screen — and the scrollback with it — whenever the terminal is resized.
 */
export const presentationModes = ["auto", "tui", "fullscreen", "plain"] as const;

export type PresentationMode = (typeof presentationModes)[number];
export type ResolvedPresentationMode = Exclude<PresentationMode, "auto"> | "json";

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
  if (selection.requested === "tui" || selection.requested === "fullscreen") {
    if (!supportsTui(selection.capabilities)) {
      throw new Error(
        `TUI mode is unavailable: ${selection.capabilities.reason ?? "the terminal is not interactive"}. Use --ui plain.`,
      );
    }
    return selection.requested;
  }
  return supportsTui(selection.capabilities) ? "tui" : "plain";
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
