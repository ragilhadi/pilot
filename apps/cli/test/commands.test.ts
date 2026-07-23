import { InstructionDiscovery, ModelRegistry, ToolRegistry } from "@pilot/agent-runtime";
import {
  defineTool,
  messageId,
  type ModelCapabilities,
  ModelContractValidationError,
  parseAgentMessage,
  runId,
  sessionId,
} from "@pilot/core";
import {
  createSqliteRepositories,
  SqliteDatabase,
  SqliteMigrationRunner,
  SqliteSessionAdministration,
} from "@pilot/persistence-sqlite";
import type { Fetch } from "@pilot/provider-openai-compatible";
import type { GitCommandRunner } from "@pilot/tools-builtin";
import {
  delayStep,
  eventStep,
  FakeLanguageModel,
  textResponseScript,
  toolCallScript,
} from "@pilot/testkit";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";
import {
  compatibleModelsEnvironmentVariable,
  createModelCatalog,
  defaultCliModelKey,
  ollamaBaseUrlEnvironmentVariable,
  runCli,
  type LineReader,
  type TextWriter,
} from "../src/index.js";

const minimalCapabilities = {
  streaming: true,
  nativeToolCalling: false,
  parallelToolCalls: false,
  structuredOutput: false,
  vision: false,
  promptCaching: false,
  reasoning: false,
  configurableReasoningEffort: false,
  systemMessages: true,
} as const satisfies ModelCapabilities;

function memoryWriter(): TextWriter & { readonly text: () => string } {
  let content = "";
  return {
    write(text) {
      content += text;
    },
    text: () => content,
  };
}

function cliDependencies(
  registry: ModelRegistry,
  signal = new AbortController().signal,
  stdin?: LineReader,
  workspacePath?: string,
  tools?: ToolRegistry,
  gitRunner?: GitCommandRunner,
) {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const identifiers = ["session-1", "run-1", "message-1"];
  let fallbackIdentifier = 0;
  return {
    dependencies: {
      registry,
      clock: { now: () => new Date("2026-07-21T03:00:00.000Z") },
      ids: {
        next: () => {
          const configured = identifiers.shift();
          if (configured !== undefined) {
            return configured;
          }
          fallbackIdentifier += 1;
          return `generated-${fallbackIdentifier}`;
        },
      },
      stdout,
      stderr,
      signal,
      ...(stdin === undefined ? {} : { stdin }),
      ...(workspacePath === undefined ? {} : { workspacePath }),
      ...(tools === undefined ? {} : { tools }),
      ...(gitRunner === undefined ? {} : { gitRunner }),
      monotonicNow: () => 0,
    },
    stdout,
    stderr,
  };
}

function timedLines(
  entries: readonly { readonly line?: string; readonly delayMs?: number }[],
): LineReader {
  let index = 0;
  return {
    async readLine() {
      const entry = entries[index];
      index += 1;
      if ((entry?.delayMs ?? 0) > 0) {
        await new Promise((resolve) => setTimeout(resolve, entry?.delayMs));
      }
      return entry?.line;
    },
  };
}

function configuredEnvironment() {
  return {
    COMPATIBLE_API_KEY: "test-secret",
    [compatibleModelsEnvironmentVariable]: JSON.stringify([
      {
        provider: {
          providerId: "compatible",
          type: "openai-compatible",
          baseUrl: "https://provider.example/v1",
          auth: { type: "environment", variable: "COMPATIBLE_API_KEY" },
        },
        modelId: "example",
        displayName: "Example Compatible Model",
        capabilities: minimalCapabilities,
      },
    ]),
  };
}

describe("pilot models", () => {
  it("lists the built-in fake model in a stable human-readable table", async () => {
    const registry = createModelCatalog({ environment: {} });
    const { dependencies, stdout, stderr } = cliDependencies(registry);

    const exitCode = await runCli(["models"], dependencies);

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe(
      "MODEL\tDISPLAY NAME\tSTREAMING\tTOOLS\tVISION\n" +
        "ollama/glm-5.2:cloud\tOllama Cloud GLM-5.2\tyes\tyes\tno\n" +
        "fake/test\tPilot Fake Model\tyes\tyes\tno\n",
    );
    expect(stderr.text()).toBe("");
  });

  it("emits machine-readable descriptors with --json", async () => {
    const registry = createModelCatalog({ environment: {} });
    const { dependencies, stdout } = cliDependencies(registry);

    expect(await runCli(["models", "--json"], dependencies)).toBe(0);

    expect(JSON.parse(stdout.text())).toMatchObject([
      {
        key: defaultCliModelKey,
        displayName: "Ollama Cloud GLM-5.2",
        metadata: { source: "builtin", route: "local-ollama", priority: 1 },
      },
      { key: "fake/test", displayName: "Pilot Fake Model", metadata: { source: "builtin" } },
    ]);
  });
});

