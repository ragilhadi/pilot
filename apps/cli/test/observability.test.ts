import { ModelRegistry } from "@pilot/agent-runtime";
import {
  createSqliteRepositories,
  SqliteDatabase,
  SqliteMigrationRunner,
  SqliteSessionAdministration,
} from "@pilot/persistence-sqlite";
import { FakeLanguageModel, textResponseScript } from "@pilot/testkit";
import { describe, expect, it } from "vitest";
import {
  inspectProviderCredentials,
  PilotDoctor,
  redactStructuredValue,
  runCli,
  StructuredLogger,
  type TextWriter,
} from "../src/index.js";

describe("pilot doctor", () => {
  it("reports complete timed environment diagnostics through the CLI", async () => {
    const database = new SqliteDatabase(":memory:");
    new SqliteMigrationRunner(database).migrate();
    const repositories = createSqliteRepositories(database);
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const doctor = new PilotDoctor({
      now: () => new Date("2026-07-22T04:00:00.000Z"),
      monotonicNow: increasingClock(),
      startedAtMs: 0,
      nodeVersion: "v24.18.0",
      memoryRssBytes: () => 64_000_000,
      workspacePath: "C:/workspace",
      database,
      providerCredentials: [],
      probeCommand: async () => true,
      checkWorkspaceAccess: async () => undefined,
    });

    expect(
      await runCli(["doctor", "--json"], {
        registry: fakeRegistry(),
        clock: { now: () => new Date("2026-07-22T04:00:00.000Z") },
        ids: { next: () => "doctor-id" },
        stdout,
        stderr,
        signal: new AbortController().signal,
        doctor,
        persistence: {
          database,
          repositories,
          administration: new SqliteSessionAdministration(database, repositories),
        },
      }),
    ).toBe(0);

    const report = JSON.parse(stdout.text());
    expect(report).toMatchObject({
      healthy: true,
      generatedAt: "2026-07-22T04:00:00.000Z",
      memoryRssBytes: 64_000_000,
    });
    expect(report.startupMs).toBeGreaterThan(0);
    expect(report.checks.map(({ id }: { readonly id: string }) => id)).toEqual([
      "node",
      "configuration",
      "provider:credentials",
      "database",
      "workspace",
      "git",
      "shell",
      "plugins",
    ]);
    expect(
      report.checks.every(({ durationMs }: { readonly durationMs: number }) => durationMs > 0),
    ).toBe(true);
    expect(stderr.text()).toBe("");
    database.close();
  });

  it("fails safely with actionable remediation while revealing no credential value", async () => {
    const secret = "seeded-super-secret";
    const doctor = new PilotDoctor({
      now: () => new Date("2026-07-22T04:00:00.000Z"),
      monotonicNow: increasingClock(),
      startedAtMs: 0,
      nodeVersion: "v20.0.0",
      memoryRssBytes: () => 1,
      workspacePath: "C:/denied",
      providerCredentials: [
        { provider: "example", environmentVariable: "EXAMPLE_API_KEY", configured: false },
      ],
      probeCommand: async () => false,
      checkWorkspaceAccess: async () => {
        throw new Error(secret);
      },
    });

    const report = await doctor.diagnose();
    const serialized = JSON.stringify(report);
    expect(report.healthy).toBe(false);
    expect(report.checks.filter(({ status }) => status === "fail")).toHaveLength(6);
    expect(report.checks.find(({ id }) => id === "provider:example")).toMatchObject({
      remediation: expect.stringContaining("EXAMPLE_API_KEY"),
    });
    expect(serialized).not.toContain(secret);
  });
});

