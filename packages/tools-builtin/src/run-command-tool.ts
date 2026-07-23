import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import {
  CancellationError,
  defineTool,
  PilotError,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolRisk,
  ToolRecoverySchema,
  type WorkspaceBoundary,
} from "@pilotrun/core";
import * as z from "zod";
import { classifyCommandRisk, type CommandIntent } from "./command-risk.js";

const DirectCommandSchema = z
  .object({
    mode: z.literal("direct"),
    executable: z.string().min(1).max(4_096).refine(withoutNull),
    args: z.array(z.string().max(32_768).refine(withoutNull)).max(1_000).default([]).readonly(),
  })
  .strict()
  .readonly();

const ShellCommandSchema = z
  .object({
    mode: z.literal("shell"),
    command: z.string().min(1).max(32_768).refine(withoutNull),
  })
  .strict()
  .readonly();

export const RunCommandInputSchema = z
  .object({
    command: z.discriminatedUnion("mode", [DirectCommandSchema, ShellCommandSchema]),
    cwd: z.string().min(1).max(4_096).default(".").refine(withoutNull),
    environment: z
      .record(z.string().min(1).max(256), z.string().max(65_536))
      .default({})
      .readonly(),
    timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
    maxOutputBytes: z.number().int().min(1_024).max(1_000_000).default(100_000),
  })
  .strict()
  .readonly();

export const CommandRiskClassificationSchema = z
  .object({
    risk: z.enum([
      "read-only",
      "workspace-write",
      "network",
      "system-change",
      "destructive",
      "unknown",
    ]),
    reasons: z.array(z.string().min(1)).readonly(),
  })
  .strict()
  .readonly();

export const RunCommandOutputSchema = z
  .object({
    status: z.enum(["completed", "failed", "timed-out"]),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    timedOut: z.boolean(),
    durationMs: z.number().nonnegative(),
    classification: CommandRiskClassificationSchema,
    recovery: ToolRecoverySchema.optional(),
  })
  .strict()
  .readonly();

export type RunCommandInput = z.output<typeof RunCommandInputSchema>;
export type RunCommandOutput = z.output<typeof RunCommandOutputSchema>;

export interface CommandOutputEvent {
  readonly stream: "stderr" | "stdout";
  readonly chunk: string;
}

export interface ShellConfiguration {
  readonly executable: string;
  readonly argsPrefix: readonly string[];
}

export interface CommandExecutionRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly secrets: readonly string[];
  readonly signal: AbortSignal;
  readonly onOutput?: (event: CommandOutputEvent) => void | Promise<void>;
}

export interface CommandExecutionResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface CommandExecutor {
  execute(request: CommandExecutionRequest): Promise<CommandExecutionResult>;
}

export interface CommandSandbox {
  prepare(
    request: CommandExecutionRequest,
  ): CommandExecutionRequest | Promise<CommandExecutionRequest>;
}

export interface NodeCommandExecutorOptions {
  readonly monotonicNow?: () => number;
  readonly killGraceMs?: number;
  readonly sandbox?: CommandSandbox;
}

export interface RunCommandToolOptions {
  readonly executor?: CommandExecutor;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly inheritedEnvironmentNames?: readonly string[];
  readonly allowedEnvironmentOverrides?: readonly string[];
  readonly shell?: ShellConfiguration;
  readonly configuredSecrets?: readonly string[];
  readonly onOutput?: (
    event: CommandOutputEvent,
    context: ToolExecutionContext,
  ) => void | Promise<void>;
}

