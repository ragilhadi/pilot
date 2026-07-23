import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { messageId, parseAgentMessage, runId, sessionId, toolCallId } from "@pilot/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteRepositories,
  SqliteDatabase,
  SqliteMigrationRunner,
  SqliteRecordError,
} from "../src/index.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pilot-records-"));
  cleanupDirectories.push(directory);
  return path.join(directory, "pilot.db");
}

function open(pathname = ":memory:") {
  const database = new SqliteDatabase(pathname);
  new SqliteMigrationRunner(database).migrate();
  return { database, repositories: createSqliteRepositories(database) };
}

async function seedRun(pathname = ":memory:") {
  const opened = open(pathname);
  const session = sessionId("session-1");
  const run = runId("run-1");
  await opened.repositories.sessions.create({
    id: session,
    createdAt: "2026-07-22T03:00:00.000Z",
  });
  await opened.repositories.runs.create({
    id: run,
    sessionId: session,
    status: "running",
    state: { kind: "waiting-for-model", revision: 1 },
    startedAt: "2026-07-22T03:00:01.000Z",
    updatedAt: "2026-07-22T03:00:01.000Z",
  });
  return { ...opened, run, session };
}

describe("SQLite persistence repositories", () => {
  it("persists normalized messages across database reopen", async () => {
    const file = await databasePath();
    const first = open(file);
    const session = sessionId("session-1");
    await first.repositories.sessions.create({
      id: session,
      createdAt: "2026-07-22T10:00:00+07:00",
    });
    await first.repositories.sessions.appendMessage(
      parseAgentMessage({
        schemaVersion: 1,
        id: messageId("message-1"),
        sessionId: session,
        runId: runId("run-not-yet-recorded"),
        role: "user",
        status: "complete",
        parts: [{ type: "text", text: "Persist me" }],
        createdAt: "2026-07-22T03:00:01.000Z",
        provenance: { kind: "user", channel: "cli" },
        metadata: { source: "test" },
      }),
    );
    first.database.close();

    const second = open(file);
    const loaded = await second.repositories.sessions.load(session);
    expect(loaded).toMatchObject({
      revision: 1,
      createdAt: "2026-07-22T03:00:00.000Z",
      messages: [
        {
          id: "message-1",
          runId: "run-not-yet-recorded",
          parts: [{ type: "text", text: "Persist me" }],
          metadata: { source: "test" },
        },
      ],
    });
    expect(Object.isFrozen(loaded)).toBe(true);
    second.database.close();
  });

  it("round-trips a complete run audit trail in deterministic order", async () => {
    const { database, repositories, run, session } = await seedRun();
    const call = toolCallId("call-1");

    await repositories.modelCalls.save({
      id: "model-call-1",
      runId: run,
      sequence: 1,
      modelKey: "ollama/glm-5.2:cloud",
      status: "started",
      request: { cycle: 1 },
      startedAt: "2026-07-22T03:00:02.000Z",
    });
    await repositories.modelCalls.save({
      id: "model-call-1",
      runId: run,
      sequence: 1,
      modelKey: "ollama/glm-5.2:cloud",
      status: "completed",
      request: { cycle: 1 },
      response: { finishReason: "tool-calls" },
      startedAt: "2026-07-22T03:00:02.000Z",
      completedAt: "2026-07-22T03:00:03.000Z",
    });
    await repositories.toolActivity.saveCall({
      runId: run,
      callId: call,
      sequence: 1,
      toolName: "read_file",
      risk: "read-only",
      replaySafety: "safe",
      status: "completed",
      input: { path: "README.md" },
      startedAt: "2026-07-22T03:00:03.000Z",
      completedAt: "2026-07-22T03:00:04.000Z",
    });
    await repositories.toolActivity.saveResult({
      runId: run,
      callId: call,
      output: { text: "Pilot" },
      isError: false,
      createdAt: "2026-07-22T03:00:04.000Z",
    });
    await repositories.permissions.append({
      sequence: 1,
      occurredAt: "2026-07-22T03:00:03.000Z",
      context: { runId: run, callId: call, sessionId: session },
      action: {
        kind: "tool",
        risk: "read-only",
        name: "read_file",
        fingerprint: `sha256:${"0".repeat(64)}`,
      },
      decision: {
        effect: "allow",
        reason: "Read-only tool",
        actionFingerprint: `sha256:${"0".repeat(64)}`,
        source: "builtin",
        evaluatedRuleIds: ["builtin-read"],
      },
    });
    await repositories.usage.append({
      runId: run,
      modelCallId: "model-call-1",
      sequence: 1,
      usage: { inputTokens: 12, outputTokens: 4, source: "provider" },
      occurredAt: "2026-07-22T03:00:03.000Z",
    });
    await repositories.checkpoints.append({
      runId: run,
      sequence: 1,
      reason: "model.stream.event",
      payload: { state: { kind: "receiving-model-stream" } },
      createdAt: "2026-07-22T03:00:03.000Z",
    });
    await repositories.runs.save({
      id: run,
      sessionId: session,
      status: "completed",
      state: { kind: "completed", revision: 2 },
      startedAt: "2026-07-22T03:00:01.000Z",
      updatedAt: "2026-07-22T03:00:05.000Z",
      completedAt: "2026-07-22T03:00:05.000Z",
    });

    expect(await repositories.runs.load(run)).toMatchObject({
      status: "completed",
      state: { kind: "completed", revision: 2 },
    });
    expect(await repositories.modelCalls.listByRun(run)).toMatchObject([
      { id: "model-call-1", status: "completed", response: { finishReason: "tool-calls" } },
    ]);
    expect(await repositories.toolActivity.listCallsByRun(run)).toMatchObject([
      { callId: "call-1", toolName: "read_file", input: { path: "README.md" } },
    ]);
    expect(await repositories.toolActivity.listResultsByRun(run)).toMatchObject([
      { callId: "call-1", output: { text: "Pilot" }, isError: false },
    ]);
    expect(await repositories.permissions.listByRun(run)).toHaveLength(1);
    expect(await repositories.usage.listByRun(run)).toMatchObject([
      { sequence: 1, usage: { inputTokens: 12, outputTokens: 4, source: "provider" } },
    ]);
    expect(await repositories.checkpoints.listByRun(run)).toMatchObject([
      { sequence: 1, reason: "model.stream.event" },
    ]);
    database.close();
  });

  it("keeps tool results and usage linked to existing activity", async () => {
    const { database, repositories, run } = await seedRun();

    await expect(
      repositories.toolActivity.saveResult({
        runId: run,
        callId: toolCallId("missing"),
        output: {},
        isError: true,
        createdAt: "2026-07-22T03:00:02.000Z",
      }),
    ).rejects.toThrow();
    await expect(
      repositories.usage.append({
        runId: run,
        modelCallId: "missing",
        sequence: 1,
        usage: { outputTokens: 1, source: "provider" },
        occurredAt: "2026-07-22T03:00:02.000Z",
      }),
    ).rejects.toThrow();
    database.close();
  });

  it("fails safely when stored JSON is corrupted", async () => {
    const { database, repositories, run } = await seedRun();
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.prepare("UPDATE runs SET state_json = 'not-json' WHERE id = ?").run(run);

    await expect(repositories.runs.load(run)).rejects.toThrowError(SqliteRecordError);
    database.close();
  });
});
