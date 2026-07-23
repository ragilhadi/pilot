import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolRegistry } from "@pilot/agent-runtime";
import { CancellationError, runId, toolCallId, type ToolExecutionContext } from "@pilot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compileGlobPattern,
  createBuiltinFileListTools,
  FileToolError,
  GlobInputSchema,
  GlobPatternError,
  ListFilesInputSchema,
  NodeWorkspaceBoundary,
} from "../src/index.js";

let sandboxPath: string;
let workspacePath: string;
let outsidePath: string;

beforeEach(async () => {
  sandboxPath = await mkdtemp(path.join(tmpdir(), "pilot-file-tools-test-"));
  workspacePath = path.join(sandboxPath, "workspace");
  outsidePath = path.join(sandboxPath, "outside");
  await mkdir(path.join(workspacePath, "src", "nested"), { recursive: true });
  await mkdir(path.join(workspacePath, "dist"));
  await mkdir(outsidePath);
  await writeFile(path.join(workspacePath, ".gitignore"), "*.log\n!keep.log\n");
  await writeFile(path.join(workspacePath, ".env"), "SECRET=value\n");
  await writeFile(path.join(workspacePath, "src", "b.ts"), "export const b = 2;\n");
  await writeFile(path.join(workspacePath, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(workspacePath, "src", ".hidden.ts"), "export {};\n");
  await writeFile(path.join(workspacePath, "src", "nested", "component.tsx"), "export {};\n");
  await writeFile(path.join(workspacePath, "src", "nested", "helper.js"), "export {};\n");
  await writeFile(path.join(workspacePath, "ignored.log"), "ignored\n");
  await writeFile(path.join(workspacePath, "keep.log"), "kept\n");
  await writeFile(path.join(workspacePath, "dist", "bundle.js"), "generated\n");
  await writeFile(path.join(outsidePath, "secret.ts"), "outside\n");
  await directoryLink(outsidePath, path.join(workspacePath, "escape"));
  await directoryLink(
    path.join(workspacePath, "src", "nested"),
    path.join(workspacePath, "safe-link"),
  );
});

afterEach(async () => {
  await rm(sandboxPath, { recursive: true, force: true });
});

async function directoryLink(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function context(signal = new AbortController().signal): ToolExecutionContext {
  return { runId: runId("run-files"), callId: toolCallId("call-files"), signal };
}

describe("list_files", () => {
  it("lists deterministic workspace-relative entries with depth, ignore, hidden, and link policy", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const { listFiles } = createBuiltinFileListTools(boundary);

    const result = await listFiles.execute(
      ListFilesInputSchema.parse({ path: ".", maxDepth: 3, limit: 100 }),
      context(),
    );

    expect(result.output.entries.map(({ path: entryPath }) => entryPath)).toEqual([
      "keep.log",
      "safe-link",
      "src",
      "src/a.ts",
      "src/b.ts",
      "src/nested",
      "src/nested/component.tsx",
      "src/nested/helper.js",
    ]);
    expect(result.output.entries.find(({ path: entryPath }) => entryPath === "safe-link")).toEqual({
      path: "safe-link",
      kind: "symlink",
    });
    expect(result.output.ignoredEntries).toBe(2);
    expect(result.output.hiddenEntries).toBe(3);
    expect(result.output.unsafeLinksSkipped).toBe(1);
    expect(result.output.truncated).toBe(false);
    expect(result.metadata).toEqual({ untrusted: true, truncated: false });
  });

  it("applies a result limit after stable sorting and reports truncation", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const { listFiles } = createBuiltinFileListTools(boundary);

    const first = await listFiles.execute(
      ListFilesInputSchema.parse({ path: "src", maxDepth: 2, limit: 2 }),
      context(),
    );
    const second = await listFiles.execute(
      ListFilesInputSchema.parse({ path: "src", maxDepth: 2, limit: 2 }),
      context(),
    );

    expect(first.output.entries).toEqual([
      { path: "src/a.ts", kind: "file", sizeBytes: 20 },
      { path: "src/b.ts", kind: "file", sizeBytes: 20 },
    ]);
    expect(first.output).toMatchObject({
      root: "src",
      truncated: true,
      truncationReason: "limit",
    });
    expect(second.output).toEqual(first.output);
  });

  it("includes hidden files only when requested while protected generated paths remain ignored", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const { listFiles } = createBuiltinFileListTools(boundary);

    const result = await listFiles.execute(
      ListFilesInputSchema.parse({ path: ".", maxDepth: 2, limit: 100, includeHidden: true }),
      context(),
    );

    const paths = result.output.entries.map(({ path: entryPath }) => entryPath);
    expect(paths).toContain(".env");
    expect(paths).toContain(".gitignore");
    expect(paths).toContain("src/.hidden.ts");
    expect(paths).not.toContain("dist");
  });

  it("rejects file targets and propagates cancellation", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const { listFiles } = createBuiltinFileListTools(boundary);
    const controller = new AbortController();
    controller.abort("stop listing");

    await expect(
      listFiles.execute(ListFilesInputSchema.parse({ path: "src/a.ts" }), context()),
    ).rejects.toBeInstanceOf(FileToolError);
    await expect(
      listFiles.execute(ListFilesInputSchema.parse({}), context(controller.signal)),
    ).rejects.toBeInstanceOf(CancellationError);
  });
});

