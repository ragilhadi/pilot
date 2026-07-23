import { runId, sessionId, toolCallId } from "@pilot/core";
import { describe, expect, it } from "vitest";
import {
  createSqliteRepositories,
  SqliteCrashRecovery,
  SqliteDatabase,
  SqliteMigrationRunner,
  SqliteRecordError,
} from "../src/index.js";

async function harness() {
  const database = new SqliteDatabase(":memory:");
  new SqliteMigrationRunner(database).migrate();
  const repositories = createSqliteRepositories(database);
  const session = sessionId("session-1");
  const run = runId("run-1");
  await repositories.sessions.create({
    id: session,
    createdAt: "2026-07-22T05:00:00.000Z",
  });
  await repositories.runs.create({
    id: run,
    sessionId: session,
    status: "running",
    state: { kind: "executing-tools", revision: 4 },
    startedAt: "2026-07-22T05:00:01.000Z",
    updatedAt: "2026-07-22T05:00:02.000Z",
  });
  return { database, repositories, run, session };
}

describe("SqliteCrashRecovery", () => {
  it("atomically interrupts unfinished work and reports uncertain mutation without replay", async () => {
    const { database, repositories, run } = await harness();
    await repositories.modelCalls.save({
      id: "model-call-1",
      runId: run,
      sequence: 1,
      modelKey: "ollama/glm-5.2:cloud",
      status: "started",
      request: { cycle: 1 },
      startedAt: "2026-07-22T05:00:02.000Z",
    });
    await repositories.toolActivity.saveCall({
      runId: run,
      callId: toolCallId("patch-running"),
      sequence: 1,
      toolName: "apply_patch",
      risk: "workspace-write",
      replaySafety: "unsafe",
      status: "running",
      input: { patch: "omitted" },
      startedAt: "2026-07-22T05:00:03.000Z",
    });
    await repositories.toolActivity.saveCall({
      runId: run,
      callId: toolCallId("read-approved"),
      sequence: 2,
      toolName: "read_file",
      risk: "read-only",
      replaySafety: "safe",
      status: "approved",
      input: { path: "README.md" },
    });
    await repositories.toolActivity.saveCall({
      runId: run,
      callId: toolCallId("network-result-lost"),
      sequence: 3,
      toolName: "run_command",
      risk: "network",
      replaySafety: "unknown",
      status: "completed",
      input: { executable: "publish" },
      startedAt: "2026-07-22T05:00:03.000Z",
      completedAt: "2026-07-22T05:00:04.000Z",
    });
    await repositories.toolActivity.saveCall({
      runId: run,
      callId: toolCallId("read-complete"),
      sequence: 4,
      toolName: "read_file",
      risk: "read-only",
      replaySafety: "safe",
      status: "completed",
      input: { path: "PLAN.md" },
      completedAt: "2026-07-22T05:00:04.000Z",
    });
    await repositories.toolActivity.saveResult({
      runId: run,
      callId: toolCallId("read-complete"),
      output: { text: "complete" },
      isError: false,
      createdAt: "2026-07-22T05:00:04.000Z",
    });
    await repositories.checkpoints.append({
      runId: run,
      sequence: 1,
      reason: "model.stream.event",
      payload: { stream: { partial: true, content: { text: "unfinished" } } },
      createdAt: "2026-07-22T05:00:03.000Z",
    });

    const report = new SqliteCrashRecovery(database).recover("2026-07-22T12:00:10+07:00");

    expect(report).toMatchObject({
      recoveredAt: "2026-07-22T05:00:10.000Z",
      runs: [
        {
          runId: "run-1",
          checkpointSequence: 2,
          requiresWorkspaceInspection: true,
          toolCalls: [
            {
              callId: "patch-running",
              previousStatus: "running",
              sideEffects: "unknown",
              recommendedAction: "inspect-workspace",
              automaticReplay: false,
            },
            {
              callId: "read-approved",
              previousStatus: "approved",
              sideEffects: "none",
              automaticReplay: false,
            },
            {
              callId: "network-result-lost",
              previousStatus: "completed",
              resultMissing: true,
              sideEffects: "unknown",
              automaticReplay: false,
            },
          ],
        },
      ],
    });
    expect(await repositories.runs.load(run)).toMatchObject({
      status: "interrupted",
      state: {
        kind: "interrupted",
        reason: "process-restart",
        recovery: { automaticReplay: false, requiresWorkspaceInspection: true },
      },
    });
    expect(await repositories.modelCalls.listByRun(run)).toMatchObject([{ status: "interrupted" }]);
    expect(await repositories.toolActivity.listCallsByRun(run)).toMatchObject([
      { callId: "patch-running", status: "interrupted" },
      { callId: "read-approved", status: "interrupted" },
      { callId: "network-result-lost", status: "interrupted" },
      { callId: "read-complete", status: "completed" },
    ]);
    expect(await repositories.toolActivity.listResultsByRun(run)).toHaveLength(1);
    expect(await repositories.checkpoints.listByRun(run)).toMatchObject([
      { sequence: 1, reason: "model.stream.event" },
      {
        sequence: 2,
        reason: "crash.recovered",
        payload: { automaticReplay: false, requiresWorkspaceInspection: true },
      },
    ]);

    expect(new SqliteCrashRecovery(database).recover("2026-07-22T05:00:11.000Z").runs).toEqual([]);
    database.close();
  });

  it("marks unfinished read-only execution inspectable without claiming side effects", async () => {
    const { database, repositories, run } = await harness();
    await repositories.toolActivity.saveCall({
      runId: run,
      callId: toolCallId("read-running"),
      sequence: 1,
      toolName: "read_file",
      risk: "read-only",
      replaySafety: "safe",
      status: "running",
      input: { path: "README.md" },
    });

    const report = new SqliteCrashRecovery(database).recover("2026-07-22T05:00:10.000Z");
    expect(report.runs[0]).toMatchObject({
      requiresWorkspaceInspection: false,
      toolCalls: [
        {
          sideEffects: "none",
          recommendedAction: "review-before-retry",
          automaticReplay: false,
        },
      ],
    });
    database.close();
  });

  it("rolls the whole recovery transaction back if durable state is corrupt", async () => {
    const { database, repositories, run } = await harness();
    await repositories.toolActivity.saveCall({
      runId: run,
      callId: toolCallId("patch-running"),
      sequence: 1,
      toolName: "apply_patch",
      risk: "workspace-write",
      replaySafety: "unsafe",
      status: "running",
      input: {},
    });
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.prepare("UPDATE runs SET state_json = 'corrupt' WHERE id = ?").run(run);

    expect(() =>
      new SqliteCrashRecovery(database).recover("2026-07-22T05:00:10.000Z"),
    ).toThrowError(SqliteRecordError);
    expect(database.prepare("SELECT status FROM runs WHERE id = ?").get(run)).toEqual({
      status: "running",
    });
    expect(database.prepare("SELECT status FROM tool_calls WHERE run_id = ?").get(run)).toEqual({
      status: "running",
    });
    database.close();
  });

  it("does not alter terminal or merely queued runs", async () => {
    const { database, repositories, session } = await harness();
    await repositories.runs.create({
      id: runId("run-complete"),
      sessionId: session,
      status: "completed",
      state: { kind: "completed" },
      startedAt: "2026-07-22T05:00:01.000Z",
      updatedAt: "2026-07-22T05:00:02.000Z",
      completedAt: "2026-07-22T05:00:02.000Z",
    });
    await repositories.runs.create({
      id: runId("run-queued"),
      sessionId: session,
      status: "queued",
      state: { kind: "idle" },
      startedAt: "2026-07-22T05:00:03.000Z",
      updatedAt: "2026-07-22T05:00:03.000Z",
    });
    await repositories.runs.save({
      id: runId("run-1"),
      sessionId: session,
      status: "aborted",
      state: { kind: "aborted" },
      startedAt: "2026-07-22T05:00:01.000Z",
      updatedAt: "2026-07-22T05:00:04.000Z",
      completedAt: "2026-07-22T05:00:04.000Z",
    });

    expect(new SqliteCrashRecovery(database).recover("2026-07-22T05:00:10.000Z").runs).toEqual([]);
    expect(await repositories.runs.load(runId("run-queued"))).toMatchObject({ status: "queued" });
    database.close();
  });
});
