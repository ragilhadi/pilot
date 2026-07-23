import {
  CancellationError,
  type JsonValue,
  type LanguageModel,
  ModelCapabilitiesSchema,
  ModelContractValidationError,
  ModelError,
  type ModelCallContext,
  type ModelCapabilities,
  type ModelRequest,
  type ModelStreamEvent,
  parseModelKey,
  parseModelRequest,
  parseModelStreamEvent,
  type TokenUsage,
} from "@pilot/core";

export type FakeModelStep =
  | { readonly kind: "delay"; readonly milliseconds: number }
  | { readonly kind: "event"; readonly event: ModelStreamEvent }
  | { readonly kind: "throw"; readonly error: Error }
  | { readonly kind: "unsafe-raw-event"; readonly value: unknown };

export interface FakeModelScript {
  readonly steps: readonly FakeModelStep[];
}

export interface FakeLanguageModelOptions {
  readonly scripts: readonly FakeModelScript[];
  readonly providerId?: string;
  readonly modelId?: string;
  readonly capabilities?: ModelCapabilities;
}

export interface RecordedModelCall {
  readonly request: ModelRequest;
  readonly context: {
    readonly runId: ModelCallContext["runId"];
    readonly attempt: number;
    readonly idempotencyKey: string;
    readonly deadline?: string;
  };
}

const defaultCapabilities = ModelCapabilitiesSchema.parse({
  streaming: true,
  nativeToolCalling: true,
  parallelToolCalls: false,
  structuredOutput: false,
  vision: false,
  promptCaching: false,
  reasoning: false,
  configurableReasoningEffort: false,
  systemMessages: true,
});

export class FakeLanguageModel implements LanguageModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;

  readonly #scripts: FakeModelScript[];
  readonly #calls: RecordedModelCall[] = [];

  constructor(options: FakeLanguageModelOptions) {
    this.providerId = options.providerId ?? "fake";
    this.modelId = options.modelId ?? "scripted";
    parseModelKey(`${this.providerId}/${this.modelId}`);
    this.capabilities = ModelCapabilitiesSchema.parse(options.capabilities ?? defaultCapabilities);
    this.#scripts = options.scripts.map((script) =>
      Object.freeze({ steps: Object.freeze(script.steps.map(snapshotStep)) }),
    );
    this.#validateScripts();
  }

  get calls(): readonly RecordedModelCall[] {
    return Object.freeze([...this.#calls]);
  }

  get remainingScripts(): number {
    return this.#scripts.length;
  }

  stream(request: ModelRequest, context: ModelCallContext): AsyncIterable<ModelStreamEvent> {
    const validatedRequest = parseModelRequest(request);
    const recordedContext = Object.freeze({
      runId: context.runId,
      attempt: context.attempt,
      idempotencyKey: context.idempotencyKey,
      ...(context.deadline === undefined ? {} : { deadline: context.deadline }),
    });
    this.#calls.push(Object.freeze({ request: validatedRequest, context: recordedContext }));

    const script = this.#scripts.shift();
    if (script === undefined) {
      const error = new ModelError({
        kind: "provider-error",
        providerId: this.providerId,
        modelId: this.modelId,
        message: "FakeLanguageModel has no remaining script",
        retryable: false,
      });
      return this.#run(Object.freeze({ steps: Object.freeze([throwStep(error)]) }), context.signal);
    }

    return this.#run(script, context.signal);
  }

  async *#run(script: FakeModelScript, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    for (const step of script.steps) {
      throwIfAborted(signal);

      switch (step.kind) {
        case "delay":
          await abortableDelay(step.milliseconds, signal);
          break;
        case "event":
          yield parseModelStreamEvent(step.event);
          break;
        case "throw":
          throw step.error;
        case "unsafe-raw-event":
          // This test-only escape hatch verifies that production consumers reject malformed adapters.
          yield step.value as ModelStreamEvent;
          break;
      }
    }
  }

  #validateScripts(): void {
    for (const script of this.#scripts) {
      for (const step of script.steps) {
        if (
          step.kind === "delay" &&
          (!Number.isFinite(step.milliseconds) || step.milliseconds < 0)
        ) {
          throw new ModelContractValidationError(
            "fake model script",
            1,
            new RangeError("Delay must be a non-negative finite number"),
          );
        }
      }
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CancellationError(signal.reason);
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancellationError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface TextResponseScriptOptions {
  readonly responseId: string;
  readonly deltas: readonly string[];
  readonly usage?: TokenUsage;
}

export function textResponseScript(options: TextResponseScriptOptions): FakeModelScript {
  let sequence = 0;
  const steps: FakeModelStep[] = [
    eventStep({ type: "response.started", sequence: sequence++, responseId: options.responseId }),
    ...options.deltas.map((delta) =>
      eventStep({
        type: "text.delta",
        sequence: sequence++,
        responseId: options.responseId,
        contentIndex: 0,
        delta,
      }),
    ),
  ];

  if (options.usage !== undefined) {
    steps.push(
      eventStep({
        type: "usage.updated",
        sequence: sequence++,
        responseId: options.responseId,
        usage: options.usage,
      }),
    );
  }

  steps.push(
    eventStep({
      type: "response.completed",
      sequence,
      responseId: options.responseId,
      finishReason: "stop",
    }),
  );

  return Object.freeze({ steps: Object.freeze(steps) });
}

export interface ToolCallScriptOptions {
  readonly responseId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly argumentDeltas: readonly string[];
  readonly completedInput?: JsonValue;
}

export function toolCallScript(options: ToolCallScriptOptions): FakeModelScript {
  let sequence = 0;
  const steps: FakeModelStep[] = [
    eventStep({ type: "response.started", sequence: sequence++, responseId: options.responseId }),
    eventStep({
      type: "tool-call.started",
      sequence: sequence++,
      responseId: options.responseId,
      contentIndex: 0,
      callId: options.callId,
      toolName: options.toolName,
    }),
    ...options.argumentDeltas.map((delta) =>
      eventStep({
        type: "tool-call.arguments.delta",
        sequence: sequence++,
        responseId: options.responseId,
        callId: options.callId,
        delta,
      }),
    ),
  ];

  if (options.completedInput !== undefined) {
    steps.push(
      eventStep({
        type: "tool-call.completed",
        sequence: sequence++,
        responseId: options.responseId,
        callId: options.callId,
        input: options.completedInput,
      }),
    );
  }

  steps.push(
    eventStep({
      type: "response.completed",
      sequence,
      responseId: options.responseId,
      finishReason: "tool-calls",
    }),
  );

  return Object.freeze({ steps: Object.freeze(steps) });
}

export function eventStep(event: unknown): FakeModelStep {
  return Object.freeze({ kind: "event", event: parseModelStreamEvent(event) });
}

export function delayStep(milliseconds: number): FakeModelStep {
  return Object.freeze({ kind: "delay", milliseconds });
}

export function throwStep(error: Error): FakeModelStep {
  return Object.freeze({ kind: "throw", error });
}

export function unsafeRawEventStep(value: unknown): FakeModelStep {
  return Object.freeze({ kind: "unsafe-raw-event", value });
}

function snapshotStep(step: FakeModelStep): FakeModelStep {
  switch (step.kind) {
    case "delay":
      return delayStep(step.milliseconds);
    case "event":
      return eventStep(step.event);
    case "throw":
      return throwStep(step.error);
    case "unsafe-raw-event":
      return unsafeRawEventStep(step.value);
  }
}
