import { JsonValueSchema, type JsonValue } from "../../shared/json.js";

export interface ToolArgumentsParse {
  /** The arguments to hand to the tool. Always a value; never a parse failure. */
  readonly input: JsonValue;
  /** True when the raw text was non-empty but could not be recovered into JSON. */
  readonly malformed: boolean;
  /** A bounded excerpt of the unparseable text, present only when `malformed`. */
  readonly raw?: string;
}

/** Enough of the raw text to identify the mistake without pulling a huge blob into the prompt. */
const maximumRawExcerpt = 400;

/**
 * Turns a model's raw tool-call `arguments` string into usable input.
 *
 * Smaller models routinely emit `""` for a zero-parameter tool, wrap the object in a Markdown code
 * fence, or double-encode it as a JSON string. Every one of those used to abort the entire run with
 * a non-retryable contract error and no model-visible feedback. Recovering the common shapes — and
 * degrading to an empty object rather than throwing for the rest — keeps the failure inside the
 * tool-result envelope, where the model can read the problem and retry.
 */
export function parseToolCallArguments(raw: string): ToolArgumentsParse {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === "null" || trimmed === "undefined") {
    return Object.freeze({ input: Object.freeze({}), malformed: false });
  }

  const direct = tryParseJson(trimmed);
  if (direct !== undefined) {
    // A double-encoded object arrives as a JSON string whose contents are themselves JSON. Only
    // unwrap when the contents really do parse, so a tool that legitimately takes a bare string
    // argument still receives its string.
    if (typeof direct === "string") {
      const inner = tryParseJson(direct.trim());
      if (inner !== undefined && typeof inner === "object" && inner !== null) {
        return Object.freeze({ input: inner, malformed: false });
      }
    }
    return Object.freeze({ input: direct, malformed: false });
  }

  const unfenced = stripCodeFence(trimmed);
  if (unfenced !== undefined) {
    const parsed = tryParseJson(unfenced);
    if (parsed !== undefined) return Object.freeze({ input: parsed, malformed: false });
  }

  return Object.freeze({
    input: Object.freeze({}),
    malformed: true,
    raw: trimmed.slice(0, maximumRawExcerpt),
  });
}

function stripCodeFence(value: string): string | undefined {
  const match = /^```(?:[a-zA-Z0-9_-]*)?\r?\n([\s\S]*?)\r?\n?```$/u.exec(value);
  return match?.[1]?.trim();
}

function tryParseJson(value: string): JsonValue | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  const result = JsonValueSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}
