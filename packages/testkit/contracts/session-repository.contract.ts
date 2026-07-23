import {
  messageId,
  parseAgentMessage,
  runId,
  sessionId,
  type AgentMessage,
  type SessionRepository,
} from "@pilot/core";
import { describe, expect, it } from "vitest";

export type SessionRepositoryFactory = () => SessionRepository | Promise<SessionRepository>;

function userMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return parseAgentMessage({
    schemaVersion: 1,
    id: messageId("message-1"),
    sessionId: sessionId("session-1"),
    runId: runId("run-1"),
    role: "user",
    status: "complete",
    parts: [{ type: "text", text: "Hello" }],
    createdAt: "2026-07-22T01:00:00.000Z",
    provenance: { kind: "user", channel: "cli" },
    ...overrides,
  });
}

/** Registers the behavior every durable and in-memory session adapter must satisfy. */
export function sessionRepositoryContract(
  adapterName: string,
  createRepository: SessionRepositoryFactory,
): void {
  describe(`${adapterName} SessionRepository contract`, () => {
    it("returns undefined for an unknown session", async () => {
      const repository = await createRepository();

      expect(await repository.load(sessionId("missing"))).toBeUndefined();
    });

    it("creates normalized immutable snapshots without exposing later writes", async () => {
      const repository = await createRepository();
      const id = sessionId("session-1");
      const created = await repository.create({
        id,
        createdAt: "2026-07-22T08:00:00+07:00",
      });
      const updated = await repository.appendMessage(userMessage(), { expectedRevision: 0 });

      expect(created).toEqual({
        schemaVersion: 1,
        id,
        createdAt: "2026-07-22T01:00:00.000Z",
        updatedAt: "2026-07-22T01:00:00.000Z",
        revision: 0,
        messages: [],
      });
      expect(created.messages).toHaveLength(0);
      expect(updated.revision).toBe(1);
      expect(updated.messages.map(({ id: message }) => message)).toEqual(["message-1"]);
      expect(Object.isFrozen(created)).toBe(true);
      expect(Object.isFrozen(created.messages)).toBe(true);
      expect(Object.isFrozen(updated)).toBe(true);
    });

    it("rejects duplicate sessions and atomically rolls back invalid initial history", async () => {
      const repository = await createRepository();
      const id = sessionId("session-1");
      await repository.create({ id, createdAt: "2026-07-22T01:00:00.000Z" });

      await expect(
        repository.create({ id, createdAt: "2026-07-22T01:00:00.000Z" }),
      ).rejects.toMatchObject({ code: "PILOT_SESSION_CONFLICT", reason: "duplicate-session" });

      const secondId = sessionId("session-2");
      await expect(
        repository.create({
          id: secondId,
          createdAt: "2026-07-22T01:00:00.000Z",
          initialMessages: [
            userMessage({ sessionId: secondId, status: "partial", id: messageId("partial") }),
          ],
        }),
      ).rejects.toMatchObject({ reason: "non-terminal-message" });
      expect(await repository.load(secondId)).toBeUndefined();
    });

    it("enforces optimistic revisions without mutating the stored session", async () => {
      const repository = await createRepository();
      const id = sessionId("session-1");
      await repository.create({ id, createdAt: "2026-07-22T01:00:00.000Z" });

      await expect(
        repository.appendMessage(userMessage(), { expectedRevision: 1 }),
      ).rejects.toMatchObject({
        code: "PILOT_SESSION_CONFLICT",
        reason: "stale-revision",
        metadata: { expectedRevision: 1, actualRevision: 0 },
      });
      expect(await repository.load(id)).toMatchObject({ revision: 0, messages: [] });
    });

    it("rejects duplicate, partial, stale, and non-linear messages", async () => {
      const repository = await createRepository();
      const id = sessionId("session-1");
      await repository.create({
        id,
        createdAt: "2026-07-22T01:00:00.000Z",
        initialMessages: [userMessage()],
      });

      await expect(repository.appendMessage(userMessage())).rejects.toMatchObject({
        reason: "duplicate-message",
      });
      await expect(
        repository.appendMessage(
          userMessage({
            id: messageId("partial"),
            parentId: messageId("message-1"),
            status: "partial",
          }),
        ),
      ).rejects.toMatchObject({ reason: "non-terminal-message" });
      await expect(
        repository.appendMessage(
          userMessage({
            id: messageId("wrong-parent"),
            parentId: messageId("unknown"),
            createdAt: "2026-07-22T01:00:01.000Z",
          }),
        ),
      ).rejects.toMatchObject({ reason: "parent-mismatch" });
      await expect(
        repository.appendMessage(
          userMessage({
            id: messageId("stale"),
            parentId: messageId("message-1"),
            createdAt: "2026-07-22T00:59:59.000Z",
          }),
        ),
      ).rejects.toMatchObject({ reason: "created-at-regressed" });
    });

    it("rejects writes for missing or mismatched sessions", async () => {
      const repository = await createRepository();
      await expect(repository.appendMessage(userMessage())).rejects.toMatchObject({
        code: "PILOT_SESSION_NOT_FOUND",
        reason: "session-not-found",
      });

      await repository.create({
        id: sessionId("session-2"),
        createdAt: "2026-07-22T01:00:00.000Z",
      });
      await expect(
        repository.create({
          id: sessionId("session-3"),
          createdAt: "2026-07-22T01:00:00.000Z",
          initialMessages: [userMessage({ sessionId: sessionId("session-2") })],
        }),
      ).rejects.toMatchObject({ reason: "message-session-mismatch" });
    });
  });
}
