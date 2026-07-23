/**
 * Normalizes untrusted text before terminal rendering. Newlines remain useful
 * layout, while carriage-return rewrites, tabs, C0/C1 controls, CSI, and OSC
 * introducers cannot affect terminal state.
 */
export function sanitizeTerminalText(value: string): string {
  const normalized = value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").replace(/\t/gu, "    ");
  return [...normalized]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 9 ||
        (codePoint >= 11 && codePoint <= 31) ||
        (codePoint >= 127 && codePoint <= 159)
        ? "�"
        : character;
    })
    .join("");
}
