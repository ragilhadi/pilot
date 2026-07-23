import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { messageId, parseAgentMessage, runId, sessionId, type AgentMessage } from "@pilotrun/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteRepositories,
  diagnoseSqliteDatabase,
  SqliteDatabase,
  SqliteMigrationRunner,
  SqliteSessionAdministration,
} from "../src/index.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function open(pathname = ":memory:") {
  const database = new SqliteDatabase(pathname);
  new SqliteMigrationRunner(database).migrate();
  const repositories = createSqliteRepositories(database);
  return {
    database,
    repositories,
    administration: new SqliteSessionAdministration(database, repositories),
  };
}

function userMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return parseAgentMessage({
    schemaVersion: 1,
    id: messageId("message-1"),
    sessionId: sessionId("session-1"),
    runId: runId("run-1"),
    role: "user",
    status: "complete",
    parts: [{ type: "text", text: "token literal-secret" }],
    createdAt: "2026-07-22T06:00:01.000Z",
    provenance: { kind: "user", channel: "cli" },
    metadata: { apiKey: "key-must-not-export" },
    ...overrides,
  });
}

describe("SqliteSessionAdministration", () => {
  it("lists, filters, and resumes sessions in stable recency order", async () => {
    const { database, repositories, administration } = open();
    await repositories.sessions.create({
      id: sessionId("older"),
      createdAt: "2026-07-22T06:00:00.000Z",
    });
    await repositories.sessions.create({
      id: sessionId("newer"),
      createdAt: "2026-07-22T06:01:00.000Z",
    });
    administration.archive(sessionId("older"), "2026-07-22T06:02:00.000Z");

    expect(administration.list().map(({ id }) => id)).toEqual(["older", "newer"]);
    expect(administration.list({ status: "active" })).toMatchObject([
      { id: "newer", status: "active", messageCount: 0 },
    ]);
    expect(await administration.resume(sessionId("newer"))).toMatchObject({ id: "newer" });
    expect(await administration.resume(sessionId("missing"))).toBeUndefined();
    database.close();
  });

  it("forks a bounded history with new identities and source provenance", async () => {
    const { database, repositories, administration } = open();
    const source = sessionId("session-1");
    await repositories.sessions.create({
      id: source,
      createdAt: "2026-07-22T06:00:00.000Z",
      initialMessages: [
        userMessage(),
        userMessage({
          id: messageId("message-2"),
          parentId: messageId("message-1"),
          createdAt: "2026-07-22T06:00:02.000Z",
        }),
      ],
    });
    const ids = [messageId("fork-message-1"), messageId("fork-message-2")];
    const forked = await administration.fork({
      sourceId: source,
      id: sessionId("fork-1"),
      createdAt: "2026-07-22T07:00:00.000Z",
      throughMessageId: messageId("message-1"),
      nextMessageId: () => {
        const next = ids.shift();
        if (next === undefined) throw new Error("ID fixture exhausted");
        return next;
      },
    });

    expect(forked).toMatchObject({
      id: "fork-1",
      revision: 1,
      messages: [
        {
          id: "fork-message-1",
          sessionId: "fork-1",
          metadata: {
            forkedFromMessageId: "message-1",
            originalCreatedAt: "2026-07-22T06:00:01.000Z",
          },
        },
      ],
    });
    expect(forked.messages[0]).not.toHaveProperty("runId");
    expect(administration.list().find(({ id }) => id === "fork-1")).toMatchObject({
      parentSessionId: "session-1",
    });
    expect((await repositories.sessions.load(source))?.messages).toHaveLength(2);
    database.close();
  });

  it("exports a complete audit trail with default key and literal redaction", async () => {
    const { database, repositories, administration } = open();
    const session = sessionId("session-1");
    const run = runId("run-1");
    await repositories.sessions.create({
      id: session,
      createdAt: "2026-07-22T06:00:00.000Z",
      initialMessages: [userMessage()],
    });
    await repositories.runs.create({
      id: run,
      sessionId: session,
      status: "completed",
      state: { kind: "completed" },
      startedAt: "2026-07-22T06:00:01.000Z",
      updatedAt: "2026-07-22T06:00:03.000Z",
      completedAt: "2026-07-22T06:00:03.000Z",
    });
    await repositories.checkpoints.append({
      runId: run,
      sequence: 1,
      reason: "run.terminal",
      payload: { authorization: "Bearer private", note: "literal-secret" },
      createdAt: "2026-07-22T06:00:03.000Z",
    });

    const exported = await administration.export(session, {
      exportedAt: "2026-07-22T06:10:00.000Z",
      secretValues: ["literal-secret"],
    });
    const serialized = JSON.stringify(exported);
    expect(exported).toMatchObject({ schemaVersion: 1, session: { id: "session-1" } });
    expect(serialized).not.toContain("key-must-not-export");
    expect(serialized).not.toContain("Bearer private");
    expect(serialized).not.toContain("literal-secret");
    expect(serialized).toContain("[REDACTED]");

    const unredacted = await administration.export(session, {
      exportedAt: "2026-07-22T06:10:00.000Z",
      redact: false,
    });
    expect(JSON.stringify(unredacted)).toContain("key-must-not-export");
    database.close();
  });

  it("deletes sessions with cascaded activity and applies bounded archived retention", async () => {
    const { database, repositories, administration } = open();
    const old = sessionId("old");
    const active = sessionId("active");
    await repositories.sessions.create({ id: old, createdAt: "2026-01-01T00:00:00.000Z" });
    await repositories.sessions.create({
      id: active,
      createdAt: "2026-07-22T00:00:00.000Z",
    });
    administration.archive(old, "2026-01-02T00:00:00.000Z");

    expect(
      administration.applyRetention({
        archivedBefore: "2026-06-01T00:00:00.000Z",
        dryRun: true,
      }),
    ).toEqual({ candidateSessionIds: ["old"], deletedSessions: 0 });
    expect(await repositories.sessions.load(old)).toBeDefined();
    expect(administration.applyRetention({ archivedBefore: "2026-06-01T00:00:00.000Z" })).toEqual({
      candidateSessionIds: ["old"],
      deletedSessions: 1,
    });
    expect(await repositories.sessions.load(old)).toBeUndefined();

    const deletion = administration.delete(active);
    expect(deletion).toEqual({ deleted: true, sessions: 1, messages: 0, runs: 0 });
    expect(administration.delete(active).deleted).toBe(false);
    database.close();
  });
});

