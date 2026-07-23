import {
  type JsonObject,
  type LanguageModel,
  type ModelDescriptor,
  type ModelKey,
  type ModelRequest,
  parseModelCapabilities,
  parseModelDescriptor,
  parseModelKey,
  parseModelRequest,
  PilotError,
} from "@pilotrun/core";

export type ModelCapabilityName =
  | "configurableReasoningEffort"
  | "maxOutputTokens"
  | "nativeToolCalling"
  | "parallelToolCalls"
  | "reasoning"
  | "streaming"
  | "structuredOutput"
  | "systemMessages"
  | "vision";

export interface ModelCapabilityIssue {
  readonly capability: ModelCapabilityName;
  readonly message: string;
  readonly required: boolean | number;
  readonly actual: boolean | number | undefined;
}

export type RegisteredModelDescriptor = ModelDescriptor;

export interface ModelRegistration {
  readonly model: LanguageModel;
  readonly displayName: string;
  readonly metadata?: JsonObject;
}

export interface ResolvedModel {
  readonly model: LanguageModel;
  readonly descriptor: RegisteredModelDescriptor;
}

export class ModelNotFoundError extends PilotError {
  readonly modelKey: ModelKey;

  constructor(modelKey: ModelKey) {
    super({
      code: "PILOT_MODEL_NOT_FOUND",
      message: `Model ${modelKey} is not registered`,
      metadata: { modelKey },
    });
    this.modelKey = modelKey;
  }
}

export class ModelRegistrationConflictError extends PilotError {
  readonly modelKey: ModelKey;

  constructor(modelKey: ModelKey) {
    super({
      code: "PILOT_MODEL_REGISTRATION_CONFLICT",
      message: `Model ${modelKey} is already registered`,
      metadata: { modelKey },
    });
    this.modelKey = modelKey;
  }
}

export class ModelCapabilityError extends PilotError {
  readonly modelKey: ModelKey;
  readonly issues: readonly ModelCapabilityIssue[];

  constructor(modelKey: ModelKey, issues: readonly ModelCapabilityIssue[]) {
    const snapshot = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
    super({
      code: "PILOT_MODEL_CAPABILITY_UNAVAILABLE",
      message: `Model ${modelKey} does not satisfy ${snapshot.length} requested capability requirement(s)`,
      safeMessage: "The selected model does not support the requested operation",
      metadata: { modelKey, issues: snapshot },
    });
    this.modelKey = modelKey;
    this.issues = snapshot;
  }
}

/** Returns every incompatibility so a caller can explain the request in one pass. */
export function inspectModelCapabilities(
  capabilitiesInput: LanguageModel["capabilities"],
  requestInput: ModelRequest,
): readonly ModelCapabilityIssue[] {
  const capabilities = parseModelCapabilities(capabilitiesInput);
  const request = parseModelRequest(requestInput);
  const issues: ModelCapabilityIssue[] = [];

  requireBoolean(issues, "streaming", capabilities.streaming, "Streaming is required");

  if (request.tools.length > 0) {
    requireBoolean(
      issues,
      "nativeToolCalling",
      capabilities.nativeToolCalling,
      "The request includes tools",
    );
  }

  if (request.allowParallelToolCalls === true) {
    requireBoolean(
      issues,
      "parallelToolCalls",
      capabilities.parallelToolCalls,
      "The request allows parallel tool calls",
    );
  }

  if (request.responseFormat?.type === "json-schema") {
    requireBoolean(
      issues,
      "structuredOutput",
      capabilities.structuredOutput,
      "The request requires JSON Schema output",
    );
  }

  if (request.messages.some((message) => message.parts.some((part) => part.type === "image"))) {
    requireBoolean(issues, "vision", capabilities.vision, "The request contains an image");
  }

  if (request.messages.some((message) => message.role === "system")) {
    requireBoolean(
      issues,
      "systemMessages",
      capabilities.systemMessages,
      "The request contains a system message",
    );
  }

  if (request.reasoningEffort !== undefined) {
    requireBoolean(issues, "reasoning", capabilities.reasoning, "Reasoning effort was requested");
    requireBoolean(
      issues,
      "configurableReasoningEffort",
      capabilities.configurableReasoningEffort,
      "A configurable reasoning effort was requested",
    );
  }

  if (
    request.maxOutputTokens !== undefined &&
    capabilities.maxOutputTokens !== undefined &&
    request.maxOutputTokens > capabilities.maxOutputTokens
  ) {
    issues.push(
      Object.freeze({
        capability: "maxOutputTokens",
        message: "The requested output-token limit exceeds the model limit",
        required: request.maxOutputTokens,
        actual: capabilities.maxOutputTokens,
      }),
    );
  }

  return Object.freeze(issues);
}

export function assertModelSupportsRequest(
  modelKeyInput: unknown,
  capabilities: LanguageModel["capabilities"],
  request: ModelRequest,
): void {
  const { key } = parseModelKey(modelKeyInput);
  const issues = inspectModelCapabilities(capabilities, request);
  if (issues.length > 0) {
    throw new ModelCapabilityError(key, issues);
  }
}

/** An explicit, collision-safe registry. It never silently substitutes another model. */
export class ModelRegistry {
  readonly #models = new Map<ModelKey, ResolvedModel>();

  constructor(registrations: readonly ModelRegistration[] = []) {
    for (const registration of registrations) {
      this.register(registration);
    }
  }

  register(registration: ModelRegistration): RegisteredModelDescriptor {
    const { key } = parseModelKey(`${registration.model.providerId}/${registration.model.modelId}`);
    if (this.#models.has(key)) {
      throw new ModelRegistrationConflictError(key);
    }

    const descriptor = parseModelDescriptor({
      key,
      displayName: registration.displayName,
      capabilities: registration.model.capabilities,
      ...(registration.metadata === undefined ? {} : { metadata: registration.metadata }),
    });
    const resolved = Object.freeze({ model: registration.model, descriptor });
    this.#models.set(key, resolved);
    return descriptor;
  }

  has(modelKeyInput: unknown): boolean {
    const { key } = parseModelKey(modelKeyInput);
    return this.#models.has(key);
  }

  resolve(modelKeyInput: unknown, request?: ModelRequest): ResolvedModel {
    const { key } = parseModelKey(modelKeyInput);
    const registered = this.#models.get(key);
    if (registered === undefined) {
      throw new ModelNotFoundError(key);
    }

    if (request !== undefined) {
      assertModelSupportsRequest(key, registered.descriptor.capabilities, request);
    }

    return registered;
  }

  list(): readonly RegisteredModelDescriptor[] {
    return Object.freeze(
      [...this.#models.values()]
        .map(({ descriptor }) => descriptor)
        .sort((left, right) => left.key.localeCompare(right.key)),
    );
  }
}

function requireBoolean(
  issues: ModelCapabilityIssue[],
  capability: Exclude<ModelCapabilityName, "maxOutputTokens">,
  actual: boolean,
  message: string,
): void {
  if (!actual) {
    issues.push(Object.freeze({ capability, message, required: true, actual }));
  }
}
