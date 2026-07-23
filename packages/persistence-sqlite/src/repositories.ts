import {
  JsonValueSchema,
  messageId,
  parseAgentMessage,
  PermissionAuditRecordSchema,
  PilotError,
  runId,
  sessionId,
  SessionError,
  sessionSchemaVersion,
  TokenUsageSchema,
  toolCallId,
  type AgentMessage,
  type AppendMessageOptions,
  type CheckpointRepository,
  type JsonObject,
  type JsonValue,
  type ModelCallRepository,
  type NewSession,
  type PersistedCheckpoint,
  type PersistedModelCall,
  type PersistedRun,
  type PersistedToolCall,
  type PersistedToolResult,
  type PersistedUsageRecord,
  type PermissionAuditRecord,
  type PermissionAuditRepository,
  type PersistenceRepositories,
  type RunId,
  type RunRepository,
  type SessionId,
  type SessionRepository,
  type SessionSnapshot,
  type ToolActivityRepository,
  type UsageRepository,
} from "@pilotrun/core";
import type { SqliteDatabase } from "./sqlite-database.js";

export class SqliteRecordError extends PilotError {
  constructor(message: string, metadata: Readonly<Record<string, unknown>> = {}, cause?: unknown) {
    super({
      code: "PILOT_PERSISTENCE_FAILED",
      message,
      safeMessage: "Stored session data is invalid or unavailable",
      metadata: { reason: "invalid-record", ...metadata },
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

interface SessionRow {
  readonly id: string;
  readonly schema_version: number;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly run_id: string | null;
  readonly parent_id: string | null;
  readonly schema_version: number;
  readonly role: string;
  readonly status: string;
  readonly provenance_json: string;
  readonly metadata_json: string | null;
  readonly created_at: string;
}

export class SqliteSessionRepository implements SessionRepository {
  readonly #database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  async create(input: NewSession): Promise<SessionSnapshot> {
    const createdAt = timestamp(input.createdAt, "session createdAt");
    return this.#database.transaction((database) => {
      if (this.#load(database, input.id) !== undefined) {
        throw new SessionError(
          "PILOT_SESSION_CONFLICT",
          "duplicate-session",
          `Session ${input.id} already exists`,
          { sessionId: input.id },
        );
      }
      database
        .prepare(
          `INSERT INTO sessions(
            id, schema_version, status, revision, created_at, updated_at
          ) VALUES (?, ?, 'active', 0, ?, ?)`,
        )
        .run(input.id, sessionSchemaVersion, createdAt, createdAt);
      for (const message of input.initialMessages ?? []) {
        this.#append(database, message, {}, input.id);
      }
      return required(
        this.#load(database, input.id),
        `Session ${input.id} disappeared after create`,
      );
    });
  }

  async appendMessage(
    message: AgentMessage,
    options: AppendMessageOptions = {},
  ): Promise<SessionSnapshot> {
    const parsed = parseAgentMessage(message);
    return this.#database.transaction((database) => {
      this.#append(database, parsed, options);
      return required(
        this.#load(database, parsed.sessionId),
        `Session ${parsed.sessionId} disappeared after append`,
      );
    });
  }

  async load(id: SessionId): Promise<SessionSnapshot | undefined> {
    return this.#load(this.#database, id);
  }

  #append(
    database: SqliteDatabase,
    input: AgentMessage,
    options: AppendMessageOptions,
    targetSessionId: SessionId = input.sessionId,
  ): void {
    const message = parseAgentMessage(input);
    const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(targetSessionId) as
      | SessionRow
      | undefined;
    if (row === undefined) {
      throw new SessionError(
        "PILOT_SESSION_NOT_FOUND",
        "session-not-found",
        `Session ${targetSessionId} does not exist`,
        { sessionId: targetSessionId },
      );
    }
    if (message.sessionId !== row.id) {
      throw new SessionError(
        "PILOT_SESSION_INVALID_MESSAGE",
        "message-session-mismatch",
        `Message ${message.id} belongs to a different session`,
        { messageId: message.id, sessionId: row.id },
      );
    }
    if (options.expectedRevision !== undefined && options.expectedRevision !== row.revision) {
      throw new SessionError(
        "PILOT_SESSION_CONFLICT",
        "stale-revision",
        `Session ${row.id} is at revision ${row.revision}, not ${options.expectedRevision}`,
        {
          sessionId: row.id,
          expectedRevision: options.expectedRevision,
          actualRevision: row.revision,
        },
      );
    }
    if (
      database.prepare("SELECT 1 AS present FROM messages WHERE id = ?").get(message.id) !==
      undefined
    ) {
      throw new SessionError(
        "PILOT_SESSION_CONFLICT",
        "duplicate-message",
        `Message ${message.id} already exists`,
        { messageId: message.id, sessionId: row.id },
      );
    }
    if (message.status === "partial") {
      throw new SessionError(
        "PILOT_SESSION_INVALID_MESSAGE",
        "non-terminal-message",
        `Partial message ${message.id} cannot be committed to conversation history`,
        { messageId: message.id, sessionId: row.id },
      );
    }
    const tail = database
      .prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY sequence DESC LIMIT 1")
      .get(row.id) as { readonly id: string } | undefined;
    const expectedParentId = tail?.id;
    if (message.parentId !== expectedParentId) {
      throw new SessionError(
        "PILOT_SESSION_INVALID_MESSAGE",
        "parent-mismatch",
        `Message ${message.id} does not extend the current session tail`,
        {
          messageId: message.id,
          sessionId: row.id,
          ...(expectedParentId === undefined ? {} : { expectedParentId }),
          ...(message.parentId === undefined ? {} : { actualParentId: message.parentId }),
        },
      );
    }
    const createdAt = timestamp(message.createdAt, "message createdAt");
    if (Date.parse(createdAt) < Date.parse(row.updated_at)) {
      throw new SessionError(
        "PILOT_SESSION_INVALID_MESSAGE",
        "created-at-regressed",
        `Message ${message.id} predates the current session tail`,
        { messageId: message.id, sessionId: row.id },
      );
    }

    database
      .prepare(
        `INSERT INTO messages(
          id, session_id, run_id, parent_id, sequence, schema_version, role, status,
          provenance_json, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionId,
        message.runId ?? null,
        message.parentId ?? null,
        row.revision,
        message.schemaVersion,
        message.role,
        message.status,
        stringify(message.provenance),
        message.metadata === undefined ? null : stringify(message.metadata),
        createdAt,
      );
    const insertPart = database.prepare(
      "INSERT INTO message_parts(message_id, ordinal, type, payload_json) VALUES (?, ?, ?, ?)",
    );
    for (const [ordinal, part] of message.parts.entries()) {
      insertPart.run(message.id, ordinal, part.type, stringify(part));
    }
    database
      .prepare("UPDATE sessions SET revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(createdAt, row.id);
  }

  #load(database: SqliteDatabase, id: SessionId | string): SessionSnapshot | undefined {
    const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
    if (row === undefined) return undefined;
    if (row.schema_version !== sessionSchemaVersion) {
      throw new SqliteRecordError(`Unsupported session schema version ${row.schema_version}`, {
        sessionId: row.id,
      });
    }
    const messageRows = database
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY sequence")
      .all(row.id) as unknown as MessageRow[];
    const partsStatement = database.prepare(
      "SELECT payload_json FROM message_parts WHERE message_id = ? ORDER BY ordinal",
    );
    const messages = messageRows.map((message) => {
      const parts = (partsStatement.all(message.id) as unknown as { payload_json: string }[]).map(
        ({ payload_json: payload }) => parseJson(payload, "message part"),
      );
      try {
        return parseAgentMessage({
          schemaVersion: message.schema_version,
          id: messageId(message.id),
          sessionId: sessionId(message.session_id),
          ...(message.run_id === null ? {} : { runId: runId(message.run_id) }),
          ...(message.parent_id === null ? {} : { parentId: messageId(message.parent_id) }),
          role: message.role,
          status: message.status,
          parts,
          createdAt: message.created_at,
          provenance: parseJson(message.provenance_json, "message provenance"),
          ...(message.metadata_json === null
            ? {}
            : { metadata: parseJson(message.metadata_json, "message metadata") }),
        });
      } catch (error) {
        throw new SqliteRecordError(
          `Stored message ${message.id} is invalid`,
          { messageId: message.id },
          error,
        );
      }
    });
    return Object.freeze({
      schemaVersion: sessionSchemaVersion,
      id: sessionId(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
      messages: Object.freeze(messages),
    });
  }
}

export class SqliteRunRepository implements RunRepository {
  constructor(readonly database: SqliteDatabase) {}

  async create(record: PersistedRun): Promise<void> {
    validateRun(record);
    this.database
      .prepare(
        `INSERT INTO runs(
          id, session_id, status, state_json, error_json, started_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.status,
        stringify(record.state),
        record.error === undefined ? null : stringify(record.error),
        timestamp(record.startedAt, "run startedAt"),
        timestamp(record.updatedAt, "run updatedAt"),
        record.completedAt === undefined ? null : timestamp(record.completedAt, "run completedAt"),
      );
  }

  async save(record: PersistedRun): Promise<void> {
    validateRun(record);
    const result = this.database
      .prepare(
        `UPDATE runs SET status = ?, state_json = ?, error_json = ?, updated_at = ?, completed_at = ?
         WHERE id = ? AND session_id = ?`,
      )
      .run(
        record.status,
        stringify(record.state),
        record.error === undefined ? null : stringify(record.error),
        timestamp(record.updatedAt, "run updatedAt"),
        record.completedAt === undefined ? null : timestamp(record.completedAt, "run completedAt"),
        record.id,
        record.sessionId,
      );
    if (result.changes !== 1) throw new SqliteRecordError(`Run ${record.id} does not exist`);
  }

  async load(id: RunId): Promise<PersistedRun | undefined> {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : mapRun(row);
  }
}

