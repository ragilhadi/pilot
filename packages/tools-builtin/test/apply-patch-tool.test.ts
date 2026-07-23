import { createHash } from "node:crypto";
import { PilotError, runId, toolCallId } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import {
  createApplyPatchTool,
  InMemoryChangeJournal,
  type AtomicReplaceInput,
  type AtomicReplaceResult,
  type WorkspaceFileSnapshot,
  type WorkspaceFileSystem,
} from "../src/index.js";

const clock = { now: () => new Date("2026-07-22T04:00:00.000Z") };

class MemoryWorkspaceFileSystem implements WorkspaceFileSystem {
  readonly files = new Map<string, string>();
  beforeReplace?: () => void;

  async readUtf8(path: string): Promise<WorkspaceFileSnapshot> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Missing ${path}`);
    return {
      path,
      content,
      sha256: sha256(content),
      sizeBytes: Buffer.byteLength(content),
      mode: 0o644,
    };
  }

  async replaceUtf8Atomic(input: AtomicReplaceInput): Promise<AtomicReplaceResult> {
    this.beforeReplace?.();
    this.beforeReplace = undefined;
    const current = this.files.get(input.path);
    if (current === undefined) throw new Error(`Missing ${input.path}`);
    const beforeSha256 = sha256(current);
    if (beforeSha256 !== input.expectedSha256) {
      throw new PilotError({
        code: "PILOT_PATCH_BASE_MISMATCH",
        message: "Stale memory file",
      });
    }
    this.files.set(input.path, input.content);
    return {
      path: input.path,
      beforeSha256,
      afterSha256: sha256(input.content),
      sizeBytes: Buffer.byteLength(input.content),
    };
  }

  async createUtf8(input: { path: string; content: string }) {
    if (this.files.has(input.path)) {
      throw new PilotError({
        code: "PILOT_WORKSPACE_FILE_EXISTS",
        message: `Existing memory file ${input.path}`,
      });
    }
    this.files.set(input.path, input.content);
    return {
      path: input.path,
      sha256: sha256(input.content),
      sizeBytes: Buffer.byteLength(input.content),
    };
  }
}

describe("apply_patch tool and change journal", () => {
  it("applies one existing-file patch and records a run-correlated change", async () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    fileSystem.files.set("src/file.ts", "export const value = 1;\n");
    const journal = new InMemoryChangeJournal(clock);
    const tool = createApplyPatchTool(fileSystem, journal);
    const original = fileSystem.files.get("src/file.ts") ?? "";

    const result = await tool.execute(
      {
        path: "src/file.ts",
        baseSha256: sha256(original),
        patch:
          "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
      },
      context("run-edit", "call-edit"),
    );

    expect(fileSystem.files.get("src/file.ts")).toBe("export const value = 2;\n");
    expect(result.output).toMatchObject({
      path: "src/file.ts",
      beforeSha256: sha256(original),
      afterSha256: sha256("export const value = 2;\n"),
      journalSequence: 1,
      preview: { additions: 1, deletions: 1, hunks: 1 },
    });
    expect(journal.entries(runId("run-edit"))).toMatchObject([
      {
        sequence: 1,
        runId: "run-edit",
        callId: "call-edit",
        operation: "apply",
        path: "src/file.ts",
        additions: 1,
        deletions: 1,
      },
    ]);
    expect(JSON.stringify(journal.entries())).not.toContain("export const");
  });

  it("rolls back only when the applied content hash still matches", async () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    fileSystem.files.set("file.txt", "before\n");
    const journal = new InMemoryChangeJournal(clock);
    const tool = createApplyPatchTool(fileSystem, journal);
    await tool.execute(
      {
        path: "file.txt",
        baseSha256: sha256("before\n"),
        patch: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n",
      },
      context("run-rollback", "call-apply"),
    );

    await expect(
      journal.rollback({
        sequence: 1,
        runId: runId("run-rollback"),
        callId: toolCallId("call-rollback"),
        fileSystem,
        signal: signal(),
      }),
    ).resolves.toMatchObject({ operation: "rollback", relatedSequence: 1 });
    expect(fileSystem.files.get("file.txt")).toBe("before\n");
    await expect(
      journal.rollback({
        sequence: 1,
        runId: runId("run-rollback"),
        callId: toolCallId("call-rollback-again"),
        fileSystem,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ code: "PILOT_CHANGE_JOURNAL_INVALID" });
  });

  it("refuses rollback after a later user edit", async () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    fileSystem.files.set("file.txt", "before\n");
    const journal = new InMemoryChangeJournal(clock);
    const tool = createApplyPatchTool(fileSystem, journal);
    await tool.execute(
      {
        path: "file.txt",
        baseSha256: sha256("before\n"),
        patch: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+agent edit\n",
      },
      context("run-rollback-conflict", "call-apply"),
    );
    fileSystem.files.set("file.txt", "later user edit\n");

    await expect(
      journal.rollback({
        sequence: 1,
        runId: runId("run-rollback-conflict"),
        callId: toolCallId("call-rollback"),
        fileSystem,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ code: "PILOT_PATCH_BASE_MISMATCH" });
    expect(fileSystem.files.get("file.txt")).toBe("later user edit\n");
    expect(journal.entries()).toHaveLength(1);
  });

  it("preserves a concurrent user edit and writes no journal entry", async () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    fileSystem.files.set("file.txt", "base\n");
    fileSystem.beforeReplace = () => fileSystem.files.set("file.txt", "user edit\n");
    const journal = new InMemoryChangeJournal(clock);
    const tool = createApplyPatchTool(fileSystem, journal);

    await expect(
      tool.execute(
        {
          path: "file.txt",
          baseSha256: sha256("base\n"),
          patch: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-base\n+agent edit\n",
        },
        context("run-race", "call-race"),
      ),
    ).rejects.toMatchObject({ code: "PILOT_PATCH_BASE_MISMATCH" });
    expect(fileSystem.files.get("file.txt")).toBe("user edit\n");
    expect(journal.entries()).toEqual([]);
  });

  it("rejects a patch header targeting a different path before reading or writing", async () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    fileSystem.files.set("requested.txt", "base\n");
    const journal = new InMemoryChangeJournal(clock);
    const tool = createApplyPatchTool(fileSystem, journal);

    await expect(
      tool.execute(
        {
          path: "requested.txt",
          baseSha256: sha256("base\n"),
          patch: "--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-base\n+changed\n",
        },
        context("run-path", "call-path"),
      ),
    ).rejects.toMatchObject({ code: "PILOT_PATCH_INVALID" });
    expect(fileSystem.files.get("requested.txt")).toBe("base\n");
    expect(journal.entries()).toEqual([]);
  });
});

function context(run: string, call: string) {
  return { runId: runId(run), callId: toolCallId(call), signal: signal() };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}
