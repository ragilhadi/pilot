import {
  JsonValueSchema,
  PilotError,
  type JsonObject,
  type JsonValue,
  type ToolCallId,
} from "@pilotrun/core";

export interface ToolResultContextPolicy {
  /** Maximum UTF-8 bytes of JSON passed to the model for one tool result. */
  readonly maximumBytes: number;
  /** Fraction of retained serialized space reserved for the beginning. */
  readonly headShare?: number;
}

export interface ToolResultContextInput {
  readonly callId: ToolCallId;
  readonly toolName: string;
  readonly output: JsonValue;
}

export interface ToolResultHeadTailTruncation {
  readonly schemaVersion: 1;
  readonly strategy: "head-tail";
  readonly untrusted: true;
  readonly contentType: "json" | "text";
  readonly maximumBytes: number;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly omittedBytes: number;
  readonly omittedCharacters: number;
  readonly retrieval: {
    readonly action: "request-narrower-result";
    readonly toolName: string;
    readonly callId: ToolCallId;
    readonly message: string;
  };
}

/**
 * Emitted when an over-budget error envelope was reduced rather than cut. Deliberately compact:
 * on a small context budget the note itself competes with the error it describes, and the error's
 * own `recovery` field already tells the model what to do next.
 */
export interface ToolResultPreservedErrorTruncation {
  readonly schemaVersion: 1;
  readonly strategy: "preserve-error";
  readonly untrusted: true;
  readonly originalBytes: number;
  readonly omittedBytes: number;
  readonly omittedDetail: "metadata" | "metadata-and-message";
}

/**
 * Emitted when a structured result was reduced by shortening its bulkiest text field. The object's
 * shape and every other field survive, so the model still sees the paging hints, hashes, and
 * counters it needs to ask for the rest.
 */
export interface ToolResultFieldContentTruncation {
  readonly schemaVersion: 1;
  readonly strategy: "field-content";
  readonly untrusted: true;
  readonly field: string;
  readonly maximumBytes: number;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly omittedBytes: number;
}

export type ToolResultTruncationMetadata =
  | ToolResultHeadTailTruncation
  | ToolResultPreservedErrorTruncation
  | ToolResultFieldContentTruncation;

export interface FormattedToolResultContext {
  readonly output: JsonValue;
  readonly truncated: boolean;
  readonly serializedBytes: number;
  readonly truncation?: ToolResultTruncationMetadata;
}

export interface ToolResultContextFormatterPort {
  format(input: ToolResultContextInput): FormattedToolResultContext;
}

export class ToolResultContextError extends PilotError {
  constructor(message: string, metadata: Readonly<Record<string, unknown>> = {}) {
    super({
      code: "PILOT_CONTEXT_TRUNCATION",
      message,
      safeMessage: "A tool result could not be represented within the model-context limit",
      metadata,
    });
  }
}

/** Keeps full tool execution data outside the prompt while producing a bounded model-facing view. */
export class ToolResultContextFormatter implements ToolResultContextFormatterPort {
  readonly #maximumBytes: number;
  readonly #headShare: number;

  constructor(policy: ToolResultContextPolicy) {
    if (!Number.isSafeInteger(policy.maximumBytes) || policy.maximumBytes < 512) {
      throw new ToolResultContextError("Tool-result context maximumBytes must be at least 512");
    }
    const headShare = policy.headShare ?? 0.65;
    if (!Number.isFinite(headShare) || headShare < 0.5 || headShare > 0.9) {
      throw new ToolResultContextError("Tool-result context headShare must be between 0.5 and 0.9");
    }
    this.#maximumBytes = policy.maximumBytes;
    this.#headShare = headShare;
  }

