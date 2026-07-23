import * as z from "zod";
import type { Brand, RunId } from "./brand.js";
import {
  AgentMessageSchema,
  JsonValueSchema,
  ToolCallIdSchema,
  type AgentMessage,
  type JsonObject,
} from "./messages.js";
import {
  ModelContractValidationError,
  ModelFailureSchema,
  type ModelFailure,
} from "./model-errors.js";

export type ModelKey = Brand<string, "ModelKey">;

const providerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/u, "Provider IDs must use lowercase kebab-case");

const modelIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => value.trim() === value && !/\s/u.test(value),
    "Model IDs cannot contain whitespace",
  );

export const ModelKeySchema: z.ZodType<ModelKey> = z
  .string()
  .superRefine((value, context) => {
    const separator = value.indexOf("/");
    if (separator <= 0 || separator === value.length - 1) {
      context.addIssue({
        code: "custom",
        message: "Model keys must use provider/model format",
      });
      return;
    }

    const providerResult = providerIdSchema.safeParse(value.slice(0, separator));
    const modelResult = modelIdSchema.safeParse(value.slice(separator + 1));
    if (!providerResult.success || !modelResult.success) {
      context.addIssue({
        code: "custom",
        message: "Model key contains an invalid provider or model identifier",
      });
    }
  })
  .transform((value) => value as ModelKey);

export interface ParsedModelKey {
  readonly key: ModelKey;
  readonly providerId: string;
  readonly modelId: string;
}

export function parseModelKey(input: unknown): ParsedModelKey {
  const result = ModelKeySchema.safeParse(input);
  if (!result.success) {
    throw new ModelContractValidationError("model key", result.error.issues.length, result.error);
  }

  const separator = result.data.indexOf("/");
  return Object.freeze({
    key: result.data,
    providerId: result.data.slice(0, separator),
    modelId: result.data.slice(separator + 1),
  });
}

export const ModelCapabilitiesSchema = z
  .object({
    streaming: z.boolean(),
    nativeToolCalling: z.boolean(),
    parallelToolCalls: z.boolean(),
    structuredOutput: z.boolean(),
    vision: z.boolean(),
    promptCaching: z.boolean(),
    reasoning: z.boolean(),
    configurableReasoningEffort: z.boolean(),
    systemMessages: z.boolean(),
    maxContextTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((capabilities, context) => {
    if (capabilities.parallelToolCalls && !capabilities.nativeToolCalling) {
      context.addIssue({
        code: "custom",
        path: ["parallelToolCalls"],
        message: "Parallel tool calls require native tool calling",
      });
    }
    if (capabilities.configurableReasoningEffort && !capabilities.reasoning) {
      context.addIssue({
        code: "custom",
        path: ["configurableReasoningEffort"],
        message: "Configurable reasoning effort requires reasoning support",
      });
    }
  })
  .readonly();

export type ModelCapabilities = z.output<typeof ModelCapabilitiesSchema>;

export const TokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    estimatedCostUsd: z.number().finite().nonnegative().optional(),
    source: z.enum(["estimated", "mixed", "provider"]),
  })
  .strict()
  .superRefine((usage, context) => {
    const hasMeasurement = Object.entries(usage).some(
      ([key, value]) => key !== "source" && value !== undefined,
    );
    if (!hasMeasurement) {
      context.addIssue({ code: "custom", message: "Usage must contain at least one measurement" });
    }
  })
  .readonly();

export type TokenUsage = z.output<typeof TokenUsageSchema>;

const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema).readonly();
const toolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u, "Tool names must use lowercase snake_case");

export const ModelToolDefinitionSchema = z
  .object({
    name: toolNameSchema,
    description: z.string().min(1).max(2_000),
    inputSchema: JsonObjectSchema,
    outputSchema: JsonObjectSchema.optional(),
  })
  .strict()
  .readonly();

export type ModelToolDefinition = z.output<typeof ModelToolDefinitionSchema>;

const ResponseFormatSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("text") })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("json-schema"),
      name: z.string().min(1).max(64),
      schema: JsonObjectSchema,
      strict: z.boolean(),
    })
    .strict()
    .readonly(),
]);

