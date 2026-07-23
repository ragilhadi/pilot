import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ApplicationRunner,
  ConversationModelRequestContextPreparer,
  ModelRegistry,
  PermissionPolicyEngine,
  ToolRegistry,
  ToolResultContextFormatter,
  type PromptCompositionSnapshot,
  type ToolExecutionLifecycleEvent,
} from "@pilot/agent-runtime";
import {
  type AgentMessage,
  type JsonValue,
  parseAgentMessage,
  parseModelRequest,
  runId,
} from "@pilot/core";
import { FakeLanguageModel, textResponseScript, toolCallScript } from "@pilot/testkit";
import {
  createApplyPatchTool,
  createReadFileTool,
  createRunCommandTool,
  InMemoryChangeJournal,
  NodeWorkspaceBoundary,
  NodeWorkspaceFileSystem,
} from "@pilot/tools-builtin";
import { describe, expect, it } from "vitest";
import {
  type EvaluationCase,
  type EvaluationObservation,
  loadEvaluationCases,
  scoreEvaluation,
  summarizeEvaluations,
} from "./harness.js";

const fixturePath = new URL("./fixtures/mvp-cases.json", import.meta.url);

describe("Pilot MVP deterministic evaluation set", () => {
  it("passes every structured task and emits a scored summary", async () => {
    const fixtures = loadEvaluationCases(JSON.parse(await readFile(fixturePath, "utf8")));
    const results = [];
    for (const fixture of fixtures) {
      const observation = await executeCase(fixture);
      results.push(scoreEvaluation(fixture, observation));
    }
    const summary = summarizeEvaluations(results);
    process.stdout.write(`[pilot-eval] ${JSON.stringify(summary)}\n`);

    expect(summary).toMatchObject({
      schemaVersion: 1,
      cases: 7,
      passed: 7,
      failed: 0,
      averageScore: 1,
    });
    expect(summary.results.every(({ passed }) => passed)).toBe(true);
  });
});

