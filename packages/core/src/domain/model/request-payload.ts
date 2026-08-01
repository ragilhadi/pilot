import type { ModelRequest } from "./model-request.js";

/**
 * The parts of a request that occupy the context window, kept separate so the cost of each can be
 * reported on its own. `tool-definitions` exists because tool JSON schemas are re-sent on every
 * request and are large enough to dominate a small window.
 */
export type RequestPayloadSegmentKind =
  | "system"
  | "tool-definitions"
  | "message"
  | "tool-result"
  | "image"
  | "response-format";

export interface RequestPayloadSegment {
  readonly kind: RequestPayloadSegmentKind;
  /** The text a server-side chat template will tokenize for this segment. */
  readonly text: string;
  /**
   * Tokens the chat template adds around `text` — role delimiters, tool-call envelopes, and the
   * like. These never appear in `text` because the server adds them after Pilot's request is
   * parsed, so they have to be modelled rather than measured.
   */
  readonly overheadTokens: number;
}

/**
 * A description of everything a provider will send for one request, in template order.
 *
 * Produced by the same adapter that serializes the request, so the accounting and the wire format
 * cannot drift: a field that is added to the request body is a field that shows up here.
 */
export interface RequestPayloadDescription {
  readonly segments: readonly RequestPayloadSegment[];
  /** Tokens the template appends to open the assistant's turn. */
  readonly generationPromptTokens: number;
}

/**
 * Token costs a server-side chat template adds around the content Pilot serializes.
 *
 * These are modelled rather than measured: the template runs on the server, after the request body
 * has been parsed, so nothing Pilot can serialize contains them. The figures are typical of the
 * ChatML-style templates used by the Llama/Qwen/GLM family — `<|im_start|>role\n` … `<|im_end|>\n`
 * per message, and a short header to open the assistant turn.
 *
 * Shared here so the adapter that describes a payload and the runtime that measures it cannot
 * disagree about the framing.
 */
export const chatTemplateOverheads = Object.freeze({
  /** Role delimiters around one message. */
  perMessage: 4,
  /** Appended to open the assistant's turn. */
  generationPrompt: 3,
  /** The `id`/`type`/`function` envelope around one tool call, and the `tool_call_id` on a result. */
  perToolCall: 8,
  /**
   * What one image costs when the provider gives no way to know.
   *
   * An OpenAI-compatible endpoint reports neither the tiling nor the resolution it will use, and a
   * base64 length is not a usable proxy. A flat, deliberately conservative figure is far closer than
   * charging for the few tokens of a data-URI prefix.
   */
  perImage: 1_100,
});

/**
 * A model that can account for its own request payload.
 *
 * Optional on {@link LanguageModel} so adapters can adopt it incrementally; callers fall back to a
 * generic description when a model does not implement it.
 */
export interface RequestPayloadDescriber {
  describeRequestPayload(request: ModelRequest): RequestPayloadDescription;
}

export function describesRequestPayload(model: unknown): model is RequestPayloadDescriber {
  return (
    typeof model === "object" &&
    model !== null &&
    typeof (model as RequestPayloadDescriber).describeRequestPayload === "function"
  );
}