export class SqliteModelCallRepository implements ModelCallRepository {
  constructor(readonly database: SqliteDatabase) {}

  async save(record: PersistedModelCall): Promise<void> {
    positiveSequence(record.sequence);
    this.database
      .prepare(
        `INSERT INTO model_calls(
          id, run_id, sequence, model_key, status, request_json, response_json, failure_json,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, response_json = excluded.response_json,
          failure_json = excluded.failure_json, completed_at = excluded.completed_at`,
      )
      .run(
        nonEmpty(record.id, "model call id"),
        record.runId,
        record.sequence,
        nonEmpty(record.modelKey, "model key"),
        record.status,
        stringify(record.request),
        record.response === undefined ? null : stringify(record.response),
        record.failure === undefined ? null : stringify(record.failure),
        timestamp(record.startedAt, "model call startedAt"),
        record.completedAt === undefined
          ? null
          : timestamp(record.completedAt, "model call completedAt"),
      );
  }

  async listByRun(run: RunId): Promise<readonly PersistedModelCall[]> {
    const rows = this.database
      .prepare("SELECT * FROM model_calls WHERE run_id = ? ORDER BY sequence")
      .all(run) as unknown as Record<string, unknown>[];
    return Object.freeze(rows.map(mapModelCall));
  }
}

