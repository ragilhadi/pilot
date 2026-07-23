import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolRegistry } from "@pilot/agent-runtime";
import {
  CancellationError,
  runId,
  toolCallId,
  ToolContractError,
  type ToolExecutionContext,
} from "@pilot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGrepTool,
  GrepInputSchema,
  GrepToolError,
  NodeRipgrepRunner,
  NodeWorkspaceBoundary,
  type RipgrepRunner,
  type RipgrepRunRequest,
  type RipgrepRunResult,
} from "../src/index.js";

/**
 * The end-to-end case shells out to a real `rg`. When ripgrep is not installed
 * it is skipped with a clear reason instead of failing with an opaque diff. CI
 * installs ripgrep explicitly so this case always runs there.
 */
const hasRipgrep = (() => {
  try {
    return spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

let sandboxPath: string;
let workspacePath: string;

beforeEach(async () => {
  sandboxPath = await mkdtemp(path.join(tmpdir(), "pilot-grep-test-"));
  workspacePath = path.join(sandboxPath, "workspace");
  await mkdir(path.join(workspacePath, "src"), { recursive: true });
  await mkdir(path.join(workspacePath, "dist"));
  await writeFile(path.join(workspacePath, ".pilotignore"), "ignored.txt\n");
  await writeFile(path.join(workspacePath, "src", "main.ts"), "const needle = 'needle';\n");
  await writeFile(path.join(workspacePath, "ignored.txt"), "needle\n");
  await writeFile(path.join(workspacePath, "dist", "bundle.js"), "needle\n");
});

afterEach(async () => {
  await rm(sandboxPath, { recursive: true, force: true });
});

function context(signal = new AbortController().signal): ToolExecutionContext {
  return { runId: runId("run-grep"), callId: toolCallId("call-grep"), signal };
}

function beginEvent(filePath: string): string {
  return JSON.stringify({ type: "begin", data: { path: { text: filePath } } });
}

function matchEvent(filePath: string, line: string, lineNumber: number, matchText: string): string {
  const start = Buffer.byteLength(line.slice(0, line.indexOf(matchText)), "utf8");
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: filePath },
      lines: { text: `${line}\n` },
      line_number: lineNumber,
      absolute_offset: 0,
      submatches: [
        {
          match: { text: matchText },
          start,
          end: start + Buffer.byteLength(matchText, "utf8"),
        },
      ],
    },
  });
}

class FakeRipgrepRunner implements RipgrepRunner {
  request?: RipgrepRunRequest;

  constructor(
    readonly lines: readonly string[] = [],
    readonly result: RipgrepRunResult = { exitCode: 0, stderr: "" },
    readonly failure?: unknown,
  ) {}

  async run(request: RipgrepRunRequest): Promise<RipgrepRunResult> {
    this.request = request;
    if (this.failure !== undefined) throw this.failure;
    for (const line of this.lines) {
      if (!request.onLine(line)) {
        return { exitCode: null, stderr: "", stoppedBy: "consumer" };
      }
    }
    return this.result;
  }
}