describe("pilot run", () => {
  it("streams the built-in fake model as terminal text", async () => {
    const registry = createModelCatalog({ environment: {} });
    const { dependencies, stdout, stderr } = cliDependencies(registry);

    const exitCode = await runCli(["run", "--model", "fake/test", "hello", "pilot"], dependencies);

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("Hello from Pilot's fake model.\n");
    expect(stderr.text()).toBe("");
  });

  it("emits every normalized event as JSON Lines with --json", async () => {
    const registry = createModelCatalog({ environment: {} });
    const { dependencies, stdout } = cliDependencies(registry);

    expect(await runCli(["run", "--json", "--model", "fake/test", "hello"], dependencies)).toBe(0);

    const events = stdout
      .text()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map(({ type }) => type)).toEqual([
      "response.started",
      "text.delta",
      "response.completed",
    ]);
  });

  it("reports a missing model through the safe error boundary", async () => {
    const registry = createModelCatalog({ environment: {} });
    const { dependencies, stdout, stderr } = cliDependencies(registry);

    expect(await runCli(["run", "--model", "fake/missing", "hello"], dependencies)).toBe(1);
    expect(stdout.text()).toBe("");
    expect(JSON.parse(stderr.text())).toMatchObject({
      code: "PILOT_MODEL_NOT_FOUND",
      retryable: false,
      remediation: expect.stringContaining("pilot models"),
    });
  });

  it("propagates cancellation through a model stream", async () => {
    const controller = new AbortController();
    controller.abort("cancelled by test");
    const registry = new ModelRegistry([
      {
        model: new FakeLanguageModel({
          providerId: "fake",
          modelId: "slow",
          scripts: [{ steps: [delayStep(1_000)] }],
        }),
        displayName: "Slow Fake",
      },
    ]);
    const { dependencies, stderr } = cliDependencies(registry, controller.signal);

    expect(await runCli(["run", "--model", "fake/slow", "hello"], dependencies)).toBe(1);
    expect(JSON.parse(stderr.text())).toMatchObject({ code: "PILOT_CANCELLED" });
  });

  it.each([
    [["unknown"], "unknown command unknown"],
    [["run"], "non-empty prompt"],
    [["run", "--model", "fake/test"], "non-empty prompt"],
    [["models", "--unknown"], "models accepts only"],
    [["chat", "--ui", "rich"], "--ui requires one of"],
  ] as const)("returns usage status 2 for %j", async (args, expectedMessage) => {
    const { dependencies, stderr } = cliDependencies(createModelCatalog({ environment: {} }));

    expect(await runCli(args, dependencies)).toBe(2);
    expect(stderr.text()).toContain(expectedMessage);
    expect(stderr.text()).toContain("Usage:");
  });
});

