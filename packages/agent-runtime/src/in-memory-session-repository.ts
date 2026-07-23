import {
  type AgentMessage,
  type AppendMessageOptions,
  type MessageId,
  type NewSession,
  parseAgentMessage,
  sessionSchemaVersion,
  SessionError,
  type SessionId,
  type SessionRepository,
  type SessionSnapshot,
} from "@pilotrun/core";

export {
  type AppendMessageOptions,
  type NewSession,
  sessionSchemaVersion,
  SessionError,
  type SessionErrorReason,
  type SessionRepository,
  type SessionSnapshot,
} from "@pilotrun/core";

interface StoredSession {
  readonly id: SessionId;
  readonly createdAt: string;
  updatedAt: string;
  revision: number;
  readonly messages: AgentMessage[];
  readonly messageIds: Set<MessageId>;
}

/** A deterministic repository used until the SQLite implementation arrives in Phase 6. */
export class InMemorySessionRepository implements SessionRepository {
  readonly #sessions = new Map<SessionId, StoredSession>();

  async create(input: NewSession): Promise<SessionSnapshot> {
    if (this.#sessions.has(input.id)) {
      throw new SessionError(
        "PILOT_SESSION_CONFLICT",
        "duplicate-session",
        `Session ${input.id} already exists`,
        { sessionId: input.id },
      );
    }

    const createdAt = parseTimestamp(input.createdAt, "session createdAt");
    const stored: StoredSession = {
      id: input.id,
      createdAt,
      updatedAt: createdAt,
      revision: 0,
      messages: [],
      messageIds: new Set(),
    };
    this.#sessions.set(input.id, stored);

    try {
      for (const message of input.initialMessages ?? []) {
        this.#append(stored, message);
      }
    } catch (error) {
      this.#sessions.delete(input.id);
      throw error;
    }

    return snapshot(stored);
  }

  async appendMessage(
    message: AgentMessage,
    options: AppendMessageOptions = {},
  ): Promise<SessionSnapshot> {
    const parsed = parseAgentMessage(message);
    const stored = this.#sessions.get(parsed.sessionId);
    if (stored === undefined) {
      throw new SessionError(
        "PILOT_SESSION_NOT_FOUND",
        "session-not-found",
        `Session ${parsed.sessionId} does not exist`,
        { sessionId: parsed.sessionId },
      );
    }
    if (options.expectedRevision !== undefined && options.expectedRevision !== stored.revision) {
      throw new SessionError(
        "PILOT_SESSION_CONFLICT",
        "stale-revision",
        `Session ${stored.id} is at revision ${stored.revision}, not ${options.expectedRevision}`,
        {
          sessionId: stored.id,
          expectedRevision: options.expectedRevision,
          actualRevision: stored.revision,
        },
      );
    }
    this.#append(stored, parsed);
    return snapshot(stored);
  }

  async load(id: SessionId): Promise<SessionSnapshot | undefined> {
    const stored = this.#sessions.get(id);
    return stored === undefined ? undefined : snapshot(stored);
  }

  #append(stored: StoredSession, input: AgentMessage): void {
    const message = parseAgentMessage(input);
    if (message.sessionId !== stored.id) {
      throw new SessionError(
        "PILOT_SESSION_INVALID_MESSAGE",
        "message-session-mismatch",
        `Message ${message.id} belongs to a different session`,
        { messageId: message.id, sessionId: stored.id },
      );
    }
    if (stored.messageIds.has(message.id)) {
      throw new SessionError(
        "PILOT_SESSION_CONFLICT",
        "duplicate-message",
        `Message ${message.id} already exists in session ${stored.id}`,
        { messageId: message.id, sessionId: stored.id },
      );
    }
    if (message.status === "partial") {
      throw new SessionError(
        "PILOT_SESSION_INVALID_MESSAGE",
        "non-terminal-message",
        `Partial message ${message.id} cannot be committed to conversation history`,
        { messageId: message.id, sessionId: stored.id },
      );
    }

    const tail = stored.messages.at(-1);
    const expectedParentId = tail?.id;
    if (message.parentId !== expectedParentId) {
      throw new SessionError(
        "PILOT_SESSION_INVALID_MESSAGE",
        "parent-mismatch",
        `Message ${message.id} does not extend the current session tail`,
        {
          messageId: message.id,
          sessionId: stored.id,
          ...(expectedParentId === undefined ? {} : { expectedParentId }),
          ...(message.parentId === undefined ? {} : { actualParentId: message.parentId }),
        },
      );
    }

    const createdAt = parseTimestamp(message.createdAt, "message createdAt");
    if (Date.parse(createdAt) < Date.parse(stored.updatedAt)) {
      throw new SessionError(
        "PILOT_SESSION_INVALID_MESSAGE",
        "created-at-regressed",
        `Message ${message.id} predates the current session tail`,
        { messageId: message.id, sessionId: stored.id },
      );
    }

    stored.messages.push(message);
    stored.messageIds.add(message.id);
    stored.updatedAt = createdAt;
    stored.revision += 1;
  }
}

function parseTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new SessionError(
      "PILOT_SESSION_INVALID_MESSAGE",
      "created-at-regressed",
      `${label} must be an ISO timestamp`,
    );
  }
  return new Date(timestamp).toISOString();
}

function snapshot(stored: StoredSession): SessionSnapshot {
  return Object.freeze({
    schemaVersion: sessionSchemaVersion,
    id: stored.id,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    revision: stored.revision,
    messages: Object.freeze([...stored.messages]),
  });
}
