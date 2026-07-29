import * as z from "zod";
import { configurationSchemaVersion } from "../../constants.js";
import { ModelKeySchema } from "../model/index.js";
import { PermissionRuleSchema } from "../permission/index.js";

export const EnvironmentReferenceSchema = z
  .object({
    variable: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
    required: z.boolean().default(true),
  })
  .strict()
  .readonly();

const secretAlias = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const modelLayerSchema = z
  .object({
    default: ModelKeySchema.optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .strict()
  .readonly();
const persistenceLayerSchema = z
  .object({
    dataDirectory: z.string().min(1).max(4_096).optional(),
    checkpointIntervalMs: z.number().int().min(0).max(60_000).optional(),
  })
  .strict()
  .readonly();
const contextLayerSchema = z
  .object({
    maxInputTokens: z.number().int().positive().optional(),
    reservedOutputTokens: z.number().int().positive().optional(),
    maxFileBytes: z.number().int().positive().max(100_000_000).optional(),
    maxInstructionBytes: z.number().int().positive().max(10_000_000).optional(),
    maxInstructionTotalBytes: z.number().int().positive().max(50_000_000).optional(),
    maxToolResultBytes: z.number().int().min(512).max(10_000_000).optional(),
  })
  .strict()
  .readonly();
const promptLayerSchema = z
  .object({ systemPrompt: z.enum(["builtin", "none"]).optional() })
  .strict()
  .readonly();
const permissionsLayerSchema = z
  .object({ rules: z.array(PermissionRuleSchema).max(1_000).readonly().optional() })
  .strict()
  .readonly();
const runBudgetLayerSchema = z
  .object({
    maxCycles: z.number().int().positive().optional(),
    maxModelAttempts: z.number().int().positive().optional(),
    maxToolCalls: z.number().int().nonnegative().optional(),
    maxElapsedMs: z.number().int().positive().optional(),
    maxInputTokens: z.number().int().nonnegative().optional(),
    maxOutputTokens: z.number().int().nonnegative().optional(),
    maxEstimatedCostUsd: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .readonly();
const webSearchSchema = z
  .object({
    provider: z.literal("tavily"),
    apiKey: EnvironmentReferenceSchema.refine(
      ({ required }) => required,
      "The web-search API key environment reference must be required",
    ),
  })
  .strict()
  .readonly();

export const ConfigurationLayerValueSchema = z
  .object({
    schemaVersion: z.literal(configurationSchemaVersion).optional(),
    model: modelLayerSchema.optional(),
    persistence: persistenceLayerSchema.optional(),
    context: contextLayerSchema.optional(),
    prompt: promptLayerSchema.optional(),
    permissions: permissionsLayerSchema.optional(),
    runBudget: runBudgetLayerSchema.optional(),
    webSearch: webSearchSchema.optional(),
    secrets: z.record(secretAlias, EnvironmentReferenceSchema).optional(),
  })
  .strict()
  .readonly();

export const PilotConfigurationSchema = z
  .object({
    schemaVersion: z.literal(configurationSchemaVersion),
    model: z
      .object({
        default: ModelKeySchema,
        // The per-response output-token cap sent to the model. When omitted, Pilot falls back to
        // the active model's declared capability, and finally to the model's own default (no cap).
        maxOutputTokens: z.number().int().positive().optional(),
      })
      .strict()
      .readonly(),
    persistence: z
      .object({
        dataDirectory: z.string().min(1).max(4_096).optional(),
        checkpointIntervalMs: z.number().int().min(0).max(60_000),
      })
      .strict()
      .readonly(),
    context: z
      .object({
        maxInputTokens: z.number().int().positive(),
        reservedOutputTokens: z.number().int().positive(),
        maxFileBytes: z.number().int().positive().max(100_000_000),
        maxInstructionBytes: z.number().int().positive().max(10_000_000),
        maxInstructionTotalBytes: z.number().int().positive().max(50_000_000),
        maxToolResultBytes: z.number().int().min(512).max(10_000_000),
      })
      .strict()
      .refine(
        ({ maxInstructionBytes, maxInstructionTotalBytes }) =>
          maxInstructionBytes <= maxInstructionTotalBytes,
        "Per-file instruction limit cannot exceed the total instruction limit",
      )
      .refine(
        ({ maxInputTokens, reservedOutputTokens }) => reservedOutputTokens < maxInputTokens,
        "Output reservation must leave room for input context",
      )
      .readonly(),
    prompt: z
      .object({
        // "none" restores Pilot's original prompt-free behaviour, for users who want the model to
        // see nothing but their own AGENTS.md files.
        systemPrompt: z.enum(["builtin", "none"]),
      })
      .strict()
      .readonly(),
    permissions: z
      .object({ rules: z.array(PermissionRuleSchema).max(1_000).readonly() })
      .strict()
      .readonly(),
    runBudget: z
      .object({
        maxCycles: z.number().int().positive(),
        maxModelAttempts: z.number().int().positive(),
        maxToolCalls: z.number().int().nonnegative(),
        maxElapsedMs: z.number().int().positive(),
        maxInputTokens: z.number().int().nonnegative().optional(),
        maxOutputTokens: z.number().int().nonnegative().optional(),
        maxEstimatedCostUsd: z.number().finite().nonnegative().optional(),
      })
      .strict()
      .readonly(),
    webSearch: webSearchSchema.optional(),
    secrets: z.record(secretAlias, EnvironmentReferenceSchema).readonly(),
  })
  .strict()
  .readonly();

export type EnvironmentReference = z.output<typeof EnvironmentReferenceSchema>;
export type ConfigurationLayerValue = z.output<typeof ConfigurationLayerValueSchema>;
export type PilotConfiguration = z.output<typeof PilotConfigurationSchema>;