describe("pilot sessions", () => {
  function persistenceHarness() {
    const database = new SqliteDatabase(":memory:");
    new SqliteMigrationRunner(database).migrate();
    const repositories = createSqliteRepositories(database);
    return {
      database,
      repositories,
      administration: new SqliteSessionAdministration(database, repositories),
    };
  }

  it("lists, shows, exports, forks, archives, and explicitly deletes durable sessions", async () => {
    const persistence = persistenceHarness();
    await persistence.repositories.sessions.create({
      id: sessionId("saved-session"),
      createdAt: "2026-07-21T03:00:00.000Z",
      initialMessages: [
        parseAgentMessage({
          schemaVersion: 1,
          id: messageId("saved-message"),
          sessionId: sessionId("saved-session"),
          runId: runId("saved-run"),
          role: "user",
          status: "complete",
          parts: [{ type: "text", text: "Persisted prompt" }],
          createdAt: "2026-07-21T03:00:00.000Z",
          provenance: { kind: "user", channel: "cli" },
          metadata: { apiKey: "must-redact" },
        }),
      ],
    });
    const registry = createModelCatalog({ environment: {} });

    const list = cliDependencies(registry);
    expect(
      await runCli(["sessions", "list", "--json"], { ...list.dependencies, persistence }),
    ).toBe(0);
    expect(JSON.parse(list.stdout.text())).toMatchObject([
      { id: "saved-session", messageCount: 1 },
    ]);

    const show = cliDependencies(registry);
    expect(
      await runCli(["sessions", "show", "saved-session"], { ...show.dependencies, persistence }),
    ).toBe(0);
    expect(show.stdout.text()).toContain("user: Persisted prompt");

    const exported = cliDependencies(registry);
    expect(
      await runCli(["sessions", "export", "saved-session"], {
        ...exported.dependencies,
        persistence,
      }),
    ).toBe(0);
    expect(exported.stdout.text()).not.toContain("must-redact");
    expect(exported.stdout.text()).toContain("[REDACTED]");

    const fork = cliDependencies(registry);
    expect(
      await runCli(["sessions", "fork", "saved-session", "forked-session"], {
        ...fork.dependencies,
        persistence,
      }),
    ).toBe(0);
    expect(await persistence.repositories.sessions.load(sessionId("forked-session"))).toMatchObject(
      { revision: 1 },
    );

    const archive = cliDependencies(registry);
    expect(
      await runCli(["sessions", "archive", "forked-session"], {
        ...archive.dependencies,
        persistence,
      }),
    ).toBe(0);
    expect(persistence.administration.list({ status: "archived" })).toMatchObject([
      { id: "forked-session" },
    ]);

    const refusedDelete = cliDependencies(registry);
    expect(
      await runCli(["sessions", "delete", "saved-session"], {
        ...refusedDelete.dependencies,
        persistence,
      }),
    ).toBe(2);
    expect(await persistence.repositories.sessions.load(sessionId("saved-session"))).toBeDefined();

    const deletion = cliDependencies(registry);
    expect(
      await runCli(["sessions", "delete", "saved-session", "--yes"], {
        ...deletion.dependencies,
        persistence,
      }),
    ).toBe(0);
    expect(
      await persistence.repositories.sessions.load(sessionId("saved-session")),
    ).toBeUndefined();
    persistence.database.close();
  });

  it("reports database health and returns a missing-session error safely", async () => {
    const persistence = persistenceHarness();
    const registry = createModelCatalog({ environment: {} });
    const doctor = cliDependencies(registry);
    expect(
      await runCli(["sessions", "doctor", "--json"], { ...doctor.dependencies, persistence }),
    ).toBe(0);
    expect(JSON.parse(doctor.stdout.text())).toMatchObject({ healthy: true, schemaVersion: 1 });

    const missing = cliDependencies(registry);
    expect(
      await runCli(["sessions", "show", "missing"], { ...missing.dependencies, persistence }),
    ).toBe(1);
    expect(JSON.parse(missing.stderr.text())).toMatchObject({ code: "PILOT_SESSION_NOT_FOUND" });
    persistence.database.close();
  });
});

