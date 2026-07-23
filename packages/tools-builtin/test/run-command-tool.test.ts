import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runId, toolCallId } from "@pilot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRunCommandTool,
  type CommandExecutionRequest,
  type CommandExecutor,
  NodeWorkspaceBoundary,
  RunCommandInputSchema,
} from "../src/index.js";

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(tmpdir(), "pilot-command-test-"));
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

describe("run_command tool contract", () => {
  it("builds a structured command permission action before execution", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const tool = createRunCommandTool(boundary, {
      shell: { executable: "test-shell", argsPrefix: ["-c"] },
    });
    const destructive = RunCommandInputSchema.parse({
      command: { mode: "direct", executable: "git", args: ["push", "--force"] },
      cwd: ".",
    });

    expect(tool.permissionAction?.(destructive)).toMatchObject({
      kind: "command",
      executable: "git",
      args: ["push", "--force"],
      cwd: ".",
      risk: "destructive",
      requiredPermissions: ["process.execute", "system.destructive"],
    });
    const shell = RunCommandInputSchema.parse({
      command: { mode: "shell", command: "echo hello" },
    });
    expect(tool.permissionAction?.(shell)).toMatchObject({
      kind: "command",
      executable: "test-shell",
      args: ["-c", "echo hello"],
      risk: "unknown",
    });
  });

  it("resolves cwd, passes only selected environment, and returns classification", async () => {
    let captured: CommandExecutionRequest | undefined;
    const executor: CommandExecutor = {
      execute: async (request) => {
        captured = request;
        await request.onOutput?.({ stream: "stdout", chunk: "live\n" });
        return {
          exitCode: 0,
          signal: null,
          stdout: "done\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          durationMs: 5,
        };
      },
    };
    const events: string[] = [];
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const tool = createRunCommandTool(boundary, {
      executor,
      environment: { PATH: "safe-path", SECRET: "not-inherited" },
      inheritedEnvironmentNames: ["PATH"],
      allowedEnvironmentOverrides: ["CI"],
      onOutput: (event) => events.push(`${event.stream}:${event.chunk}`),
    });

    const result = await tool.execute(
      RunCommandInputSchema.parse({
        command: { mode: "direct", executable: "git", args: ["status"] },
        cwd: ".",
        environment: { CI: "true" },
      }),
      context(),
    );

    expect(captured).toMatchObject({
      executable: "git",
      args: ["status"],
      cwd: boundary.rootPath,
      environment: { PATH: "safe-path", CI: "true" },
    });
    expect(captured?.environment).not.toHaveProperty("SECRET");
    expect(result.output).toMatchObject({
      status: "completed",
      exitCode: 0,
      classification: { risk: "read-only" },
    });
    expect(events).toEqual(["stdout:live\n"]);
  });

  it("rejects non-allowlisted environment overrides before invoking the executor", async () => {
    const execute = vi.fn<CommandExecutor["execute"]>();
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const tool = createRunCommandTool(boundary, { executor: { execute } });

    await expect(
      tool.execute(
        RunCommandInputSchema.parse({
          command: { mode: "direct", executable: "echo", args: ["hello"] },
          environment: { API_TOKEN: "secret" },
        }),
        context(),
      ),
    ).rejects.toMatchObject({
      code: "PILOT_COMMAND_ENVIRONMENT_DENIED",
      metadata: { variable: "API_TOKEN" },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("Node command execution", () => {
  it("streams redacted output across chunk boundaries and bounds each stream", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const events: string[] = [];
    const tool = createRunCommandTool(boundary, {
      environment: process.env,
      allowedEnvironmentOverrides: ["TEST_SECRET"],
      onOutput: (event) => events.push(event.chunk),
    });
    const secret = "seeded-command-secret";
    const script =
      "process.stdout.write(process.env.TEST_SECRET.slice(0,7));" +
      "setTimeout(() => { process.stdout.write(process.env.TEST_SECRET.slice(7)); process.stdout.write('\\u001b[31m'); process.stdout.write('x'.repeat(2000)); }, 10);";

    const result = await tool.execute(
      RunCommandInputSchema.parse({
        command: { mode: "direct", executable: process.execPath, args: ["-e", script] },
        environment: { TEST_SECRET: secret },
        maxOutputBytes: 1_024,
      }),
      context(),
    );

    expect(result.output.stdout.startsWith("***")).toBe(true);
    expect(result.output.stdout).not.toContain(secret);
    expect(events.join("")).not.toContain(secret);
    expect(result.output.stdout).not.toContain("\u001b");
    expect(Buffer.byteLength(result.output.stdout)).toBe(1_024);
    expect(result.output).toMatchObject({
      exitCode: 0,
      stdoutTruncated: true,
      classification: { risk: "unknown" },
    });
  });

  it("terminates a timed-out process tree and reports timeout state", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const tool = createRunCommandTool(boundary, { environment: process.env });
    const result = await tool.execute(
      RunCommandInputSchema.parse({
        command: {
          mode: "direct",
          executable: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
        },
        timeoutMs: 150,
      }),
      context(),
    );

    expect(result.output).toMatchObject({
      status: "timed-out",
      timedOut: true,
      recovery: {
        kind: "timeout",
        action: "inspect-workspace",
        sideEffects: "unknown",
        retryable: false,
      },
    });
  });

  it("returns non-zero exit details with an inspect-output recovery path", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const tool = createRunCommandTool(boundary, { environment: process.env });
    const result = await tool.execute(
      RunCommandInputSchema.parse({
        command: {
          mode: "direct",
          executable: process.execPath,
          args: ["-e", "process.stderr.write('failed\\n'); process.exit(3)"],
        },
      }),
      context(),
    );

    expect(result.output).toMatchObject({
      status: "failed",
      exitCode: 3,
      stderr: "failed\n",
      recovery: {
        kind: "command-failure",
        action: "inspect-command-output",
        sideEffects: "possible",
        retryable: true,
      },
    });
  });

  it("terminates the process tree and propagates cancellation", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const tool = createRunCommandTool(boundary, { environment: process.env });
    const controller = new AbortController();
    const pending = tool.execute(
      RunCommandInputSchema.parse({
        command: {
          mode: "direct",
          executable: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
        },
      }),
      {
        runId: runId("run-command"),
        callId: toolCallId("call-command"),
        signal: controller.signal,
      },
    );
    setTimeout(() => controller.abort("test cancellation"), 50);

    await expect(pending).rejects.toMatchObject({ code: "PILOT_CANCELLED" });
  });
});

function context() {
  return {
    runId: runId("run-command"),
    callId: toolCallId("call-command"),
    signal: new AbortController().signal,
  };
}