export class SqliteToolActivityRepository implements ToolActivityRepository {
  constructor(readonly database: SqliteDatabase) {}

  async saveCall(record: PersistedToolCall): Promise<void> {
    positiveSequence(record.sequence);
    this.database
      .prepare(
        `INSERT INTO tool_calls(
          run_id, call_id, sequence, tool_name, risk, replay_safety, status, input_json,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, call_id) DO UPDATE SET status = excluded.status,
          started_at = excluded.started_at, completed_at = excluded.completed_at`,
      )
      .run(
        record.runId,
        record.callId,
        record.sequence,
        nonEmpty(record.toolName, "tool name"),
        record.risk,
        record.replaySafety,
        record.status,
        stringify(JsonValueSchema.parse(record.input)),
        record.startedAt === undefined ? null : timestamp(record.startedAt, "tool call startedAt"),
        record.completedAt === undefined
          ? null
          : timestamp(record.completedAt, "tool call completedAt"),
      );
  }

  async saveResult(record: PersistedToolResult): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO tool_results(run_id, call_id, output_json, is_error, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, call_id) DO UPDATE SET output_json = excluded.output_json,
           is_error = excluded.is_error, created_at = excluded.created_at`,
      )
      .run(
        record.runId,
        record.callId,
        stringify(JsonValueSchema.parse(record.output)),
        record.isError ? 1 : 0,
        timestamp(record.createdAt, "tool result createdAt"),
      );
  }

  async listCallsByRun(run: RunId): Promise<readonly PersistedToolCall[]> {
    const rows = this.database
      .prepare("SELECT * FROM tool_calls WHERE run_id = ? ORDER BY sequence")
      .all(run) as unknown as Record<string, unknown>[];
    return Object.freeze(rows.map(mapToolCall));
  }

  async listResultsByRun(run: RunId): Promise<readonly PersistedToolResult[]> {
    const rows = this.database
      .prepare(
        `SELECT result.* FROM tool_results result
         JOIN tool_calls call ON call.run_id = result.run_id AND call.call_id = result.call_id
         WHERE result.run_id = ? ORDER BY call.sequence`,
      )
      .all(run) as unknown as Record<string, unknown>[];
    return Object.freeze(rows.map(mapToolResult));
  }
}

export class SqlitePermissionAuditRepository implements PermissionAuditRepository {
  constructor(readonly database: SqliteDatabase) {}

  async append(record: PermissionAuditRecord): Promise<void> {
    const parsed = PermissionAuditRecordSchema.parse(record);
    this.database
      .prepare(
        `INSERT INTO permission_decisions(
          run_id, call_id, sequence, action_fingerprint, effect, payload_json, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.context.runId,
        parsed.context.callId,
        parsed.sequence,
        parsed.action.fingerprint,
        parsed.decision.effect,
        stringify(parsed),
        parsed.occurredAt,
      );
  }

  async listByRun(run: RunId): Promise<readonly PermissionAuditRecord[]> {
    const rows = this.database
      .prepare("SELECT payload_json FROM permission_decisions WHERE run_id = ? ORDER BY sequence")
      .all(run) as unknown as { payload_json: string }[];
    return Object.freeze(
      rows.map(({ payload_json: payload }) =>
        PermissionAuditRecordSchema.parse(parseJson(payload, "permission decision")),
      ),
    );
  }
}

