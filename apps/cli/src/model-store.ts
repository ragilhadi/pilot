import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod";

/** File name, under the Pilot data directory, holding user-added models. */
export const modelsStoreFileName = "models.json" as const;

/**
 * A user-added model as persisted in `models.json`. Only `modelId` is required;
 * everything else has a sensible default so `pilot models add <modelId>` is
 * enough for a local Ollama model.
 */
export const PersistedModelSchema = z
  .object({
    provider: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/u, "provider must be lowercase alphanumeric or dashes")
      .default("ollama"),
    modelId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !/\s/u.test(value), "modelId must not contain whitespace"),
    displayName: z.string().min(1).max(256).optional(),
    baseUrl: z.string().url().max(2_048).optional(),
    tools: z.boolean().default(true),
    vision: z.boolean().default(false),
    /**
     * The model's real context window. Without it Pilot falls back to the global
     * `context.maxInputTokens`, which silently over-fills a small local model and under-fills a
     * large one.
     */
    contextWindow: z.number().int().positive().max(10_000_000).optional(),
  })
  .strict();

export type PersistedModel = z.output<typeof PersistedModelSchema>;
export type PersistedModelInput = z.input<typeof PersistedModelSchema>;

const PersistedModelsSchema = z.array(PersistedModelSchema);

export class ModelStoreError extends Error {
  constructor(
    message: string,
    readonly location: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ModelStoreError";
  }
}

export interface ModelStoreIo {
  readonly read?: (filePath: string) => Promise<string | undefined>;
  readonly write?: (filePath: string, content: string) => Promise<void>;
}

/** The address a model is registered under: `provider/modelId`. */
export function persistedModelKey(model: Pick<PersistedModel, "provider" | "modelId">): string {
  return `${model.provider}/${model.modelId}`;
}

/** Absolute path to the models store inside a data directory. */
export function modelsStorePath(dataDirectory: string): string {
  return path.join(dataDirectory, modelsStoreFileName);
}

/**
 * Reads the persisted models. Returns an empty list when the file does not
 * exist yet. Throws {@link ModelStoreError} when the file is present but not
 * valid JSON or does not match the schema, so a corrupt store surfaces loudly
 * instead of silently dropping models.
 */
export async function readPersistedModels(
  storePath: string,
  io: ModelStoreIo = {},
): Promise<readonly PersistedModel[]> {
  const read = io.read ?? readOptionalFile;
  const content = await read(storePath);
  if (content === undefined || content.trim().length === 0) {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new ModelStoreError(`Models store ${storePath} is not valid JSON`, storePath, {
      cause: error,
    });
  }
  const parsed = PersistedModelsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ModelStoreError(
      `Models store ${storePath} does not match the expected format`,
      storePath,
      { cause: parsed.error },
    );
  }
  return Object.freeze(parsed.data);
}

/** Writes the persisted models, creating the data directory if necessary. */
export async function writePersistedModels(
  storePath: string,
  models: readonly PersistedModel[],
  io: ModelStoreIo = {},
): Promise<void> {
  const write =
    io.write ??
    (async (filePath, content) => {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await writeFile(filePath, content, "utf8");
    });
  await write(storePath, `${JSON.stringify(models, null, 2)}\n`);
}

/**
 * Returns the model list with `entry` added, replacing any existing entry that
 * shares the same key so `add` is idempotent. The boolean reports whether an
 * existing entry was replaced.
 */
export function upsertPersistedModel(
  existing: readonly PersistedModel[],
  entry: PersistedModel,
): { readonly models: readonly PersistedModel[]; readonly replaced: boolean } {
  const key = persistedModelKey(entry);
  const filtered = existing.filter((model) => persistedModelKey(model) !== key);
  return {
    models: Object.freeze([...filtered, entry]),
    replaced: filtered.length !== existing.length,
  };
}

/**
 * Returns the model list with the entry matching `key` removed. The boolean
 * reports whether anything was removed.
 */
export function removePersistedModel(
  existing: readonly PersistedModel[],
  key: string,
): { readonly models: readonly PersistedModel[]; readonly removed: boolean } {
  const filtered = existing.filter((model) => persistedModelKey(model) !== key);
  return { models: Object.freeze(filtered), removed: filtered.length !== existing.length };
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw new ModelStoreError(`Models store ${filePath} could not be read`, filePath, {
      cause: error,
    });
  }
}