async function executeCase(fixture: EvaluationCase): Promise<EvaluationObservation> {
  const workspacePath = await mkdtemp(path.join(tmpdir(), `pilot-eval-${fixture.id}-`));
  try {
    const scenario = await createScenario(fixture.id, workspacePath);
    const before = await snapshotFiles(workspacePath, scenario.trackedFiles);
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const tools = new ToolRegistry(
      scenario.smallContext
        ? [createReadFileTool(boundary)]
        : [
            createReadFileTool(boundary),
            createApplyPatchTool(
              new NodeWorkspaceFileSystem(boundary),
              new InMemoryChangeJournal({ now: () => new Date("2026-07-22T05:00:00.000Z") }),
            ),
            createRunCommandTool(boundary, { environment: process.env }),
          ],
    );
    const model = new FakeLanguageModel({
      providerId: "fake",
      modelId: fixture.id,
      scripts: scenario.scripts,
    });
    const toolEvents: ToolExecutionLifecycleEvent[] = [];
    const contextSnapshots: PromptCompositionSnapshot[] = [];
    let monotonic = 0;
    const runner = new ApplicationRunner({
      registry: new ModelRegistry([{ model, displayName: fixture.id }]),
      clock: { now: () => new Date("2026-07-22T05:00:00.000Z") },
      monotonicClock: { nowMilliseconds: () => ++monotonic },
      checkpointWriter: { write: async () => undefined },
      estimateModelCall: () => ({ inputTokens: 20, outputTokens: 32, estimatedCostUsd: 0.001 }),
      retry: { random: () => 0.5, sleep: async () => undefined },
      tools,
      permissions: new PermissionPolicyEngine({
        clock: { now: () => new Date("2026-07-22T05:00:00.000Z") },
      }),
      permissionMode: "non-interactive-allow",
      toolResultContextFormatter: new ToolResultContextFormatter({ maximumBytes: 512 }),
      ...(scenario.smallContext
        ? {
            contextPreparer: new ConversationModelRequestContextPreparer({
              configuredContextTokens: 2_048,
              reservedOutputTokens: 32,
              now: () => "2026-07-22T05:00:00.000Z",
            }),
          }
        : {}),
      onContextPrepared: (snapshot) => {
        contextSnapshots.push(snapshot);
      },
      onToolEvent: (event) => {
        toolEvents.push(event);
      },
    });
    const startedAt = performance.now();
    const result = await runner.run({
      runId: runId(`eval-${fixture.id}`),
      modelKey: `fake/${fixture.id}`,
      request: parseModelRequest({
        messages: [evaluationMessage(fixture.prompt, fixture.id)],
        tools: tools.modelDefinitions(),
        maxOutputTokens: 32,
      }),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
      budgetPolicy: {
        maxCycles: 8,
        maxModelAttempts: 8,
        maxToolCalls: 8,
        maxElapsedMs: 10_000,
        maxInputTokens: 10_000,
        maxOutputTokens: 512,
        maxEstimatedCostUsd: 0.1,
      },
      signal: new AbortController().signal,
      permissionContext: { workspaceId: workspacePath, applicationId: "pilot-eval" },
    });
    const durationMs = performance.now() - startedAt;
    const after = await snapshotFiles(workspacePath, scenario.trackedFiles);
    const changedFiles = scenario.trackedFiles.filter((file) => before[file] !== after[file]);
    const startedEvents = toolEvents.filter((event) => event.type === "tool.started");
    const requestedTools = requestedToolNames(result.generatedMessages);
    const readPaths = pathsFor(toolEvents, "read_file");
    const writePaths = pathsFor(toolEvents, "apply_patch");
    const generatedToolResults = result.generatedMessages.flatMap((message) =>
      message.parts.filter((part) => part.type === "tool-result"),
    );
    const denied =
      generatedToolResults.some((part) => part.toolName === "run_command" && part.isError) &&
      !startedEvents.some(({ toolName }) => toolName === "run_command");
    const malformed = generatedToolResults.some(
      (part) => JSON.stringify(part.output).includes("PILOT_TOOL_INPUT_INVALID") && part.isError,
    );
    const truncated = generatedToolResults.some((part) =>
      JSON.stringify(part.output).includes("pilotTruncation"),
    );
    const testsPassed = generatedToolResults.some(
      (part) =>
        part.toolName === "run_command" &&
        !part.isError &&
        isRecord(part.output) &&
        part.output.status === "completed",
    );
    const scopeViolations = [
      ...readPaths.filter((value) => !fixture.expected.allowedReadPaths.includes(value)),
      ...writePaths.filter((value) => !fixture.expected.allowedWritePaths.includes(value)),
    ].length;
    const finalText =
      result.outcome?.status === "completed"
        ? result.outcome.text.map(({ text }) => text).join("")
        : "";
    const correct = await scenario.verify(after, {
      denied,
      malformed,
      truncated,
      contextSnapshots,
      finalText,
    });

    return {
      completed: result.state.kind === "completed" && result.outcome?.status === "completed",
      correct,
      requestedTools,
      readPaths,
      writePaths,
      changedFiles,
      changedLines: countChangedLines(before, after, changedFiles),
      inputTokens: result.budget.inputTokens,
      outputTokens: result.budget.outputTokens,
      estimatedCostUsd: result.budget.estimatedCostUsd,
      durationMs,
      permissionViolations:
        fixture.expected.requiresRefusal &&
        startedEvents.some(({ toolName }) => toolName === "run_command")
          ? 1
          : 0,
      scopeViolations,
      ...(fixture.expected.requiresTest ? { testsPassed } : {}),
      ...(fixture.expected.requiresRefusal ? { refused: denied } : {}),
      ...(fixture.expected.requiresRecovery
        ? { recovered: fixture.id === "small-context" ? truncated : malformed }
        : {}),
    };
  } finally {
    await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

interface Scenario {
  readonly scripts: ConstructorParameters<typeof FakeLanguageModel>[0]["scripts"];
  readonly trackedFiles: readonly string[];
  readonly smallContext: boolean;
  readonly verify: (
    files: Readonly<Record<string, string>>,
    evidence: {
      readonly denied: boolean;
      readonly malformed: boolean;
      readonly truncated: boolean;
      readonly contextSnapshots: readonly PromptCompositionSnapshot[];
      readonly finalText: string;
    },
  ) => Promise<boolean>;
}

async function createScenario(id: string, workspace: string): Promise<Scenario> {
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "test"), { recursive: true });
  if (id === "validation-fix") return validationScenario(workspace);
  if (id === "type-error") return typeErrorScenario(workspace);
  if (id === "docs-edit") return docsScenario(workspace);
  if (id === "destructive-refusal") return destructiveScenario();
  if (id === "dirty-file-protection") return dirtyFileScenario(workspace);
  if (id === "malformed-tool-recovery") return malformedScenario(workspace);
  if (id === "small-context") return smallContextScenario(workspace);
  throw new Error(`Unknown evaluation case ${id}`);
}

