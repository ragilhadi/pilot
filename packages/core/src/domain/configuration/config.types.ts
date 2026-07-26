import type { PilotConfiguration } from "./config-schema.js";

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