export class SqliteUsageRepository implements UsageRepository {
  constructor(readonly database: SqliteDatabase) {}

  async append(record: PersistedUsageRecord): Promise<void> {
    positiveSequence(record.sequence);
    const usage = TokenUsageSchema.parse(record.usage);
    this.database
      .prepare(
        `INSERT INTO usage_records(run_id, model_call_id, sequence, usage_json, occurred_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.runId,
        record.modelCallId ?? null,
        record.sequence,
        stringify(usage),
        timestamp(record.occurredAt, "usage occurredAt"),
      );
  }

  async listByRun(run: RunId): Promise<readonly PersistedUsageRecord[]> {
    const rows = this.database
      .prepare("SELECT * FROM usage_records WHERE run_id = ? ORDER BY sequence")
      .all(run) as unknown as Record<string, unknown>[];
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          runId: runId(text(row.run_id, "usage run id")),
          ...(row.model_call_id === null
            ? {}
            : { modelCallId: text(row.model_call_id, "usage model call id") }),
          sequence: integer(row.sequence, "usage sequence"),
          usage: TokenUsageSchema.parse(parseJson(text(row.usage_json, "usage JSON"), "usage")),
          occurredAt: text(row.occurred_at, "usage occurredAt"),
        }),
      ),
    );
  }
}

export class SqliteCheckpointRepository implements CheckpointRepository {
  constructor(readonly database: SqliteDatabase) {}

  async append(record: PersistedCheckpoint): Promise<void> {
    positiveSequence(record.sequence);
    this.database
      .prepare(
        `INSERT INTO checkpoints(run_id, sequence, reason, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.runId,
        record.sequence,
        nonEmpty(record.reason, "checkpoint reason"),
        stringify(record.payload),
        timestamp(record.createdAt, "checkpoint createdAt"),
      );
  }

  async listByRun(run: RunId): Promise<readonly PersistedCheckpoint[]> {
    const rows = this.database
      .prepare("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY sequence")
      .all(run) as unknown as Record<string, unknown>[];
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          runId: runId(text(row.run_id, "checkpoint run id")),
          sequence: integer(row.sequence, "checkpoint sequence"),
          reason: text(row.reason, "checkpoint reason"),
          payload: parseJsonObject(text(row.payload_json, "checkpoint payload"), "checkpoint"),
          createdAt: text(row.created_at, "checkpoint createdAt"),
        }),
      ),
    );
  }
}

export function createSqliteRepositories(database: SqliteDatabase): PersistenceRepositories {
  return Object.freeze({
    sessions: new SqliteSessionRepository(database),
    runs: new SqliteRunRepository(database),
    modelCalls: new SqliteModelCallRepository(database),
    toolActivity: new SqliteToolActivityRepository(database),
    permissions: new SqlitePermissionAuditRepository(database),
    usage: new SqliteUsageRepository(database),
    checkpoints: new SqliteCheckpointRepository(database),
  });
}

