import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Terminal } from "@earendil-works/pi-tui";
import { realpath as realpathCallback } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const realpathNative = promisify(realpathCallback.native);
import { InstructionDiscovery, ModelRegistry } from "@pilot/agent-runtime";
import { sessionId } from "@pilot/core";
import {
  createSqliteRepositories,
  SqliteDatabase,
  SqliteMigrationRunner,
  SqliteSessionAdministration,
} from "@pilot/persistence-sqlite";
import type { GitCommandRunner } from "@pilot/tools-builtin";
import { FakeLanguageModel, textResponseScript, toolCallScript } from "@pilot/testkit";
import { describe, expect, it, vi } from "vitest";
import {
  NodeInstructionFileReader,
  runCli,
  type LineReader,
  type TextWriter,
} from "../src/index.js";
import { TerminalChatPresentation } from "../src/tui/terminal-chat-presentation.js";
import { approvalAwareLines } from "./approval-aware-lines.js";

const originalImplementation = `export function isValidName(value: string): boolean {
  return value.length >= 2;
}
`;

const fixedImplementation = `export function isValidName(value: string): boolean {
  return value.length >= 3;
}
`;

const implementationPatch = `--- a/src/validation.ts
+++ b/src/validation.ts
@@ -1,3 +1,3 @@
 export function isValidName(value: string): boolean {
-  return value.length >= 2;
+  return value.length >= 3;
 }
`;

/**
 * The scripted acceptance journey includes a real `grep` step, which shells out
 * to ripgrep. When `rg` is not installed these cases are skipped with a clear
 * reason rather than failing with an opaque tool-status diff. CI installs
 * ripgrep explicitly so the full journey always runs there.
 */