export const ModelRequestSchema = z
  .object({
    messages: z.array(AgentMessageSchema).min(1).readonly(),
    tools: z.array(ModelToolDefinitionSchema).readonly(),
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    toolChoice: z.enum(["auto", "none", "required"]).optional(),
    allowParallelToolCalls: z.boolean().optional(),
    responseFormat: ResponseFormatSchema.optional(),
    reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict()
  .readonly();

export type ModelRequest = z.output<typeof ModelRequestSchema>;

const streamEventBase = z.object({
  sequence: z.number().int().nonnegative(),
  responseId: z.string().min(1),
});

export const ModelStreamEventSchema = z.discriminatedUnion("type", [
  streamEventBase
    .extend({ type: z.literal("response.started") })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("text.delta"),
      contentIndex: z.number().int().nonnegative(),
      delta: z.string().min(1),
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("reasoning.delta"),
      contentIndex: z.number().int().nonnegative(),
      delta: z.string().min(1),
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("tool-call.started"),
      contentIndex: z.number().int().nonnegative(),
      callId: ToolCallIdSchema,
      toolName: toolNameSchema,
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("tool-call.arguments.delta"),
      callId: ToolCallIdSchema,
      delta: z.string().min(1),
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("tool-call.completed"),
      callId: ToolCallIdSchema,
      input: JsonValueSchema,
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("usage.updated"),
      usage: TokenUsageSchema,
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("provider.metadata"),
      metadata: JsonObjectSchema,
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("response.completed"),
      finishReason: z.enum(["content-filter", "error", "length", "stop", "tool-calls", "unknown"]),
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("response.failed"),
      error: ModelFailureSchema,
    })
    .strict()
    .readonly(),
]);

export type ModelStreamEvent = z.output<typeof ModelStreamEventSchema>;
export type FinishReason = Extract<
  ModelStreamEvent,
  { type: "response.completed" }
>["finishReason"];

export const ModelResponseSchema = z
  .object({
    responseId: z.string().min(1),
    message: AgentMessageSchema,
    finishReason: z.enum(["content-filter", "error", "length", "stop", "tool-calls", "unknown"]),
    usage: TokenUsageSchema.optional(),
    providerMetadata: JsonObjectSchema.optional(),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.message.role !== "assistant") {
      context.addIssue({
        code: "custom",
        path: ["message", "role"],
        message: "A model response must contain an assistant message",
      });
    }
  })
  .readonly();

export type ModelResponse = z.output<typeof ModelResponseSchema>;

export const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().positive(),
    baseDelayMs: z.number().int().nonnegative(),
    maxDelayMs: z.number().int().nonnegative(),
    jitterRatio: z.number().finite().min(0).max(1),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.baseDelayMs > policy.maxDelayMs) {
      context.addIssue({
        code: "custom",
        path: ["baseDelayMs"],
        message: "Base retry delay cannot exceed the maximum delay",
      });
    }
  })
  .readonly();

export type RetryPolicy = z.output<typeof RetryPolicySchema>;

export const ProviderAuthSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("none") })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("environment"),
      variable: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u, "Expected an environment variable name"),
    })
    .strict()
    .readonly(),
]);

export type ProviderAuth = z.output<typeof ProviderAuthSchema>;

const HttpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Provider URLs must use HTTP or HTTPS");

export const ProviderConfigurationSchema = z
  .object({
    providerId: providerIdSchema,
    type: z.enum(["anthropic", "custom", "google", "openai", "openai-compatible"]),
    baseUrl: HttpUrlSchema.optional(),
    auth: ProviderAuthSchema,
    options: JsonObjectSchema.optional(),
  })
  .strict()
  .readonly();

export type ProviderConfiguration = z.output<typeof ProviderConfigurationSchema>;

export const ModelDescriptorSchema = z
  .object({
    key: ModelKeySchema,
    displayName: z.string().min(1),
    capabilities: ModelCapabilitiesSchema,
    metadata: JsonObjectSchema.optional(),
  })
  .strict()
  .readonly();

export type ModelDescriptor = z.output<typeof ModelDescriptorSchema>;

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

function parseContract<Output>(
  contract: string,
  schema: z.ZodType<Output>,
  input: unknown,
): Output {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ModelContractValidationError(contract, result.error.issues.length, result.error);
  }

  return result.data;
}

export function parseModelRequest(input: unknown): ModelRequest {
  return parseContract("model request", ModelRequestSchema, input);
}

export function parseModelCapabilities(input: unknown): ModelCapabilities {
  return parseContract("model capabilities", ModelCapabilitiesSchema, input);
}

export function parseModelDescriptor(input: unknown): ModelDescriptor {
  return parseContract("model descriptor", ModelDescriptorSchema, input);
}

export function parseModelStreamEvent(input: unknown): ModelStreamEvent {
  return parseContract("model stream event", ModelStreamEventSchema, input);
}

export function parseProviderConfiguration(input: unknown): ProviderConfiguration {
  return parseContract("provider configuration", ProviderConfigurationSchema, input);
}

export type { AgentMessage, ModelFailure };
