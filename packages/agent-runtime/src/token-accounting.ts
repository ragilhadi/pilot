import {
  type AgentMessage,
  agentMessageWireText,
  chatTemplateOverheads,
  describesRequestPayload,
  type ModelRequest,
  type RequestPayloadDescription,
  type RequestPayloadSegment,
  type RequestPayloadSegmentKind,
  type TokenCountConfidence,
  type TokenCounter,
} from "@pilotrun/core";
import type {
  ContextContent,
  ContextTokenEstimate,
  ContextTokenEstimator,
} from "./context-engine.js";
import { ContextEngineError } from "./context-engine.js";

/**
 * How much of the context window a request occupies, broken down by what is occupying it.
 *
 * This is a *level*, computed locally over the bytes the provider will send. It is deliberately not
 * the provider's reported prompt tokens: on a runner with a KV cache (Ollama) that figure counts
 * only the tokens actually evaluated, so it collapses as a conversation grows and cannot answer
 * "how full is the window".
 */
export interface ContextOccupancy {
  readonly totalTokens: number;
  readonly bySegment: Readonly<Record<RequestPayloadSegmentKind, number>>;
  /** Identifier of the counter that produced the figure, for diagnostics. */
  readonly method: string;
  readonly confidence: TokenCountConfidence;
}

const segmentKinds: readonly RequestPayloadSegmentKind[] = Object.freeze([
  "system",
  "tool-definitions",
  "message",
  "tool-result",
  "image",
  "response-format",
]);

/**
 * Counts tokens from the shape of the text rather than a single bytes-per-token divisor.
 *
 * A flat divisor cannot be right for the mix Pilot actually sends. Measured against BPE tokenizers
 * of the Llama/Qwen/GLM family, bytes per token runs about 4.2 on prose, 3.3 on source code, 2.8 on
 * diffs and minified JSON, and CJK text is better modelled per code point than per byte. Applying
 * one ratio to all of it under-counts code by 10-25% and structured text by more.
 */
export class ScriptAwareHeuristicCounter implements TokenCounter {
  readonly id = "script-heuristic";
  readonly confidence: TokenCountConfidence = "heuristic";

  /** Bytes per token for each class, and tokens per CJK code point. */
  static readonly proseBytesPerToken = 4.2;
  static readonly codeBytesPerToken = 3.3;
  static readonly structuredBytesPerToken = 2.8;
  static readonly cjkTokensPerCodePoint = 0.9;

  /** Above this length the class ratios are sampled rather than scanned, to bound the cost. */
  static readonly samplingThreshold = 65_536;
  static readonly sampleSize = 8_192;

  count(text: string): number {
    if (text.length === 0) return 0;
    const cjkCodePoints = countCjkCodePoints(text);
    // CJK code points are 3 UTF-8 bytes each; charging them per code point and removing their bytes
    // from the byte pool keeps the two models from double-counting the same characters.
    const totalBytes = utf8ByteLength(text);
    const remainingBytes = Math.max(0, totalBytes - cjkCodePoints * 3);
    const bytesPerToken = classifyBytesPerToken(text);
    return (
      Math.ceil(remainingBytes / bytesPerToken) +
      Math.ceil(cjkCodePoints * ScriptAwareHeuristicCounter.cjkTokensPerCodePoint)
    );
  }
}

/**
 * Adapts a {@link TokenCounter} to the context engine's estimator port.
 *
 * Keeps one counter behind every token figure in the process — admission, composition, budget
 * reservation, and the occupancy display — so they cannot disagree with each other.
 */
export class TokenCounterContextEstimator implements ContextTokenEstimator {
  readonly #counter: TokenCounter;
  readonly #framingTokens: number;

