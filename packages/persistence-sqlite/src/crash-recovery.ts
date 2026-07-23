import {
  JsonValueSchema,
  runId,
  toolCallId,
  type JsonObject,
  type JsonValue,
  type RunId,
  type ToolCallId,
  type ToolRisk,
} from "@pilot/core";
import { SqliteRecordError } from "./repositories.js";
import type { SqliteDatabase } from "./sqlite-database.js";

export interface RecoveredToolCall {
  readonly callId: ToolCallId;
  readonly previousStatus: "approved" | "completed" | "requested" | "running";
  readonly risk: ToolRisk;
  readonly replaySafety: "safe" | "unknown" | "unsafe";
  readonly resultMissing: boolean;
  readonly sideEffects: "none" | "unknown";
  readonly recommendedAction: "inspect-workspace" | "review-before-retry";
  readonly automaticReplay: false;
}

export interface RecoveredRun {
  readonly runId: RunId;
  readonly checkpointSequence: number;
  readonly requiresWorkspaceInspection: boolean;
  readonly toolCalls: readonly RecoveredToolCall[];
}

export interface CrashRecoveryReport {
  readonly recoveredAt: string;
  readonly runs: readonly RecoveredRun[];
}

interface RunRow {
  readonly id: string;
  readonly state_json: string;
}

interface ToolRow {
  readonly call_id: string;
  readonly status: RecoveredToolCall["previousStatus"];
  readonly risk: ToolRisk;
  readonly replay_safety: RecoveredToolCall["replaySafety"];
  readonly result_missing: number;
}

/** Reconciles work that was durable but non-terminal when the previous process stopped. */
export class SqliteCrashRecovery {
  readonly #database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  recover(occurredAtInput: string): CrashRecoveryReport {
    const recoveredAt = timestamp(occurredAtInput);
    return this.#database.transaction((database) => {
      const rows = database
        .prepare("SELECT id, state_json FROM runs WHERE status = 'running' ORDER BY started_at, id")
        .all() as unknown as RunRow[];
      const recoveredRuns = rows.map((row) => this.#recoverRun(database, row, recoveredAt));
      return Object.freeze({ recoveredAt, runs: Object.freeze(recoveredRuns) });
    });
  }

  #recoverRun(database: SqliteDatabase, row: RunRow, recoveredAt: string): RecoveredRun {
    const previousState = parseJsonObject(row.state_json, `run ${row.id} state`);
    const tools = database
      .prepare(
        `SELECT call.call_id, call.status, call.risk, call.replay_safety,
          CASE WHEN result.call_id IS NULL THEN 1 ELSE 0 END AS result_missing
         FROM tool_calls call
         LEFT JOIN tool_results result
           ON result.run_id = call.run_id AND result.call_id = call.call_id
         WHERE call.run_id = ? AND (
           call.status IN ('requested', 'approved', 'running') OR
           (call.status = 'completed' AND result.call_id IS NULL)
         )
         ORDER BY call.sequence`,
      )
      .all(row.id) as unknown as ToolRow[];
    const recoveredTools = tools.map((tool) => recoverTool(tool));
    const requiresWorkspaceInspection = recoveredTools.some(
      ({ sideEffects }) => sideEffects === "unknown",
    );
    const nextSequenceRow = database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM checkpoints WHERE run_id = ?",
      )
      .get(row.id) as { readonly sequence: number };
    const checkpointSequence = nextSequenceRow.sequence;
    const recovery = parseJsonObject(
      JSON.stringify({
        automaticReplay: false,
        requiresWorkspaceInspection,
        toolCalls: recoveredTools,
      }),
      `run ${row.id} recovery`,
    );
    const state = {
      kind: "interrupted",
      reason: "process-restart",
      previousState,
      recovery,
    } satisfies JsonObject;

    database
      .prepare(
        `UPDATE model_calls SET status = 'interrupted', completed_at = COALESCE(completed_at, ?)
         WHERE run_id = ? AND status = 'started'`,
      )
      .run(recoveredAt, row.id);
    const interruptTool = database.prepare(
      `UPDATE tool_calls SET status = 'interrupted', completed_at = COALESCE(completed_at, ?)
       WHERE run_id = ? AND call_id = ?`,
    );
    for (const tool of recoveredTools) interruptTool.run(recoveredAt, row.id, tool.callId);
    database
      .prepare(
        `UPDATE runs SET status = 'interrupted', state_json = ?, updated_at = ?, completed_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(JSON.stringify(state), recoveredAt, recoveredAt, row.id);
    database
      .prepare(
        `INSERT INTO checkpoints(run_id, sequence, reason, payload_json, created_at)
         VALUES (?, ?, 'crash.recovered', ?, ?)`,
      )
      .run(row.id, checkpointSequence, JSON.stringify(recovery), recoveredAt);

    return Object.freeze({
      runId: runId(row.id),
      checkpointSequence,
      requiresWorkspaceInspection,
      toolCalls: Object.freeze(recoveredTools),
    });
  }
}

function recoverTool(row: ToolRow): RecoveredToolCall {
  const resultMissing = row.status === "completed" && row.result_missing === 1;
  const mayHaveExecuted = row.status === "running" || resultMissing;
  const sideEffects = mayHaveExecuted && row.risk !== "read-only" ? "unknown" : "none";
  return Object.freeze({
    callId: toolCallId(row.call_id),
    previousStatus: row.status,
    risk: row.risk,
    replaySafety: row.replay_safety,
    resultMissing,
    sideEffects,
    recommendedAction: sideEffects === "unknown" ? "inspect-workspace" : "review-before-retry",
    automaticReplay: false,
  });
}

function timestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new SqliteRecordError("Crash recovery timestamp must be an ISO timestamp");
  }
  return new Date(parsed).toISOString();
}

function parseJsonObject(value: string, label: string): JsonObject {
  let parsed: JsonValue;
  try {
    parsed = JsonValueSchema.parse(JSON.parse(value));
  } catch (error) {
    throw new SqliteRecordError(`Stored ${label} is invalid`, {}, error);
  }
  if (!isJsonObject(parsed)) throw new SqliteRecordError(`Stored ${label} must be an object`);
  return parsed;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
