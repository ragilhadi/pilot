export {
  ConfigurationLayerValueSchema,
  EnvironmentReferenceSchema,
  PilotConfigurationSchema,
  type ConfigurationLayerValue,
  type EnvironmentReference,
  type PilotConfiguration,
} from "./config-schema.js";
export type {
  ConfigurationLayer,
  ConfigurationLayerSource,
  ConfigurationProvenance,
  EffectiveConfiguration,
} from "./config.types.js";
export { ConfigurationError, MissingConfigurationEnvironmentError } from "./config-errors.js";
export { builtinConfiguration } from "./builtin-configuration.js";
export { resolveConfiguration, resolveEnvironmentReference } from "./configuration-resolver.js";
export { parseJsonConfiguration } from "./jsonc-parser.js";