  constructor(counter: TokenCounter, options: { readonly framingTokens?: number } = {}) {
    this.#counter = counter;
    this.#framingTokens = options.framingTokens ?? chatTemplateOverheads.perMessage;
    if (!Number.isSafeInteger(this.#framingTokens) || this.#framingTokens < 0) {
      throw new ContextEngineError("PILOT_CONTEXT_INVALID", "framingTokens cannot be negative");
    }
  }

  estimate(content: ContextContent): ContextTokenEstimate {
    const text = typeof content === "string" ? content : agentMessageWireText(content);
    return Object.freeze({
      tokens: this.#counter.count(text) + this.#framingTokens,
      method: `${this.#counter.id}+${this.#framingTokens}`,
    });
  }
}

/**
 * Measures what a request will occupy, from a description of the payload the adapter will send.
 *
 * The accountant never inspects a `ModelRequest` directly when the model can describe its own
 * payload, because the request is the domain shape and the payload is the wire shape — and the gap
 * between them is exactly where the tool schemas went missing.
 */
export class RequestTokenAccountant {
  readonly #counter: TokenCounter;

  constructor(counter: TokenCounter) {
    this.#counter = counter;
  }

  measure(description: RequestPayloadDescription): ContextOccupancy {
    const bySegment: Record<RequestPayloadSegmentKind, number> = {
      system: 0,
      "tool-definitions": 0,
      message: 0,
      "tool-result": 0,
      image: 0,
      "response-format": 0,
    };
    for (const segment of description.segments) {
      bySegment[segment.kind] += this.#counter.count(segment.text) + segment.overheadTokens;
    }
    const total =
      segmentKinds.reduce((sum, kind) => sum + bySegment[kind], 0) +
      description.generationPromptTokens;
    return Object.freeze({
      totalTokens: total,
      bySegment: Object.freeze(bySegment),
      method: this.#counter.id,
      confidence: this.#counter.confidence,
    });
  }

  /**
   * Measure a request, preferring the model's own payload description and falling back to a
   * provider-neutral one. Always accounts for tool definitions, whichever path is taken.
   */
  measureRequest(request: ModelRequest, model?: unknown): ContextOccupancy {
    const description = describesRequestPayload(model)
      ? model.describeRequestPayload(request)
      : describeGenericRequestPayload(request);
    return this.measure(description);
  }
}

/**
 * A provider-neutral payload description, for models that cannot describe their own.
 *
 * Shaped after the OpenAI chat-completions body because that is what every adapter in this
 * repository speaks; it is an approximation by design, and a model that implements
 * `describeRequestPayload` should always be preferred.
 */
export function describeGenericRequestPayload(request: ModelRequest): RequestPayloadDescription {
  const segments: RequestPayloadSegment[] = [];
  if (request.tools.length > 0) {
    // Mirrors the wire shape: `{type, function:{name, description, parameters}}` per tool. The
    // domain definition also carries `outputSchema`, which is never sent, so serializing the domain
    // object directly would charge for bytes the model never sees.
    segments.push({
      kind: "tool-definitions",
      text: JSON.stringify(
        request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      ),
      overheadTokens: chatTemplateOverheads.perToolCall,
    });
  }
  for (const message of request.messages) {
    segments.push(...describeMessage(message));
  }
  if (request.responseFormat?.type === "json-schema") {
    segments.push({
      kind: "response-format",
      text: JSON.stringify(request.responseFormat.schema),
      overheadTokens: 0,
    });
  }
  return Object.freeze({
    segments: Object.freeze(segments),
    generationPromptTokens: chatTemplateOverheads.generationPrompt,
  });
}

/**
 * Split one message into the segments it contributes.
 *
 * Tool results and images get their own segments so the breakdown can attribute a bloated window to
 * the tool output that caused it, which is the question a user actually asks when the context fills.
 */
function describeMessage(message: AgentMessage): readonly RequestPayloadSegment[] {
  const segments: RequestPayloadSegment[] = [];
  const kind: RequestPayloadSegmentKind = message.role === "system" ? "system" : "message";
  const inlineParts: string[] = [message.role];
  let toolCallCount = 0;
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        inlineParts.push(part.text);
        break;
      case "redacted":
        inlineParts.push("[redacted]");
        break;
      case "tool-call":
        toolCallCount += 1;
        inlineParts.push(part.toolName, JSON.stringify(part.input));
        break;
      case "tool-result":
        segments.push({
          kind: "tool-result",
          text: typeof part.output === "string" ? part.output : JSON.stringify(part.output),
          // The `role: "tool"` wrapper plus the `tool_call_id` field.
          overheadTokens: chatTemplateOverheads.perMessage + chatTemplateOverheads.perToolCall,
        });
        break;
      case "image":
        segments.push({ kind: "image", text: "", overheadTokens: chatTemplateOverheads.perImage });
        break;
    }
  }
  if (inlineParts.length > 1 || segments.length === 0) {
    segments.unshift({
      kind,
      text: inlineParts.join("\n"),
      overheadTokens:
        chatTemplateOverheads.perMessage + toolCallCount * chatTemplateOverheads.perToolCall,
    });
  }
  return segments;
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * CJK punctuation and symbols, kana, Hangul, and the unified ideograph blocks — the ranges where a
 * code point is worth roughly one token rather than roughly a quarter of one.
 */
