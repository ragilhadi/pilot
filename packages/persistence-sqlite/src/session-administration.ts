import {
  parseAgentMessage,
  runId,
  sessionId,
  type AgentMessage,
  type JsonObject,
  type MessageId,
  type PersistenceRepositories,
  type SessionId,
  type SessionSnapshot,
} from "@pilot/core";
import type { SqliteDatabase } from "./sqlite-database.js";

export interface SessionSummary {
  readonly id: SessionId;
  readonly parentSessionId?: SessionId;
  readonly status: "active" | "archived";
  readonly revision: number;
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListSessionsOptions {
  readonly status?: "active" | "archived";
  readonly limit?: number;
}

export interface ForkSessionInput {
  readonly sourceId: SessionId;
  readonly id: SessionId;
  readonly createdAt: string;
  readonly nextMessageId: () => MessageId;
  readonly throughMessageId?: MessageId;
}

export interface SessionExportOptions {
  readonly exportedAt: string;
  readonly redact?: boolean;
  readonly secretValues?: readonly string[];
}

export interface DeleteSessionResult {
  readonly deleted: boolean;
  readonly sessions: number;
  readonly messages: number;
  readonly runs: number;
}

export interface RetentionPolicy {
  readonly archivedBefore: string;
  readonly limit?: number;
  readonly dryRun?: boolean;
}

export interface RetentionResult {
  readonly candidateSessionIds: readonly SessionId[];
  readonly deletedSessions: number;
}

interface SummaryRow {
  readonly id: string;
  readonly parent_session_id: string | null;
  readonly status: "active" | "archived";
  readonly revision: number;
  readonly message_count: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export class SqliteSessionAdministration {
  readonly #database: SqliteDatabase;
  readonly #repositories: PersistenceRepositories;

  constructor(database: SqliteDatabase, repositories: PersistenceRepositories) {
    this.#database = database;
    this.#repositories = repositories;
  }

  list(options: ListSessionsOptions = {}): readonly SessionSummary[] {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Session list limit must be between 1 and 1000");
    }
    const rows = (options.status === undefined
      ? this.#database
          .prepare(
            `SELECT session.*, COUNT(message.id) AS message_count
             FROM sessions session LEFT JOIN messages message ON message.session_id = session.id
             GROUP BY session.id ORDER BY session.updated_at DESC, session.id LIMIT ?`,
          )
          .all(limit)
      : this.#database
          .prepare(
            `SELECT session.*, COUNT(message.id) AS message_count
             FROM sessions session LEFT JOIN messages message ON message.session_id = session.id
             WHERE session.status = ? GROUP BY session.id
             ORDER BY session.updated_at DESC, session.id LIMIT ?`,
          )
          .all(options.status, limit)) as unknown as SummaryRow[];
    return Object.freeze(rows.map(summary));
  }

  async resume(id: SessionId): Promise<SessionSnapshot | undefined> {
    return this.#repositories.sessions.load(id);
  }