describe("structured observability", () => {
  it("emits command, first-token, and usage latency records with correlation fields", async () => {
    const logs = memoryWriter();
    const stdout = memoryWriter();
    const model = new FakeLanguageModel({
      providerId: "fake",
      modelId: "telemetry",
      scripts: [
        textResponseScript({
          responseId: "telemetry-response",
          deltas: ["Measured"],
          usage: {
            source: "provider",
            inputTokens: 12,
            outputTokens: 3,
            estimatedCostUsd: 0.001,
          },
        }),
      ],
    });
    const logger = new StructuredLogger({
      writer: logs,
      level: "info",
      now: () => new Date("2026-07-22T04:00:00.000Z"),
    });

    expect(
      await runCli(["run", "--model", "fake/telemetry", "measure"], {
        registry: new ModelRegistry([{ model, displayName: "Telemetry Fake" }]),
        clock: { now: () => new Date("2026-07-22T04:00:00.000Z") },
        ids: sequentialIds(),
        stdout,
        stderr: memoryWriter(),
        signal: new AbortController().signal,
        monotonicNow: increasingClock(),
        logger,
      }),
    ).toBe(0);

    const records = logs
      .text()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map(({ event }) => event)).toEqual([
      "cli.command.started",
      "model.first_token",
      "model.usage",
      "cli.command.completed",
    ]);
    expect(records[1]?.fields).toMatchObject({
      sessionId: "telemetry-1",
      runId: "telemetry-2",
      agentId: "main",
      provider: "fake",
      model: "telemetry",
      retryCount: 0,
      durationMs: 1,
    });
    expect(records[2]?.fields).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      costUsd: 0.001,
    });
    expect(records[3]?.fields).toMatchObject({ command: "run", exitCode: 0 });
  });

  it("honors log levels and recursively redacts secret keys, values, and control characters", () => {
    const writer = memoryWriter();
    const secret = "sk-seeded-value";
    const logger = new StructuredLogger({
      writer,
      level: "info",
      now: () => new Date("2026-07-22T04:00:00.000Z"),
      secrets: [secret],
    });

    logger.log("debug", "hidden", { value: "not emitted" });
    logger.log("info", "tool.completed\u001b", {
      sessionId: "session-1",
      runId: "run-1",
      tool: "run_command",
      durationMs: 12.5,
      authorization: `Bearer ${secret}`,
      nested: { clientSecret: "another-secret", note: `credential=${secret}\u001b[31m` },
    });

    const text = writer.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("\u001b");
    expect(JSON.parse(text)).toEqual({
      timestamp: "2026-07-22T04:00:00.000Z",
      level: "info",
      event: "tool.completed�",
      fields: {
        sessionId: "session-1",
        runId: "run-1",
        tool: "run_command",
        durationMs: 12.5,
        authorization: "[REDACTED]",
        nested: { clientSecret: "[REDACTED]", note: "credential=[REDACTED]�[31m" },
      },
    });
  });

  it("redacts standalone diagnostic structures without mutating the input", () => {
    const input = { password: "visible", message: "token abc12345", safe: true };
    expect(redactStructuredValue(input, ["abc12345"])).toEqual({
      password: "[REDACTED]",
      message: "token [REDACTED]",
      safe: true,
    });
    expect(input.password).toBe("visible");
  });

  it("inspects credential presence without returning secret values", () => {
    const secret = "credential-secret-value";
    const environment = {
      EXAMPLE_API_KEY: secret,
      PILOT_OPENAI_COMPATIBLE_MODELS_JSON: JSON.stringify([
        {
          provider: {
            providerId: "example",
            type: "openai-compatible",
            baseUrl: "https://example.invalid/v1",
            auth: { type: "environment", variable: "EXAMPLE_API_KEY" },
          },
          modelId: "test",
          displayName: "Test",
          capabilities: {
            streaming: true,
            nativeToolCalling: false,
            parallelToolCalls: false,
            structuredOutput: false,
            vision: false,
            promptCaching: false,
            reasoning: false,
            configurableReasoningEffort: false,
            systemMessages: true,
          },
        },
      ]),
    };
    const result = inspectProviderCredentials(environment);
    expect(result).toEqual([
      { provider: "example", environmentVariable: "EXAMPLE_API_KEY", configured: true },
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

function fakeRegistry(): ModelRegistry {
  return new ModelRegistry([
    {
      model: new FakeLanguageModel({
        providerId: "fake",
        modelId: "doctor",
        scripts: [textResponseScript({ responseId: "unused", deltas: ["unused"] })],
      }),
      displayName: "Doctor Fake",
    },
  ]);
}

function increasingClock(): () => number {
  let value = 0;
  return () => ++value;
}

function sequentialIds() {
  let value = 0;
  return { next: () => `telemetry-${++value}` };
}

function memoryWriter(): TextWriter & { readonly text: () => string } {
  let content = "";
  return {
    write(text) {
      content += text;
    },
    text: () => content,
  };
}
