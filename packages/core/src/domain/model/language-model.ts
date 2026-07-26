import type { RunId } from "../../shared/brand.js";
import type { ModelCapabilities } from "./model-descriptor.js";
import type { ModelRequest } from "./model-request.js";
import type { ModelStreamEvent } from "./model-stream-event.js";

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
}
