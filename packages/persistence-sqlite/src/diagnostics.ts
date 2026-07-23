import type { SqliteDatabase } from "./sqlite-database.js";

export interface SqliteDiagnosticReport {
  readonly healthy: boolean;
  readonly integrityMessages: readonly string[];
  readonly foreignKeyViolationCount: number;
  readonly schemaVersion: number;
  readonly migrationCount: number;
}

export function diagnoseSqliteDatabase(database: SqliteDatabase): SqliteDiagnosticReport {
  const integrityRows = database.prepare("PRAGMA quick_check").all() as unknown as Record<
    string,
    string
  >[];
  const integrityMessages = Object.freeze(
    integrityRows.flatMap((row) => Object.values(row).filter((value) => typeof value === "string")),
  );
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  const version = database.prepare("PRAGMA user_version").get() as {
    readonly user_version: number;
  };
  const migrations = database.prepare("SELECT COUNT(*) AS count FROM pilot_migrations").get() as {
    readonly count: number;
  };
  return Object.freeze({
    healthy:
      integrityMessages.length === 1 &&
      integrityMessages[0] === "ok" &&
      foreignKeyViolations.length === 0,
    integrityMessages,
    foreignKeyViolationCount: foreignKeyViolations.length,
    schemaVersion: version.user_version,
    migrationCount: migrations.count,
  });
}