describe("glob", () => {
  it("matches globstar, braces, and character classes with deterministic file-only defaults", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const { glob } = createBuiltinFileListTools(boundary);

    const typescript = await glob.execute(
      GlobInputSchema.parse({ pattern: "**/*.{ts,tsx}", limit: 100 }),
      context(),
    );
    const letterClass = await glob.execute(
      GlobInputSchema.parse({ pattern: "src/[ab].ts", limit: 100 }),
      context(),
    );

    expect(typescript.output.matches.map(({ path: entryPath }) => entryPath)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/nested/component.tsx",
    ]);
    expect(letterClass.output.matches.map(({ path: entryPath }) => entryPath)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("matches relative to a selected directory and can return directories", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const { glob } = createBuiltinFileListTools(boundary);

    const files = await glob.execute(
      GlobInputSchema.parse({ pattern: "**/*.js", path: "src", limit: 100 }),
      context(),
    );
    const directories = await glob.execute(
      GlobInputSchema.parse({ pattern: "**/nested", path: "src", kind: "directory" }),
      context(),
    );

    expect(files.output).toMatchObject({
      root: "src",
      matches: [{ path: "src/nested/helper.js", kind: "file" }],
    });
    expect(directories.output.matches).toEqual([{ path: "src/nested", kind: "directory" }]);
  });

  it.each(["../**/*.ts", "C:\\**\\*.ts", "/**/*.ts", "[abc", "{ts}"])(
    "rejects unsafe or malformed pattern %s",
    (pattern) => {
      expect(() => compileGlobPattern(pattern)).toThrow(GlobPatternError);
    },
  );

  it("publishes strict read-only model schemas through the tool registry", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const tools = createBuiltinFileListTools(boundary);
    const registry = new ToolRegistry([tools.listFiles, tools.glob]);

    expect(registry.modelDefinitions().map(({ name }) => name)).toEqual(["glob", "list_files"]);
    expect(registry.resolve("list_files").definition.metadata).toEqual({
      risk: "read-only",
      concurrency: "parallel-safe",
      timeoutMs: 10_000,
      maxOutputBytes: 262_144,
      requiredPermissions: ["workspace.read"],
    });
    expect(() => registry.parseInput("glob", { pattern: "*.ts", unknown: true })).toThrowError(
      expect.objectContaining({ code: "PILOT_TOOL_INPUT_INVALID" }),
    );
  });
});
