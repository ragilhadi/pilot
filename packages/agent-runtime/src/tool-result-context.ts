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

export interface ToolResultTruncationMetadata {
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
  if (object.schemaVersion !== 1 || object.strategy !== "head-tail") {
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
