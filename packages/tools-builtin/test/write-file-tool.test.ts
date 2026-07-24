import { createHash } from "node:crypto";
import { PilotError, runId, toolCallId } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import {
  createWriteFileTool,
  InMemoryChangeJournal,
  type CreateFileInput,
  type CreateFileResult,
  type WorkspaceFileSnapshot,
  type WorkspaceFileSystem,
} from "../src/index.js";

const clock = { now: () => new Date("2026-07-22T04:00:00.000Z") };
const emptySha256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

class MemoryWorkspaceFileSystem implements WorkspaceFileSystem {
  readonly files = new Map<string, string>();

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

  async replaceUtf8Atomic(): Promise<never> {
    throw new Error("not used in write_file tests");
  }

  async createUtf8(input: CreateFileInput): Promise<CreateFileResult> {
    if (this.files.has(input.path)) {
      throw new PilotError({
        code: "PILOT_WORKSPACE_FILE_EXISTS",
        message: `Existing memory file ${input.path}`,
        safeMessage: "create_file only creates new files.",
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

describe("write_file tool", () => {
  it("creates a new file and records a run-correlated change from empty", async () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    const journal = new InMemoryChangeJournal(clock);
    const tool = createWriteFileTool(fileSystem, journal);
    const content = "line one\nline two\n";

    const result = await tool.execute(
      { path: "src/new.ts", content },
      context("run-new", "call-new"),
    );

    expect(fileSystem.files.get("src/new.ts")).toBe(content);
    expect(result.output).toMatchObject({
      path: "src/new.ts",
      sha256: sha256(content),
      sizeBytes: Buffer.byteLength(content),
      lineCount: 3,
      journalSequence: 1,
    });
    expect(result.metadata).toMatchObject({
      changed: true,
      created: true,
      sourcePath: "src/new.ts",
    });
    expect(journal.entries(runId("run-new"))).toMatchObject([
      {
        sequence: 1,
        operation: "apply",
        path: "src/new.ts",
        beforeSha256: emptySha256,
        afterSha256: sha256(content),
        additions: 3,
        deletions: 0,
      },
    ]);
  });

  it("reports an empty file as zero lines", async () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    const tool = createWriteFileTool(fileSystem, new InMemoryChangeJournal(clock));

    const result = await tool.execute(
      { path: "empty.txt", content: "" },
      context("run-e", "call-e"),
    );

    expect(result.output).toMatchObject({ sizeBytes: 0, lineCount: 0, sha256: emptySha256 });
  });

  it("refuses to overwrite an existing file and surfaces a typed error", async () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    fileSystem.files.set("exists.ts", "original\n");
    const tool = createWriteFileTool(fileSystem, new InMemoryChangeJournal(clock));

    await expect(
      tool.execute({ path: "exists.ts", content: "new\n" }, context("run-x", "call-x")),
    ).rejects.toMatchObject({ code: "PILOT_WORKSPACE_FILE_EXISTS" });
    expect(fileSystem.files.get("exists.ts")).toBe("original\n");
  });

  it("rejects model-facing input that violates the schema", async () => {
    const fileSystem = new MemoryWorkspaceFileSystem();
    const tool = createWriteFileTool(fileSystem, new InMemoryChangeJournal(clock));

    expect(() => tool.inputSchema.parse({ path: "", content: "x" })).toThrow();
    expect(() => tool.inputSchema.parse({ path: "a.ts", content: "x", extra: 1 })).toThrow();
  });
});

function context(run: string, call: string) {
  return { runId: runId(run), callId: toolCallId(call), signal: new AbortController().signal };
}

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}
