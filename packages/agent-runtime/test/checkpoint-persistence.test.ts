import { runId, toolCallId, type PersistedCheckpoint } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import {
  RepositoryRunCheckpointWriter,
  type RunCheckpoint,
  ThrottledRunCheckpointWriter,
  toPersistedCheckpoint,
} from "../src/index.js";

function checkpoint(
  sequence: number,
  reason: RunCheckpoint["reason"],
  options: {
    readonly run?: string;
    readonly stream?: boolean;
    readonly phase?: "active" | "completed";
  } = {},
): RunCheckpoint {
  return {
    schemaVersion: 1,
    sequence,
    occurredAt: `2026-07-22T04:00:${String(sequence).padStart(2, "0")}.000Z`,
    reason,
    state: { kind: "idle", runId: runId(options.run ?? "run-1"), revision: sequence },
    budget: {
      policy: {
        maxCycles: 3,
        maxModelAttempts: 3,
        maxToolCalls: 5,
        maxElapsedMs: 10_000,
      },
      elapsedMs: sequence,
      cycles: 1,
      modelAttempts: 1,
      toolCalls: 0,
      inputTokens: 2,
      outputTokens: 1,
      estimatedCostUsd: 0,
      activeModelAttempts: 1,
    },
    ...(options.stream === true
      ? {
          stream: {
            phase: options.phase ?? "active",
            responseId: "response-1",
            lastSequence: sequence,
            content: {
              text: [{ contentIndex: 0, text: `partial-${sequence}` }],
              ephemeralReasoning: [{ contentIndex: 0, text: "never persist this reasoning" }],
              toolCalls: [
                {
                  contentIndex: 1,
                  callId: toolCallId("call-1"),
                  toolName: "read_file",
                  argumentsText: '{"path":"README.md"}',
                  completed: true,
                  input: { path: "README.md" },
                },
              ],
              usage: { outputTokens: sequence, source: "provider" as const },
            },
          },
        }
      : {}),
  };
}

describe("ThrottledRunCheckpointWriter", () => {
  it("coalesces stream events but flushes the latest partial before lifecycle boundaries", async () => {
    let now = 0;
    const written: RunCheckpoint[] = [];
    const writer = new ThrottledRunCheckpointWriter(
      { write: async (value) => void written.push(value) },
      { nowMilliseconds: () => now },
      { streamIntervalMs: 100 },
    );

    await writer.write(checkpoint(1, "run.started"));
    await writer.write(checkpoint(2, "model.stream.event", { stream: true }));
    now = 10;
    await writer.write(checkpoint(3, "model.stream.event", { stream: true }));
    now = 20;
    await writer.write(checkpoint(4, "model.stream.event", { stream: true }));
    await writer.write(checkpoint(5, "tools.completed"));

    expect(written.map(({ sequence }) => sequence)).toEqual([1, 2, 4, 5]);
  });

  it("writes the newest snapshot when the interval elapses and bounds pending state to one item", async () => {
    let now = 0;
    const written: RunCheckpoint[] = [];
    const writer = new ThrottledRunCheckpointWriter(
      { write: async (value) => void written.push(value) },
      { nowMilliseconds: () => now },
      { streamIntervalMs: 100 },
    );

    await writer.write(checkpoint(1, "model.stream.event", { stream: true }));
    now = 10;
    await writer.write(checkpoint(2, "model.stream.event", { stream: true }));
    now = 100;
    await writer.write(checkpoint(3, "model.stream.event", { stream: true }));
    await writer.flush();

    expect(written.map(({ sequence }) => sequence)).toEqual([1, 3]);
  });

  it("serializes concurrent callers and retains a pending checkpoint after write failure", async () => {
    let failed = false;
    const attempts: number[] = [];
    const writer = new ThrottledRunCheckpointWriter(
      {
        write: async (value) => {
          attempts.push(value.sequence);
          if (value.sequence === 2 && !failed) {
            failed = true;
            throw new Error("storage unavailable");
          }
        },
      },
      { nowMilliseconds: () => 0 },
      { streamIntervalMs: 100 },
    );

    await writer.write(checkpoint(1, "model.stream.event", { stream: true }));
    await writer.write(checkpoint(2, "model.stream.event", { stream: true }));
    await expect(writer.flush()).rejects.toThrow("storage unavailable");
    await writer.flush();

    expect(attempts).toEqual([1, 2, 2]);
  });

  it("keeps throttling state isolated per run", async () => {
    const written: RunCheckpoint[] = [];
    const writer = new ThrottledRunCheckpointWriter(
      { write: async (value) => void written.push(value) },
      { nowMilliseconds: () => 0 },
      { streamIntervalMs: 100 },
    );

    await Promise.all([
      writer.write(checkpoint(1, "model.stream.event", { run: "run-1", stream: true })),
      writer.write(checkpoint(1, "model.stream.event", { run: "run-2", stream: true })),
    ]);
    expect(written.map(({ state }) => state.runId)).toEqual(["run-1", "run-2"]);
  });
});

describe("durable checkpoint representation", () => {
  it("marks active assistant content partial and excludes ephemeral reasoning", () => {
    const persisted = toPersistedCheckpoint(checkpoint(1, "model.stream.event", { stream: true }));

    expect(persisted).toMatchObject({
      runId: "run-1",
      sequence: 1,
      payload: {
        stream: {
          phase: "active",
          partial: true,
          content: {
            text: [{ text: "partial-1" }],
            toolCalls: [{ toolName: "read_file" }],
          },
          reasoning: { persisted: false },
        },
      },
    });
    expect(JSON.stringify(persisted)).not.toContain("never persist this reasoning");
    expect(Object.isFrozen(persisted)).toBe(true);
  });

  it("maps completed stream content as non-partial and writes through the repository port", async () => {
    const records: PersistedCheckpoint[] = [];
    const writer = new RepositoryRunCheckpointWriter({
      append: async (record) => void records.push(record),
      listByRun: async () => records,
    });

    await writer.write(
      checkpoint(2, "model.stream.event", {
        stream: true,
        phase: "completed",
      }),
    );
    expect(records).toMatchObject([{ payload: { stream: { partial: false } } }]);
  });

  it("rejects invalid throttle policies", () => {
    expect(
      () =>
        new ThrottledRunCheckpointWriter(
          { write: async () => undefined },
          { nowMilliseconds: () => 0 },
          { streamIntervalMs: -1 },
        ),
    ).toThrow(RangeError);
  });
});
