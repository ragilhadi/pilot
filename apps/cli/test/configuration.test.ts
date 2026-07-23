import { InstructionDiscovery, ModelRegistry } from "@pilotrun/agent-runtime";
import { resolveConfiguration } from "@pilotrun/core";
import { FakeLanguageModel, textResponseScript } from "@pilotrun/testkit";
import { describe, expect, it } from "vitest";
import {
  defaultConfigurationPaths,
  loadCliConfiguration,
  runCli,
  type TextWriter,
} from "../src/index.js";

function writer(): TextWriter & { text(): string } {
  let value = "";
  return {
    write(text) {
      value += text;
    },
    text: () => value,
  };
}

describe("CLI configuration loading", () => {
  it("loads optional global/project JSONC and exposes effective provenance", async () => {
    const files: Readonly<Record<string, string>> = {
      global:
        '{ "model": { "default": "fake/global" }, // comment\n "context": { "maxFileBytes": 2000 } }',
      project:
        '{ "model": { "default": "fake/project", }, "persistence": { "checkpointIntervalMs": 75 } }',
    };
    const effective = await loadCliConfiguration({
      paths: { global: "global", project: "project" },
      readOptional: async (file) => files[file],
    });

    expect(effective.configuration).toMatchObject({
      model: { default: "fake/project" },
      context: { maxFileBytes: 2_000 },
      persistence: { checkpointIntervalMs: 75 },
    });
    expect(effective.provenance["model.default"]).toMatchObject({
      source: "project",
      location: "project",
    });
  });

  it("derives stable global and project paths with an explicit global override", () => {
    expect(
      defaultConfigurationPaths({
        dataDirectory: "/data/pilot",
        workspaceDirectory: "/repo",
        environment: { PILOT_CONFIG: "/custom/config.jsonc" },
      }),
    ).toEqual({ global: "/custom/config.jsonc", project: expect.stringMatching(/repo.*\.pilot/u) });
  });

  it("renders configuration and uses its default model for run", async () => {
    const configuration = resolveConfiguration([
      {
        source: "global",
        location: "test",
        value: { model: { default: "fake/configured" } },
      },
    ]);
    const model = new FakeLanguageModel({
      providerId: "fake",
      modelId: "configured",
      scripts: [textResponseScript({ responseId: "configured", deltas: ["Configured"] })],
    });
    const registry = new ModelRegistry([{ model, displayName: "Configured fake" }]);
    const stdout = writer();
    const stderr = writer();
    const dependencies = {
      registry,
      configuration,
      clock: { now: () => new Date("2026-07-22T08:00:00.000Z") },
      ids: { next: () => "id" },
      stdout,
      stderr,
      signal: new AbortController().signal,
    };

    expect(await runCli(["config", "--json"], dependencies)).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      configuration: { model: { default: "fake/configured" } },
      provenance: { "model.default": { source: "global" } },
    });

    const runOutput = writer();
    expect(await runCli(["run", "hello"], { ...dependencies, stdout: runOutput })).toBe(0);
    expect(model.calls).toHaveLength(1);
    expect(stderr.text()).toBe("");
  });

  it("displays scoped instruction trust, provenance, and precedence", async () => {
    const configuration = resolveConfiguration([]);
    const instructionDiscovery = new InstructionDiscovery({
      async read(request) {
        const content =
          request.kind === "global"
            ? "Global guidance"
            : request.path === "AGENTS.md"
              ? "Project guidance"
              : request.path === "src/AGENTS.md"
                ? "Source guidance"
                : undefined;
        return content === undefined
          ? { status: "missing" as const }
          : {
              status: "found" as const,
              displayPath: request.path,
              realPath: request.path,
              content,
              bytes: content.length,
            };
      },
    });
    const stdout = writer();
    const stderr = writer();

    expect(
      await runCli(["instructions", "src/file.ts"], {
        registry: new ModelRegistry([]),
        configuration,
        instructionDiscovery,
        instructionGlobalPath: "/global/AGENTS.md",
        clock: { now: () => new Date("2026-07-22T08:00:00.000Z") },
        ids: { next: () => "id" },
        stdout,
        stderr,
        signal: new AbortController().signal,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain("trusted-user");
    expect(stdout.text()).toContain("untrusted-project");
    expect(stdout.text()).toContain("Source guidance");
    expect(stdout.text()).toContain("semantic conflicts require review");
    expect(stderr.text()).toBe("");
  });
});
