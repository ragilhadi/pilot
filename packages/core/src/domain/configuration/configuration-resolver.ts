import type { PermissionRule } from "../permission/index.js";
import { builtinConfiguration, sourcePriority } from "./builtin-configuration.js";
import { ConfigurationError, MissingConfigurationEnvironmentError } from "./config-errors.js";
import {
  ConfigurationLayerValueSchema,
  EnvironmentReferenceSchema,
  PilotConfigurationSchema,
  type ConfigurationLayerValue,
  type EnvironmentReference,
} from "./config-schema.js";
import type {
  ConfigurationLayer,
  ConfigurationProvenance,
  EffectiveConfiguration,
} from "./config.types.js";

export function resolveConfiguration(
  layers: readonly ConfigurationLayer[],
): EffectiveConfiguration {
  const ordered = [
    { source: "builtin" as const, location: "builtin", value: builtinConfiguration },
    ...layers.filter(({ source }) => source !== "builtin"),
  ].sort((left, right) => sourcePriority[left.source] - sourcePriority[right.source]);
  let merged: unknown = {};
  const provenance: Record<string, ConfigurationProvenance> = {};
  const permissionRules: PermissionRule[] = [];
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
