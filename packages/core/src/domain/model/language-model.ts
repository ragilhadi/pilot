import type { RunId } from "../../shared/brand.js";
import type { ModelCapabilities } from "./model-descriptor.js";
import type { ModelRequest } from "./model-request.js";
import type { ModelStreamEvent } from "./model-stream-event.js";
import type { RequestPayloadDescription } from "./request-payload.js";

export interface ModelCallContext {
  readonly runId: RunId;
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
  readonly deadline?: string;
}

export interface LanguageModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;

  stream(request: ModelRequest, context: ModelCallContext): AsyncIterable<ModelStreamEvent>;

  /**
   * Describe what this request will occupy in the context window.
   *
   * Optional so adapters can adopt it incrementally. An adapter that implements it must derive the
   * description from the same serialization `stream` sends, so the two cannot disagree about what
   * crosses the wire.
   */
  describeRequestPayload?(request: ModelRequest): RequestPayloadDescription;
}