export class CommandExecutionError extends PilotError {
  constructor(
    code:
      | "PILOT_COMMAND_ENVIRONMENT_DENIED"
      | "PILOT_COMMAND_EXECUTION_FAILED"
      | "PILOT_COMMAND_SPAWN_FAILED",
    message: string,
    metadata: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super({
      code,
      message,
      safeMessage:
        code === "PILOT_COMMAND_ENVIRONMENT_DENIED"
          ? "The command requested an environment variable that is not allowed"
          : "The command could not be executed safely",
      metadata,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

export class NodeCommandExecutor implements CommandExecutor {
  readonly #now: () => number;
  readonly #killGraceMs: number;
  readonly #sandbox: CommandSandbox | undefined;

  constructor(options: NodeCommandExecutorOptions = {}) {
    this.#now = options.monotonicNow ?? (() => performance.now());
    this.#killGraceMs = options.killGraceMs ?? 250;
    this.#sandbox = options.sandbox;
  }

  async execute(rawRequest: CommandExecutionRequest): Promise<CommandExecutionResult> {
    const request = (await this.#sandbox?.prepare(rawRequest)) ?? rawRequest;
    throwIfCancelled(request.signal);
    const startedAt = this.#now();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: { ...request.environment },
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new CommandExecutionError(
        "PILOT_COMMAND_SPAWN_FAILED",
        "Command spawn failed",
        {},
        error,
      );
    }

    const stdout = new BoundedRedactedStream(request.maxOutputBytes, request.secrets);
    const stderr = new BoundedRedactedStream(request.maxOutputBytes, request.secrets);
    let outputDelivery = Promise.resolve();
    const deliver = (stream: "stderr" | "stdout", chunk: string) => {
      if (chunk.length === 0) return;
      outputDelivery = outputDelivery.then(async () => request.onOutput?.({ stream, chunk }));
    };
    child.stdout?.on("data", (chunk: Buffer) => deliver("stdout", stdout.consume(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => deliver("stderr", stderr.consume(chunk)));

    let timedOut = false;
    let cancelled = false;
    let termination = Promise.resolve();
    const terminate = () => {
      termination = terminateProcessTree(child, this.#killGraceMs);
    };
    const abort = () => {
      cancelled = true;
      terminate();
    };
    request.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);
    let exitCode: number | null;
    let exitSignal: string | null;
    try {
      ({ exitCode, signal: exitSignal } = await waitForProcess(child));
      await termination;
      deliver("stdout", stdout.finish());
      deliver("stderr", stderr.finish());
      await outputDelivery;
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abort);
    }
    if (cancelled || request.signal.aborted) throw new CancellationError(request.signal.reason);
    return Object.freeze({
      exitCode,
      signal: exitSignal,
      stdout: stdout.output,
      stderr: stderr.output,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut,
      durationMs: Math.max(0, this.#now() - startedAt),
    });
  }
}

export function createRunCommandTool(
  boundary: WorkspaceBoundary,
  options: RunCommandToolOptions = {},
): ToolDefinition<typeof RunCommandInputSchema, typeof RunCommandOutputSchema> {
  const executor = options.executor ?? new NodeCommandExecutor();
  const shell = options.shell ?? defaultShellConfiguration(options.environment);
  const allowedOverrides = new Set(options.allowedEnvironmentOverrides ?? ["CI", "NO_COLOR"]);
  const baseEnvironment = selectEnvironment(
    options.environment ?? {},
    options.inheritedEnvironmentNames ?? defaultInheritedEnvironmentNames,
  );
  const configuredSecrets = options.configuredSecrets ?? [];
  return defineTool({
    name: "run_command",
    description:
      "Run a bounded command in the workspace. Prefer direct executable/argument mode; shell-string mode is higher risk.",
    inputSchema: RunCommandInputSchema,
    outputSchema: RunCommandOutputSchema,
    metadata: {
      risk: "unknown",
      concurrency: "exclusive",
      timeoutMs: 125_000,
      maxOutputBytes: 2_100_000,
      requiredPermissions: ["process.execute"],
    },
    permissionAction: (input) => commandPermissionAction(input, shell),
    execute: async (input, context) => {
      const resolved = await boundary.resolve(input.cwd, "read");
      const verified = await boundary.revalidate(resolved);
      const cwd = verified.realPath ?? verified.absolutePath;
      if (!(await stat(cwd)).isDirectory()) {
        throw new CommandExecutionError(
          "PILOT_COMMAND_EXECUTION_FAILED",
          "Command cwd is not a directory",
          {
            cwd: verified.relativePath,
          },
        );
      }
      const environment = { ...baseEnvironment };
      for (const [name, value] of Object.entries(input.environment)) {
        if (!allowedOverrides.has(name)) {
          throw new CommandExecutionError(
            "PILOT_COMMAND_ENVIRONMENT_DENIED",
            `Environment variable ${name} is not allowed`,
            { variable: name },
          );
        }
        environment[name] = value;
      }
      const processIntent = processCommand(input.command, shell);
      const classification = classifyCommandRisk(input.command);
      const secrets = Object.freeze(
        [
          ...configuredSecrets,
          ...Object.entries(input.environment)
            .filter(([name]) => /(?:api[_-]?key|credential|password|secret|token)/iu.test(name))
            .map(([, value]) => value),
        ].filter((value) => value.length >= 4),
      );
      const result = await executor.execute({
        ...processIntent,
        cwd,
        environment,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        secrets,
        signal: context.signal,
        ...(options.onOutput === undefined
          ? {}
          : { onOutput: (event) => options.onOutput?.(event, context) }),
      });
      const status = result.timedOut
        ? ("timed-out" as const)
        : result.exitCode === 0
          ? ("completed" as const)
          : ("failed" as const);
      const recovery =
        status === "completed"
          ? undefined
          : ToolRecoverySchema.parse(
              status === "timed-out"
                ? {
                    kind: "timeout",
                    action: "inspect-workspace",
                    sideEffects: "unknown",
                    retryable: false,
                    message:
                      "Inspect workspace and process state before deciding whether to retry the command",
                  }
                : {
                    kind: "command-failure",
                    action: "inspect-command-output",
                    sideEffects: "possible",
                    retryable: true,
                    message:
                      "Inspect stdout, stderr, and the exit code before revising the command",
                  },
            );
      return {
        output: Object.freeze({
          status,
          ...result,
          classification,
          ...(recovery === undefined ? {} : { recovery }),
        }),
        metadata: {
          risk: classification.risk,
          timedOut: result.timedOut,
          exitCode: result.exitCode,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
        },
      };
    },
  });
}

function commandPermissionAction(input: RunCommandInput, shell: ShellConfiguration) {
  const processIntent = processCommand(input.command, shell);
  const classification = classifyCommandRisk(input.command);
  return {
    kind: "command" as const,
    executable: processIntent.executable,
    args: processIntent.args,
    cwd: input.cwd,
    environment: input.environment,
    risk: classification.risk,
    requiredPermissions: ["process.execute", permissionForRisk(classification.risk)],
  };
}

function processCommand(intent: CommandIntent, shell: ShellConfiguration) {
  return intent.mode === "direct"
    ? { executable: intent.executable, args: intent.args }
    : { executable: shell.executable, args: [...shell.argsPrefix, intent.command] };
}

function permissionForRisk(risk: ToolRisk): string {
  return {
    "read-only": "workspace.read",
    "workspace-write": "workspace.write",
    network: "network.access",
    "system-change": "system.change",
    destructive: "system.destructive",
    unknown: "process.unknown",
  }[risk];
}

function defaultShellConfiguration(
  environment: Readonly<Record<string, string | undefined>> | undefined,
): ShellConfiguration {
  return process.platform === "win32"
    ? { executable: environment?.COMSPEC ?? "cmd.exe", argsPrefix: ["/d", "/s", "/c"] }
    : { executable: "/bin/sh", argsPrefix: ["-c"] };
}

const defaultInheritedEnvironmentNames = Object.freeze([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "COMSPEC",
  "TEMP",
  "TMP",
]);

function selectEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) selected[name] = value;
  }
  return selected;
}

class BoundedRedactedStream {
  readonly #maximumBytes: number;
  readonly #secrets: readonly string[];
  readonly #decoder = new TextDecoder();
  #pending = "";
  #output = "";
  #usedBytes = 0;
  truncated = false;

  constructor(maximumBytes: number, secrets: readonly string[]) {
    this.#maximumBytes = maximumBytes;
    this.#secrets = [...new Set(secrets)].sort((left, right) => right.length - left.length);
  }

  get output(): string {
    return this.#output;
  }

  consume(bytes: Uint8Array): string {
    this.#pending += this.#decoder.decode(bytes, { stream: true });
    return this.#drain(false);
  }

  finish(): string {
    this.#pending += this.#decoder.decode();
    return this.#drain(true);
  }

  #drain(final: boolean): string {
    const emitted: string[] = [];
    const keep = final ? 0 : Math.max(0, (this.#secrets[0]?.length ?? 1) - 1);
    const processUntil = this.#pending.length - keep;
    let index = 0;
    while (index < processUntil) {
      const secret = this.#secrets.find((candidate) => this.#pending.startsWith(candidate, index));
      if (secret !== undefined) {
        index += secret.length;
        this.#append("***", emitted);
      } else {
        const codePoint = this.#pending.codePointAt(index);
        const character = codePoint === undefined ? "" : String.fromCodePoint(codePoint);
        index += character.length;
        this.#append(character, emitted);
      }
    }
    this.#pending = this.#pending.slice(index);
    return emitted.join("");
  }

  #append(value: string, emitted: string[]): void {
    if (this.truncated || value.length === 0) return;
    const sanitized = sanitizeCommandOutput(value);
    const remaining = this.#maximumBytes - this.#usedBytes;
    const selected = truncateUtf8(sanitized, remaining);
    if (selected.length > 0) {
      this.#output += selected;
      this.#usedBytes += Buffer.byteLength(selected, "utf8");
      emitted.push(selected);
    }
    if (selected !== sanitized) this.truncated = true;
  }
}

function sanitizeCommandOutput(value: string): string {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    output +=
      codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      (codePoint >= 127 && codePoint <= 159)
        ? "�"
        : character;
  }
  return output;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

function waitForProcess(
  child: ReturnType<typeof spawn>,
): Promise<{ exitCode: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", (error) =>
      reject(
        new CommandExecutionError(
          "PILOT_COMMAND_SPAWN_FAILED",
          "Command process failed to start",
          {},
          error,
        ),
      ),
    );
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

async function terminateProcessTree(
  child: ReturnType<typeof spawn>,
  graceMs: number,
): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

function withoutNull(value: string): boolean {
  return !value.includes("\0");
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancellationError(signal.reason);
}
