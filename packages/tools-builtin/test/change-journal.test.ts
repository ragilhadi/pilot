import { runId, toolCallId } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import { InMemoryChangeJournal } from "../src/index.js";
import type { WorkspaceFileSystem } from "../src/index.js";

const clock = { now: () => new Date("2026-07-29T09:00:00.000Z") };

function digest(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function record(journal: InMemoryChangeJournal, index: number, content: string) {
  return journal.recordApplied({
    runId: runId("run-1"),
    callId: toolCallId(`call-${index}`),
    path: `file-${index}.txt`,
    beforeSha256: digest("a"),
    afterSha256: digest("b"),
    additions: 1,
    deletions: 1,
    originalContent: content,
  });
}

function fileSystemStub(): WorkspaceFileSystem {
  return {
    readUtf8: async () => {
      throw new Error("not used");
    },
    createUtf8: async () => {
      throw new Error("not used");
    },
    replaceUtf8Atomic: async ({ path }) => ({
      path,
      beforeSha256: digest("b"),
      afterSha256: digest("a"),
      sizeBytes: 1,
    }),
  };
}

describe("InMemoryChangeJournal retention", () => {
  // Every edit kept a full copy of the file as it was beforehand, for the lifetime of the process,
  // and nothing ever read it back. A long session rewriting large files grew without bound.
  it("evicts the oldest rollback payloads once the byte budget is exceeded", async () => {
    const journal = new InMemoryChangeJournal(clock, { maximumContentBytes: 1_000 });
    const first = record(journal, 1, "x".repeat(600));
    const second = record(journal, 2, "y".repeat(600));

    // Both changes stay in the public journal; only the oldest payload is dropped.
    expect(journal.entries()).toHaveLength(2);
    await expect(
      journal.rollback({
        sequence: first.sequence,
        runId: runId("run-1"),
        callId: toolCallId("call-undo"),
        fileSystem: fileSystemStub(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "PILOT_CHANGE_JOURNAL_INVALID" });

    const undone = await journal.rollback({
      sequence: second.sequence,
      runId: runId("run-1"),
      callId: toolCallId("call-undo"),
      fileSystem: fileSystemStub(),
      signal: new AbortController().signal,
    });
    expect(undone).toMatchObject({ operation: "rollback", relatedSequence: second.sequence });
  });

  it("keeps rollback available while the budget is not exhausted", async () => {
    const journal = new InMemoryChangeJournal(clock, { maximumContentBytes: 10_000 });
    const entry = record(journal, 1, "original text");
    record(journal, 2, "other text");

    const undone = await journal.rollback({
      sequence: entry.sequence,
      runId: runId("run-1"),
      callId: toolCallId("call-undo"),
      fileSystem: fileSystemStub(),
      signal: new AbortController().signal,
    });
    expect(undone).toMatchObject({ operation: "rollback", relatedSequence: entry.sequence });
  });

  it("does not retain a single file larger than the whole budget", async () => {
    const journal = new InMemoryChangeJournal(clock, { maximumContentBytes: 100 });
    const entry = record(journal, 1, "z".repeat(5_000));
    expect(journal.entries()).toHaveLength(1);
    await expect(
      journal.rollback({
        sequence: entry.sequence,
        runId: runId("run-1"),
        callId: toolCallId("call-undo"),
        fileSystem: fileSystemStub(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "PILOT_CHANGE_JOURNAL_INVALID" });
  });
});