  format(input: ToolResultContextInput): FormattedToolResultContext {
    validateToolName(input.toolName);
    const output = JsonValueSchema.parse(input.output);
    const originalSerialized = JSON.stringify(output);
    const originalMessageBytes = utf8Bytes(originalSerialized);
    if (originalMessageBytes <= this.#maximumBytes) {
      return Object.freeze({
        output,
        truncated: false,
        serializedBytes: originalMessageBytes,
      });
    }

    // A tool error is the one result the model must be able to read in full: its code and recovery
    // hint are what tell it whether and how to retry. Head/tail truncation slices the code in half
    // ("PILOT_TOOL_INPU"), turning a recoverable failure into an unreadable one, so shed the
    // optional detail instead and keep the recovery-critical fields intact.
    const preserved = boundErrorEnvelope(output, this.#maximumBytes);
    if (preserved !== undefined) return preserved;

    // A structured result carries its own paging hints (nextStartLine, truncated, counters) next to
    // its bulk text. Re-serializing the whole object into head/tail string fragments destroys those
    // hints and double-escapes the payload; shortening the one oversized field keeps them intact.
    const reduced = boundLargestStringField(output, this.#maximumBytes, this.#headShare);
    if (reduced !== undefined) return reduced;

    const contentType = typeof output === "string" ? "text" : "json";
    const content = typeof output === "string" ? output : canonicalJson(output);
    const characters = [...content];
    const originalBytes = utf8Bytes(content);
    const makeEnvelope = (head: string, tail: string): JsonObject => {
      const retainedBytes = utf8Bytes(head) + utf8Bytes(tail);
      const retainedCharacters = [...head].length + [...tail].length;
      const truncation = truncationMetadata(input, {
        contentType,
        maximumBytes: this.#maximumBytes,
        originalBytes,
        retainedBytes,
        omittedBytes: originalBytes - retainedBytes,
        omittedCharacters: characters.length - retainedCharacters,
      });
      return Object.freeze({
        pilotTruncation: truncation as unknown as JsonValue,
        head,
        tail,
      });
    };

    const emptyEnvelope = makeEnvelope("", "");
    const emptyBytes = serializedBytes(emptyEnvelope);
    if (emptyBytes > this.#maximumBytes) {
      throw new ToolResultContextError(
        `Tool-result truncation metadata requires ${emptyBytes} bytes`,
        { maximumBytes: this.#maximumBytes, requiredBytes: emptyBytes },
      );
    }

    const availableBytes = this.#maximumBytes - emptyBytes;
    const tailEnvelopeLimit = emptyBytes + Math.floor(availableBytes * (1 - this.#headShare));
    const maximumTailCharacters = Math.max(0, characters.length - 1);
    const tailCount = maximumFittingCount(maximumTailCharacters, (count) => {
      const tail = count === 0 ? "" : characters.slice(-count).join("");
      return serializedBytes(makeEnvelope("", tail)) <= tailEnvelopeLimit;
    });
    const tail = tailCount === 0 ? "" : characters.slice(-tailCount).join("");
    const maximumHeadCharacters = Math.max(0, characters.length - tailCount - 1);
    const headCount = maximumFittingCount(maximumHeadCharacters, (count) => {
      const head = characters.slice(0, count).join("");
      return serializedBytes(makeEnvelope(head, tail)) <= this.#maximumBytes;
    });
    const head = characters.slice(0, headCount).join("");
    const boundedOutput = makeEnvelope(head, tail);
    const boundedBytes = serializedBytes(boundedOutput);
    if (boundedBytes > this.#maximumBytes || headCount + tailCount >= characters.length) {
      throw new ToolResultContextError("Tool-result truncation failed to produce a bounded view", {
        maximumBytes: this.#maximumBytes,
        observedBytes: boundedBytes,
      });
    }
    const truncation = readTruncationMetadata(boundedOutput.pilotTruncation);
    return Object.freeze({
      output: boundedOutput,
      truncated: true,
      serializedBytes: boundedBytes,
      truncation,
    });
  }
}

/**
 * Rebuilds an over-budget error envelope by dropping its optional detail — metadata first, then the
 * message text — while keeping `error.code`, `error.retryable`, and `recovery` verbatim. Returns
 * undefined when the output is not an error envelope, or when even the minimal form does not fit,
 * in which case the caller falls back to generic truncation.
 */
function boundErrorEnvelope(
  output: JsonValue,
  maximumBytes: number,
): FormattedToolResultContext | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
  const envelope = output as JsonObject;
  const error = envelope.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
  const errorObject = error as JsonObject;
  if (typeof errorObject.code !== "string") return undefined;

  const originalBytes = utf8Bytes(canonicalJson(output));
  const fullMessage = typeof errorObject.message === "string" ? errorObject.message : "";
  const { metadata: _metadata, message: _message, ...requiredError } = errorObject;

  const assemble = (
    message: string,
    omittedDetail: ToolResultPreservedErrorTruncation["omittedDetail"],
  ): JsonObject => {
    const reduced: JsonObject = Object.freeze({
      ...envelope,
      error: Object.freeze({ ...requiredError, message }),
    });
    const retainedBytes = utf8Bytes(canonicalJson(reduced));
    return Object.freeze({
      ...reduced,
      pilotTruncation: Object.freeze({
        schemaVersion: 1,
        strategy: "preserve-error",
        untrusted: true,
        originalBytes,
        omittedBytes: Math.max(0, originalBytes - retainedBytes),
        omittedDetail,
      }) as unknown as JsonValue,
    });
  };

  // Shed the optional detail in order of expendability: structured metadata first, then the prose
  // message. The code, retryable flag, and recovery hint are never dropped.
  const withoutMetadata = assemble(fullMessage, "metadata");
  const withoutMetadataBytes = serializedBytes(withoutMetadata);
  if (withoutMetadataBytes <= maximumBytes) {
    return Object.freeze({
      output: withoutMetadata,
      truncated: true,
      serializedBytes: withoutMetadataBytes,
      truncation: readTruncationMetadata(withoutMetadata.pilotTruncation),
    });
  }

  const characters = [...fullMessage];
  const fitting = maximumFittingCount(
    characters.length,
    (count) =>
      serializedBytes(assemble(characters.slice(0, count).join(""), "metadata-and-message")) <=
      maximumBytes,
  );
  const shortened = assemble(characters.slice(0, fitting).join(""), "metadata-and-message");
  const shortenedBytes = serializedBytes(shortened);
  if (shortenedBytes > maximumBytes) return undefined;
  return Object.freeze({
    output: shortened,
    truncated: true,
    serializedBytes: shortenedBytes,
    truncation: readTruncationMetadata(shortened.pilotTruncation),
  });
}

/**
 * Shortens the single largest top-level string field of a structured result until the whole object
 * fits, keeping every other field verbatim. Returns undefined when the output is not an object, has
 * no string field worth shortening, or still does not fit once that field is emptied — in which
 * case the caller falls back to head/tail truncation of the whole payload.
 */
function boundLargestStringField(
  output: JsonValue,
  maximumBytes: number,
  headShare: number,
): FormattedToolResultContext | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
  const record = output as JsonObject;

  let field: string | undefined;
  let fieldValue = "";
  let largest = 0;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") continue;
    const size = utf8Bytes(value);
    if (size > largest) {
      largest = size;
      field = key;
      fieldValue = value;
    }
  }
  if (field === undefined || largest === 0) return undefined;
  const targetField = field;

  const originalBytes = largest;
  const characters = [...fieldValue];
  const assemble = (replacement: string): JsonObject =>
    Object.freeze({
      ...record,
      [targetField]: replacement,
      pilotTruncation: Object.freeze({
        schemaVersion: 1,
        strategy: "field-content",
        untrusted: true,
        field: targetField,
        maximumBytes,
        originalBytes,
        retainedBytes: utf8Bytes(replacement),
        omittedBytes: Math.max(0, originalBytes - utf8Bytes(replacement)),
      }) as unknown as JsonValue,
    });

  const marker = (omitted: number): string =>
    `\n…[${omitted} bytes omitted — request a narrower range, path, or limit]…\n`;

  // If the object does not fit even with the field emptied, the bulk is elsewhere; let the generic
  // path handle it rather than producing a result that is all envelope and no content.
  const emptyBytes = serializedBytes(assemble(marker(originalBytes)));
  if (emptyBytes > maximumBytes) return undefined;

  const build = (headCount: number, tailCount: number): string => {
    const head = characters.slice(0, headCount).join("");
    const tail = tailCount === 0 ? "" : characters.slice(-tailCount).join("");
    const omitted = Math.max(0, originalBytes - utf8Bytes(head) - utf8Bytes(tail));
    return `${head}${marker(omitted)}${tail}`;
  };

  // Cap the tail search at its share of the budget, or it consumes everything and leaves the head
  // — the part the model usually needs first — empty.
  const tailCeiling = emptyBytes + Math.floor((maximumBytes - emptyBytes) * (1 - headShare));
  const tailCount = maximumFittingCount(
    Math.max(0, characters.length - 1),
    (count) => serializedBytes(assemble(build(0, count))) <= tailCeiling,
  );
  const headCount = maximumFittingCount(
    Math.max(0, characters.length - tailCount - 1),
    (count) => serializedBytes(assemble(build(count, tailCount))) <= maximumBytes,
  );
  if (headCount + tailCount >= characters.length) return undefined;

  const bounded = assemble(build(headCount, tailCount));
  const bytes = serializedBytes(bounded);
  if (bytes > maximumBytes) return undefined;
  return Object.freeze({
    output: bounded,
    truncated: true,
    serializedBytes: bytes,
    truncation: readTruncationMetadata(bounded.pilotTruncation),
  });
}

interface TruncationMeasurements {
  readonly contentType: "json" | "text";
  readonly maximumBytes: number;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly omittedBytes: number;
  readonly omittedCharacters: number;
}

function truncationMetadata(
  input: ToolResultContextInput,
  measurements: TruncationMeasurements,
): ToolResultTruncationMetadata {
  return Object.freeze({
    schemaVersion: 1,
    strategy: "head-tail",
    untrusted: true,
    ...measurements,
    retrieval: Object.freeze({
      action: "request-narrower-result",
      toolName: input.toolName,
      callId: input.callId,
      message:
        "Request a narrower range, path, query, or result limit. Do not replay a mutating tool call solely to recover omitted output.",
    }),
  });
}

function readTruncationMetadata(value: JsonValue | undefined): ToolResultTruncationMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolResultContextError("Tool-result truncation metadata was malformed");
  }
  const object = value as JsonObject;
  if (
    object.schemaVersion !== 1 ||
    (object.strategy !== "head-tail" &&
      object.strategy !== "preserve-error" &&
      object.strategy !== "field-content")
  ) {
    throw new ToolResultContextError("Tool-result truncation metadata was malformed");
  }
  return object as unknown as ToolResultTruncationMetadata;
}

function maximumFittingCount(maximum: number, fits: (count: number) => boolean): number {
  let low = 0;
  let high = maximum;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function serializedBytes(value: JsonValue): number {
  return utf8Bytes(JSON.stringify(value));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateToolName(value: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(value)) {
    throw new ToolResultContextError("Tool-result context received an invalid tool name");
  }
}
