import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  pilotMigrations,
  SqliteDatabase,
  SqliteMigrationError,
  SqliteMigrationRunner,
  SqlitePersistenceError,
} from "../src/index.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pilot-sqlite-"));
  cleanupDirectories.push(directory);
  return path.join(directory, "pilot.db");
}

describe("SqliteDatabase", () => {
  it("commits successful transactions and rolls failed transactions back", () => {
    const database = new SqliteDatabase(":memory:");
    database.exec("CREATE TABLE values_table (value TEXT NOT NULL) STRICT");

    database.transaction((transaction) => {
      transaction.prepare("INSERT INTO values_table(value) VALUES (?)").run("committed");
    });
    expect(database.prepare("SELECT value FROM values_table").all()).toEqual([
      { value: "committed" },
    ]);

    expect(() =>
      database.transaction((transaction) => {
        transaction.prepare("INSERT INTO values_table(value) VALUES (?)").run("rolled-back");
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(database.prepare("SELECT value FROM values_table").all()).toEqual([
      { value: "committed" },
    ]);
    database.close();
  });

  it("rejects implicit nested transactions and use after close", () => {
    const database = new SqliteDatabase(":memory:");
    expect(() => database.transaction(() => database.transaction(() => undefined))).toThrowError(
      SqlitePersistenceError,
    );

    database.close();
    expect(() => database.exec("SELECT 1")).toThrowError(SqlitePersistenceError);
    database.close();
  });

  it("rolls back callbacks that accidentally cross an asynchronous boundary", () => {
    const database = new SqliteDatabase(":memory:");
    database.exec("CREATE TABLE values_table (value TEXT NOT NULL) STRICT");

    expect(() =>
      database.transaction((transaction) => {
        transaction.exec("INSERT INTO values_table(value) VALUES ('not-committed')");
        return Promise.resolve();
      }),
    ).toThrowError(SqlitePersistenceError);
    expect(database.prepare("SELECT value FROM values_table").all()).toEqual([]);
    database.close();
  });
});

describe("SqliteMigrationRunner", () => {
  it("applies the schema once and preserves its version across reopen", async () => {
    const file = await databasePath();
    const first = new SqliteDatabase(file);
    const result = new SqliteMigrationRunner(first, pilotMigrations, {
      now: () => new Date("2026-07-22T02:00:00.000Z"),
    }).migrate();

    expect(result).toMatchObject({ currentVersion: 1 });
    expect(result.applied).toEqual([
      {
        version: 1,
        name: "initial-persistence-schema",
        checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        appliedAt: "2026-07-22T02:00:00.000Z",
      },
    ]);
    expect(
      first
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name),
    ).toEqual(
      expect.arrayContaining([
        "checkpoints",
        "events",
        "message_parts",
        "messages",
        "model_calls",
        "permission_decisions",
        "runs",
        "sessions",
        "tool_calls",
        "tool_results",
        "usage_records",
      ]),
    );
    first.close();

    const reopened = new SqliteDatabase(file);
    expect(new SqliteMigrationRunner(reopened).migrate()).toEqual({
      currentVersion: 1,
      applied: [],
    });
    reopened.close();
  });

  it("enforces foreign keys in every opened connection", () => {
    const database = new SqliteDatabase(":memory:");
    new SqliteMigrationRunner(database).migrate();

    expect(() =>
      database
        .prepare(
          "INSERT INTO runs(id, session_id, status, state_json, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("run-1", "missing", "running", "{}", "now", "now"),
    ).toThrow();
    database.close();
  });

  it("rolls back every pending migration when one migration fails", () => {
    const database = new SqliteDatabase(":memory:");
    const runner = new SqliteMigrationRunner(database, [
      { version: 1, name: "valid", sql: "CREATE TABLE durable (id INTEGER) STRICT" },
      { version: 2, name: "invalid", sql: "THIS IS NOT SQL" },
    ]);

    expect(() => runner.migrate()).toThrow();
    expect(
      database.prepare("SELECT name FROM sqlite_schema WHERE name = 'durable'").get(),
    ).toBeUndefined();
    expect(database.prepare("SELECT count(*) AS count FROM pilot_migrations").get()).toEqual({
      count: 0,
    });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    database.close();
  });

  it("detects edited applied migrations and databases from newer builds", () => {
    const initialMigration = pilotMigrations[0];
    if (initialMigration === undefined) throw new Error("Initial migration fixture is missing");
    const changedDatabase = new SqliteDatabase(":memory:");
    new SqliteMigrationRunner(changedDatabase).migrate();
    expect(() =>
      new SqliteMigrationRunner(changedDatabase, [
        { ...initialMigration, sql: `${initialMigration.sql}\n-- edited` },
      ]).migrate(),
    ).toThrowError(SqliteMigrationError);
    changedDatabase.close();

    const newerDatabase = new SqliteDatabase(":memory:");
    new SqliteMigrationRunner(newerDatabase).migrate();
    newerDatabase
      .prepare(
        "INSERT INTO pilot_migrations(version, name, checksum, applied_at) VALUES (2, 'future', 'sha256:future', 'now')",
      )
      .run();
    newerDatabase.exec("PRAGMA user_version = 2");
    expect(() => new SqliteMigrationRunner(newerDatabase).migrate()).toThrowError(
      SqliteMigrationError,
    );
    newerDatabase.close();
  });

  it("rejects non-consecutive migration plans before changing the database", () => {
    const database = new SqliteDatabase(":memory:");
    expect(
      () => new SqliteMigrationRunner(database, [{ version: 2, name: "gap", sql: "SELECT 1" }]),
    ).toThrowError(SqliteMigrationError);
    expect(
      database.prepare("SELECT name FROM sqlite_schema WHERE name = 'pilot_migrations'").get(),
    ).toBeUndefined();
    database.close();
  });
});
