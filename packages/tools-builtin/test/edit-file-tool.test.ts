import { createHash } from "node:crypto";
import { PilotError, runId, toolCallId } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import {
  createEditFileTool,
  InMemoryChangeJournal,
  type AtomicReplaceInput,
  type AtomicReplaceResult,
  type WorkspaceFileSnapshot,
  type WorkspaceFileSystem,
} from "../src/index.js";

const clock = { now: () => new Date("2026-07-25T04:00:00.000Z") };

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
      throw new PilotError({ code: "PILOT_PATCH_BASE_MISMATCH", message: "Stale memory file" });
    }
    this.files.set(input.path, input.content);
    return {
      path: input.path,
      beforeSha256,
      afterSha256: sha256(input.content),
      sizeBytes: Buffer.byteLength(input.content),
    };
  }

  async createUtf8(): Promise<never> {
    throw new Error("not used in edit tests");
  }
}

describe("edit tool", () => {
  it("replaces a unique string and records a run-correlated change", async () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    const original = "export const value = 1;\nconst other = 2;\n";
    fileSystem.files.set("src/file.ts", original);
    const journal = new InMemoryChangeJournal(clock);
    const tool = createEditFileTool(fileSystem, journal);

    const result = await tool.execute(
      {
        path: "src/file.ts",
        baseSha256: sha256(original),
        oldString: "export const value = 1;",
        newString: "export const value = 42;",
        replaceAll: false,
      },
      context("run-edit", "call-edit"),
    );

    expect(fileSystem.files.get("src/file.ts")).toBe(
      "export const value = 42;\nconst other = 2;\n",
    );
    expect(result.output).toMatchObject({
      path: "src/file.ts",
      beforeSha256: sha256(original),
      afterSha256: sha256("export const value = 42;\nconst other = 2;\n"),
      replacements: 1,
      additions: 1,
      deletions: 1,
      journalSequence: 1,
    });
    expect(journal.entries(runId("run-edit"))).toMatchObject([
      { sequence: 1, operation: "apply", path: "src/file.ts", additions: 1, deletions: 1 },
    ]);
    // Original content must not leak into the public journal records.
    expect(JSON.stringify(journal.entries())).not.toContain("const other");
  });

  it("rejects a non-unique oldString unless replaceAll is set", async () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    fileSystem.files.set("a.txt", "x\nx\n");
    const tool = createEditFileTool(fileSystem, new InMemoryChangeJournal(clock));

    await expect(
      tool.execute(
        {
          path: "a.txt",
          baseSha256: sha256("x\nx\n"),
          oldString: "x",
          newString: "y",
          replaceAll: false,
        },
        context("run-dup", "call-dup"),
      ),
    ).rejects.toMatchObject({ code: "PILOT_EDIT_STRING_NOT_UNIQUE", metadata: { occurrences: 2 } });
    expect(fileSystem.files.get("a.txt")).toBe("x\nx\n");
  });

  it("replaces every occurrence when replaceAll is set", async () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    fileSystem.files.set("a.txt", "x\nx\n");
    const tool = createEditFileTool(fileSystem, new InMemoryChangeJournal(clock));

    const result = await tool.execute(
      {
        path: "a.txt",
        baseSha256: sha256("x\nx\n"),
        oldString: "x",
        newString: "y",
        replaceAll: true,
      },
      context("run-all", "call-all"),
    );

    expect(fileSystem.files.get("a.txt")).toBe("y\ny\n");
    expect(result.output).toMatchObject({ replacements: 2 });
  });

  it("fails when oldString is absent", async () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    fileSystem.files.set("a.txt", "hello\n");
    const tool = createEditFileTool(fileSystem, new InMemoryChangeJournal(clock));

    await expect(
      tool.execute(
        {
          path: "a.txt",
          baseSha256: sha256("hello\n"),
          oldString: "absent",
          newString: "y",
          replaceAll: false,
        },
        context("run-miss", "call-miss"),
      ),
    ).rejects.toMatchObject({ code: "PILOT_EDIT_STRING_NOT_FOUND" });
  });

  it("refuses to edit when the base hash is stale", async () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    fileSystem.files.set("a.txt", "current\n");
    const journal = new InMemoryChangeJournal(clock);
    const tool = createEditFileTool(fileSystem, journal);

    await expect(
      tool.execute(
        {
          path: "a.txt",
          baseSha256: sha256("stale\n"),
          oldString: "current",
          newString: "next",
          replaceAll: false,
        },
        context("run-stale", "call-stale"),
      ),
    ).rejects.toMatchObject({ code: "PILOT_PATCH_BASE_MISMATCH" });
    expect(fileSystem.files.get("a.txt")).toBe("current\n");
    expect(journal.entries()).toEqual([]);
  });

  it("preserves a concurrent user edit and writes no journal entry", async () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    fileSystem.files.set("a.txt", "base\n");
    fileSystem.beforeReplace = () => fileSystem.files.set("a.txt", "user edit\n");
    const journal = new InMemoryChangeJournal(clock);
    const tool = createEditFileTool(fileSystem, journal);

    await expect(
      tool.execute(
        {
          path: "a.txt",
          baseSha256: sha256("base\n"),
          oldString: "base",
          newString: "agent",
          replaceAll: false,
        },
        context("run-race", "call-race"),
      ),
    ).rejects.toMatchObject({ code: "PILOT_PATCH_BASE_MISMATCH" });
    expect(fileSystem.files.get("a.txt")).toBe("user edit\n");
    expect(journal.entries()).toEqual([]);
  });

  it("rejects model-facing input that violates the schema", () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    const tool = createEditFileTool(fileSystem, new InMemoryChangeJournal(clock));

    // Missing baseSha256.
    expect(() =>
      tool.inputSchema.parse({ path: "a.ts", oldString: "a", newString: "b" }),
    ).toThrow();
    // oldString equal to newString has no effect.
    expect(() =>
      tool.inputSchema.parse({
        path: "a.ts",
        baseSha256: sha256("x"),
        oldString: "a",
        newString: "a",
      }),
    ).toThrow();
    // Empty oldString is not allowed.
    expect(() =>
      tool.inputSchema.parse({
        path: "a.ts",
        baseSha256: sha256("x"),
        oldString: "",
        newString: "b",
      }),
    ).toThrow();
  });
});

function context(run: string, call: string) {
  return { runId: runId(run), callId: toolCallId(call), signal: new AbortController().signal };
}

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}
