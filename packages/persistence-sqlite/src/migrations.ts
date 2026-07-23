import { createHash } from "node:crypto";
import { PilotError } from "@pilotrun/core";
import type { SqliteDatabase } from "./sqlite-database.js";

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationResult {
  readonly currentVersion: number;
  readonly applied: readonly AppliedMigration[];
}

export class SqliteMigrationError extends PilotError {
  constructor(
    reason: "changed-migration" | "invalid-plan" | "newer-database" | "version-drift",
    message: string,
    metadata: Readonly<Record<string, unknown>> = {},
  ) {
    super({
      code: "PILOT_PERSISTENCE_MIGRATION_FAILED",
      message,
      safeMessage: "The session database schema cannot be opened safely",
      metadata: { reason, ...metadata },
    });
  }
}

export interface MigrationRunnerOptions {
  readonly now?: () => Date;
}

export class SqliteMigrationRunner {
  readonly #database: SqliteDatabase;
  readonly #migrations: readonly SqliteMigration[];
  readonly #now: () => Date;

  constructor(
    database: SqliteDatabase,
    migrations: readonly SqliteMigration[] = pilotMigrations,
    options: MigrationRunnerOptions = {},
  ) {
    validatePlan(migrations);
    this.#database = database;
    this.#migrations = Object.freeze([...migrations]);
    this.#now = options.now ?? (() => new Date());
  }

  migrate(): MigrationResult {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS pilot_migrations (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT
    `);

    const existing = this.#readApplied();
    this.#validateExisting(existing);
    const pending = this.#migrations.slice(existing.length);
    if (pending.length === 0) {
      return Object.freeze({
        currentVersion: existing.at(-1)?.version ?? 0,
        applied: Object.freeze([]),
      });
    }

    const applied = this.#database.transaction((database) => {
      const records: AppliedMigration[] = [];
      const insert = database.prepare(
        "INSERT INTO pilot_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      );
      for (const migration of pending) {
        database.exec(migration.sql);
        const record = Object.freeze({
          version: migration.version,
          name: migration.name,
          checksum: checksum(migration.sql),
          appliedAt: this.#now().toISOString(),
        });
        insert.run(record.version, record.name, record.checksum, record.appliedAt);
        database.exec(`PRAGMA user_version = ${record.version}`);
        records.push(record);
      }
      return Object.freeze(records);
    });

    return Object.freeze({
      currentVersion: applied.at(-1)?.version ?? existing.at(-1)?.version ?? 0,
      applied,
    });
  }

  #readApplied(): readonly AppliedMigration[] {
    const rows = this.#database
      .prepare(
        "SELECT version, name, checksum, applied_at AS appliedAt FROM pilot_migrations ORDER BY version",
      )
      .all() as unknown as AppliedMigration[];
    return rows;
  }

  #validateExisting(existing: readonly AppliedMigration[]): void {
    const userVersionRow = this.#database.prepare("PRAGMA user_version").get() as
      | { readonly user_version: number }
      | undefined;
    const userVersion = userVersionRow?.user_version ?? 0;
    const recordedVersion = existing.at(-1)?.version ?? 0;
    if (userVersion !== recordedVersion) {
      throw new SqliteMigrationError(
        "version-drift",
        `SQLite user_version ${userVersion} does not match migration version ${recordedVersion}`,
        { userVersion, recordedVersion },
      );
    }
    if (existing.length > this.#migrations.length) {
      throw new SqliteMigrationError(
        "newer-database",
        `Database schema version ${recordedVersion} is newer than this Pilot build`,
        { recordedVersion, latestSupportedVersion: this.#migrations.at(-1)?.version ?? 0 },
      );
    }
    for (const [index, record] of existing.entries()) {
      const expected = this.#migrations[index];
      if (expected === undefined || record.version !== expected.version) {
        throw new SqliteMigrationError("version-drift", "Database migration history has a gap");
      }
      if (record.name !== expected.name || record.checksum !== checksum(expected.sql)) {
        throw new SqliteMigrationError(
          "changed-migration",
          `Applied migration ${record.version} no longer matches the application`,
          { version: record.version },
        );
      }
    }
  }
}

function validatePlan(migrations: readonly SqliteMigration[]): void {
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (
      migration.version !== expectedVersion ||
      migration.name.trim().length === 0 ||
      migration.sql.trim().length === 0
    ) {
      throw new SqliteMigrationError(
        "invalid-plan",
        `Migration plan must contain consecutive non-empty migrations starting at 1`,
        { index, expectedVersion, actualVersion: migration.version },
      );
    }
  }
}

function checksum(sql: string): string {
  return `sha256:${createHash("sha256").update(sql, "utf8").digest("hex")}`;
}

const initialSchema = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  title TEXT,
  workspace_root TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'aborted', 'interrupted')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT,
  parent_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  schema_version INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  status TEXT NOT NULL CHECK (status IN ('partial', 'complete', 'failed', 'redacted')),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  UNIQUE (session_id, sequence)
) STRICT;

CREATE TABLE message_parts (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (message_id, ordinal)
) STRICT;

CREATE TABLE model_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  model_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'interrupted')),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (run_id, sequence)
) STRICT;

CREATE TABLE tool_calls (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  tool_name TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('read-only', 'workspace-write', 'network', 'system-change', 'destructive', 'unknown')),
  replay_safety TEXT NOT NULL CHECK (replay_safety IN ('safe', 'unknown', 'unsafe')),
  status TEXT NOT NULL CHECK (status IN ('requested', 'approved', 'denied', 'running', 'completed', 'failed', 'interrupted')),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (run_id, call_id),
  UNIQUE (run_id, sequence)
) STRICT;

CREATE TABLE tool_results (
  run_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  output_json TEXT NOT NULL CHECK (json_valid(output_json)),
  is_error INTEGER NOT NULL CHECK (is_error IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, call_id),
  FOREIGN KEY (run_id, call_id) REFERENCES tool_calls(run_id, call_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE permission_decisions (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  action_fingerprint TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny', 'ask')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL,
  UNIQUE (run_id, sequence)
) STRICT;

CREATE TABLE usage_records (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  model_call_id TEXT REFERENCES model_calls(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  usage_json TEXT NOT NULL CHECK (json_valid(usage_json)),
  occurred_at TEXT NOT NULL,
  UNIQUE (run_id, sequence)
) STRICT;

CREATE TABLE checkpoints (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
) STRICT;

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX runs_session_idx ON runs(session_id, started_at);
CREATE INDEX messages_session_idx ON messages(session_id, sequence);
CREATE INDEX model_calls_run_idx ON model_calls(run_id, sequence);
CREATE INDEX tool_calls_run_idx ON tool_calls(run_id, sequence);
CREATE INDEX checkpoints_run_idx ON checkpoints(run_id, sequence);
CREATE INDEX events_session_idx ON events(session_id, occurred_at);
`;

export const pilotMigrations: readonly SqliteMigration[] = Object.freeze([
  Object.freeze({ version: 1, name: "initial-persistence-schema", sql: initialSchema }),
]);
