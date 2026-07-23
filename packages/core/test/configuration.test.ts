import {
  builtinConfiguration,
  ConfigurationError,
  maximumConfigurationBytes,
  MissingConfigurationEnvironmentError,
  parseJsonConfiguration,
  resolveConfiguration,
  resolveEnvironmentReference,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("JSONC configuration parsing", () => {
  it("supports BOM, comments, trailing commas, and comment markers inside strings", () => {
    const parsed = parseJsonConfiguration(
      '\uFEFF{\n  // global default\n  "schemaVersion": 1,\n  "model": { "default": "ollama/glm-5.2:cloud", },\n  /* bounded persistence */\n  "persistence": { "dataDirectory": "C://pilot/*literal*/", },\n}',
      "config.jsonc",
    );

    expect(parsed).toEqual({
      schemaVersion: 1,
      model: { default: "ollama/glm-5.2:cloud" },
      persistence: { dataDirectory: "C://pilot/*literal*/" },
    });
  });

  it("rejects unknown keys, raw secret strings, malformed input, and oversized files", () => {
    expect(() => parseJsonConfiguration('{"unknown":true}', "unknown.jsonc")).toThrowError(
      ConfigurationError,
    );
    expect(() =>
      parseJsonConfiguration('{"secrets":{"github":"raw-secret"}}', "secret.jsonc"),
    ).toThrowError(ConfigurationError);
    expect(() => parseJsonConfiguration("{/* unterminated", "broken.jsonc")).toThrowError(
      ConfigurationError,
    );
    expect(() =>
      parseJsonConfiguration(`{"model":{} }${" ".repeat(maximumConfigurationBytes)}`, "large"),
    ).toThrowError(ConfigurationError);
    expect(() =>
      parseJsonConfiguration('{"context":{"maxToolResultBytes":511}}', "small-tool-result"),
    ).toThrowError(ConfigurationError);
  });
});

describe("configuration resolution", () => {
  it("applies fixed source precedence, deep object merge, and array replacement", () => {
    const effective = resolveConfiguration([
      {
        source: "cli",
        location: "--model",
        value: { model: { default: "fake/cli" } },
      },
      {
        source: "project",
        location: "/repo/.pilot/config.jsonc",
        value: {
          model: { default: "fake/project" },
          context: { maxFileBytes: 2_000 },
          permissions: {
            rules: [
              {
                id: "project-read",
                source: "project",
                effect: "allow",
                reason: "Project read policy",
                matcher: { kind: "tool", toolName: "read_file" },
              },
            ],
          },
        },
      },
      {
        source: "global",
        location: "/home/config.jsonc",
        value: {
          persistence: { checkpointIntervalMs: 500 },
          context: { maxInputTokens: 64_000 },
          permissions: {
            rules: [
              {
                id: "global-commands",
                source: "global",
                effect: "ask",
                reason: "Ask for commands",
                matcher: { kind: "action-kind", actionKind: "command" },
              },
            ],
          },
        },
      },
    ]);

    expect(effective.configuration).toMatchObject({
      model: { default: "fake/cli" },
      persistence: { checkpointIntervalMs: 500 },
      context: {
        maxInputTokens: 64_000,
        reservedOutputTokens: builtinConfiguration.context.reservedOutputTokens,
        maxFileBytes: 2_000,
      },
      permissions: { rules: [{ id: "global-commands" }, { id: "project-read" }] },
    });
    expect(effective.provenance).toMatchObject({
      "model.default": { source: "cli", location: "--model" },
      "persistence.checkpointIntervalMs": { source: "global", location: "/home/config.jsonc" },
      "context.maxFileBytes": {
        source: "project",
        location: "/repo/.pilot/config.jsonc",
      },
      "permissions.rules": {
        source: "project",
        location: "/repo/.pilot/config.jsonc",
      },
      "permissions.rules.global-commands": { source: "global" },
      "permissions.rules.project-read": { source: "project" },
    });
    expect(Object.isFrozen(effective.configuration)).toBe(true);
    expect(Object.isFrozen(effective.provenance)).toBe(true);
  });

  it("validates cross-field constraints after merging all layers", () => {
    expect(() =>
      resolveConfiguration([
        {
          source: "project",
          location: "project",
          value: { context: { maxInputTokens: 1_000, reservedOutputTokens: 1_000 } },
        },
      ]),
    ).toThrowError(ConfigurationError);
    expect(() =>
      resolveConfiguration([
        {
          source: "project",
          location: "project",
          value: {
            context: { maxInstructionBytes: 2_000, maxInstructionTotalBytes: 1_000 },
          },
        },
      ]),
    ).toThrowError(ConfigurationError);
  });

  it("prevents lower-trust layers from spoofing authority or redirecting durable storage", () => {
    expect(() =>
      resolveConfiguration([
        {
          source: "project",
          location: "project",
          value: {
            permissions: {
              rules: [
                {
                  id: "spoofed",
                  source: "cli",
                  effect: "allow",
                  reason: "Pretend to be CLI",
                  matcher: { kind: "any" },
                },
              ],
            },
          },
        },
      ]),
    ).toThrowError(ConfigurationError);
    expect(() =>
      resolveConfiguration([
        {
          source: "project",
          location: "project",
          value: { persistence: { dataDirectory: "/outside" } },
        },
      ]),
    ).toThrowError(ConfigurationError);
  });

  it("preserves references rather than interpolating arbitrary configuration strings", () => {
    const uninterpolatedDirectory = ["$", "{SHOULD_NOT_EXPAND}"].join("");
    const effective = resolveConfiguration([
      {
        source: "global",
        location: "global",
        value: {
          persistence: { dataDirectory: uninterpolatedDirectory },
          secrets: {
            github: { variable: "GITHUB_TOKEN" },
            optional: { variable: "OPTIONAL_TOKEN", required: false },
          },
        },
      },
    ]);

    const github = effective.configuration.secrets.github;
    const optional = effective.configuration.secrets.optional;
    if (github === undefined || optional === undefined) throw new Error("Secret fixtures missing");
    expect(effective.configuration.persistence.dataDirectory).toBe(uninterpolatedDirectory);
    expect(resolveEnvironmentReference(github, { GITHUB_TOKEN: "resolved-secret" })).toBe(
      "resolved-secret",
    );
    expect(resolveEnvironmentReference(optional, {})).toBeUndefined();
    expect(() => resolveEnvironmentReference(github, {})).toThrowError(
      MissingConfigurationEnvironmentError,
    );
    expect(JSON.stringify(effective)).not.toContain("resolved-secret");
  });
});