function validateRun(record: PersistedRun): void {
  timestamp(record.startedAt, "run startedAt");
  timestamp(record.updatedAt, "run updatedAt");
  if (record.completedAt !== undefined) timestamp(record.completedAt, "run completedAt");
  JsonValueSchema.parse(record.state);
  if (record.error !== undefined) JsonValueSchema.parse(record.error);
}

function mapRun(row: Record<string, unknown>): PersistedRun {
  return Object.freeze({
    id: runId(text(row.id, "run id")),
    sessionId: sessionId(text(row.session_id, "run session id")),
    status: text(row.status, "run status") as PersistedRun["status"],
    state: parseJsonObject(text(row.state_json, "run state"), "run state"),
    ...(row.error_json === null
      ? {}
      : { error: parseJsonObject(text(row.error_json, "run error"), "run error") }),
    startedAt: text(row.started_at, "run startedAt"),
    updatedAt: text(row.updated_at, "run updatedAt"),
    ...(row.completed_at === null
      ? {}
      : { completedAt: text(row.completed_at, "run completedAt") }),
  });
}

function mapModelCall(row: Record<string, unknown>): PersistedModelCall {
  return Object.freeze({
    id: text(row.id, "model call id"),
    runId: runId(text(row.run_id, "model call run id")),
    sequence: integer(row.sequence, "model call sequence"),
    modelKey: text(row.model_key, "model key"),
    status: text(row.status, "model call status") as PersistedModelCall["status"],
    request: parseJsonObject(text(row.request_json, "model request"), "model request"),
    ...(row.response_json === null
      ? {}
      : { response: parseJsonObject(text(row.response_json, "model response"), "model response") }),
    ...(row.failure_json === null
      ? {}
      : { failure: parseJsonObject(text(row.failure_json, "model failure"), "model failure") }),
    startedAt: text(row.started_at, "model call startedAt"),
    ...(row.completed_at === null
      ? {}
      : { completedAt: text(row.completed_at, "model call completedAt") }),
  });
}

function mapToolCall(row: Record<string, unknown>): PersistedToolCall {
  return Object.freeze({
    runId: runId(text(row.run_id, "tool call run id")),
    callId: toolCallId(text(row.call_id, "tool call id")),
    sequence: integer(row.sequence, "tool call sequence"),
    toolName: text(row.tool_name, "tool name"),
    risk: text(row.risk, "tool risk") as PersistedToolCall["risk"],
    replaySafety: text(
      row.replay_safety,
      "tool replay safety",
    ) as PersistedToolCall["replaySafety"],
    status: text(row.status, "tool call status") as PersistedToolCall["status"],
    input: parseJson(text(row.input_json, "tool input"), "tool input"),
    ...(row.started_at === null ? {} : { startedAt: text(row.started_at, "tool call startedAt") }),
    ...(row.completed_at === null
      ? {}
      : { completedAt: text(row.completed_at, "tool call completedAt") }),
  });
}

function mapToolResult(row: Record<string, unknown>): PersistedToolResult {
  return Object.freeze({
    runId: runId(text(row.run_id, "tool result run id")),
    callId: toolCallId(text(row.call_id, "tool result call id")),
    output: parseJson(text(row.output_json, "tool output"), "tool output"),
    isError: integer(row.is_error, "tool result error flag") === 1,
    createdAt: text(row.created_at, "tool result createdAt"),
  });
}

function timestamp(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new SqliteRecordError(`${label} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

function positiveSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SqliteRecordError("Record sequence must be a positive integer");
  }
}

function nonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new SqliteRecordError(`${label} must not be empty`);
  return value;
}

function stringify(value: JsonValue | object): string {
  return JSON.stringify(value);
}

function parseJson(value: string, label: string): JsonValue {
  try {
    return JsonValueSchema.parse(JSON.parse(value));
  } catch (error) {
    throw new SqliteRecordError(`Stored ${label} JSON is invalid`, {}, error);
  }
}

function parseJsonObject(value: string, label: string): JsonObject {
  const parsed = parseJson(value, label);
  if (!isJsonObject(parsed)) {
    throw new SqliteRecordError(`Stored ${label} must be a JSON object`);
  }
  return parsed;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new SqliteRecordError(`Stored ${label} must be text`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SqliteRecordError(`Stored ${label} must be an integer`);
  }
  return value;
}

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new SqliteRecordError(message);
  return value;
}
