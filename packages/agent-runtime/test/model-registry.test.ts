import {
  ModelContractValidationError,
  parseAgentMessage,
  parseModelRequest,
  type ModelCapabilities,
} from "@pilot/core";
import { FakeLanguageModel, textResponseScript } from "@pilot/testkit";
import { describe, expect, it } from "vitest";
import {
  inspectModelCapabilities,
  ModelCapabilityError,
  ModelNotFoundError,
  ModelRegistrationConflictError,
  ModelRegistry,
} from "../src/index.js";

const fullCapabilities = {
  streaming: true,
  nativeToolCalling: true,
  parallelToolCalls: true,
  structuredOutput: true,
  vision: true,
  promptCaching: true,
  reasoning: true,
  configurableReasoningEffort: true,
  systemMessages: true,
  maxContextTokens: 128_000,
  maxOutputTokens: 8_192,
} as const satisfies ModelCapabilities;

const minimalCapabilities = {
  streaming: true,
  nativeToolCalling: false,
  parallelToolCalls: false,
  structuredOutput: false,
  vision: false,
  promptCaching: false,
  reasoning: false,
  configurableReasoningEffort: false,
  systemMessages: false,
  maxOutputTokens: 1_024,
} as const satisfies ModelCapabilities;

function fakeModel(providerId: string, modelId: string, capabilities = fullCapabilities) {
  return new FakeLanguageModel({
    providerId,
    modelId,
    capabilities,
    scripts: [textResponseScript({ responseId: `${providerId}-response`, deltas: ["hello"] })],
  });
}

function userMessage(
  parts: readonly Record<string, unknown>[] = [{ type: "text", text: "Hello" }],
) {
  return parseAgentMessage({
    schemaVersion: 1,
    id: "message-user-1",
    sessionId: "session-1",
    runId: "run-1",
    role: "user",
    status: "complete",
    parts,
    createdAt: "2026-07-20T03:00:00.000Z",
    provenance: { kind: "user", channel: "cli" },
  });
}

function systemMessage() {
  return parseAgentMessage({
    schemaVersion: 1,
    id: "message-system-1",
    sessionId: "session-1",
    role: "system",
    status: "complete",
    parts: [{ type: "text", text: "Be concise" }],
    createdAt: "2026-07-20T02:59:00.000Z",
    provenance: { kind: "system", source: "builtin" },
  });
}

function simpleRequest() {
  return parseModelRequest({ messages: [userMessage()], tools: [] });
}

function demandingRequest() {
  return parseModelRequest({
    messages: [
      systemMessage(),
      userMessage([
        {
          type: "image",
          mediaType: "image/png",
          source: { kind: "url", url: "https://example.test/image.png" },
        },
      ]),
    ],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object" },
      },
    ],
    allowParallelToolCalls: true,
    maxOutputTokens: 2_048,
    responseFormat: {
      type: "json-schema",
      name: "answer",
      schema: { type: "object" },
      strict: true,
    },
    reasoningEffort: "medium",
  });
}

describe("ModelRegistry", () => {
  it("registers and resolves an exact stable model key", () => {
    const model = fakeModel("openrouter", "vendor/model-a");
    const registry = new ModelRegistry([
      { model, displayName: "Model A", metadata: { source: "configured" } },
    ]);

    const resolved = registry.resolve("openrouter/vendor/model-a", simpleRequest());

    expect(resolved.model).toBe(model);
    expect(resolved.descriptor).toMatchObject({
      key: "openrouter/vendor/model-a",
      displayName: "Model A",
      metadata: { source: "configured" },
    });
    expect(registry.has("openrouter/vendor/model-a")).toBe(true);
  });

  it("lists immutable descriptors in stable key order", () => {
    const registry = new ModelRegistry([
      { model: fakeModel("zeta", "model"), displayName: "Zeta" },
      { model: fakeModel("alpha", "model"), displayName: "Alpha" },
    ]);

    const descriptors = registry.list();

    expect(descriptors.map(({ key }) => key)).toEqual(["alpha/model", "zeta/model"]);
    expect(Object.isFrozen(descriptors)).toBe(true);
    expect(Object.isFrozen(descriptors[0])).toBe(true);
    expect(Object.isFrozen(descriptors[0]?.capabilities)).toBe(true);
  });

  it("rejects duplicate keys instead of replacing a model", () => {
    const first = fakeModel("fake", "same");
    const second = fakeModel("fake", "same");
    const registry = new ModelRegistry([{ model: first, displayName: "First" }]);

    expect(() => registry.register({ model: second, displayName: "Second" })).toThrow(
      ModelRegistrationConflictError,
    );
    expect(registry.resolve("fake/same").model).toBe(first);
  });

  it("distinguishes malformed keys from valid but missing models", () => {
    const registry = new ModelRegistry();

    expect(() => registry.resolve("malformed")).toThrow(ModelContractValidationError);
    expect(() => registry.resolve("fake/missing")).toThrow(ModelNotFoundError);
  });

  it("validates adapter descriptors at the registration boundary", () => {
    const registry = new ModelRegistry();

    expect(() => registry.register({ model: fakeModel("fake", "valid"), displayName: "" })).toThrow(
      ModelContractValidationError,
    );
  });

  it("does not choose a different compatible model when the selected one is missing", () => {
    const registry = new ModelRegistry([
      { model: fakeModel("fake", "available"), displayName: "Available" },
    ]);

    expect(() => registry.resolve("fake/requested", simpleRequest())).toThrow(ModelNotFoundError);
  });
});

describe("model capability checks", () => {
  it("reports every unsupported requirement in one deterministic result", () => {
    const issues = inspectModelCapabilities(minimalCapabilities, demandingRequest());

    expect(issues.map(({ capability }) => capability)).toEqual([
      "nativeToolCalling",
      "parallelToolCalls",
      "structuredOutput",
      "vision",
      "systemMessages",
      "reasoning",
      "configurableReasoningEffort",
      "maxOutputTokens",
    ]);
    expect(Object.isFrozen(issues)).toBe(true);
    expect(Object.isFrozen(issues[0])).toBe(true);
  });

  it("allows a request when every required capability is present", () => {
    expect(inspectModelCapabilities(fullCapabilities, demandingRequest())).toEqual([]);
  });

  it("treats an unpublished output-token limit as unknown rather than unsupported", () => {
    const { maxOutputTokens: _omitted, ...capabilitiesWithoutLimit } = fullCapabilities;

    expect(inspectModelCapabilities(capabilitiesWithoutLimit, demandingRequest())).toEqual([]);
  });

  it("rejects an incompatible selected model with safe structured issues", () => {
    const registry = new ModelRegistry([
      {
        model: fakeModel("fake", "text-only", minimalCapabilities),
        displayName: "Text only",
      },
    ]);

    expect(() => registry.resolve("fake/text-only", demandingRequest())).toThrow(
      ModelCapabilityError,
    );

    try {
      registry.resolve("fake/text-only", demandingRequest());
    } catch (error) {
      expect(error).toBeInstanceOf(ModelCapabilityError);
      expect((error as ModelCapabilityError).issues).toHaveLength(8);
      expect((error as ModelCapabilityError).metadata).not.toHaveProperty("request");
    }
  });

  it("requires streaming because the runtime consumes only normalized streams", () => {
    const capabilities = { ...minimalCapabilities, streaming: false };

    expect(inspectModelCapabilities(capabilities, simpleRequest())).toMatchObject([
      { capability: "streaming", required: true, actual: false },
    ]);
  });
});
