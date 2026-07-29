import { configurationSchemaVersion } from "../../constants.js";
import { PilotConfigurationSchema, type PilotConfiguration } from "./config-schema.js";
import type { ConfigurationLayerSource } from "./config.types.js";

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
  permissions: { rules: [] },
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
