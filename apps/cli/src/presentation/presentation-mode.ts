export const presentationModes = ["auto", "tui", "plain"] as const;

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
  if (selection.requested === "tui") {
    if (!supportsTui(selection.capabilities)) {
      throw new Error(
        `TUI mode is unavailable: ${selection.capabilities.reason ?? "the terminal is not interactive"}. Use --ui plain.`,
      );
    }
    return "tui";
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
