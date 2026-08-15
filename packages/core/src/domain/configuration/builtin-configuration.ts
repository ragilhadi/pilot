import { configurationSchemaVersion } from "../../constants.js";
import { PilotConfigurationSchema, type PilotConfiguration } from "./config-schema.js";
import type { ConfigurationLayerSource } from "./config.types.js";

// The environment every command starts with: enough to find and run a program, and nothing that
// carries a credential. `commands.inheritEnvironment` in config.jsonc extends this list; because
// the resolver accumulates the lists rather than replacing them, no configuration can strip PATH
// out from under a subprocess.
export const defaultInheritedEnvironmentNames: readonly string[] = Object.freeze([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "COMSPEC",
  "TEMP",
  "TMP",
]);

// Variables the model may set on an individual command. Both are output-shaping flags, so a wrong
// guess costs nothing; `commands.allowEnvironmentOverrides` extends this list the same way.
export const defaultAllowedEnvironmentOverrides: readonly string[] = Object.freeze([
  "CI",
  "NO_COLOR",
]);

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
  // Three seconds is comfortably above a warm re-check for both servers, and the cost is paid only
  // on files a language server actually serves.
  diagnostics: { enabled: true, timeoutMs: 3_000 },
  prompt: { systemPrompt: "builtin" },
  // Skills are discovered and listed by default but never activate on their own: activation is
  // always an explicit user action in this phase.
  skills: { enabled: true, maxFileBytes: 65_536, maxTotalBytes: 524_288, maxSkills: 200 },
  permissions: { rules: [] },
  commands: {
    inheritEnvironment: defaultInheritedEnvironmentNames,
    allowEnvironmentOverrides: defaultAllowedEnvironmentOverrides,
  },
  runBudget: {
    // Loop bounds are generous backstops against runaway iteration, not the
    // normal stopping point. Wall-clock elapsed time is the primary limiter;
    // per-request context size is bounded separately by context.maxInputTokens,
    // so no cumulative token cap is set by default. Set maxEstimatedCostUsd (or
    // the token caps) in config.jsonc to add an opt-in ceiling.
    maxCycles: 200,
    maxModelAttempts: 600,
    maxToolCalls: 2_000,
    maxElapsedMs: 1_800_000,
  },
  secrets: {},
});

export const sourcePriority: Readonly<Record<ConfigurationLayerSource, number>> = {
  builtin: 0,
  global: 1,
  project: 2,
  session: 3,
  cli: 4,
};