const hasRipgrep = (() => {
  try {
    return spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

describe("MVP acceptance scenario", () => {
  it.skipIf(!hasRipgrep)(
    "diagnoses, patches, verifies, persists, and resumes a TypeScript repository task",
    async () => {
      const workspacePath = await mkdtemp(path.join(tmpdir(), "pilot-mvp-acceptance-"));
      const databasePath = path.join(workspacePath, ".pilot-test", "sessions.db");
      let database: SqliteDatabase | undefined;

      try {
        await createFixtureRepository(workspacePath);
        await mkdir(path.dirname(databasePath), { recursive: true });

        const testCommand = {
          command: {
            mode: "direct" as const,
            executable: process.execPath,
            args: ["test/validation.test.mjs"],
          },
          cwd: ".",
        };
        const patchInput = {
          path: "src/validation.ts",
          baseSha256: sha256(originalImplementation),
          patch: implementationPatch,
        };
        const report = [
          "Summary: Corrected the minimum valid name length.",
          "Files changed: src/validation.ts",
          "Diff: value.length >= 2 -> value.length >= 3",
          "Commands executed: node test/validation.test.mjs (twice)",
          "Tests performed: targeted validation test passed",
          "Token usage: 240 input, 60 output",
          "Estimated cost: $0.0000",
        ].join("\n");
        const model = new FakeLanguageModel({
          providerId: "fake",
          modelId: "mvp-acceptance",
          scripts: [
            toolCall("git-status", "git_status", {}),
            toolCall("package", "read_file", { path: "package.json" }),
            toolCall("test-failing", "run_command", testCommand),
            toolCall("search", "grep", { query: "isValidName", path: "." }),
            toolCall("read-test", "read_file", { path: "test/validation.test.mjs" }),
            toolCall("read-source", "read_file", { path: "src/validation.ts" }),
            toolCall("patch", "apply_patch", patchInput),
            toolCall("test-passing", "run_command", testCommand),
            textResponseScript({
              responseId: "response-report",
              deltas: [report],
              usage: {
                source: "provider",
                inputTokens: 240,
                outputTokens: 60,
                estimatedCostUsd: 0,
              },
            }),
          ],
        });
        const registry = new ModelRegistry([{ model, displayName: "MVP Acceptance Fake" }]);
        const output = memoryWriter();
        const errors = memoryWriter();
        const gitRunner = fixtureGitRunner(workspacePath);
        const instructionReader = await NodeInstructionFileReader.create(workspacePath);
        const instructionDiscovery = new InstructionDiscovery(instructionReader);

        database = openPersistence(databasePath).database;
        const persistence = openRepositories(database);
        const firstRun = dependencies({
          registry,
          workspacePath,
          stdout: output,
          stderr: errors,
          gitRunner,
          instructionDiscovery,
          stdin: approvalAwareLines({
            initialLine: "Fix the failing validation test.",
            approvalCount: 3,
            output,
            remainingScripts: () => model.remainingScripts,
          }),
        });

        expect(
          await runCli(["chat", "--model", "fake/mvp-acceptance"], {
            ...firstRun,
            persistence,
          }),
        ).toBe(0);

        expect(errors.text()).toContain(
          "validation failed: expected two-character names to be invalid",
        );
        expect(errors.text()).not.toContain("Invalid approval response");
        expect(model.remainingScripts).toBe(0);
        expect(await readFile(path.join(workspacePath, "src", "validation.ts"), "utf8")).toBe(
          fixedImplementation,
        );
        expect(output.text()).toContain(`[approval required: ${process.execPath} (unknown)]`);
        expect(output.text()).toContain(`[proposed diff]\n${implementationPatch}`);
        expect(output.text()).toContain("validation test passed");
        for (const section of [
          "Summary:",
          "Files changed:",
          "Diff:",
          "Commands executed:",
          "Tests performed:",
          "Token usage:",
          "Estimated cost:",
        ]) {
          expect(output.text()).toContain(section);
        }

        expect(model.calls).toHaveLength(9);
        expect(model.calls[0]?.request.messages[0]).toMatchObject({ role: "system" });
        expect(JSON.stringify(model.calls[0]?.request.messages[0])).toContain(
          "Run only the targeted validation test",
        );
        expect(model.calls[3]?.request.messages.at(-1)).toMatchObject({
          role: "tool",
          parts: [
            expect.objectContaining({
              type: "tool-result",
              output: expect.objectContaining({ status: "failed", exitCode: 1 }),
            }),
          ],
        });

        const saved = await persistence.repositories.sessions.load(sessionId("session-1"));
        expect(saved?.messages.at(-1)).toMatchObject({
          role: "assistant",
          parts: [{ type: "text", text: report }],
        });
        const calls = await persistence.repositories.toolActivity.listCallsByRun(
          saved?.messages.at(-1)?.runId ?? "",
        );
        expect(calls.map(({ toolName, status }) => [toolName, status])).toEqual([
          ["git_status", "completed"],
          ["read_file", "completed"],
          ["run_command", "completed"],
          ["grep", "completed"],
          ["read_file", "completed"],
          ["read_file", "completed"],
          ["apply_patch", "completed"],
          ["run_command", "completed"],
        ]);

        database.close();
        database = undefined;

        database = openPersistence(databasePath).database;
        const restartedPersistence = openRepositories(database);
        const resumeModel = new FakeLanguageModel({
          providerId: "fake",
          modelId: "mvp-resume",
          scripts: [
            textResponseScript({ responseId: "response-resumed", deltas: ["Session resumed."] }),
          ],
        });
        const resumedOutput = memoryWriter();
        const resumeExitCode = await runCli(
          ["chat", "--session", "session-1", "--model", "fake/mvp-resume"],
          {
            ...dependencies({
              registry: new ModelRegistry([{ model: resumeModel, displayName: "Resume Fake" }]),
              workspacePath,
              stdout: resumedOutput,
              stderr: errors,
              gitRunner,
              instructionDiscovery,
              identifiers: ["resume-run", "resume-user-message", "resume-assistant-message"],
              stdin: delayedLines([
                { line: "Confirm the completed work." },
                { line: "/exit", delayMs: 200 },
              ]),
            }),
            persistence: restartedPersistence,
          },
        );

        expect(errors.text()).not.toContain("PILOT_");
        expect(resumeExitCode).toBe(0);
        expect(resumedOutput.text()).toContain("Session resumed.");
        expect(resumeModel.calls[0]?.request.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ role: "assistant", parts: [{ type: "text", text: report }] }),
            expect.objectContaining({
              role: "user",
              parts: [{ type: "text", text: "Confirm the completed work." }],
            }),
          ]),
        );
      } finally {
        database?.close();
        await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
    // Runs real subprocesses (the scripted validation test, twice) through the full
    // approval flow; hosted Windows CI runners can be notably slower than a local
    // machine, so this needs more headroom than a purely in-memory test.
    40_000,
  );

  it.skipIf(!hasRipgrep)(
    "drives the complete repair and approval journey through the terminal UI",
    async () => {
      const workspacePath = await mkdtemp(path.join(tmpdir(), "pilot-mvp-tui-"));
      const databasePath = path.join(workspacePath, ".pilot-test", "sessions.db");
      let database: SqliteDatabase | undefined;
      let presentation: TerminalChatPresentation | undefined;
      try {
        await createFixtureRepository(workspacePath);
        await mkdir(path.dirname(databasePath), { recursive: true });
        const testCommand = {
          command: {
            mode: "direct" as const,
            executable: process.execPath,
            args: ["test/validation.test.mjs"],
          },
          cwd: ".",
        };
        const report =
          "Summary: Corrected validation.\nFiles changed: src/validation.ts\nTests performed: targeted validation test passed";
        const model = new FakeLanguageModel({
          providerId: "fake",
          modelId: "mvp-tui",
          scripts: [
            toolCall("git-status", "git_status", {}),
            toolCall("package", "read_file", { path: "package.json" }),
            toolCall("test-failing", "run_command", testCommand),
            toolCall("search", "grep", { query: "isValidName", path: "." }),
            toolCall("read-test", "read_file", { path: "test/validation.test.mjs" }),
            toolCall("read-source", "read_file", { path: "src/validation.ts" }),
            toolCall("patch", "apply_patch", {
              path: "src/validation.ts",
              baseSha256: sha256(originalImplementation),
              patch: implementationPatch,
            }),
            toolCall("test-passing", "run_command", testCommand),
            textResponseScript({ responseId: "response-tui-report", deltas: [report] }),
          ],
        });
        const registry = new ModelRegistry([{ model, displayName: "MVP TUI Fake" }]);
        const terminal = new AcceptanceTerminal();
        presentation = new TerminalChatPresentation({
          terminal,
          capabilities: {
            interactiveInput: true,
            interactiveOutput: true,
            cursorAddressing: true,
            color: false,
            unicode: false,
            columns: 100,
            rows: 30,
          },
          workspacePath,
          models: registry.list().map(({ key, displayName }) => ({ key, displayName })),
        });
        let approvalsSent = 0;
        let exitSent = false;
        terminal.onWrite = () => {
          const approvalCount = terminal.output.split("Permission required").length - 1;
          if (approvalCount > approvalsSent) {
            approvalsSent += 1;
            queueMicrotask(() => terminal.input("\r"));
          }
          if (approvalsSent === 3 && terminal.output.includes("Tests performed:") && !exitSent) {
            exitSent = true;
            queueMicrotask(() => typeTerminal(terminal, "/exit\r"));
          }
        };
        database = openPersistence(databasePath).database;
        const persistence = openRepositories(database);
        const instructionDiscovery = new InstructionDiscovery(
          await NodeInstructionFileReader.create(workspacePath),
        );
        const running = runCli(["chat", "--model", "fake/mvp-tui"], {
          ...dependencies({
            registry,
            workspacePath,
            stdout: memoryWriter(),
            stderr: memoryWriter(),
            stdin: presentation,
            gitRunner: fixtureGitRunner(workspacePath),
            instructionDiscovery,
          }),
          chatRenderer: presentation,
          persistence,
        });
        typeTerminal(terminal, "Fix the failing validation test.\r");

        await expect(running).resolves.toBe(0);
        expect(approvalsSent).toBe(3);
        expect(model.remainingScripts).toBe(0);
        expect(await readFile(path.join(workspacePath, "src", "validation.ts"), "utf8")).toBe(
          fixedImplementation,
        );
        expect(terminal.output).toContain("apply_patch");
        expect(terminal.output).toContain("Turn summary");
        expect(terminal.output).toContain("targeted validation test passed");
      } finally {
        await presentation?.close();
        database?.close();
        await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
    20_000,
  );
});

function toolCall(id: string, toolName: string, input: object) {
  return toolCallScript({
    responseId: `response-${id}`,
    callId: `call-${id}`,
    toolName,
    argumentDeltas: [JSON.stringify(input)],
    completedInput: input,
  });
}

async function createFixtureRepository(workspacePath: string): Promise<void> {
  await mkdir(path.join(workspacePath, ".git"));
  await mkdir(path.join(workspacePath, "src"));
  await mkdir(path.join(workspacePath, "test"));
  await writeFile(
    path.join(workspacePath, "AGENTS.md"),
    "Run only the targeted validation test. Keep the patch minimal.\n",
  );
  await writeFile(
    path.join(workspacePath, "package.json"),
    `${JSON.stringify(
      {
        name: "validation-fixture",
        private: true,
        type: "module",
        scripts: { "test:validation": "node test/validation.test.mjs" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(workspacePath, "src", "validation.ts"), originalImplementation);
  await writeFile(
    path.join(workspacePath, "test", "validation.test.mjs"),
    `import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/validation.ts", import.meta.url), "utf8");
if (!source.includes("value.length >= 3")) {
  console.error("validation failed: expected two-character names to be invalid");
  process.exit(1);
}
console.log("validation test passed");
`,
  );
}

function openPersistence(databasePath: string) {
  const database = new SqliteDatabase(databasePath);
  new SqliteMigrationRunner(database).migrate();
  return { database };
}

function openRepositories(database: SqliteDatabase) {
  const repositories = createSqliteRepositories(database);
  return {
    database,
    repositories,
    administration: new SqliteSessionAdministration(database, repositories),
  };
}

function fixtureGitRunner(workspacePath: string): GitCommandRunner {
  return {
    run: vi.fn(async (args) => {
      const command = args.join(" ");
      if (command.includes("rev-parse --show-toplevel")) {
        // Real `git rev-parse --show-toplevel` reports the fully resolved canonical
        // path (e.g. expanding Windows 8.3 short names), matching the workspace
        // boundary's native-realpath root.
        const realWorkspacePath = await realpathNative(workspacePath);
        return { stdout: `${realWorkspacePath}\n`, stderr: "" };
      }
      if (command.includes(" status ")) {
        return { stdout: "# branch.oid abc\n# branch.head main\n", stderr: "" };
      }
      throw new Error(`Unexpected Git command: ${command}`);
    }),
  };
}

function memoryWriter(): TextWriter & { readonly text: () => string } {
  let content = "";
  return {
    write(text) {
      content += text;
    },
    text: () => content,
  };
}

function delayedLines(entries: readonly { readonly line?: string; readonly delayMs?: number }[]) {
  let index = 0;
  return {
    async readLine() {
      const entry = entries[index++];
      if ((entry?.delayMs ?? 0) > 0) {
        await new Promise((resolve) => setTimeout(resolve, entry?.delayMs));
      }
      return entry?.line;
    },
  } satisfies LineReader;
}

function dependencies(input: {
  readonly registry: ModelRegistry;
  readonly workspacePath: string;
  readonly stdout: TextWriter;
  readonly stderr: TextWriter;
  readonly stdin: LineReader;
  readonly gitRunner: GitCommandRunner;
  readonly instructionDiscovery: InstructionDiscovery;
  readonly identifiers?: readonly string[];
}) {
  const identifiers = [...(input.identifiers ?? ["session-1", "run-1", "message-1"])];
  let generated = 0;
  const { identifiers: _identifiers, ...dependencies } = input;
  return {
    ...dependencies,
    clock: { now: () => new Date("2026-07-22T03:00:00.000Z") },
    ids: { next: () => identifiers.shift() ?? `generated-${++generated}` },
    signal: new AbortController().signal,
    monotonicNow: () => 0,
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

class AcceptanceTerminal implements Terminal {
  columns = 100;
  rows = 30;
  readonly kittyProtocolActive = false;
  output = "";
  onWrite?: () => void;
  #onInput?: (data: string) => void;
  start(onInput: (data: string) => void): void {
    this.#onInput = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
    this.onWrite?.();
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  input(data: string): void {
    this.#onInput?.(data);
  }
}

function typeTerminal(terminal: AcceptanceTerminal, text: string): void {
  for (const character of text) terminal.input(character);
}
