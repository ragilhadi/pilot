import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { PilotError } from "@pilotrun/core";

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
}

export interface GitCommandOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

export interface GitCommandRunner {
  run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult>;
}

export interface GitStatusCounts {
  readonly staged: number;
  readonly modified: number;
  readonly untracked: number;
  readonly conflicted: number;
}

export type GitMetadata =
  | {
      readonly available: false;
      readonly reason: "git-directory-missing" | "git-entry-unsafe" | "git-unavailable";
    }
  | {
      readonly available: true;
      readonly rootPath: string;
      readonly branch: string | undefined;
      readonly headCommit: string | undefined;
      readonly dirty: boolean;
      readonly status: GitStatusCounts;
    };

export class GitInspectionError extends PilotError {
  constructor(message: string, cause?: unknown) {
    super({
      code: "PILOT_GIT_INSPECTION_FAILED",
      message,
      safeMessage: "Git repository metadata could not be inspected safely",
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

export class NodeGitCommandRunner implements GitCommandRunner {
  async run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult> {
    const maximumStdout = options.maxStdoutBytes ?? 1_048_576;
    const maximumStderr = options.maxStderrBytes ?? 65_536;
    try {
      const result = await execFileAsync("git", args, {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: Math.max(maximumStdout, maximumStderr) + 4_096,
        timeout: options.timeoutMs ?? 3_000,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_LITERAL_PATHSPECS: "1",
          LC_ALL: "C",
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return boundedGitResult(result.stdout, result.stderr, maximumStdout, maximumStderr);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ) {
        const captured = error as Error & { stdout?: string; stderr?: string };
        return boundedGitResult(
          captured.stdout ?? "",
          captured.stderr ?? "",
          maximumStdout,
          maximumStderr,
          true,
        );
      }
      throw error;
    }
  }
}

function boundedGitResult(
  stdout: string,
  stderr: string,
  maximumStdout: number,
  maximumStderr: number,
  bufferExceeded = false,
): GitCommandResult {
  const boundedStdout = truncateUtf8(stdout, maximumStdout);
  const boundedStderr = truncateUtf8(stderr, maximumStderr);
  return Object.freeze({
    stdout: boundedStdout,
    stderr: boundedStderr,
    ...(bufferExceeded || boundedStdout !== stdout ? { stdoutTruncated: true } : {}),
    ...(boundedStderr !== stderr ? { stderrTruncated: true } : {}),
  });
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let output = "";
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maximumBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

export async function inspectGitMetadata(input: {
  readonly workspaceRoot: string;
  readonly hasGitEntry: boolean;
  readonly runner?: GitCommandRunner;
  readonly signal?: AbortSignal;
}): Promise<GitMetadata> {
  if (!input.hasGitEntry) {
    return Object.freeze({ available: false, reason: "git-directory-missing" });
  }
  const runner = input.runner ?? new NodeGitCommandRunner();
  const commandOptions = {
    cwd: input.workspaceRoot,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  let root: string;
  try {
    root = (await runner.run(["rev-parse", "--show-toplevel"], commandOptions)).stdout.trim();
  } catch (error) {
    if (isExecutableMissing(error)) {
      return Object.freeze({ available: false, reason: "git-unavailable" });
    }
    throw new GitInspectionError("Git root discovery failed", error);
  }
  const canonicalRoot = path.resolve(root);
  if (!samePath(canonicalRoot, input.workspaceRoot)) {
    throw new GitInspectionError("Git reported a root outside the configured workspace");
  }

  try {
    const [branchResult, commitResult, statusResult] = await Promise.all([
      optionalGit(runner, ["symbolic-ref", "--quiet", "--short", "HEAD"], input),
      optionalGit(runner, ["rev-parse", "--verify", "HEAD"], input),
      runner.run(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], commandOptions),
    ]);
    const status = parsePorcelainStatus(statusResult.stdout);
    return Object.freeze({
      available: true,
      rootPath: canonicalRoot,
      branch: nonEmpty(branchResult?.stdout),
      headCommit: nonEmpty(commitResult?.stdout),
      dirty: Object.values(status).some((count) => count > 0),
      status,
    });
  } catch (error) {
    throw new GitInspectionError("Git status inspection failed", error);
  }
}

async function optionalGit(
  runner: GitCommandRunner,
  args: readonly string[],
  options: { readonly workspaceRoot: string; readonly signal?: AbortSignal },
): Promise<GitCommandResult | undefined> {
  try {
    return await runner.run(args, {
      cwd: options.workspaceRoot,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return undefined;
  }
}

function parsePorcelainStatus(output: string): GitStatusCounts {
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicted = 0;
  for (const record of output.split("\0")) {
    if (record.length < 3) {
      continue;
    }
    const index = record[0];
    const worktree = record[1];
    if (index === "?" && worktree === "?") {
      untracked += 1;
      continue;
    }
    if (isConflict(index, worktree)) {
      conflicted += 1;
      continue;
    }
    if (index !== " " && index !== "!") {
      staged += 1;
    }
    if (worktree !== " " && worktree !== "!") {
      modified += 1;
    }
  }
  return Object.freeze({ staged, modified, untracked, conflicted });
}

function isConflict(index: string | undefined, worktree: string | undefined): boolean {
  return (
    index === "U" ||
    worktree === "U" ||
    (index === "A" && worktree === "A") ||
    (index === "D" && worktree === "D")
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function isExecutableMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
