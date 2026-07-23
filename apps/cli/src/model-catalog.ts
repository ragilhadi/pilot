import { ModelRegistry } from "@pilotrun/agent-runtime";
import {
  ModelCapabilitiesSchema,
  ModelContractValidationError,
  ProviderConfigurationSchema,
} from "@pilotrun/core";
import { type Fetch, OpenAICompatibleLanguageModel } from "@pilotrun/provider-openai-compatible";
import { FakeLanguageModel, textResponseScript } from "@pilotrun/testkit";
import * as z from "zod";

export const compatibleModelsEnvironmentVariable = "PILOT_OPENAI_COMPATIBLE_MODELS_JSON" as const;
export const ollamaBaseUrlEnvironmentVariable = "PILOT_OLLAMA_BASE_URL" as const;
export const defaultCliModelKey = "ollama/glm-5.2:cloud" as const;
export const defaultOllamaBaseUrl = "http://localhost:11434/v1" as const;

export type CliEnvironment = Readonly<Record<string, string | undefined>>;

export interface ModelCatalogDependencies {
  readonly environment: CliEnvironment;
  readonly fetch?: Fetch;
}

export interface ProviderCredentialStatus {
  readonly provider: string;
  readonly environmentVariable?: string;
  readonly configured: boolean;
}

const ConfiguredCompatibleModelSchema = z
  .object({
    provider: ProviderConfigurationSchema.refine(
      (provider) => provider.type === "openai" || provider.type === "openai-compatible",
      "Expected an OpenAI or OpenAI-compatible provider",
    ),
    modelId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !/\s/u.test(value)),
    displayName: z.string().min(1).max(256),
    capabilities: ModelCapabilitiesSchema,
  })
  .strict()
  .readonly();

const ConfiguredCompatibleModelsSchema = z.array(ConfiguredCompatibleModelSchema).readonly();

export function createModelCatalog(dependencies: ModelCatalogDependencies): ModelRegistry {
  const ollamaConfiguration = ProviderConfigurationSchema.parse({
    providerId: "ollama",
    type: "openai-compatible",
    baseUrl: dependencies.environment[ollamaBaseUrlEnvironmentVariable] ?? defaultOllamaBaseUrl,
    auth: { type: "none" },
  });
  const registry = new ModelRegistry([
    {
      model: new OpenAICompatibleLanguageModel({
        configuration: ollamaConfiguration,
        modelId: "glm-5.2:cloud",
        capabilities: ModelCapabilitiesSchema.parse({
          streaming: true,
          nativeToolCalling: true,
          parallelToolCalls: false,
          structuredOutput: true,
          vision: false,
          promptCaching: false,
          reasoning: true,
          configurableReasoningEffort: false,
          systemMessages: true,
        }),
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      }),
      displayName: "Ollama Cloud GLM-5.2",
      metadata: { source: "builtin", route: "local-ollama", priority: 1 },
    },
    {
      model: new FakeLanguageModel({
        providerId: "fake",
        modelId: "test",
        scripts: Array.from({ length: 64 }, (_, index) =>
          textResponseScript({
            responseId: `fake-response-${index + 1}`,
            deltas: ["Hello from Pilot's fake model."],
          }),
        ),
      }),
      displayName: "Pilot Fake Model",
      metadata: { source: "builtin", priority: 2 },
    },
  ]);

  const serialized = dependencies.environment[compatibleModelsEnvironmentVariable];
  if (serialized === undefined || serialized.trim().length === 0) {
    return registry;
  }

  const configuredModels = parseConfiguredModels(serialized);

  for (const configured of configuredModels) {
    const model = new OpenAICompatibleLanguageModel({
      configuration: configured.provider,
      modelId: configured.modelId,
      capabilities: configured.capabilities,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      readEnvironment: (variable) => dependencies.environment[variable],
    });
    registry.register({
      model,
      displayName: configured.displayName,
      metadata: { source: "environment" },
    });
  }

  return registry;
}

export function inspectProviderCredentials(
  environment: CliEnvironment,
): readonly ProviderCredentialStatus[] {
  const serialized = environment[compatibleModelsEnvironmentVariable];
  if (serialized === undefined || serialized.trim().length === 0) return [];
  const statuses = new Map<string, ProviderCredentialStatus>();
  for (const configured of parseConfiguredModels(serialized)) {
    const auth = configured.provider.auth;
    if (auth.type !== "environment") continue;
    statuses.set(`${configured.provider.providerId}\0${auth.variable}`, {
      provider: configured.provider.providerId,
      environmentVariable: auth.variable,
      configured: (environment[auth.variable]?.length ?? 0) > 0,
    });
  }
  return Object.freeze([...statuses.values()]);
}

function parseConfiguredModels(serialized: string) {
  let input: unknown;
  try {
    input = JSON.parse(serialized);
  } catch (error) {
    throw new ModelContractValidationError("CLI model catalog", 1, error);
  }
  const parsed = ConfiguredCompatibleModelsSchema.safeParse(input);
  if (!parsed.success) {
    throw new ModelContractValidationError(
      "CLI model catalog",
      parsed.error.issues.length,
      parsed.error,
    );
  }
  return parsed.data;
}
