import * as z from "zod";
import { PilotError } from "./errors.js";
import { ModelKeySchema } from "./models.js";
import { PermissionRuleSchema } from "./permissions.js";

export const configurationSchemaVersion = 1 as const;
export const maximumConfigurationBytes = 1_048_576;

export const EnvironmentReferenceSchema = z
  .object({
    variable: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
    required: z.boolean().default(true),
  })
  .strict()
  .readonly();

const secretAlias = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const modelLayerSchema = z.object({ default: ModelKeySchema.optional() }).strict().readonly();
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
const permissionsLayerSchema = z
  .object({ rules: z.array(PermissionRuleSchema).max(1_000).readonly().optional() })
  .strict()
  .readonly();

export const ConfigurationLayerValueSchema = z
  .object({
    schemaVersion: z.literal(configurationSchemaVersion).optional(),
    model: modelLayerSchema.optional(),
    persistence: persistenceLayerSchema.optional(),
    context: contextLayerSchema.optional(),
    permissions: permissionsLayerSchema.optional(),
    secrets: z.record(secretAlias, EnvironmentReferenceSchema).optional(),
  })
  .strict()
  .readonly();

export const PilotConfigurationSchema = z
  .object({
    schemaVersion: z.literal(configurationSchemaVersion),
    model: z.object({ default: ModelKeySchema }).strict().readonly(),
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
    permissions: z
      .object({ rules: z.array(PermissionRuleSchema).max(1_000).readonly() })
      .strict()
      .readonly(),
    secrets: z.record(secretAlias, EnvironmentReferenceSchema).readonly(),
  })
  .strict()
  .readonly();

export type EnvironmentReference = z.output<typeof EnvironmentReferenceSchema>;
export type ConfigurationLayerValue = z.output<typeof ConfigurationLayerValueSchema>;
export type PilotConfiguration = z.output<typeof PilotConfigurationSchema>;

export type ConfigurationLayerSource = "builtin" | "global" | "project" | "session" | "cli";

export interface ConfigurationLayer {
  readonly source: ConfigurationLayerSource;
  readonly location: string;
  readonly value: unknown;
}

export interface ConfigurationProvenance {
  readonly source: ConfigurationLayerSource;
  readonly location: string;
  readonly layerIndex: number;
}

export interface EffectiveConfiguration {
  readonly configuration: PilotConfiguration;
  readonly provenance: Readonly<Record<string, ConfigurationProvenance>>;
}

