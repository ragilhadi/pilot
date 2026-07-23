import type { RunId, SessionId, ToolCallId } from "./brand.js";
import { PilotError } from "./errors.js";
import type { AgentMessage, JsonObject, JsonValue } from "./messages.js";
import type { PermissionAuditRecord } from "./permissions.js";
import type { TokenUsage } from "./models.js";
import type { ToolRisk } from "./tools.js";

export const sessionSchemaVersion = 1 as const;

export interface NewSession {
  readonly id: SessionId;
  readonly createdAt: string;
  readonly initialMessages?: readonly AgentMessage[];
}

export interface AppendMessageOptions {
  /** Rejects a stale writer instead of silently extending a newer session revision. */
  readonly expectedRevision?: number;
}

export interface SessionSnapshot {
  readonly schemaVersion: typeof sessionSchemaVersion;
  readonly id: SessionId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly messages: readonly AgentMessage[];
}

/** Persistence boundary consumed by runtime use cases and implemented by memory/SQLite adapters. */
export interface SessionRepository {
  create(input: NewSession): Promise<SessionSnapshot>;
  appendMessage(message: AgentMessage, options?: AppendMessageOptions): Promise<SessionSnapshot>;
  load(id: SessionId): Promise<SessionSnapshot | undefined>;
}

export type PersistedRunStatus =
  | "aborted"
  | "completed"
  | "failed"
  | "interrupted"
  | "queued"
  | "running";

export interface PersistedRun {
  readonly id: RunId;
  readonly sessionId: SessionId;
  readonly status: PersistedRunStatus;
  readonly state: JsonObject;
  readonly error?: JsonObject;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface RunRepository {
  create(record: PersistedRun): Promise<void>;
  save(record: PersistedRun): Promise<void>;
  load(id: RunId): Promise<PersistedRun | undefined>;
}

export type PersistedActivityStatus = "completed" | "failed" | "interrupted" | "started";

export interface PersistedModelCall {
  readonly id: string;
  readonly runId: RunId;
  readonly sequence: number;
  readonly modelKey: string;
  readonly status: PersistedActivityStatus;
  readonly request: JsonObject;
  readonly response?: JsonObject;
  readonly failure?: JsonObject;
  readonly startedAt: string;
  readonly completedAt?: string;
}

export interface ModelCallRepository {
  save(record: PersistedModelCall): Promise<void>;
  listByRun(runId: RunId): Promise<readonly PersistedModelCall[]>;
}

export type PersistedToolCallStatus =
  | "approved"
  | "completed"
  | "denied"
  | "failed"
  | "interrupted"
  | "requested"
  | "running";

export interface PersistedToolCall {
  readonly runId: RunId;
  readonly callId: ToolCallId;
  readonly sequence: number;
  readonly toolName: string;
  readonly risk: ToolRisk;
  readonly replaySafety: "safe" | "unknown" | "unsafe";
  readonly status: PersistedToolCallStatus;
  readonly input: JsonValue;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface PersistedToolResult {
  readonly runId: RunId;
  readonly callId: ToolCallId;
  readonly output: JsonValue;
  readonly isError: boolean;
  readonly createdAt: string;
}

export interface ToolActivityRepository {
  saveCall(record: PersistedToolCall): Promise<void>;
  saveResult(record: PersistedToolResult): Promise<void>;
  listCallsByRun(runId: RunId): Promise<readonly PersistedToolCall[]>;
  listResultsByRun(runId: RunId): Promise<readonly PersistedToolResult[]>;
}

export interface PermissionAuditRepository {
  append(record: PermissionAuditRecord): Promise<void>;
  listByRun(runId: RunId): Promise<readonly PermissionAuditRecord[]>;
}

export interface PersistedUsageRecord {
  readonly runId: RunId;
  readonly modelCallId?: string;
  readonly sequence: number;
  readonly usage: TokenUsage;
  readonly occurredAt: string;
}

export interface UsageRepository {
  append(record: PersistedUsageRecord): Promise<void>;
  listByRun(runId: RunId): Promise<readonly PersistedUsageRecord[]>;
}

export interface PersistedCheckpoint {
  readonly runId: RunId;
  readonly sequence: number;
  readonly reason: string;
  readonly payload: JsonObject;
  readonly createdAt: string;
}

export interface CheckpointRepository {
  append(record: PersistedCheckpoint): Promise<void>;
  listByRun(runId: RunId): Promise<readonly PersistedCheckpoint[]>;
}

export interface PersistenceRepositories {
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly modelCalls: ModelCallRepository;
  readonly toolActivity: ToolActivityRepository;
  readonly permissions: PermissionAuditRepository;
  readonly usage: UsageRepository;
  readonly checkpoints: CheckpointRepository;
}

export type SessionErrorReason =
  | "created-at-regressed"
  | "duplicate-message"
  | "duplicate-session"
  | "message-session-mismatch"
  | "non-terminal-message"
  | "parent-mismatch"
  | "session-not-found"
  | "stale-revision";

export class SessionError extends PilotError {
  readonly reason: SessionErrorReason;

  constructor(
    code: "PILOT_SESSION_CONFLICT" | "PILOT_SESSION_INVALID_MESSAGE" | "PILOT_SESSION_NOT_FOUND",
    reason: SessionErrorReason,
    message: string,
    metadata: Readonly<Record<string, unknown>> = {},
  ) {
    super({
      code,
      message,
      safeMessage:
        code === "PILOT_SESSION_NOT_FOUND"
          ? "The requested session does not exist"
          : "The session update is invalid",
      metadata: { reason, ...metadata },
    });
    this.reason = reason;
  }
}
