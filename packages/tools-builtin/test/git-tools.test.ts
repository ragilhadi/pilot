import { realpath as realpathCallback } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runId, toolCallId } from "@pilotrun/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGitDiffTool,
  createGitStatusTool,
  type GitCommandRunner,
  NodeWorkspaceBoundary,
  parseGitNumstat,
  parseGitStatusPorcelainV2,
} from "../src/index.js";

const realpathNative = promisify(realpathCallback.native);

let workspacePath: string;
// Real `git rev-parse --show-toplevel` always reports the fully resolved canonical
// path (e.g. expanding Windows 8.3 short names), matching NodeWorkspaceBoundary's
// native-realpath root. The fixture below must mirror that, not echo the raw
// mkdtemp path, or these tests only pass by accident on machines without any
// short-name segment in their temp directory.
let realWorkspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(tmpdir(), "pilot-git-tools-test-"));
  realWorkspacePath = await realpathNative(workspacePath);
  await mkdir(path.join(workspacePath, ".git"));
  await mkdir(path.join(workspacePath, "src"));
  await writeFile(path.join(workspacePath, "src", "file.ts"), "export {};\n");
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

describe("Git porcelain parsers", () => {
  it("parses branch headers, ordinary, renamed, unmerged, and untracked records", () => {
    const output =
      "# branch.oid abcdef\n" +
      "# branch.head main\n" +
      "# branch.upstream origin/main\n" +
      "# branch.ab +2 -1\n" +
      "1 M. N... 100644 100644 100644 aaa bbb staged.ts\0" +
      "1 .M N... 100644 100644 100644 aaa bbb bad\u001b.ts\0" +
      "2 R. N... 100644 100644 100644 aaa bbb R100 renamed.ts\0old.ts\0" +
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts\0" +
      "? new.ts\0";

    const parsed = parseGitStatusPorcelainV2(output);

    expect(parsed.branch).toEqual({
      oid: "abcdef",
      head: "main",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
    });
    expect(parsed.entries).toMatchObject([
      { path: "staged.ts", kind: "ordinary", status: "M.", staged: true },
      { path: "bad�.ts", kind: "ordinary", status: ".M", modified: true, sanitized: true },
      { path: "renamed.ts", originalPath: "old.ts", kind: "renamed", status: "R." },
      { path: "conflict.ts", kind: "unmerged", conflicted: true },
      { path: "new.ts", kind: "untracked", status: "??" },
    ]);
    expect(parsed.counts).toEqual({ staged: 3, modified: 2, untracked: 1, conflicted: 1 });
  });

  it("bounds status entries and reports parser truncation", () => {
    const parsed = parseGitStatusPorcelainV2("? one\0? two\0? three\0", 2);
    expect(parsed.entries.map(({ path }) => path)).toEqual(["one", "two"]);
    expect(parsed.truncated).toBe(true);
  });

  it("parses text, binary, and NUL-delimited rename numstat records", () => {
    expect(
      parseGitNumstat("2\t1\tfile.ts\0-\t-\tbinary.png\0" + "3\t0\t\0old.ts\0new.ts\0"),
    ).toEqual([
      { path: "file.ts", additions: 2, deletions: 1, binary: false, sanitized: false },
      { path: "binary.png", additions: 0, deletions: 0, binary: true, sanitized: false },
      {
        path: "new.ts",
        originalPath: "old.ts",
        additions: 3,
        deletions: 0,
        binary: false,
        sanitized: false,
      },
    ]);
  });
});

describe("structured Git tools", () => {
  it("returns bounded status and passes literal workspace pathspecs after --", async () => {
    const runner = fixtureRunner();
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const tool = createGitStatusTool(boundary, runner);

    const result = await tool.execute({ paths: ["src/file.ts"], maxEntries: 10 }, context());

    expect(result.output).toMatchObject({
      branch: { head: "main", ahead: 0, behind: 0 },
      entries: [{ path: "src/file.ts", status: ".M" }],
      dirty: true,
      summaryComplete: true,
      truncated: false,
      provenance: { source: "git", untrusted: true },
    });
    expect(runner.run).toHaveBeenCalledWith(
      expect.arrayContaining(["status", "--porcelain=v2", "--", "src/file.ts"]),
      expect.objectContaining({ cwd: boundary.rootPath }),
    );
  });

  it("disables external diff behavior and returns bounded sanitized diff plus summary", async () => {
    const runner = fixtureRunner({
      diff: `diff --git a/src/file.ts b/src/file.ts\n+unsafe\u001b[31m${"x".repeat(2_000)}\n`,
    });
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const tool = createGitDiffTool(boundary, runner);

    const result = await tool.execute(
      { scope: "staged", paths: [], contextLines: 2, maxOutputBytes: 1_024 },
      context(),
    );

    expect(result.output).toMatchObject({
      scope: "staged",
      files: [{ path: "src/file.ts", additions: 2, deletions: 1 }],
      filesChanged: 1,
      additions: 2,
      deletions: 1,
      summaryComplete: true,
      truncated: true,
      truncationReason: "output-bytes",
      provenance: { source: "git", untrusted: true },
    });
    expect(result.output.diff).not.toContain("\u001b");
    const calls = vi.mocked(runner.run).mock.calls.map(([args]) => args.join(" "));
    expect(calls.some((call) => call.includes("diff --cached --no-ext-diff --no-textconv"))).toBe(
      true,
    );
    expect(calls.some((call) => call.includes("--numstat -z"))).toBe(true);
  });

  it("rejects a Git root outside the workspace", async () => {
    const runner = fixtureRunner({ root: path.dirname(workspacePath) });
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const tool = createGitStatusTool(boundary, runner);

    await expect(tool.execute({ paths: [], maxEntries: 10 }, context())).rejects.toMatchObject({
      code: "PILOT_GIT_INSPECTION_FAILED",
    });
  });

  it("rejects linked-worktree git files without invoking Git", async () => {
    await rm(path.join(workspacePath, ".git"), { recursive: true });
    await writeFile(path.join(workspacePath, ".git"), "gitdir: ../outside\n");
    const runner = fixtureRunner();
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const tool = createGitStatusTool(boundary, runner);

    await expect(tool.execute({ paths: [], maxEntries: 10 }, context())).rejects.toMatchObject({
      code: "PILOT_GIT_INSPECTION_FAILED",
    });
    expect(runner.run).not.toHaveBeenCalled();
  });
});

function fixtureRunner(options: { readonly root?: string; readonly diff?: string } = {}) {
  return {
    run: vi.fn<GitCommandRunner["run"]>(async (args) => {
      const command = args.join(" ");
      if (command.includes("rev-parse --show-toplevel")) {
        return { stdout: `${options.root ?? realWorkspacePath}\n`, stderr: "" };
      }
      if (command.includes(" status ")) {
        return {
          stdout:
            "# branch.oid abc\n# branch.head main\n1 .M N... 100644 100644 100644 aaa bbb src/file.ts\0",
          stderr: "",
        };
      }
      if (command.includes("--numstat")) {
        return { stdout: "2\t1\tsrc/file.ts\0", stderr: "" };
      }
      if (command.includes(" diff ")) return { stdout: options.diff ?? "", stderr: "" };
      throw new Error(`Unexpected Git command: ${command}`);
    }),
  } satisfies GitCommandRunner;
}

function context() {
  return {
    runId: runId("run-git"),
    callId: toolCallId("call-git"),
    signal: new AbortController().signal,
  };
}