export class ConfigurationError extends PilotError {
  constructor(message: string, metadata: Readonly<Record<string, unknown>> = {}, cause?: unknown) {
    super({
      code: "PILOT_CONFIG_INVALID",
      message,
      safeMessage: "Pilot configuration is invalid",
      metadata,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

export class MissingConfigurationEnvironmentError extends PilotError {
  constructor(variable: string) {
    super({
      code: "PILOT_CONFIG_ENVIRONMENT_MISSING",
      message: `Required configuration environment variable ${variable} is missing`,
      safeMessage: "A required configuration environment variable is missing",
      metadata: { variable },
    });
  }
}

export const builtinConfiguration: PilotConfiguration = PilotConfigurationSchema.parse({
  schemaVersion: configurationSchemaVersion,
  model: { default: "ollama/glm-5.2:cloud" },
  persistence: { checkpointIntervalMs: 250 },
  context: {
    maxInputTokens: 120_000,
    reservedOutputTokens: 4_096,
    maxFileBytes: 1_048_576,
    maxInstructionBytes: 131_072,
    maxInstructionTotalBytes: 524_288,
    maxToolResultBytes: 32_768,
  },
  permissions: { rules: [] },
  secrets: {},
});

const sourcePriority: Readonly<Record<ConfigurationLayerSource, number>> = {
  builtin: 0,
  global: 1,
  project: 2,
  session: 3,
  cli: 4,
};

export function resolveConfiguration(
  layers: readonly ConfigurationLayer[],
): EffectiveConfiguration {
  const ordered = [
    { source: "builtin" as const, location: "builtin", value: builtinConfiguration },
    ...layers.filter(({ source }) => source !== "builtin"),
  ].sort((left, right) => sourcePriority[left.source] - sourcePriority[right.source]);
  let merged: unknown = {};
  const provenance: Record<string, ConfigurationProvenance> = {};
  const permissionRules: z.output<typeof PermissionRuleSchema>[] = [];
  const permissionRuleIds = new Set<string>();
  for (const [layerIndex, layer] of ordered.entries()) {
    const result = ConfigurationLayerValueSchema.safeParse(layer.value);
    if (!result.success) {
      throw new ConfigurationError(
        `Configuration layer ${layer.location} has ${result.error.issues.length} validation issue(s)`,
        { source: layer.source, location: layer.location, issueCount: result.error.issues.length },
        result.error,
      );
    }
    validateLayerAuthority(layer, result.data);
    for (const rule of result.data.permissions?.rules ?? []) {
      if (permissionRuleIds.has(rule.id)) {
        throw new ConfigurationError(`Permission rule ${rule.id} is declared more than once`, {
          ruleId: rule.id,
          location: layer.location,
        });
      }
      permissionRuleIds.add(rule.id);
      permissionRules.push(rule);
      provenance[`permissions.rules.${rule.id}`] = Object.freeze({
        source: layer.source,
        location: layer.location,
        layerIndex,
      });
    }
    merged = deepMerge(merged, result.data);
    recordProvenance(
      result.data,
      "",
      {
        source: layer.source,
        location: layer.location,
        layerIndex,
      },
      provenance,
    );
  }
  merged = deepMerge(merged, { permissions: { rules: permissionRules } });
  const final = PilotConfigurationSchema.safeParse(merged);
  if (!final.success) {
    throw new ConfigurationError(
      `Effective configuration has ${final.error.issues.length} validation issue(s)`,
      { issueCount: final.error.issues.length },
      final.error,
    );
  }
  return Object.freeze({ configuration: final.data, provenance: Object.freeze(provenance) });
}

function validateLayerAuthority(layer: ConfigurationLayer, value: ConfigurationLayerValue): void {
  if (
    (layer.source === "project" || layer.source === "session") &&
    value.persistence?.dataDirectory !== undefined
  ) {
    throw new ConfigurationError(
      `${layer.source} configuration cannot redirect the persistence data directory`,
      { source: layer.source, location: layer.location, path: "persistence.dataDirectory" },
    );
  }
  for (const rule of value.permissions?.rules ?? []) {
    if (rule.source !== layer.source) {
      throw new ConfigurationError(
        `Permission rule ${rule.id} source ${rule.source} does not match layer ${layer.source}`,
        { ruleId: rule.id, ruleSource: rule.source, layerSource: layer.source },
      );
    }
  }
}

export function parseJsonConfiguration(text: string, location: string): ConfigurationLayerValue {
  if (new TextEncoder().encode(text).byteLength > maximumConfigurationBytes) {
    throw new ConfigurationError(`Configuration ${location} exceeds the size limit`, { location });
  }
  try {
    const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return ConfigurationLayerValueSchema.parse(
      JSON.parse(removeTrailingCommas(stripComments(withoutBom))),
    );
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(
      `Configuration ${location} is not valid JSONC`,
      { location },
      error,
    );
  }
}

export function resolveEnvironmentReference(
  reference: EnvironmentReference,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const parsed = EnvironmentReferenceSchema.parse(reference);
  const value = environment[parsed.variable];
  if (value === undefined && parsed.required) {
    throw new MissingConfigurationEnvironmentError(parsed.variable);
  }
  return value;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isObject(base) || !isObject(override)) return override;
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    output[key] = isObject(value) && isObject(output[key]) ? deepMerge(output[key], value) : value;
  }
  return output;
}

function recordProvenance(
  value: unknown,
  path: string,
  source: ConfigurationProvenance,
  output: Record<string, ConfigurationProvenance>,
): void {
  if (!isObject(value) || Array.isArray(value)) {
    if (path.length > 0) output[path] = Object.freeze({ ...source });
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path.length === 0 ? key : `${path}.${key}`;
    recordProvenance(child, childPath, source, output);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripComments(text: string): string {
  let output = "";
  let quote = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') {
      quote = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        output += text[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index >= text.length)
        throw new ConfigurationError("Configuration has an unterminated comment");
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

function removeTrailingCommas(text: string): string {
  let output = "";
  let quote = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') quote = true;
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/u.test(text[lookahead] ?? "")) lookahead += 1;
      if (text[lookahead] === "}" || text[lookahead] === "]") continue;
    }
    output += character;
  }
  return output;
}