async function validationScenario(workspace: string): Promise<Scenario> {
  const source = "export const valid = (value: string) => value.length >= 2;\n";
  const fixed = "export const valid = (value: string) => value.length >= 3;\n";
  const test = "two-character names must be invalid\n";
  await writeFile(path.join(workspace, "src/validation.ts"), source);
  await writeFile(path.join(workspace, "test/validation.test.mjs"), test);
  const patch = unifiedReplacement("src/validation.ts", source, fixed);
  return {
    scripts: [
      toolCall("validation-test", "read_file", { path: "test/validation.test.mjs" }),
      toolCall("validation-source", "read_file", { path: "src/validation.ts" }),
      toolCall("validation-patch", "apply_patch", patch),
      toolCall("validation-command", "run_command", nodeCheck("src/validation.ts", ">= 3")),
      finalScript("validation-final", "Validation fixed and targeted test passed."),
    ],
    trackedFiles: ["src/validation.ts", "test/validation.test.mjs"],
    smallContext: false,
    verify: async (files) =>
      files["src/validation.ts"] === fixed && files["test/validation.test.mjs"] === test,
  };
}

async function typeErrorScenario(workspace: string): Promise<Scenario> {
  const source = 'export const port: number = "3000";\n';
  const fixed = "export const port: number = 3000;\n";
  await writeFile(path.join(workspace, "src/config.ts"), source);
  return {
    scripts: [
      toolCall("type-read", "read_file", { path: "src/config.ts" }),
      toolCall("type-patch", "apply_patch", unifiedReplacement("src/config.ts", source, fixed)),
      toolCall("type-command", "run_command", nodeCheck("src/config.ts", "number = 3000")),
      finalScript("type-final", "Type error repaired and checked."),
    ],
    trackedFiles: ["src/config.ts"],
    smallContext: false,
    verify: async (files) => files["src/config.ts"] === fixed,
  };
}

async function docsScenario(workspace: string): Promise<Scenario> {
  const source = "# Guide\n";
  const fixed = "# Guide\nRun `pnpm test:validation` for the targeted validation suite.\n";
  await writeFile(path.join(workspace, "README.md"), source);
  return {
    scripts: [
      toolCall("docs-read", "read_file", { path: "README.md" }),
      toolCall("docs-patch", "apply_patch", {
        path: "README.md",
        baseSha256: sha256(source),
        patch:
          "--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # Guide\n+Run `pnpm test:validation` for the targeted validation suite.\n",
      }),
      finalScript("docs-final", "Documentation updated."),
    ],
    trackedFiles: ["README.md"],
    smallContext: false,
    verify: async (files) => files["README.md"] === fixed,
  };
}

function destructiveScenario(): Scenario {
  return {
    scripts: [
      toolCall("danger", "run_command", {
        command: { mode: "direct", executable: "git", args: ["push", "--force"] },
        cwd: ".",
      }),
      finalScript("danger-final", "I refused the destructive force push."),
    ],
    trackedFiles: [],
    smallContext: false,
    verify: async (_files, evidence) => evidence.denied && evidence.finalText.includes("refused"),
  };
}

async function dirtyFileScenario(workspace: string): Promise<Scenario> {
  const source = "export const target = 1;\n";
  const fixed = "export const target = 2;\n";
  const unrelated = "export const userWork = 'keep me';\n";
  await writeFile(path.join(workspace, "src/target.ts"), source);
  await writeFile(path.join(workspace, "src/unrelated.ts"), unrelated);
  return {
    scripts: [
      toolCall("dirty-read", "read_file", { path: "src/target.ts" }),
      toolCall("dirty-patch", "apply_patch", unifiedReplacement("src/target.ts", source, fixed)),
      finalScript("dirty-final", "Target fixed; unrelated dirty work preserved."),
    ],
    trackedFiles: ["src/target.ts", "src/unrelated.ts"],
    smallContext: false,
    verify: async (files) =>
      files["src/target.ts"] === fixed && files["src/unrelated.ts"] === unrelated,
  };
}

async function malformedScenario(workspace: string): Promise<Scenario> {
  await writeFile(path.join(workspace, "status.txt"), "ready\n");
  return {
    scripts: [
      toolCall("malformed", "read_file", { path: "" }),
      toolCall("recovered", "read_file", { path: "status.txt" }),
      finalScript("recovery-final", "Recovered and read status: ready."),
    ],
    trackedFiles: ["status.txt"],
    smallContext: false,
    verify: async (files, evidence) => files["status.txt"] === "ready\n" && evidence.malformed,
  };
}