describe("pilot chat", () => {
  it("persists validated tool input and output around execution", async () => {
    const database = new SqliteDatabase(":memory:");
    new SqliteMigrationRunner(database).migrate();
    const repositories = createSqliteRepositories(database);
    const persistence = {
      database,
      repositories,
      administration: new SqliteSessionAdministration(database, repositories),
    };
    await repositories.sessions.create({
      id: sessionId("tool-session"),
      createdAt: "2026-07-21T03:00:00.000Z",
    });
    const inspectTool = defineTool({
      name: "inspect_value",
      description: "Inspect a value",
      inputSchema: z.object({ value: z.string() }).strict(),
      outputSchema: z.object({ inspected: z.string() }).strict(),
      metadata: {
        risk: "read-only",
        concurrency: "parallel-safe",
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
        requiredPermissions: [],
      },
      execute: async ({ value }) => ({ output: { inspected: value } }),
    });
    const model = new FakeLanguageModel({
      providerId: "fake",
      modelId: "persistent-tool",
      scripts: [
        toolCallScript({
          responseId: "response-tool",
          callId: "call-1",
          toolName: "inspect_value",
          argumentDeltas: ['{"value":"durable"}'],
          completedInput: { value: "durable" },
        }),
        textResponseScript({ responseId: "response-final", deltas: ["Inspected"] }),
      ],
    });
    const { dependencies } = cliDependencies(
      new ModelRegistry([{ model, displayName: "Persistent Tool Fake" }]),
      new AbortController().signal,
      timedLines([{ line: "Inspect" }, { line: "/exit", delayMs: 300 }]),
      undefined,
      new ToolRegistry([inspectTool]),
    );

    expect(
      await runCli(["chat", "--session", "tool-session", "--model", "fake/persistent-tool"], {
        ...dependencies,
        persistence,
      }),
    ).toBe(0);
    expect(await repositories.toolActivity.listCallsByRun(runId("session-1"))).toMatchObject([
      {
        callId: "call-1",
        status: "completed",
        risk: "read-only",
        replaySafety: "safe",
        input: { value: "durable" },
      },
    ]);
    expect(await repositories.toolActivity.listResultsByRun(runId("session-1"))).toMatchObject([
      { callId: "call-1", output: { inspected: "durable" }, isError: false },
    ]);
    database.close();
  });

  it("resumes an existing SQLite session and commits the next turn", async () => {
    const database = new SqliteDatabase(":memory:");
    new SqliteMigrationRunner(database).migrate();
    const repositories = createSqliteRepositories(database);
    const persistence = {
      database,
      repositories,
      administration: new SqliteSessionAdministration(database, repositories),
    };
    await repositories.sessions.create({
      id: sessionId("saved-session"),
      createdAt: "2026-07-21T03:00:00.000Z",
    });
    const model = new FakeLanguageModel({
      providerId: "fake",
      modelId: "resume",
      scripts: [textResponseScript({ responseId: "response-resume", deltas: ["Resumed"] })],
    });
    const registry = new ModelRegistry([{ model, displayName: "Resume fake" }]);
    const { dependencies } = cliDependencies(
      registry,
      new AbortController().signal,
      timedLines([{ line: "Continue" }, { line: "/exit", delayMs: 300 }]),
    );

    expect(
      await runCli(["chat", "--session", "saved-session", "--model", "fake/resume"], {
        ...dependencies,
        persistence,
      }),
    ).toBe(0);
    expect((await repositories.sessions.load(sessionId("saved-session")))?.messages).toMatchObject([
      { role: "user", parts: [{ text: "Continue" }] },
      { role: "assistant", parts: [{ text: "Resumed" }] },
    ]);
    expect(await repositories.runs.load(runId("session-1"))).toMatchObject({
      sessionId: "saved-session",
      status: "completed",
    });
    expect(await repositories.checkpoints.listByRun(runId("session-1"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "run.started" }),
        expect.objectContaining({ reason: "run.terminal" }),
      ]),
    );
    database.close();
  });

  it("exposes structured read-only Git status to the model without approval", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "pilot-cli-git-test-"));
    // Real `git rev-parse --show-toplevel` reports the fully resolved canonical path
    // (e.g. expanding Windows 8.3 short names), matching the workspace boundary's
    // native-realpath root.
    const realWorkspacePath = await realpathNative(workspacePath);
    try {
      await mkdir(path.join(workspacePath, ".git"));
      const runner: GitCommandRunner = {
        run: vi.fn(async (args) => {
          const command = args.join(" ");
          if (command.includes("rev-parse --show-toplevel")) {
            return { stdout: `${realWorkspacePath}\n`, stderr: "" };
          }
          if (command.includes(" status ")) {
            return {
              stdout:
                "# branch.oid abc\n# branch.head main\n1 .M N... 100644 100644 100644 aaa bbb src/file.ts\0",
              stderr: "",
            };
          }
          throw new Error(`Unexpected Git command: ${command}`);
        }),
      };
      const model = new FakeLanguageModel({
        providerId: "fake",
        modelId: "git-status",
        scripts: [
          toolCallScript({
            responseId: "response-status",
            callId: "call-status",
            toolName: "git_status",
            argumentDeltas: ["{}"],
            completedInput: {},
          }),
          textResponseScript({ responseId: "response-final", deltas: ["One modified file"] }),
        ],
      });
      const { dependencies, stdout, stderr } = cliDependencies(
        new ModelRegistry([{ model, displayName: "Git Status Fake" }]),
        new AbortController().signal,
        timedLines([{ line: "Check status" }, { line: "/exit", delayMs: 300 }]),
        workspacePath,
        undefined,
        runner,
      );

      expect(await runCli(["chat", "--model", "fake/git-status"], dependencies)).toBe(0);

      expect(stdout.text()).toContain("[tool: git_status]");
      expect(stdout.text()).not.toContain("[approval required:");
      expect(stdout.text()).toContain("One modified file");
      expect(stderr.text()).toBe("");
      expect(model.calls[1]?.request.messages.at(-1)).toMatchObject({
        role: "tool",
        parts: [
          {
            type: "tool-result",
            output: {
              branch: { head: "main" },
              entries: [{ path: "src/file.ts", status: ".M" }],
              provenance: { source: "git", untrusted: true },
            },
          },
        ],
      });
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("prompts for a mutation and executes it after scoped terminal approval", async () => {
    const execute = vi.fn(async ({ path }: { readonly path: string }) => ({
      output: { changed: path },
    }));
    const writeFileTool = defineTool({
      name: "write_file",
      description: "Write a test file",
      inputSchema: z.object({ path: z.string() }).strict().readonly(),
      outputSchema: z.object({ changed: z.string() }).strict().readonly(),
      metadata: {
        risk: "workspace-write",
        concurrency: "exclusive",
        timeoutMs: 1_000,
        maxOutputBytes: 10_000,
        requiredPermissions: ["workspace.write"],
      },
      execute,
    });
    const tools = new ToolRegistry([writeFileTool]);
    const model = new FakeLanguageModel({
      providerId: "fake",
      modelId: "approval",
      scripts: [
        toolCallScript({
          responseId: "response-write",
          callId: "call-write",
          toolName: "write_file",
          argumentDeltas: ['{"path":"approved.txt"}'],
          completedInput: { path: "approved.txt" },
        }),
        textResponseScript({ responseId: "response-final", deltas: ["Write approved"] }),
      ],
    });
    const { dependencies, stdout, stderr } = cliDependencies(
      new ModelRegistry([{ model, displayName: "Approval Fake" }]),
      new AbortController().signal,
      timedLines([
        { line: "Write approved.txt" },
        { line: "allow workspace", delayMs: 250 },
        { line: "/exit", delayMs: 300 },
      ]),
      undefined,
      tools,
    );

    expect(await runCli(["chat", "--model", "fake/approval"], dependencies)).toBe(0);

    expect(stdout.text()).toContain("[approval required: write_file (workspace-write)]");
    expect(stdout.text()).toContain("[tool: write_file]");
    expect(stdout.text()).toContain("Write approved");
    expect(stderr.text()).toBe("");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("previews and atomically applies a real approved workspace patch", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "pilot-cli-patch-test-"));
    try {
      const original = "const answer = 41;\n";
      const changed = "const answer = 42;\n";
      await writeFile(path.join(workspacePath, "answer.ts"), original);
      const patch =
        "--- a/answer.ts\n+++ b/answer.ts\n@@ -1 +1 @@\n-const answer = 41;\n+const answer = 42;\n";
      const toolInput = { path: "answer.ts", baseSha256: sha256(original), patch };
      const model = new FakeLanguageModel({
        providerId: "fake",
        modelId: "real-patch",
        scripts: [
          toolCallScript({
            responseId: "response-patch",
            callId: "call-patch",
            toolName: "apply_patch",
            argumentDeltas: [JSON.stringify(toolInput)],
            completedInput: toolInput,
          }),
          textResponseScript({ responseId: "response-final", deltas: ["Patch applied"] }),
        ],
      });
      const { dependencies, stdout, stderr } = cliDependencies(
        new ModelRegistry([{ model, displayName: "Real Patch Fake" }]),
        new AbortController().signal,
        timedLines([
          { line: "Update the answer" },
          { line: "allow once", delayMs: 250 },
          { line: "/exit", delayMs: 500 },
        ]),
        workspacePath,
      );

      expect(await runCli(["chat", "--model", "fake/real-patch"], dependencies)).toBe(0);

      expect(stdout.text()).toContain("[approval required: apply_patch (workspace-write)]");
      expect(stdout.text()).toContain(`[proposed diff]\n${patch}`);
      expect(stdout.text()).toContain("[tool: apply_patch]");
      expect(stdout.text()).toContain("Patch applied");
      expect(stderr.text()).toBe("");
      expect(await readFile(path.join(workspacePath, "answer.ts"), "utf8")).toBe(changed);
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("approves, streams, and completes a real workspace-bound command", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "pilot-cli-command-test-"));
    try {
      const toolInput = {
        command: {
          mode: "direct",
          executable: process.execPath,
          args: ["-e", "process.stdout.write('command-output\\n')"],
        },
        cwd: ".",
      };
      const model = new FakeLanguageModel({
        providerId: "fake",
        modelId: "command",
        scripts: [
          toolCallScript({
            responseId: "response-command",
            callId: "call-command",
            toolName: "run_command",
            argumentDeltas: [JSON.stringify(toolInput)],
            completedInput: toolInput,
          }),
          textResponseScript({ responseId: "response-final", deltas: ["Command completed"] }),
        ],
      });
      const { dependencies, stdout, stderr } = cliDependencies(
        new ModelRegistry([{ model, displayName: "Command Fake" }]),
        new AbortController().signal,
        timedLines([
          { line: "Run the command" },
          { line: "allow once", delayMs: 250 },
          { line: "/exit", delayMs: 600 },
        ]),
        workspacePath,
      );

      expect(await runCli(["chat", "--model", "fake/command"], dependencies)).toBe(0);

      expect(stdout.text()).toContain("[approval required:");
      expect(stdout.text()).toContain("[command]");
      expect(stdout.text()).toContain("[tool: run_command]");
      expect(stdout.text()).toContain("command-output\n");
      expect(stdout.text()).toContain("Command completed");
      expect(stderr.text()).toBe("");
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("exposes the bounded repository tools and completes a real read_file cycle", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "pilot-cli-tools-test-"));
    try {
      await writeFile(path.join(workspacePath, "evidence.txt"), "CLI repository evidence\n");
      const model = new FakeLanguageModel({
        providerId: "fake",
        modelId: "tools",
        scripts: [
          toolCallScript({
            responseId: "response-tool",
            callId: "call-read",
            toolName: "read_file",
            argumentDeltas: ['{"path":"evidence.txt"}'],
            completedInput: { path: "evidence.txt" },
          }),
          textResponseScript({ responseId: "response-final", deltas: ["Evidence inspected"] }),
        ],
      });
      const registry = new ModelRegistry([{ model, displayName: "Tool Fake" }]);
      const { dependencies, stdout, stderr } = cliDependencies(
        registry,
        new AbortController().signal,
        timedLines([{ line: "Inspect evidence.txt" }, { line: "/exit", delayMs: 300 }]),
        workspacePath,
      );

      expect(await runCli(["chat", "--model", "fake/tools"], dependencies)).toBe(0);

      expect(stdout.text()).toContain("[tool: read_file]");
      expect(stdout.text()).toContain("Evidence inspected");
      expect(stderr.text()).toBe("");
      expect(model.calls[0]?.request.tools.map(({ name }) => name)).toEqual([
        "apply_patch",
        "git_diff",
        "git_status",
        "glob",
        "grep",
        "list_files",
        "read_file",
        "run_command",
        "write_file",
      ]);
      expect(model.calls[1]?.request.messages.at(-1)).toMatchObject({
        role: "tool",
        parts: [
          {
            type: "tool-result",
            callId: "call-read",
            isError: false,
            output: { path: "evidence.txt", content: "CLI repository evidence\n" },
          },
        ],
      });
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("runs multiple line-oriented turns against one in-memory session", async () => {
    const registry = new ModelRegistry([
      {
        model: new FakeLanguageModel({
          providerId: "fake",
          modelId: "chat",
          scripts: [
            textResponseScript({ responseId: "response-1", deltas: ["First answer"] }),
            textResponseScript({ responseId: "response-2", deltas: ["Second answer"] }),
          ],
        }),
        displayName: "Chat Fake",
      },
    ]);
    const stdin = timedLines([
      { line: "First question" },
      { line: "Second question", delayMs: 200 },
      { line: "/exit", delayMs: 200 },
    ]);
    const { dependencies, stdout, stderr } = cliDependencies(
      registry,
      new AbortController().signal,
      stdin,
    );

    expect(await runCli(["chat", "--ui", "plain", "--model", "fake/chat"], dependencies)).toBe(0);

    expect(stdout.text()).toBe(
      "Pilot chat — fake/chat\n" +
        "Type /help for commands, /abort to cancel, /exit to quit.\n" +
        "First answer\n" +
        "Second answer\n" +
        "[chat ended: user-exit]\n",
    );
    expect(stderr.text()).toBe("");
  });

  it("switches the active model for the next chat turn without changing session history", async () => {
    const initialModel = new FakeLanguageModel({
      providerId: "fake",
      modelId: "initial",
      scripts: [],
    });
    const selectedModel = new FakeLanguageModel({
      providerId: "fake",
      modelId: "selected",
      scripts: [
        textResponseScript({ responseId: "response-selected", deltas: ["Selected answer"] }),
      ],
    });
    const registry = new ModelRegistry([
      { model: initialModel, displayName: "Initial" },
      { model: selectedModel, displayName: "Selected" },
    ]);
    const { dependencies, stdout, stderr } = cliDependencies(
      registry,
      new AbortController().signal,
      timedLines([
        { line: "/model fake/selected" },
        { line: "Use the selected model" },
        { line: "/exit", delayMs: 100 },
      ]),
    );

    expect(await runCli(["chat", "--model", "fake/initial"], dependencies)).toBe(0);
    expect(initialModel.calls).toHaveLength(0);
    expect(selectedModel.calls).toHaveLength(1);
    expect(stdout.text()).toContain("[model: fake/selected]");
    expect(stdout.text()).toContain("Selected answer");
    expect(stderr.text()).toBe("");
  });

  it("keeps screen-reader and JSON modes independent of TUI availability", async () => {
    const registry = new ModelRegistry([
      {
        model: new FakeLanguageModel({
          providerId: "fake",
          modelId: "accessible-chat",
          scripts: [
            textResponseScript({ responseId: "response-accessible", deltas: ["Readable"] }),
          ],
        }),
        displayName: "Accessible Chat Fake",
      },
    ]);
    const accessible = cliDependencies(
      registry,
      new AbortController().signal,
      timedLines([{ line: "Hello" }, { line: "/exit", delayMs: 50 }]),
    );

    expect(
      await runCli(
        ["chat", "--ui", "tui", "--screen-reader", "--model", "fake/accessible-chat"],
        accessible.dependencies,
      ),
    ).toBe(0);
    expect(accessible.stdout.text()).toContain("Readable");

    const unavailable = cliDependencies(
      registry,
      new AbortController().signal,
      timedLines([{ line: "/exit" }]),
    );
    expect(
      await runCli(
        ["chat", "--ui", "tui", "--model", "fake/accessible-chat"],
        unavailable.dependencies,
      ),
    ).toBe(2);
    expect(unavailable.stderr.text()).toContain("Use --ui plain");
  });

  it("renders the latest model-facing context snapshot without exposing selected content", async () => {
    const registry = new ModelRegistry([
      {
        model: new FakeLanguageModel({
          providerId: "fake",
          modelId: "context-chat",
          scripts: [textResponseScript({ responseId: "response-context", deltas: ["Answer"] })],
        }),
        displayName: "Context Chat Fake",
      },
    ]);
    const { dependencies, stdout, stderr } = cliDependencies(
      registry,
      new AbortController().signal,
      timedLines([
        { line: "private context marker" },
        { line: "/context", delayMs: 200 },
        { line: "/exit", delayMs: 100 },
      ]),
    );

    expect(await runCli(["chat", "--model", "fake/context-chat"], dependencies)).toBe(0);

    const contextStart = stdout.text().indexOf("[context cycle 1:");
    expect(contextStart).toBeGreaterThan(0);
    const contextOutput = stdout.text().slice(contextStart);
    expect(contextOutput).toContain("1 selected, 0 excluded");
    expect(contextOutput).toContain("[fingerprint sha256:");
    expect(contextOutput).toContain("+ conversation:000001");
    expect(contextOutput).toContain("trust=untrusted");
    expect(contextOutput).not.toContain("private context marker");
    expect(stderr.text()).toBe("");
  });

  it("includes applicable project instructions in the inspected model prompt", async () => {
    const model = new FakeLanguageModel({
      providerId: "fake",
      modelId: "instruction-chat",
      scripts: [textResponseScript({ responseId: "response-instructions", deltas: ["Applied"] })],
    });
    const registry = new ModelRegistry([{ model, displayName: "Instruction Chat Fake" }]);
    const base = cliDependencies(
      registry,
      new AbortController().signal,
      timedLines([{ line: "Work" }, { line: "/context", delayMs: 30 }, {}]),
    );
    const instructionDiscovery = new InstructionDiscovery({
      async read(request) {
        if (request.kind === "workspace" && request.path === "AGENTS.md") {
          const content = "Use the repository test command.";
          return {
            status: "found" as const,
            displayPath: "AGENTS.md",
            realPath: "C:/workspace/AGENTS.md",
            content,
            bytes: new TextEncoder().encode(content).byteLength,
          };
        }
        return { status: "missing" as const };
      },
    });

    expect(
      await runCli(["chat", "--model", "fake/instruction-chat"], {
        ...base.dependencies,
        instructionDiscovery,
      }),
    ).toBe(0);

    expect(model.calls[0]?.request.messages.map(({ role }) => role)).toEqual(["system", "user"]);
    const instructionPart = model.calls[0]?.request.messages[0]?.parts[0];
    expect(instructionPart?.type === "text" ? instructionPart.text : "").toContain(
      "Use the repository test command.",
    );
    expect(base.stdout.text()).toContain("source=instructions");
    expect(base.stdout.text()).toContain("ref=AGENTS.md");
  });

  it("renders a stable typed JSONL event stream", async () => {
    const registry = new ModelRegistry([
      {
        model: new FakeLanguageModel({
          providerId: "fake",
          modelId: "json-chat",
          scripts: [textResponseScript({ responseId: "response-1", deltas: ["Hello"] })],
        }),
        displayName: "JSON Chat Fake",
      },
    ]);
    const { dependencies, stdout, stderr } = cliDependencies(
      registry,
      new AbortController().signal,
      timedLines([{ line: "Hello" }, {}]),
    );

    expect(
      await runCli(["chat", "--json", "--ui", "tui", "--model", "fake/json-chat"], dependencies),
    ).toBe(0);

    const events = stdout
      .text()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { schemaVersion: number; sequence: number; type: string });
    expect(events.map(({ type }) => type)).toEqual([
      "chat.started",
      "model.stream",
      "model.stream",
      "model.stream",
      "chat.turn.completed",
      "chat.ended",
    ]);
    expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.every(({ schemaVersion }) => schemaVersion === 1)).toBe(true);
    expect(stderr.text()).toBe("");
  });

  it("queues input received during a stream and restarts from updated history", async () => {
    const model = new FakeLanguageModel({
      providerId: "fake",
      modelId: "follow-up",
      scripts: [
        {
          steps: [
            eventStep({ type: "response.started", sequence: 0, responseId: "cancelled-response" }),
            delayStep(1_000),
          ],
        },
        textResponseScript({ responseId: "response-2", deltas: ["Revised answer"] }),
      ],
    });
    const registry = new ModelRegistry([{ model, displayName: "Follow-up Fake" }]);
    const { dependencies, stdout } = cliDependencies(
      registry,
      new AbortController().signal,
      timedLines([{ line: "Original" }, { line: "Changed direction", delayMs: 20 }, {}]),
    );

    expect(await runCli(["chat", "--model", "fake/follow-up"], dependencies)).toBe(0);

    expect(stdout.text()).toContain("[follow-up queued]");
    expect(stdout.text()).toContain("Revised answer");
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.request.messages.map(({ role }) => role)).toEqual(["user", "user"]);
    expect(model.calls[1]?.request.messages[1]?.parts).toEqual([
      { type: "text", text: "Changed direction" },
    ]);
  });

  it("handles /abort without corrupting or terminating the chat process", async () => {
    const registry = new ModelRegistry([
      {
        model: new FakeLanguageModel({
          providerId: "fake",
          modelId: "abort",
          scripts: [{ steps: [delayStep(1_000)] }],
        }),
        displayName: "Abort Fake",
      },
    ]);
    const { dependencies, stdout } = cliDependencies(
      registry,
      new AbortController().signal,
      timedLines([{ line: "Wait" }, { line: "/abort", delayMs: 20 }, {}]),
    );

    expect(await runCli(["chat", "--model", "fake/abort"], dependencies)).toBe(0);
    expect(stdout.text()).toContain("[aborted: user-cancelled]");
    expect(stdout.text()).toContain("[chat ended: end-of-input]");
  });

  it.each([
    [["chat", "--model", "fake/test", "prompt"], "does not accept an initial prompt"],
    [["chat", "unexpected prompt"], "does not accept an initial prompt"],
  ] as const)("validates chat usage for %j", async (args, expectedMessage) => {
    const { dependencies, stderr } = cliDependencies(createModelCatalog({ environment: {} }));

    expect(await runCli(args, dependencies)).toBe(2);
    expect(stderr.text()).toContain(expectedMessage);
  });
});