describe("grep", () => {
  it("constructs a fixed literal search and normalizes deterministic results", async () => {
    const secondPath = path.join(workspacePath, "src", "z.ts");
    const firstPath = path.join(workspacePath, "src", "a.ts");
    const runner = new FakeRipgrepRunner([
      beginEvent(secondPath),
      matchEvent(secondPath, "z needle", 8, "needle"),
      beginEvent(firstPath),
      matchEvent(firstPath, "a needle", 2, "needle"),
    ]);
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const grep = createGrepTool(boundary, runner);

    const result = await grep.execute(GrepInputSchema.parse({ query: "needle" }), context());

    expect(result.output.matches.map((match) => match.path)).toEqual(["src/a.ts", "src/z.ts"]);
    expect(result.output.matches[0]).toMatchObject({ line: 2, column: 3, matchText: "needle" });
    expect(result.output).toMatchObject({
      root: ".",
      query: "needle",
      mode: "literal",
      filesSearched: 2,
      truncated: false,
    });
    expect(result.metadata).toEqual({ untrusted: true, truncated: false, sanitizedMatches: 0 });
    expect(runner.request?.cwd).toBe(boundary.rootPath);
    expect(runner.request?.args).toContain("--fixed-strings");
    expect(runner.request?.args).toContain("--no-follow");
    expect(runner.request?.args).toContain(".pilotignore");
    expect(runner.request?.args.slice(-4)).toEqual(["--regexp", "needle", "--", boundary.rootPath]);
  });

  it("uses regex, case, hidden, and glob options without shell interpolation", async () => {
    const runner = new FakeRipgrepRunner();
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const grep = createGrepTool(boundary, runner);
    const query = "value; echo unsafe";

    await grep.execute(
      GrepInputSchema.parse({
        query,
        mode: "regex",
        path: "src",
        glob: "**/*.ts",
        caseSensitive: false,
        includeHidden: true,
      }),
      context(),
    );

    expect(runner.request?.args).not.toContain("--fixed-strings");
    expect(runner.request?.args).toContain("--ignore-case");
    expect(runner.request?.args).toContain("--hidden");
    expect(runner.request?.args).toContain("**/*.ts");
    expect(runner.request?.args).toContain(query);
    expect(runner.request?.args.at(-1)).toBe(path.join(boundary.rootPath, "src"));
  });

  it("centers bounded Unicode excerpts on the match and sanitizes control bytes", async () => {
    const line = `${"界".repeat(80)}\u001b[31mneedle${"x".repeat(80)}`;
    const runner = new FakeRipgrepRunner([
      beginEvent("src/main.ts"),
      matchEvent("src/main.ts", line, 1, "needle"),
    ]);
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const grep = createGrepTool(boundary, runner);

    const result = await grep.execute(
      GrepInputSchema.parse({ query: "needle", maxExcerptChars: 40 }),
      context(),
    );

    expect(result.output.matches[0]?.excerpt).toContain("needle");
    expect(result.output.matches[0]?.excerpt).not.toContain("\u001b");
    expect([...(result.output.matches[0]?.excerpt ?? "")]).toHaveLength(40);
    expect(result.output.matches[0]).toMatchObject({ excerptTruncated: true, sanitized: true });
    expect(result.output.sanitizedMatches).toBe(1);
  });

  it("stops at the result limit and reports explicit partial output", async () => {
    const runner = new FakeRipgrepRunner([
      matchEvent("src/main.ts", "needle one", 1, "needle"),
      matchEvent("src/main.ts", "needle two", 2, "needle"),
    ]);
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const grep = createGrepTool(boundary, runner);

    const result = await grep.execute(
      GrepInputSchema.parse({ query: "needle", maxResults: 1 }),
      context(),
    );

    expect(result.output.matches).toHaveLength(1);
    expect(result.output).toMatchObject({ truncated: true, truncationReason: "result-limit" });
  });

  it("accepts no-match exit code and reports runner output truncation", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const noMatches = createGrepTool(
      boundary,
      new FakeRipgrepRunner([], { exitCode: 1, stderr: "" }),
    );
    const outputLimited = createGrepTool(
      boundary,
      new FakeRipgrepRunner([], { exitCode: null, stderr: "", stoppedBy: "output-limit" }),
    );

    await expect(
      noMatches.execute(GrepInputSchema.parse({ query: "absent" }), context()),
    ).resolves.toMatchObject({ output: { matches: [], truncated: false } });
    await expect(
      outputLimited.execute(GrepInputSchema.parse({ query: "needle" }), context()),
    ).resolves.toMatchObject({
      output: { truncated: true, truncationReason: "runner-output-limit" },
    });
  });

  it("maps invalid regexes, timeouts, malformed events, and cancellation to typed failures", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const invalidRegex = createGrepTool(
      boundary,
      new FakeRipgrepRunner([], { exitCode: 2, stderr: "regex parse error" }),
    );
    const timeout = createGrepTool(
      boundary,
      new FakeRipgrepRunner([], { exitCode: null, stderr: "", stoppedBy: "timeout" }),
    );
    const malformed = createGrepTool(boundary, new FakeRipgrepRunner(["not-json"]));
    const cancelled = createGrepTool(
      boundary,
      new FakeRipgrepRunner([], { exitCode: null, stderr: "" }, new CancellationError("stop")),
    );

    await expect(
      invalidRegex.execute(GrepInputSchema.parse({ query: "[", mode: "regex" }), context()),
    ).rejects.toMatchObject({ code: "PILOT_GREP_PATTERN_INVALID" });
    await expect(
      timeout.execute(GrepInputSchema.parse({ query: "needle" }), context()),
    ).rejects.toMatchObject({ code: "PILOT_GREP_FAILED" });
    await expect(
      malformed.execute(GrepInputSchema.parse({ query: "needle" }), context()),
    ).rejects.toMatchObject({ code: "PILOT_GREP_FAILED" });
    await expect(
      cancelled.execute(GrepInputSchema.parse({ query: "needle" }), context()),
    ).rejects.toBeInstanceOf(CancellationError);
  });

  it("rejects paths outside the workspace and invalid model-facing input", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const outside = createGrepTool(
      boundary,
      new FakeRipgrepRunner([
        matchEvent(path.join(sandboxPath, "secret.ts"), "needle", 1, "needle"),
      ]),
    );
    const registry = new ToolRegistry([outside]);

    await expect(
      outside.execute(GrepInputSchema.parse({ query: "needle" }), context()),
    ).rejects.toMatchObject({ code: "PILOT_GREP_FAILED" });
    expect(() => registry.parseInput("grep", { query: "needle", command: "whoami" })).toThrow(
      ToolContractError,
    );
    expect(registry.modelDefinitions()[0]).toMatchObject({
      name: "grep",
      inputSchema: { type: "object", additionalProperties: false },
    });
    expect(registry.resolve("grep").definition.metadata).toMatchObject({
      risk: "read-only",
      requiredPermissions: ["workspace.read"],
    });
  });

  it.skipIf(!hasRipgrep)(
    "runs ripgrep end to end with protected and Pilot ignore rules",
    async () => {
      const boundary = await NodeWorkspaceBoundary.create(workspacePath);
      const grep = createGrepTool(boundary);

      const result = await grep.execute(GrepInputSchema.parse({ query: "needle" }), context());

      expect(result.output.matches.map((match) => match.path)).toEqual(["src/main.ts"]);
      expect(result.output.filesSearched).toBe(1);
    },
  );

  it("reports a missing ripgrep executable as an unavailable dependency", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const grep = createGrepTool(boundary, new NodeRipgrepRunner("pilot-rg-does-not-exist"));

    await expect(
      grep.execute(GrepInputSchema.parse({ query: "needle" }), context()),
    ).rejects.toBeInstanceOf(GrepToolError);
    await expect(
      grep.execute(GrepInputSchema.parse({ query: "needle" }), context()),
    ).rejects.toMatchObject({ code: "PILOT_GREP_UNAVAILABLE" });
  });
});