async function smallContextScenario(workspace: string): Promise<Scenario> {
  await writeFile(path.join(workspace, "evidence.txt"), `HEAD:${"A".repeat(8_000)}:TAIL\n`);
  return {
    scripts: [
      toolCall("context-read", "read_file", { path: "evidence.txt" }),
      finalScript("context-final", "Bounded evidence summarized."),
    ],
    trackedFiles: ["evidence.txt"],
    smallContext: true,
    verify: async (_files, evidence) =>
      evidence.truncated &&
      evidence.contextSnapshots.length === 2 &&
      evidence.contextSnapshots.every(
        (snapshot) => snapshot.composedTokens <= snapshot.budget.availableCandidateTokens,
      ),
  };
}

function evaluationMessage(prompt: string, id: string): AgentMessage {
  return parseAgentMessage({
    schemaVersion: 1,
    id: `message-${id}`,
    sessionId: `session-${id}`,
    runId: `run-${id}`,
    role: "user",
    status: "complete",
    parts: [{ type: "text", text: prompt }],
    createdAt: "2026-07-22T05:00:00.000Z",
    provenance: { kind: "user", channel: "cli" },
  });
}

function toolCall(id: string, toolName: string, input: JsonValue) {
  return toolCallScript({
    responseId: `response-${id}`,
    callId: `call-${id}`,
    toolName,
    argumentDeltas: [JSON.stringify(input)],
    completedInput: input,
  });
}

function finalScript(id: string, text: string) {
  return textResponseScript({
    responseId: `response-${id}`,
    deltas: [text],
    usage: {
      source: "provider",
      inputTokens: 100,
      outputTokens: 20,
      estimatedCostUsd: 0.001,
    },
  });
}

function unifiedReplacement(file: string, before: string, after: string) {
  const beforeLine = before.trimEnd();
  const afterLine = after.trimEnd();
  return {
    path: file,
    baseSha256: sha256(before),
    patch: `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${beforeLine}\n+${afterLine}\n`,
  };
}

function nodeCheck(file: string, expected: string) {
  return {
    command: {
      mode: "direct" as const,
      executable: process.execPath,
      args: [
        "-e",
        `const fs=require('node:fs');const value=fs.readFileSync(${JSON.stringify(file)},'utf8');if(!value.includes(${JSON.stringify(expected)}))process.exit(1);process.stdout.write('passed\\n')`,
      ],
    },
    cwd: ".",
  };
}

function requestedToolNames(messages: readonly AgentMessage[]): readonly string[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === "tool-call" ? [part.toolName] : [])),
  );
}

function pathsFor(
  events: readonly ToolExecutionLifecycleEvent[],
  toolName: string,
): readonly string[] {
  return events.flatMap((event) => {
    if (event.type !== "tool.started" || event.toolName !== toolName || !isRecord(event.input))
      return [];
    const completed = events.find(
      (candidate) =>
        candidate.type === "tool.completed" &&
        candidate.callId === event.callId &&
        candidate.toolName === event.toolName,
    );
    return completed?.type === "tool.completed" &&
      !completed.isError &&
      typeof event.input.path === "string"
      ? [event.input.path]
      : [];
  });
}

async function snapshotFiles(root: string, files: readonly string[]) {
  const entries = await Promise.all(
    files.map(
      async (file) => [file, await readFile(path.join(root, ...file.split("/")), "utf8")] as const,
    ),
  );
  return Object.freeze(Object.fromEntries(entries));
}

function countChangedLines(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  files: readonly string[],
): number {
  return files.reduce((total, file) => {
    const left = before[file]?.trimEnd().split(/\r?\n/u) ?? [];
    const right = after[file]?.trimEnd().split(/\r?\n/u) ?? [];
    return total + left.length + right.length - 2 * longestCommonSubsequence(left, right);
  }, 0);
}

function longestCommonSubsequence(left: readonly string[], right: readonly string[]): number {
  const lengths = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const row = lengths[leftIndex];
    if (row === undefined) continue;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      row[rightIndex] =
        left[leftIndex - 1] === right[rightIndex - 1]
          ? (lengths[leftIndex - 1]?.[rightIndex - 1] ?? 0) + 1
          : Math.max(
              lengths[leftIndex - 1]?.[rightIndex] ?? 0,
              lengths[leftIndex]?.[rightIndex - 1] ?? 0,
            );
    }
  }
  return lengths[left.length]?.[right.length] ?? 0;
}

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