describe("SQLite backup and diagnostics", () => {
  it("creates a consistent online backup that opens and passes diagnostics", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pilot-backup-"));
    cleanupDirectories.push(directory);
    const sourcePath = path.join(directory, "source.db");
    const backupPath = path.join(directory, "backup.db");
    const source = open(sourcePath);
    await source.repositories.sessions.create({
      id: sessionId("session-1"),
      createdAt: "2026-07-22T06:00:00.000Z",
    });

    expect(diagnoseSqliteDatabase(source.database)).toEqual({
      healthy: true,
      integrityMessages: ["ok"],
      foreignKeyViolationCount: 0,
      schemaVersion: 1,
      migrationCount: 1,
    });
    await source.database.backupTo(backupPath);
    source.database.close();

    const backup = open(backupPath);
    expect(await backup.repositories.sessions.load(sessionId("session-1"))).toBeDefined();
    expect(diagnoseSqliteDatabase(backup.database).healthy).toBe(true);
    backup.database.close();
  });

  it("reports foreign-key corruption instead of declaring the database healthy", () => {
    const { database } = open();
    database.exec("PRAGMA foreign_keys = OFF");
    database
      .prepare(
        `INSERT INTO runs(id, session_id, status, state_json, started_at, updated_at)
         VALUES ('orphan', 'missing', 'queued', '{}', 'now', 'now')`,
      )
      .run();
    database.exec("PRAGMA foreign_keys = ON");

    expect(diagnoseSqliteDatabase(database)).toMatchObject({
      healthy: false,
      foreignKeyViolationCount: 1,
    });
    database.close();
  });
});
