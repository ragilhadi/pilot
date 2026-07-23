import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ConfigurationError,
  type ConfigurationLayer,
  type EffectiveConfiguration,
  parseJsonConfiguration,
  resolveConfiguration,
} from "@pilotrun/core";

export const pilotConfigEnvironmentVariable = "PILOT_CONFIG";

export interface CliConfigurationPaths {
  readonly global?: string;
  readonly project?: string;
}

export interface LoadCliConfigurationOptions {
  readonly paths: CliConfigurationPaths;
  readonly cliLayer?: ConfigurationLayer["value"];
  readonly readOptional?: (filePath: string) => Promise<string | undefined>;
}

export async function loadCliConfiguration(
  options: LoadCliConfigurationOptions,
): Promise<EffectiveConfiguration> {
  const readOptional = options.readOptional ?? readOptionalFile;
  const layers: ConfigurationLayer[] = [];
  for (const source of ["global", "project"] as const) {
    const location = options.paths[source];
    if (location === undefined) continue;
    const content = await readOptional(location);
    if (content === undefined) continue;
    layers.push({ source, location, value: parseJsonConfiguration(content, location) });
  }
  if (options.cliLayer !== undefined) {
    layers.push({ source: "cli", location: "command line", value: options.cliLayer });
  }
  return resolveConfiguration(layers);
}

export function defaultConfigurationPaths(input: {
  readonly dataDirectory: string;
  readonly workspaceDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): CliConfigurationPaths {
  return Object.freeze({
    global:
      input.environment[pilotConfigEnvironmentVariable] ??
      path.join(input.dataDirectory, "config.jsonc"),
    project: path.join(input.workspaceDirectory, ".pilot", "config.jsonc"),
  });
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new ConfigurationError(
      `Configuration ${filePath} could not be read`,
      { location: filePath },
      error,
    );
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