describe("CLI OpenAI-compatible catalog", () => {
  it("registers strict credential-reference configurations without making a request", () => {
    const fetch = vi.fn<Fetch>();

    const registry = createModelCatalog({ environment: configuredEnvironment(), fetch });

    expect(registry.list().map(({ key }) => key)).toEqual([
      "compatible/example",
      "fake/test",
      defaultCliModelKey,
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("runs a configured adapter through the same normalized CLI path", async () => {
    let authorization: string | null = null;
    const fetch: Fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return new Response(
        'data: {"id":"response-1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n' +
          'data: {"id":"response-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        { status: 200 },
      );
    };
    const registry = createModelCatalog({ environment: configuredEnvironment(), fetch });
    const { dependencies, stdout, stderr } = cliDependencies(registry);

    const exitCode = await runCli(["run", "--model", "compatible/example", "hello"], dependencies);

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("Hi\n");
    expect(stderr.text()).toBe("");
    expect(authorization).toBe("Bearer test-secret");
  });

  it("rejects malformed JSON and raw API-key fields", () => {
    expect(() =>
      createModelCatalog({
        environment: { [compatibleModelsEnvironmentVariable]: "not-json" },
      }),
    ).toThrow(ModelContractValidationError);

    const configured = JSON.parse(
      configuredEnvironment()[compatibleModelsEnvironmentVariable],
    ) as Array<Record<string, unknown>>;
    configured[0] = { ...configured[0], apiKey: "must-not-be-accepted" };
    expect(() =>
      createModelCatalog({
        environment: {
          [compatibleModelsEnvironmentVariable]: JSON.stringify(configured),
        },
      }),
    ).toThrow(ModelContractValidationError);
  });
});

describe("CLI Ollama Cloud priority", () => {
  it("defaults one-shot runs to GLM-5.2 Cloud through the local Ollama /v1 endpoint", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    const fetch: Fetch = async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        'data: {"id":"ollama-response","choices":[{"index":0,"delta":{"content":"Cloud ready"},"finish_reason":null}]}\n\n' +
          'data: {"id":"ollama-response","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        { status: 200 },
      );
    };
    const registry = createModelCatalog({ environment: {}, fetch });
    const { dependencies, stdout, stderr } = cliDependencies(registry);

    expect(await runCli(["run", "hello"], dependencies)).toBe(0);

    expect(requestUrl).toBe("http://localhost:11434/v1/chat/completions");
    expect(requestBody).toMatchObject({ model: "glm-5.2:cloud", stream: true });
    expect(stdout.text()).toBe("Cloud ready\n");
    expect(stderr.text()).toBe("");
  });

  it("allows an explicit local Ollama base URL override", async () => {
    let requestUrl = "";
    const fetch: Fetch = async (input) => {
      requestUrl = String(input);
      return new Response(
        'data: {"id":"response-1","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n' +
          'data: {"id":"response-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        { status: 200 },
      );
    };
    const registry = createModelCatalog({
      environment: { [ollamaBaseUrlEnvironmentVariable]: "http://127.0.0.1:22434/v1" },
      fetch,
    });
    const { dependencies } = cliDependencies(registry);

    expect(await runCli(["run", "hello"], dependencies)).toBe(0);
    expect(requestUrl).toBe("http://127.0.0.1:22434/v1/chat/completions");
  });
});
import { createHash } from "node:crypto";
import { realpath as realpathCallback } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const realpathNative = promisify(realpathCallback.native);

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}
