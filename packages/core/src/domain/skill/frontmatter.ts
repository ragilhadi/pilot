import { SkillError } from "./skill-errors.js";

export type FrontmatterValue = string | number | boolean | readonly string[];

export interface FrontmatterDocument {
  /** Parsed frontmatter fields, in the order they appeared. */
  readonly fields: Readonly<Record<string, FrontmatterValue>>;
  /** Everything after the closing delimiter, with surrounding blank lines removed. */
  readonly body: string;
}

/**
 * Parses a Markdown document that opens with a `---` delimited metadata block.
 *
 * The block is a deliberately small, fully specified subset of YAML rather than YAML itself: a
 * flat mapping of scalars and string sequences. Skill files are frequently supplied by a
 * repository rather than by the user, so a full YAML parser would widen the untrusted surface
 * (anchors, aliases, merge keys, arbitrary tags) for metadata that never needs any of it.
 * Anything outside the subset is rejected by line number instead of being guessed at.
 *
 * Supported forms:
 *
 * ```text
 * ---
 * name: review-diff            # bare scalar, kept as a trimmed string
 * enabled: true                # `true`/`false` become booleans
 * maxFiles: 20                 # base-10 integers become numbers
 * description: "A: literal"    # quoted scalars are always strings
 * requiresTools: [grep, edit]  # inline sequence
 * keywords:                    # block sequence
 *   - review
 *   - diff
 * ---
 * ```
 */
export function parseFrontmatterDocument(text: string, location: string): FrontmatterDocument {
  const normalized = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replaceAll(
    "\r\n",
    "\n",
  );
  const lines = normalized.split("\n");
  if (lines[0]?.trimEnd() !== "---") {
    throw invalid(location, 1, "the document must start with a `---` frontmatter delimiter");
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (closing < 0) {
    throw invalid(location, lines.length, "the frontmatter block is never closed by `---`");
  }

  const fields: Record<string, FrontmatterValue> = {};
  let pendingSequence: { readonly key: string; readonly items: string[] } | undefined;
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    if (line.includes("\t")) throw invalid(location, lineNumber, "tabs are not allowed");
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;

    const sequenceItem = /^ +- (?<item>.*)$/u.exec(line);
    if (sequenceItem !== null) {
      if (pendingSequence === undefined) {
        throw invalid(location, lineNumber, "a `- ` list item has no preceding key");
      }
      pendingSequence.items.push(scalarString(location, lineNumber, sequenceItem[1] ?? ""));
      continue;
    }
    if (line.startsWith(" ")) {
      throw invalid(
        location,
        lineNumber,
        "indented values are only allowed as `- ` list items; nested mappings are unsupported",
      );
    }

    const entry = /^(?<key>[A-Za-z][A-Za-z0-9_-]*):(?<rest>.*)$/u.exec(line);
    if (entry === null) {
      throw invalid(location, lineNumber, "expected a `key: value` frontmatter entry");
    }
    const key = entry.groups?.key ?? "";
    const rest = (entry.groups?.rest ?? "").trim();
    if (key in fields) throw invalid(location, lineNumber, `duplicate frontmatter key \`${key}\``);
    if (rest.length === 0) {
      pendingSequence = { key, items: [] };
      fields[key] = pendingSequence.items;
      continue;
    }
    pendingSequence = undefined;
    fields[key] = rest.startsWith("[")
      ? inlineSequence(location, lineNumber, rest)
      : scalar(location, lineNumber, rest);
  }

  return Object.freeze({
    fields: Object.freeze(
      Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key,
          Array.isArray(value) ? Object.freeze([...value]) : value,
        ]),
      ),
    ),
    body: normalized
      .split("\n")
      .slice(closing + 1)
      .join("\n")
      .replace(/^\n+/u, "")
      .trimEnd(),
  });
}

function inlineSequence(location: string, line: number, raw: string): readonly string[] {
  if (!raw.endsWith("]")) throw invalid(location, line, "the inline list is not closed by `]`");
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return Object.freeze([]);
  return Object.freeze(
    splitInlineItems(location, line, inner).map((item) => scalarString(location, line, item)),
  );
}

/** Splits `a, "b, c", d` on the separating commas only, leaving quoted commas intact. */
function splitInlineItems(location: string, line: number, inner: string): readonly string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const character of inner) {
    if (quote !== undefined) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (quote !== undefined) throw invalid(location, line, "the inline list has an unclosed quote");
  items.push(current);
  const trimmed = items.map((item) => item.trim());
  if (trimmed.some((item) => item.length === 0)) {
    throw invalid(location, line, "the inline list has an empty item");
  }
  return trimmed;
}

function scalar(location: string, line: number, raw: string): FrontmatterValue {
  const quoted = quotedScalar(location, line, raw);
  if (quoted !== undefined) return quoted;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/u.test(raw)) {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      throw invalid(location, line, "the integer value is out of the safe range");
    }
    return parsed;
  }
  return raw;
}

/** Sequence items and list entries are always strings; a list of booleans has no use here. */
function scalarString(location: string, line: number, raw: string): string {
  const trimmed = raw.trim();
  const quoted = quotedScalar(location, line, trimmed);
  if (quoted !== undefined) return quoted;
  if (trimmed.length === 0) throw invalid(location, line, "a list item cannot be empty");
  return trimmed;
}

function quotedScalar(location: string, line: number, raw: string): string | undefined {
  const quote = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : undefined;
  if (quote === undefined) return undefined;
  if (raw.length < 2 || !raw.endsWith(quote)) {
    throw invalid(location, line, "the quoted value has no closing quote");
  }
  const inner = raw.slice(1, -1);
  if (inner.includes(quote)) {
    throw invalid(location, line, "quoted values cannot contain their own quote character");
  }
  return inner;
}

function invalid(location: string, line: number, detail: string): SkillError {
  return new SkillError(
    "PILOT_SKILL_DOCUMENT_INVALID",
    `${location} line ${line}: ${detail}`,
    Object.freeze({ location, line, detail }),
  );
}
