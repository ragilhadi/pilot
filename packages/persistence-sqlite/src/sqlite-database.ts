import { backup, DatabaseSync, type StatementSync } from "node:sqlite";
import { PilotError } from "@pilotrun/core";

export interface SqliteDatabaseOptions {
  readonly busyTimeoutMs?: number;
  readonly readOnly?: boolean;
}

export class SqlitePersistenceError extends PilotError {
  constructor(
    reason: "async-transaction" | "closed" | "nested-transaction" | "transaction-failed",
    message: string,
    cause?: unknown,
  ) {
    super({
      code: "PILOT_PERSISTENCE_FAILED",
      message,
      safeMessage: "The session database operation failed",
      metadata: { reason },
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

/** Small ownership wrapper around Node's synchronous SQLite connection. */
export class SqliteDatabase {
  readonly #connection: DatabaseSync;
  #closed = false;
  #transactionActive = false;

  constructor(path: string, options: SqliteDatabaseOptions = {}) {
    this.#connection = new DatabaseSync(path, {
      readOnly: options.readOnly ?? false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) {
      this.#connection.close();
      throw new RangeError("busyTimeoutMs must be an integer between 0 and 60000");
    }
    this.#connection.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    this.#connection.exec("PRAGMA foreign_keys = ON");
  }

  exec(sql: string): void {
    this.#assertOpen();
    this.#connection.exec(sql);
  }

  prepare(sql: string): StatementSync {
    this.#assertOpen();
    return this.#connection.prepare(sql);
  }

  async backupTo(destinationPath: string): Promise<void> {
    this.#assertOpen();
    await backup(this.#connection, destinationPath);
  }

  transaction<Result>(operation: (database: SqliteDatabase) => Result): Result {
    this.#assertOpen();
    if (this.#transactionActive) {
      throw new SqlitePersistenceError(
        "nested-transaction",
        "Nested SQLite transactions require an explicit savepoint",
      );
    }

    this.#connection.exec("BEGIN IMMEDIATE");
    this.#transactionActive = true;
    try {
      const result = operation(this);
      if (isThenable(result)) {
        throw new SqlitePersistenceError(
          "async-transaction",
          "SQLite transaction callbacks must complete synchronously",
        );
      }
      this.#connection.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#connection.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new SqlitePersistenceError(
          "transaction-failed",
          "SQLite transaction and rollback both failed",
          new AggregateError([error, rollbackError]),
        );
      }
      throw error;
    } finally {
      this.#transactionActive = false;
    }
  }

  close(): void {
    if (this.#closed) return;
    if (this.#transactionActive) {
      throw new SqlitePersistenceError(
        "transaction-failed",
        "Cannot close SQLite while a transaction is active",
      );
    }
    this.#connection.close();
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SqlitePersistenceError("closed", "SQLite database is closed");
    }
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
