import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  emptyDiagnosticsReport,
  runId,
  toolCallId,
  type WorkspaceDiagnosticsPort,
  type WorkspaceDiagnosticsReport,
} from "@pilotrun/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDiagnosticsTool,
  createEditFileTool,
  createWriteFileTool,
  InMemoryChangeJournal,
  NodeWorkspaceBoundary,
  NodeWorkspaceFileSystem,
} from "../src/index.js";

const clock = { now: () => new Date("2026-07-29T10:00:00.000Z") };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<{
  fileSystem: NodeWorkspaceFileSystem;
  journal: InMemoryChangeJournal;
  root: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "pilot-diagnostics-"));
  roots.push(root);
  const boundary = await NodeWorkspaceBoundary.create(root);
  return {
    fileSystem: new NodeWorkspaceFileSystem(boundary),
    journal: new InMemoryChangeJournal(clock),
    root,
  };
}

function context() {
  return {
    runId: runId("run-1"),
    callId: toolCallId("call-1"),
    signal: new AbortController().signal,
  };
}

function portReturning(report: WorkspaceDiagnosticsReport): {
  port: WorkspaceDiagnosticsPort;
  seen: { path: string; content: string }[];
} {
  const seen: { path: string; content: string }[] = [];
  return {
    seen,
    port: {
      check: async ({ path: target, content }) => {
        seen.push({ path: target, content });
        return report;
      },
    },
  };
}

const oneError: WorkspaceDiagnosticsReport = Object.freeze({
  status: "ready",
  items: Object.freeze([
    Object.freeze({
      severity: "error" as const,
      line: 3,
      column: 11,
      message: "Type 'string' is not assignable to type 'number'.",
      source: "ts",
    }),
  ]),
  errorCount: 1,
  warningCount: 0,
});

describe("diagnostics attached to write results", () => {
  // The point of the whole feature: the model reads the error as part of the edit's own result,
  // so it fixes it in the same turn instead of never looking.
  it("write_file returns diagnostics for the content it just wrote", async () => {
    const { fileSystem, journal } = await workspace();
    const { port, seen } = portReturning(oneError);
    const tool = createWriteFileTool(fileSystem, journal, { port });

    const result = await tool.execute(
      { path: "index.ts", content: "const x: number = 'a';\n" },
      context(),
    );

    expect(result.output).toMatchObject({ diagnostics: { status: "ready", errorCount: 1 } });
    expect(seen).toEqual([{ path: "index.ts", content: "const x: number = 'a';\n" }]);
  });

  it("edit returns diagnostics for the post-edit content, not the original", async () => {
    const { fileSystem, journal, root } = await workspace();
    await writeFile(path.join(root, "a.ts"), "const x: number = 1;\n", "utf8");
    const sha = createHash("sha256").update("const x: number = 1;\n", "utf8").digest("hex");
    const { port, seen } = portReturning(oneError);
    const tool = createEditFileTool(fileSystem, journal, { port });

    await tool.execute(
      { path: "a.ts", baseSha256: sha, oldString: "1", newString: "'a'", replaceAll: false },
      context(),
    );

    expect(seen[0]?.content).toBe("const x: number = 'a';\n");
  });

  it("omits the field entirely when no port is wired", async () => {
    const { fileSystem, journal } = await workspace();
    const tool = createWriteFileTool(fileSystem, journal);
    const result = await tool.execute({ path: "a.ts", content: "ok\n" }, context());
    expect(result.output).not.toHaveProperty("diagnostics");
  });

  // The edit already landed and its result is already correct; a broken language server must not
  // turn a successful write into a failed tool call.
  it("survives a diagnostics provider that throws", async () => {
    const { fileSystem, journal } = await workspace();
    const tool = createWriteFileTool(fileSystem, journal, {
      port: {
        check: async () => {
          throw new Error("language server exploded");
        },
      },
    });

    const result = await tool.execute({ path: "a.ts", content: "ok\n" }, context());
    expect(result.output).toMatchObject({
      created: true,
      diagnostics: { status: "unavailable" },
    });
  });

  it("survives a provider returning a malformed report", async () => {
    const { fileSystem, journal } = await workspace();
    const tool = createWriteFileTool(fileSystem, journal, {
      port: { check: async () => ({ nonsense: true }) as never },
    });
    const result = await tool.execute({ path: "a.ts", content: "ok\n" }, context());
    expect(result.output).toMatchObject({ created: true, diagnostics: { status: "unavailable" } });
  });

  it("passes through a non-ready status so the model does not read it as clean", async () => {
    const { fileSystem, journal } = await workspace();
    const tool = createWriteFileTool(fileSystem, journal, {
      port: { check: async () => emptyDiagnosticsReport("timeout", "server was too slow") },
    });
    const result = await tool.execute({ path: "a.ts", content: "ok\n" }, context());
    expect(result.output).toMatchObject({
      diagnostics: { status: "timeout", detail: "server was too slow", items: [] },
    });
  });
});

describe("diagnostics tool", () => {
  it("checks a file the model has only read", async () => {
    const { fileSystem, root } = await workspace();
    await writeFile(path.join(root, "a.ts"), "const x = 1;\n", "utf8");
    const { port, seen } = portReturning(oneError);
    const tool = createDiagnosticsTool(fileSystem, port);

    const result = await tool.execute({ path: "a.ts" }, context());

    expect(result.output).toMatchObject({ path: "a.ts", diagnostics: { errorCount: 1 } });
    expect(seen[0]?.content).toBe("const x = 1;\n");
  });

  it("reports a provider failure rather than throwing", async () => {
    const { fileSystem, root } = await workspace();
    await writeFile(path.join(root, "a.ts"), "x\n", "utf8");
    const tool = createDiagnosticsTool(fileSystem, {
      check: async () => {
        throw new Error("nope");
      },
    });
    const result = await tool.execute({ path: "a.ts" }, context());
    expect(result.output).toMatchObject({ diagnostics: { status: "unavailable" } });
  });
});
