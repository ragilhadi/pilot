/** A fenced code block extracted from assistant markdown. */
export interface CodeBlock {
  /** Info-string language token (first word after the opening fence), if any. */
  readonly lang?: string;
  /** Raw code contents, without the surrounding fences. */
  readonly code: string;
}

const FENCE = /^(\s*)([`~]{3,})(.*)$/u;

/**
 * Extract fenced code blocks (``` or ~~~) from a markdown string. Closing
 * fences must use the same character and be at least as long as the opening
 * fence. An unterminated fence at end-of-input is still captured so streaming,
 * partially rendered replies remain copyable.
 */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let open: { readonly char: string; readonly length: number; readonly lang: string } | undefined;
  let body: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = FENCE.exec(line);
    if (open === undefined) {
      if (match !== null) {
        const fence = match[2] ?? "";
        open = { char: fence[0] ?? "`", length: fence.length, lang: (match[3] ?? "").trim() };
        body = [];
      }
      continue;
    }
    const fence = match?.[2] ?? "";
    const isClose =
      match !== null &&
      fence[0] === open.char &&
      fence.length >= open.length &&
      (match[3] ?? "").trim().length === 0;
    if (isClose) {
      blocks.push(finishBlock(open.lang, body));
      open = undefined;
      body = [];
    } else {
      body.push(line);
    }
  }
  if (open !== undefined && body.length > 0) blocks.push(finishBlock(open.lang, body));
  return blocks;
}

function finishBlock(info: string, body: readonly string[]): CodeBlock {
  const lang = info.split(/\s+/u)[0] ?? "";
  const code = body.join("\n");
  return lang.length > 0 ? { lang, code } : { code };
}