  async fork(input: ForkSessionInput): Promise<SessionSnapshot> {
    const source = await this.#repositories.sessions.load(input.sourceId);
    if (source === undefined) throw new Error(`Session ${input.sourceId} does not exist`);
    const endIndex =
      input.throughMessageId === undefined
        ? source.messages.length
        : source.messages.findIndex(({ id }) => id === input.throughMessageId) + 1;
    if (endIndex === 0) throw new Error(`Fork message ${input.throughMessageId} does not exist`);
    const baseTime = normalizeTimestamp(input.createdAt);
    const cloned: AgentMessage[] = [];
    for (const [index, original] of source.messages.slice(0, endIndex).entries()) {
      const id = input.nextMessageId();
      const parentId = cloned.at(-1)?.id;
      cloned.push(
        parseAgentMessage({
          ...original,
          id,
          sessionId: input.id,
          ...(parentId === undefined ? { parentId: undefined } : { parentId }),
          runId: undefined,
          createdAt: new Date(Date.parse(baseTime) + index).toISOString(),
          metadata: {
            ...original.metadata,
            forkedFromMessageId: original.id,
            originalCreatedAt: original.createdAt,
          },
        }),
      );
    }
    const forked = await this.#repositories.sessions.create({
      id: input.id,
      createdAt: baseTime,
      initialMessages: cloned,
    });
    this.#database
      .prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?")
      .run(input.sourceId, input.id);
    return forked;
  }

  archive(id: SessionId, updatedAt: string): boolean {
    const result = this.#database
      .prepare("UPDATE sessions SET status = 'archived', updated_at = ? WHERE id = ?")
      .run(normalizeTimestamp(updatedAt), id);
    return result.changes === 1;
  }

  delete(id: SessionId): DeleteSessionResult {
    return this.#database.transaction((database) => {
      const counts = database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM messages WHERE session_id = ?) AS messages,
             (SELECT COUNT(*) FROM runs WHERE session_id = ?) AS runs,
             (SELECT COUNT(*) FROM sessions WHERE id = ?) AS sessions`,
        )
        .get(id, id, id) as {
        readonly messages: number;
        readonly runs: number;
        readonly sessions: number;
      };
      database.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      return Object.freeze({
        deleted: counts.sessions === 1,
        sessions: counts.sessions,
        messages: counts.messages,
        runs: counts.runs,
      });
    });
  }

  applyRetention(policy: RetentionPolicy): RetentionResult {
    const before = normalizeTimestamp(policy.archivedBefore);
    const limit = policy.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError("Retention limit must be between 1 and 10000");
    }
    const candidates = this.#database
      .prepare(
        `SELECT id FROM sessions WHERE status = 'archived' AND updated_at < ?
         ORDER BY updated_at, id LIMIT ?`,
      )
      .all(before, limit) as unknown as { readonly id: string }[];
    const ids = Object.freeze(candidates.map(({ id }) => sessionId(id)));
    if (policy.dryRun !== true) {
      this.#database.transaction((database) => {
        const remove = database.prepare(
          "DELETE FROM sessions WHERE id = ? AND status = 'archived'",
        );
        for (const id of ids) remove.run(id);
      });
    }
    return Object.freeze({
      candidateSessionIds: ids,
      deletedSessions: policy.dryRun === true ? 0 : ids.length,
    });
  }

  async export(id: SessionId, options: SessionExportOptions): Promise<JsonObject | undefined> {
    const session = await this.#repositories.sessions.load(id);
    if (session === undefined) return undefined;
    const runRows = this.#database
      .prepare("SELECT id FROM runs WHERE session_id = ? ORDER BY started_at, id")
      .all(id) as unknown as { readonly id: string }[];
    const runs = [];
    for (const row of runRows) {
      const run = await this.#repositories.runs.load(runId(row.id));
      if (run === undefined) continue;
      runs.push({
        ...run,
        modelCalls: await this.#repositories.modelCalls.listByRun(run.id),
        toolCalls: await this.#repositories.toolActivity.listCallsByRun(run.id),
        toolResults: await this.#repositories.toolActivity.listResultsByRun(run.id),
        permissions: await this.#repositories.permissions.listByRun(run.id),
        usage: await this.#repositories.usage.listByRun(run.id),
        checkpoints: await this.#repositories.checkpoints.listByRun(run.id),
      });
    }
    const raw = normalizeJsonObject({
      schemaVersion: 1,
      exportedAt: normalizeTimestamp(options.exportedAt),
      session,
      runs,
    });
    return options.redact === false ? raw : redactJson(raw, options.secretValues ?? []);
  }
}

const sensitiveKey =
  /(?:^|[-_])(api[-_]?key|authorization|cookie|credential|password|secret|token)(?:$|[-_])/iu;

export function redactJson(value: JsonObject, secretValues: readonly string[]): JsonObject {
  const secrets = [...new Set(secretValues.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  return visit(value) as JsonObject;

  function visit(input: unknown, key?: string): unknown {
    if (key !== undefined && sensitiveKey.test(key)) return "[REDACTED]";
    if (typeof input === "string") {
      return secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), input);
    }
    if (Array.isArray(input)) return input.map((item) => visit(item));
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input).map(([childKey, child]) => [childKey, visit(child, childKey)]),
      );
    }
    return input;
  }
}

function summary(row: SummaryRow): SessionSummary {
  return Object.freeze({
    id: sessionId(row.id),
    ...(row.parent_session_id === null
      ? {}
      : { parentSessionId: sessionId(row.parent_session_id) }),
    status: row.status,
    revision: row.revision,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function normalizeTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("Timestamp must be valid ISO date-time");
  return new Date(timestamp).toISOString();
}

function normalizeJsonObject(value: unknown): JsonObject {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new TypeError("Session export must be a JSON object");
  }
  return normalized as JsonObject;
}
