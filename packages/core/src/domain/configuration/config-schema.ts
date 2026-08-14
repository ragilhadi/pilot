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
// Environment variable names, not values: configuration names a variable and the value is read
// from Pilot's own environment, so a checked-in config never becomes a place secrets land. Mixed
// case is accepted because the built-in inherited set already includes `SystemRoot` and `COMSPEC`.
const environmentVariableName = z
  .string()
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const commandsLayerSchema = z
  .object({
    inheritEnvironment: z.array(environmentVariableName).max(256).readonly().optional(),
    allowEnvironmentOverrides: z.array(environmentVariableName).max(256).readonly().optional(),
  })
  .strict()
  .readonly();
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
const diagnosticsLayerSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().min(0).max(60_000).optional(),
  })
  .strict()
  .readonly();
const promptLayerSchema = z
  .object({ systemPrompt: z.enum(["builtin", "none"]).optional() })
  .strict()
  .readonly();
const skillsLayerSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxFileBytes: z.number().int().positive().max(1_000_000).optional(),
    maxTotalBytes: z.number().int().positive().max(10_000_000).optional(),
    maxSkills: z.number().int().positive().max(1_000).optional(),
  })
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
    diagnostics: diagnosticsLayerSchema.optional(),
    prompt: promptLayerSchema.optional(),
    skills: skillsLayerSchema.optional(),
    permissions: permissionsLayerSchema.optional(),
    commands: commandsLayerSchema.optional(),
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
    diagnostics: z
      .object({
        // Language servers are optional: with `enabled: false` Pilot never spawns one and the
        // edit tools behave exactly as they did before diagnostics existed.
        enabled: z.boolean(),
        // How long a write waits for diagnostics describing the content it just produced. A
        // timeout yields no diagnostics rather than stale ones, so this trades latency for
        // coverage, never for correctness.
        timeoutMs: z.number().int().min(0).max(60_000),
      })
      .strict()
      .readonly(),
    prompt: z
      .object({
        // "none" restores Pilot's original prompt-free behaviour, for users who want the model to
        // see nothing but their own AGENTS.md files.
        systemPrompt: z.enum(["builtin", "none"]),
      })
      .strict()
      .readonly(),
    skills: z
      .object({
        // Discovery is read-only and cheap, but a project that ships skills is still supplying
        // model instructions, so the whole subsystem can be switched off in one place.
        enabled: z.boolean(),
        maxFileBytes: z.number().int().positive().max(1_000_000),
        maxTotalBytes: z.number().int().positive().max(10_000_000),
        maxSkills: z.number().int().positive().max(1_000),
      })
      .strict()
      .refine(
        ({ maxFileBytes, maxTotalBytes }) => maxFileBytes <= maxTotalBytes,
        "Per-file skill limit cannot exceed the total skill limit",
      )
      .readonly(),
    permissions: z
      .object({ rules: z.array(PermissionRuleSchema).max(1_000).readonly() })
      .strict()
      .readonly(),
    commands: z
      .object({
        // Names inherited from Pilot's environment into every command it runs, and names the
        // model may set on a single command. Both lists accumulate across layers rather than
        // being replaced, so configuration can only widen what the built-in defaults allow.
        inheritEnvironment: z.array(environmentVariableName).max(1_024).readonly(),
        allowEnvironmentOverrides: z.array(environmentVariableName).max(1_024).readonly(),
      })
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
