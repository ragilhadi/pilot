import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModelCatalog, runCli, type TextWriter } from "../src/index.js";
import {
  ModelStoreError,
  modelsStorePath,
  PersistedModelSchema,
  readPersistedModels,
  removePersistedModel,
  upsertPersistedModel,
  writePersistedModels,
} from "../src/model-store.js";

let dataDirectory: string;

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), "pilot-models-test-"));
});

afterEach(async () => {
  await rm(dataDirectory, { recursive: true, force: true });
});

function memoryWriter(): TextWriter & { readonly text: () => string } {
  let content = "";
  return {
    write(text) {
      content += text;
    },
    text: () => content,
  };
}

function dependencies() {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  return {
    dependencies: {
      registry: createModelCatalog({ environment: {} }),
      clock: { now: () => new Date("2026-07-25T00:00:00.000Z") },
      ids: { next: () => "id" },
      stdout,
      stderr,
      signal: new AbortController().signal,
      dataDirectory,
      monotonicNow: () => 0,
    },
    stdout,
    stderr,
  };
}

describe("model store", () => {
  it("applies defaults so only a modelId is required", () => {
    const model = PersistedModelSchema.parse({ modelId: "llama3.1:8b" });
    expect(model).toEqual({
      provider: "ollama",
      modelId: "llama3.1:8b",
      tools: true,
      vision: false,
    });
  });

  it("returns an empty list when the store file does not exist", async () => {
    expect(await readPersistedModels(modelsStorePath(dataDirectory))).toEqual([]);
  });

  it("round-trips written models", async () => {
    const storePath = modelsStorePath(dataDirectory);
    const model = PersistedModelSchema.parse({ modelId: "deepseek-v4-flash:cloud" });
    await writePersistedModels(storePath, [model]);
    expect(await readPersistedModels(storePath)).toEqual([model]);
  });

  it("throws a ModelStoreError on a corrupt store", async () => {
    const storePath = modelsStorePath(dataDirectory);
    await writePersistedModels(storePath, []);
    await import("node:fs/promises").then((fs) => fs.writeFile(storePath, "not json", "utf8"));
    await expect(readPersistedModels(storePath)).rejects.toBeInstanceOf(ModelStoreError);
  });

  it("upserts by key without duplicating", () => {
    const a = PersistedModelSchema.parse({ modelId: "a:cloud" });
    const aUpdated = PersistedModelSchema.parse({ modelId: "a:cloud", vision: true });
    const first = upsertPersistedModel([], a);
    expect(first.replaced).toBe(false);
    const second = upsertPersistedModel(first.models, aUpdated);
    expect(second.replaced).toBe(true);
    expect(second.models).toEqual([aUpdated]);
  });

  it("removes by key", () => {
    const a = PersistedModelSchema.parse({ modelId: "a:cloud" });
    const result = removePersistedModel([a], "ollama/a:cloud");
    expect(result.removed).toBe(true);
    expect(result.models).toEqual([]);
  });
});

describe("pilot models add / remove", () => {
  it("saves a model that is then usable and listed", async () => {
    const { dependencies: deps, stdout } = dependencies();
    const code = await runCli(["models", "add", "deepseek-v4-flash:cloud"], deps);

    expect(code).toBe(0);
    expect(stdout.text()).toContain("Added ollama/deepseek-v4-flash:cloud");
    expect(stdout.text()).toContain("pilot chat --model ollama/deepseek-v4-flash:cloud");

    const persisted = await readPersistedModels(modelsStorePath(dataDirectory));
    expect(persisted).toEqual([
      { provider: "ollama", modelId: "deepseek-v4-flash:cloud", tools: true, vision: false },
    ]);

    // A catalog built from the saved store now registers the model.
    const registry = createModelCatalog({ environment: {}, persistedModels: persisted });
    expect(registry.has("ollama/deepseek-v4-flash:cloud")).toBe(true);
  });

  it("honours --no-tools and --name flags", async () => {
    const { dependencies: deps } = dependencies();
    await runCli(["models", "add", "qwen2.5-coder:7b", "--no-tools", "--name", "Qwen Coder"], deps);

    const persisted = await readPersistedModels(modelsStorePath(dataDirectory));
    expect(persisted[0]).toMatchObject({
      modelId: "qwen2.5-coder:7b",
      displayName: "Qwen Coder",
      tools: false,
    });
  });

  it("refuses to override a built-in model", async () => {
    const { dependencies: deps, stderr } = dependencies();
    const code = await runCli(["models", "add", "glm-5.2:cloud"], deps);

    expect(code).toBe(1);
    expect(stderr.text()).toContain("built-in model");
    await expect(readFile(modelsStorePath(dataDirectory), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes a saved model by key", async () => {
    const { dependencies: deps, stdout } = dependencies();
    await runCli(["models", "add", "temp:cloud"], deps);
    const code = await runCli(["models", "remove", "ollama/temp:cloud"], deps);

    expect(code).toBe(0);
    expect(stdout.text()).toContain("Removed ollama/temp:cloud");
    expect(await readPersistedModels(modelsStorePath(dataDirectory))).toEqual([]);
  });

  it("reports a helpful error when removing an unknown model", async () => {
    const { dependencies: deps, stderr } = dependencies();
    const code = await runCli(["models", "remove", "ghost:cloud"], deps);

    expect(code).toBe(1);
    expect(stderr.text()).toContain("not a saved model");
  });
});
