import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import type { TerminalCapabilitySnapshot } from "../presentation/presentation-mode.js";

export interface PilotTheme {
  readonly accent: (text: string) => string;
  readonly muted: (text: string) => string;
  readonly success: (text: string) => string;
  readonly warning: (text: string) => string;
  readonly danger: (text: string) => string;
  readonly info: (text: string) => string;
  readonly strong: (text: string) => string;
  readonly editor: EditorTheme;
  readonly markdown: MarkdownTheme;
  readonly select: SelectListTheme;
}

export const pilotThemeModes = ["system", "dark", "light", "high-contrast"] as const;
export type PilotThemeMode = (typeof pilotThemeModes)[number];

export function isPilotThemeMode(value: unknown): value is PilotThemeMode {
  return pilotThemeModes.includes(value as PilotThemeMode);
}

export function createPilotTheme(
  capabilities: TerminalCapabilitySnapshot,
  mode: PilotThemeMode = "system",
): PilotTheme {
  const style = (open: number, close: number) => (text: string) =>
    capabilities.color ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  const palette =
    mode === "light"
      ? { accent: 34, success: 32, warning: 35, danger: 31, info: 36 }
      : mode === "high-contrast"
        ? { accent: 96, success: 92, warning: 93, danger: 91, info: 94 }
        : { accent: 36, success: 32, warning: 33, danger: 31, info: 34 };
  const accent = style(palette.accent, 39);
  const muted = style(2, 22);
  const success = style(palette.success, 39);
  const warning = style(palette.warning, 39);
  const danger = style(palette.danger, 39);
  const info = style(palette.info, 39);
  const strong = style(1, 22);
  const inverse = style(7, 27);
  const unicode = capabilities.unicode;
  const codeTopCorner = unicode ? "┌─" : "+-";
  const codeBottomCorner = unicode ? "└─" : "+-";
  const codeBar = unicode ? "│ " : "| ";
  const codeFenceLabel = (fence: string): string => fence.replace(/`+/gu, "").trim();
  const select: SelectListTheme = {
    selectedPrefix: accent,
    selectedText: inverse,
    description: muted,
    scrollInfo: muted,
    noMatch: warning,
  };

  return {
    accent,
    muted,
    success,
    warning,
    danger,
    info,
    strong,
    select,
    editor: { borderColor: accent, selectList: select },
    markdown: {
      heading: (text) => strong(accent(text)),
      link: accent,
      linkUrl: muted,
      code: (text) => warning(text),
      codeBlock: (text) => text,
      // The fence callback cannot know the viewport width, so instead of a full
      // rule we render a labeled top corner (```lang) and a plain bottom/langless
      // corner, and frame every code line with the styled left bar below.
      codeBlockBorder: (fence) => {
        const label = codeFenceLabel(fence);
        return muted(label.length > 0 ? `${codeTopCorner} ${label}` : codeBottomCorner);
      },
      codeBlockIndent: muted(codeBar),
      quote: muted,
      quoteBorder: accent,
      hr: muted,
      listBullet: accent,
      bold: strong,
      italic: style(3, 23),
      strikethrough: style(9, 29),
      underline: style(4, 24),
    },
  };
}

/** Update a shared theme object so already-mounted Pi components switch atomically. */
export function applyPilotTheme(target: PilotTheme, source: PilotTheme): void {
  Object.assign(target.editor, source.editor);
  Object.assign(target.markdown, source.markdown);
  Object.assign(target.select, source.select);
  const mutable = target as unknown as Record<string, unknown>;
  for (const key of ["accent", "muted", "success", "warning", "danger", "info", "strong"]) {
    mutable[key] = (source as unknown as Record<string, unknown>)[key];
  }
}
