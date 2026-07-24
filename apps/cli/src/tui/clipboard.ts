import type { Terminal } from "@earendil-works/pi-tui";

const OSC = "\u001b]";
const BEL = "\u0007";

/**
 * Upper bound on the base64 payload we will emit in a single OSC 52 write.
 * Many terminals silently drop very large clipboard sequences, so above this
 * size we report failure and let the caller fall back to another strategy.
 */
export const MAX_OSC52_BASE64_LENGTH = 100_000;

/** Build an OSC 52 clipboard-write sequence, or undefined when too large. */
export function encodeOsc52(text: string): string | undefined {
  const base64 = Buffer.from(text, "utf8").toString("base64");
  if (base64.length > MAX_OSC52_BASE64_LENGTH) return undefined;
  return `${OSC}52;c;${base64}${BEL}`;
}

/**
 * Write `text` to the system clipboard using the OSC 52 escape sequence.
 * Returns false when the payload is too large to emit safely; terminals that
 * do not support OSC 52 will ignore the sequence, so success here only means it
 * was written, not that the terminal honored it.
 */
export function copyToClipboard(terminal: Pick<Terminal, "write">, text: string): boolean {
  const sequence = encodeOsc52(text);
  if (sequence === undefined) return false;
  terminal.write(sequence);
  return true;
}
