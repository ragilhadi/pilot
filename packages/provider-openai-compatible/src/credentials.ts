import { ModelError, type ProviderAuth } from "@pilot/core";

export type EnvironmentReader = (variable: string) => string | undefined;

export const processEnvironmentReader: EnvironmentReader = (variable) => process.env[variable];

export function resolveBearerToken(
  auth: ProviderAuth,
  providerId: string,
  modelId: string,
  readEnvironment: EnvironmentReader,
): string | undefined {
  if (auth.type === "none") {
    return undefined;
  }

  const value = readEnvironment(auth.variable);
  if (value === undefined || value.trim().length === 0) {
    throw new ModelError({
      kind: "authentication",
      providerId,
      modelId,
      message: `Credential environment variable ${auth.variable} is missing or empty`,
    });
  }

  return value;
}
