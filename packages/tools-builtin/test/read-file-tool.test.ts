import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolRegistry } from "@pilotrun/agent-runtime";
import {
  CancellationError,
  runId,
  toolCallId,
  ToolContractError,
  type ToolExecutionContext,
} from "@pilotrun/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createReadFileTool,
  NodeWorkspaceBoundary,
  ReadFileInputSchema,
  ReadFileToolError,
} from "../src/index.js";

let sandboxPath: string;
let workspacePath: string;
let outsidePath: string;

beforeEach(async () => {
  sandboxPath = await mkdtemp(path.join(tmpdir(), "pilot-read-file-test-"));
  workspacePath = path.join(sandboxPath, "workspace");
  outsidePath = path.join(sandboxPath, "outside");
  await mkdir(path.join(workspacePath, "src"), { recursive: true });
  await mkdir(outsidePath);
});

afterEach(async () => {
  await rm(sandboxPath, { recursive: true, force: true });
});

function context(signal = new AbortController().signal): ToolExecutionContext {
  return { runId: runId("run-read"), callId: toolCallId("call-read"), signal };
}

describe("read_file", () => {
  it("reads an exact line range with full-file hash and provenance", async () => {
    const source = "alpha\r\nβeta\r\ngamma";
    await writeFile(path.join(workspacePath, "src", "main.ts"), source);
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const readFile = createReadFileTool(boundary);

    const result = await readFile.execute(
      ReadFileInputSchema.parse({ path: "src/main.ts", startLine: 2, endLine: 2 }),
      context(),
    );

    const sha256 = createHash("sha256").update(Buffer.from(source)).digest("hex");
    expect(result.output).toEqual({
      path: "src/main.ts",
      content: "βeta\r\n",
      startLine: 2,
      endLine: 2,
      totalLines: 3,
      sizeBytes: Buffer.byteLength(source),
      sha256,
      encoding: "utf-8",
      hasBom: false,
      lineEnding: "crlf",
      truncated: false,
      lineTruncated: false,
      sanitizedCharacters: 0,
      provenance: { source: "workspace-file", path: "src/main.ts", sha256, untrusted: true },
    });
    expect(result.metadata).toEqual({
      untrusted: true,
      truncated: false,
      sourcePath: "src/main.ts",
      sha256,
      sanitizedCharacters: 0,
    });
  });

  it("handles an empty file, a UTF-8 BOM, and mixed line endings explicitly", async () => {
    await writeFile(path.join(workspacePath, "empty.txt"), "");
    await writeFile(
      path.join(workspacePath, "mixed.txt"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\ntwo\rthree\r\n")]),
    );
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const readFile = createReadFileTool(boundary);

    const empty = await readFile.execute(
      ReadFileInputSchema.parse({ path: "empty.txt" }),
      context(),
    );
    const mixed = await readFile.execute(
      ReadFileInputSchema.parse({ path: "mixed.txt" }),
      context(),
    );

    expect(empty.output).toMatchObject({
      content: "",
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      lineEnding: "none",
      hasBom: false,
    });
    expect(mixed.output).toMatchObject({
      content: "one\ntwo\rthree\r\n",
      totalLines: 3,
      lineEnding: "mixed",
      hasBom: true,
    });
  });

  it("bounds output on UTF-8 character boundaries and reports partial-line truncation", async () => {
    const source = `${"界".repeat(400)}\nsecond line\n`;
    await writeFile(path.join(workspacePath, "long.txt"), source);
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const readFile = createReadFileTool(boundary);

    const result = await readFile.execute(
      ReadFileInputSchema.parse({ path: "long.txt", maxContentBytes: 1_024 }),
      context(),
    );

    expect(Buffer.byteLength(result.output.content, "utf8")).toBeLessThanOrEqual(1_024);
    expect(result.output.content.endsWith("�")).toBe(false);
    expect(result.output).toMatchObject({
      startLine: 1,
      endLine: 1,
      totalLines: 2,
      truncated: true,
      truncationReason: "output-bytes",
      lineTruncated: true,
    });
    expect(result.output.nextStartLine).toBeUndefined();
  });

  it("provides a next-line retrieval hint when truncation lands on a line boundary", async () => {
    await writeFile(path.join(workspacePath, "paged.txt"), `${"x".repeat(1_023)}\nnext\n`);
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const readFile = createReadFileTool(boundary);

    const result = await readFile.execute(
      ReadFileInputSchema.parse({ path: "paged.txt", maxContentBytes: 1_024 }),
      context(),
    );

    expect(result.output).toMatchObject({
      endLine: 1,
      truncated: true,
      nextStartLine: 2,
      lineTruncated: false,
    });
  });

  it("keeps worst-case JSON-escaped content below the declared tool output limit", async () => {
    await writeFile(path.join(workspacePath, "newlines.txt"), "\n".repeat(100_001));
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const readFile = createReadFileTool(boundary);

    const result = await readFile.execute(
      ReadFileInputSchema.parse({ path: "newlines.txt", maxContentBytes: 100_000 }),
      context(),
    );

    expect(Buffer.byteLength(JSON.stringify(result.output), "utf8")).toBeLessThan(
      readFile.metadata.maxOutputBytes,
    );
    expect(result.output).toMatchObject({ truncated: true, nextStartLine: 100_001 });
  });

  it("sanitizes terminal controls while retaining the raw-file hash", async () => {
    const source = "safe\u001b[31m text\n";
    await writeFile(path.join(workspacePath, "control.txt"), source);
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const readFile = createReadFileTool(boundary);

    const result = await readFile.execute(
      ReadFileInputSchema.parse({ path: "control.txt" }),
      context(),
    );

    expect(result.output.content).toBe("safe�[31m text\n");
    expect(result.output.sanitizedCharacters).toBe(1);
    expect(result.output.sha256).toBe(
      createHash("sha256").update(Buffer.from(source)).digest("hex"),
    );
  });

  it("rejects invalid UTF-8, binary nulls, and files over the requested hard read bound", async () => {
    await writeFile(path.join(workspacePath, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(path.join(workspacePath, "binary.dat"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(path.join(workspacePath, "large.txt"), "12345");
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const readFile = createReadFileTool(boundary);

    await expect(
      readFile.execute(ReadFileInputSchema.parse({ path: "invalid.txt" }), context()),
    ).rejects.toMatchObject({ code: "PILOT_READ_FILE_INVALID_ENCODING" });
    await expect(
      readFile.execute(ReadFileInputSchema.parse({ path: "binary.dat" }), context()),
    ).rejects.toMatchObject({ code: "PILOT_READ_FILE_BINARY" });
    await expect(
      readFile.execute(
        ReadFileInputSchema.parse({ path: "large.txt", maxFileSizeBytes: 4 }),
        context(),
      ),
    ).rejects.toMatchObject({ code: "PILOT_READ_FILE_TOO_LARGE" });
  });

  it("rejects directories, invalid ranges, traversal, and symlink escapes", async () => {
    await writeFile(path.join(workspacePath, "one.txt"), "one\n");
    await writeFile(path.join(outsidePath, "secret.txt"), "secret\n");
    await symlink(outsidePath, path.join(workspacePath, "escape"), "junction");
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const readFile = createReadFileTool(boundary);

    await expect(
      readFile.execute(ReadFileInputSchema.parse({ path: "src" }), context()),
    ).rejects.toBeInstanceOf(ReadFileToolError);
    await expect(
      readFile.execute(ReadFileInputSchema.parse({ path: "one.txt", startLine: 2 }), context()),
    ).rejects.toMatchObject({ code: "PILOT_READ_FILE_INVALID_RANGE" });
    await expect(
      readFile.execute(ReadFileInputSchema.parse({ path: "../outside/secret.txt" }), context()),
    ).rejects.toMatchObject({ code: "PILOT_WORKSPACE_PATH_ESCAPE" });
    await expect(
      readFile.execute(ReadFileInputSchema.parse({ path: "escape/secret.txt" }), context()),
    ).rejects.toMatchObject({ code: "PILOT_WORKSPACE_PATH_ESCAPE" });
  });

  it("propagates cancellation and exposes strict model-facing schemas", async () => {
    await writeFile(path.join(workspacePath, "file.txt"), "content\n");
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const readFile = createReadFileTool(boundary);
    const registry = new ToolRegistry([readFile]);
    const controller = new AbortController();
    controller.abort("stop reading");

    await expect(
      readFile.execute(ReadFileInputSchema.parse({ path: "file.txt" }), context(controller.signal)),
    ).rejects.toBeInstanceOf(CancellationError);
    expect(() => registry.parseInput("read_file", { path: "file.txt", shell: "whoami" })).toThrow(
      ToolContractError,
    );
    expect(registry.modelDefinitions()[0]).toMatchObject({
      name: "read_file",
      inputSchema: { type: "object", additionalProperties: false },
    });
    expect(registry.resolve("read_file").definition.metadata).toMatchObject({
      risk: "read-only",
      concurrency: "parallel-safe",
      requiredPermissions: ["workspace.read"],
    });
  });

  it("validates line ordering at the input boundary", () => {
    expect(
      ReadFileInputSchema.safeParse({ path: "file.txt", startLine: 4, endLine: 3 }).success,
    ).toBe(false);
  });
});