const cjkPattern = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/gu;

function countCjkCodePoints(text: string): number {
  // Skipping the scan on pure-ASCII text keeps the common case free: ASCII cannot contain any of
  // the ranges above, so the answer is known without looking.
  if (!hasNonAscii(text)) return 0;
  let count = 0;
  cjkPattern.lastIndex = 0;
  while (cjkPattern.exec(text) !== null) count += 1;
  return count;
}

function hasNonAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 127) return true;
  }
  return false;
}

/**
 * Pick a bytes-per-token ratio from how the text is built: punctuation density separates structured
 * payloads (JSON, diffs, base64) from language, and indentation separates source code from prose.
 */
function classifyBytesPerToken(text: string): number {
  const sample = sampleText(text);
  let punctuation = 0;
  let alphanumeric = 0;
  let whitespace = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    const isSpace = code === 32 || code === 9 || code === 10 || code === 13;
    if (isSpace) {
      whitespace += 1;
      continue;
    }
    const isAlphanumeric =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code > 127;
    if (isAlphanumeric) alphanumeric += 1;
    else punctuation += 1;
  }
  const visible = punctuation + alphanumeric;
  if (visible === 0) return ScriptAwareHeuristicCounter.proseBytesPerToken;
  const punctuationDensity = punctuation / visible;
  if (punctuationDensity > 0.25) return ScriptAwareHeuristicCounter.structuredBytesPerToken;
  // Indentation is the cheapest reliable signal that text is code rather than prose, and it
  // survives sampling because it is a per-line property.
  const indentedLineRatio = countIndentedLines(sample);
  if (punctuationDensity > 0.12 || indentedLineRatio > 0.15) {
    return ScriptAwareHeuristicCounter.codeBytesPerToken;
  }
  if (whitespace > 0 && punctuation / Math.max(1, whitespace) > 1.5) {
    return ScriptAwareHeuristicCounter.codeBytesPerToken;
  }
  return ScriptAwareHeuristicCounter.proseBytesPerToken;
}

function countIndentedLines(sample: string): number {
  const lines = sample.split("\n");
  if (lines.length <= 1) return 0;
  let indented = 0;
  for (const line of lines) {
    if (line.startsWith("\t") || line.startsWith("  ")) indented += 1;
  }
  return indented / lines.length;
}

/**
 * For large texts, classify from three fixed windows instead of the whole string. The byte length is
 * still exact — only the ratio is sampled — so the error this introduces is bounded by how much the
 * text's character mix varies, which for a single file or tool result is small.
 */
function sampleText(text: string): string {
  if (text.length <= ScriptAwareHeuristicCounter.samplingThreshold) return text;
  const size = ScriptAwareHeuristicCounter.sampleSize;
  const middle = Math.floor(text.length / 2 - size / 2);
  return (
    text.slice(0, size) +
    text.slice(middle, middle + size) +
    text.slice(Math.max(0, text.length - size))
  );
}
