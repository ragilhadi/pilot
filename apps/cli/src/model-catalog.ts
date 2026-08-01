import { ModelRegistry } from "@pilotrun/agent-runtime";
import {
  ModelCapabilitiesSchema,
  ModelContractValidationError,
  ProviderConfigurationSchema,
} from "@pilotrun/core";
import { type Fetch, OpenAICompatibleLanguageModel } from "@pilotrun/provider-openai-compatible";
import { FakeLanguageModel, textResponseScript } from "@pilotrun/testkit";
import * as z from "zod";
import { type PersistedModel, persistedModelKey } from "./model-store.js";

export const compatibleModelsEnvironmentVariable = "PILOT_OPENAI_COMPATIBLE_MODELS_JSON" as const;
export const ollamaBaseUrlEnvironmentVariable = "PILOT_OLLAMA_BASE_URL" as const;
export const defaultCliModelKey = "ollama/glm-5.2:cloud" as const;
export const defaultOllamaBaseUrl = "http://localhost:11434/v1" as const;

/** Keys of the models that always exist and cannot be overridden by user config. */
export const builtinModelKeys = ["ollama/glm-5.2:cloud", "fake/test"] as const;

export type CliEnvironment = Readonly<Record<string, string | undefined>>;

export interface ModelCatalogDependencies {
  readonly environment: CliEnvironment;
  readonly fetch?: Fetch;
  /** User-added models loaded from the models store; registered after builtins. */
  readonly persistedModels?: readonly PersistedModel[];
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
          maxContextTokens: 128_000,
          // Ollama's /v1 shim reports `prompt_eval_count` as `prompt_tokens`, which counts only the
          // tokens the runner evaluated. Once the KV cache holds the conversation prefix it falls
          // well below the real prompt size, so it is throughput data, not context occupancy.
          promptUsageTrust: "eval-only",
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

  for (const persisted of dependencies.persistedModels ?? []) {
    const key = persistedModelKey(persisted);
    // A user-added model must never shadow a builtin or an already-registered
    // model; skip silently so `models add` of a known key is a harmless no-op.
    if (registry.has(key)) {
      continue;
    }
    registry.register({
      model: new OpenAICompatibleLanguageModel({
        configuration: ProviderConfigurationSchema.parse({
          providerId: persisted.provider,
          type: "openai-compatible",
          baseUrl:
            persisted.baseUrl ??
            dependencies.environment[ollamaBaseUrlEnvironmentVariable] ??
            defaultOllamaBaseUrl,
          auth: { type: "none" },
        }),
        modelId: persisted.modelId,
        capabilities: persistedModelCapabilities(persisted),
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
        readEnvironment: (variable) => dependencies.environment[variable],
      }),
      displayName: persisted.displayName ?? persisted.modelId,
      metadata: { source: "store" },
    });
  }

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

function persistedModelCapabilities(model: PersistedModel) {
  return ModelCapabilitiesSchema.parse({
    streaming: true,
    nativeToolCalling: model.tools,
    parallelToolCalls: false,
    structuredOutput: true,
    vision: model.vision,
    promptCaching: false,
    reasoning: false,
    configurableReasoningEffort: false,
    systemMessages: true,
    // User-added models are reached through the same Ollama-compatible endpoint by default, so the
    // same caveat about `prompt_eval_count` applies until a model declares otherwise.
    promptUsageTrust: "eval-only",
    ...(model.contextWindow === undefined ? {} : { maxContextTokens: model.contextWindow }),
  });
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
