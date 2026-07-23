import { stat } from "node:fs/promises";
import path from "node:path";
import {
  CancellationError,
  defineTool,
  type ToolDefinition,
  type WorkspaceBoundary,
} from "@pilotrun/core";
import * as z from "zod";
import {
  type GitCommandResult,
  type GitCommandRunner,
  GitInspectionError,
  NodeGitCommandRunner,
} from "./git-metadata.js";

const pathSchema = z.string().min(1).max(4_096);
const statusCodeSchema = z.string().length(2);

export const GitStatusInputSchema = z
  .object({
    paths: z.array(pathSchema).max(100).default([]).readonly(),
    maxEntries: z.number().int().min(1).max(1_000).default(200),
  })
  .strict()
  .readonly();

export const GitStatusEntrySchema = z
  .object({
    path: z.string(),
    originalPath: z.string().optional(),
    kind: z.enum(["ordinary", "renamed", "unmerged", "untracked"]),
    status: statusCodeSchema,
    staged: z.boolean(),
    modified: z.boolean(),
    conflicted: z.boolean(),
    sanitized: z.boolean(),
  })
  .strict()
  .readonly();

export const GitStatusOutputSchema = z
  .object({
    branch: z
      .object({
        head: z.string().nullable(),
        oid: z.string().nullable(),
        upstream: z.string().nullable(),
        ahead: z.number().int().nonnegative(),
        behind: z.number().int().nonnegative(),
      })
      .strict()
      .readonly(),
    entries: z.array(GitStatusEntrySchema).max(1_000).readonly(),
    counts: z
      .object({
        staged: z.number().int().nonnegative(),
        modified: z.number().int().nonnegative(),
        untracked: z.number().int().nonnegative(),
        conflicted: z.number().int().nonnegative(),
      })
      .strict()
      .readonly(),
    dirty: z.boolean(),
    summaryComplete: z.boolean(),
    truncated: z.boolean(),
    truncationReason: z.enum(["entry-limit", "runner-output-limit"]).optional(),
    provenance: z
      .object({ source: z.literal("git"), untrusted: z.literal(true) })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export const GitDiffInputSchema = z
  .object({
    scope: z.enum(["unstaged", "staged", "all"]).default("all"),
    paths: z.array(pathSchema).max(100).default([]).readonly(),
    contextLines: z.number().int().min(0).max(20).default(3),
    maxOutputBytes: z.number().int().min(1_024).max(500_000).default(100_000),
  })
  .strict()
  .readonly();

export const GitDiffFileSchema = z
  .object({
    path: z.string(),
    originalPath: z.string().optional(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.boolean(),
    sanitized: z.boolean(),
  })
  .strict()
  .readonly();

export const GitDiffOutputSchema = z
  .object({
    scope: z.enum(["unstaged", "staged", "all"]),
    diff: z.string(),
    files: z.array(GitDiffFileSchema).max(1_000).readonly(),
    filesChanged: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    summaryComplete: z.boolean(),
    truncated: z.boolean(),
    truncationReason: z.literal("output-bytes").optional(),
    provenance: z
      .object({ source: z.literal("git"), untrusted: z.literal(true) })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export type GitStatusInput = z.output<typeof GitStatusInputSchema>;
export type GitStatusEntry = z.output<typeof GitStatusEntrySchema>;
export type GitStatusOutput = z.output<typeof GitStatusOutputSchema>;
export type GitDiffInput = z.output<typeof GitDiffInputSchema>;
export type GitDiffFile = z.output<typeof GitDiffFileSchema>;
export type GitDiffOutput = z.output<typeof GitDiffOutputSchema>;

export interface GitTools {
  readonly gitStatus: ToolDefinition<typeof GitStatusInputSchema, typeof GitStatusOutputSchema>;
  readonly gitDiff: ToolDefinition<typeof GitDiffInputSchema, typeof GitDiffOutputSchema>;
}

export function createGitTools(
  boundary: WorkspaceBoundary,
  runner: GitCommandRunner = new NodeGitCommandRunner(),
): GitTools {
  return Object.freeze({
    gitStatus: createGitStatusTool(boundary, runner),
    gitDiff: createGitDiffTool(boundary, runner),
  });
}

export function createGitStatusTool(
  boundary: WorkspaceBoundary,
  runner: GitCommandRunner = new NodeGitCommandRunner(),
): ToolDefinition<typeof GitStatusInputSchema, typeof GitStatusOutputSchema> {
  return defineTool({
    name: "git_status",
    description: "Return bounded structured Git branch and working-tree status for the workspace.",
    inputSchema: GitStatusInputSchema,
    outputSchema: GitStatusOutputSchema,
    metadata: {
      risk: "read-only",
      concurrency: "parallel-safe",
      timeoutMs: 10_000,
      maxOutputBytes: 300_000,
      requiredPermissions: ["workspace.read", "git.read"],
    },
    execute: async (input, context) => {
      await verifyGitWorkspace(boundary, runner, context.signal);
      const paths = await validatePaths(boundary, input.paths);
      const result = await runGit(
        runner,
        [
          "status",
          "--porcelain=v2",
          "-z",
          "--branch",
          "--untracked-files=normal",
          "--ignored=no",
          ...(paths.length === 0 ? [] : ["--", ...paths]),
        ],
        boundary.rootPath,
        context.signal,
        1_048_576,
      );
      const parsed = parseStatus(result.stdout, input.maxEntries);
      const truncated = parsed.truncated || result.stdoutTruncated === true;
      const output: GitStatusOutput = Object.freeze({
        branch: parsed.branch,
        entries: parsed.entries,
        counts: parsed.counts,
        dirty: parsed.entries.length > 0,
        summaryComplete: !truncated,
        truncated,
        ...(truncated
          ? {
              truncationReason: result.stdoutTruncated
                ? ("runner-output-limit" as const)
                : ("entry-limit" as const),
            }
          : {}),
        provenance: { source: "git" as const, untrusted: true as const },
      });
      return { output, metadata: { untrusted: true, truncated } };
    },
  });
}

export function createGitDiffTool(
  boundary: WorkspaceBoundary,
  runner: GitCommandRunner = new NodeGitCommandRunner(),
): ToolDefinition<typeof GitDiffInputSchema, typeof GitDiffOutputSchema> {
  return defineTool({
    name: "git_diff",
    description:
      "Return a bounded Git diff and structured numstat summary with external diff drivers disabled.",
    inputSchema: GitDiffInputSchema,
    outputSchema: GitDiffOutputSchema,
    metadata: {
      risk: "read-only",
      concurrency: "parallel-safe",
      timeoutMs: 15_000,
      maxOutputBytes: 700_000,
      requiredPermissions: ["workspace.read", "git.read"],
    },
    execute: async (input, context) => {
      await verifyGitWorkspace(boundary, runner, context.signal);
      const paths = await validatePaths(boundary, input.paths);
      const common = ["--no-ext-diff", "--no-textconv", `--unified=${input.contextLines}`];
      const suffix = paths.length === 0 ? [] : ["--", ...paths];
      const [summaryResult, diffResult] = await Promise.all([
        runDiffForScope(
          runner,
          input.scope,
          ["--no-ext-diff", "--no-textconv", "--numstat", "-z", ...suffix],
          boundary.rootPath,
          context.signal,
          1_048_576,
        ),
        runDiffForScope(
          runner,
          input.scope,
          [...common, ...suffix],
          boundary.rootPath,
          context.signal,
          input.maxOutputBytes + 65_536,
        ),
      ]);
      const files = parseNumstat(summaryResult.stdout);
      const sanitized = sanitizeDiff(diffResult.stdout);
      const diff = truncateUtf8(sanitized.text, input.maxOutputBytes);
      const truncated = diff !== sanitized.text || diffResult.stdoutTruncated === true;
      const additions = files.reduce((total, file) => total + file.additions, 0);
      const deletions = files.reduce((total, file) => total + file.deletions, 0);
      const summaryComplete = summaryResult.stdoutTruncated !== true && files.length <= 1_000;
      const boundedFiles = Object.freeze(files.slice(0, 1_000));
      const output: GitDiffOutput = Object.freeze({
        scope: input.scope,
        diff,
        files: boundedFiles,
        filesChanged: files.length,
        additions,
        deletions,
        summaryComplete,
        truncated,
        ...(truncated ? { truncationReason: "output-bytes" as const } : {}),
        provenance: { source: "git" as const, untrusted: true as const },
      });
      return {
        output,
        metadata: {
          untrusted: true,
          truncated,
          sanitizedCharacters: sanitized.sanitizedCharacters,
          summaryComplete,
        },
      };
    },
  });
}

interface ParsedStatus {
  readonly branch: GitStatusOutput["branch"];
  readonly entries: readonly GitStatusEntry[];
  readonly counts: GitStatusOutput["counts"];
  readonly truncated: boolean;
}

export function parseGitStatusPorcelainV2(output: string, maxEntries = 1_000): ParsedStatus {
  return parseStatus(output, maxEntries);
}

function parseStatus(output: string, maxEntries: number): ParsedStatus {
  let head: string | null = null;
  let oid: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: GitStatusEntry[] = [];
  const records = porcelainRecords(output);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.startsWith("# branch.oid ")) oid = nullableBranch(record.slice(13));
    else if (record.startsWith("# branch.head ")) head = nullableBranch(record.slice(14));
    else if (record.startsWith("# branch.upstream ")) upstream = nullableBranch(record.slice(18));
    else if (record.startsWith("# branch.ab ")) {
      const match = record.match(/^# branch\.ab \+(\d+) -(\d+)$/u);
      if (match !== null) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (record.startsWith("1 ")) {
      const fields = splitFields(record.slice(2), 7);
      if (fields !== undefined)
        entries.push(statusEntry("ordinary", fields[0] ?? "  ", fields[7] ?? ""));
    } else if (record.startsWith("2 ")) {
      const fields = splitFields(record.slice(2), 8);
      const original = records[index + 1] ?? "";
      index += 1;
      if (fields !== undefined)
        entries.push(statusEntry("renamed", fields[0] ?? "  ", fields[8] ?? "", original));
    } else if (record.startsWith("u ")) {
      const fields = splitFields(record.slice(2), 9);
      if (fields !== undefined)
        entries.push(statusEntry("unmerged", fields[0] ?? "UU", fields[9] ?? ""));
    } else if (record.startsWith("? ")) {
      entries.push(statusEntry("untracked", "??", record.slice(2)));
    }
    if (entries.length > maxEntries) break;
  }
  const truncated = entries.length > maxEntries;
  const bounded = Object.freeze(entries.slice(0, maxEntries));
  return Object.freeze({
    branch: Object.freeze({ head, oid, upstream, ahead, behind }),
    entries: bounded,
    counts: Object.freeze({
      staged: bounded.filter(({ staged }) => staged).length,
      modified: bounded.filter(({ modified }) => modified).length,
      untracked: bounded.filter(({ kind }) => kind === "untracked").length,
      conflicted: bounded.filter(({ conflicted }) => conflicted).length,
    }),
    truncated,
  });
}

function statusEntry(
  kind: GitStatusEntry["kind"],
  status: string,
  rawPath: string,
  rawOriginalPath?: string,
): GitStatusEntry {
  const selectedStatus = status.length === 2 ? status : "??";
  const pathValue = sanitizePath(rawPath);
  const original = rawOriginalPath === undefined ? undefined : sanitizePath(rawOriginalPath);
  return Object.freeze({
    path: pathValue.text,
    ...(original === undefined ? {} : { originalPath: original.text }),
    kind,
    status: selectedStatus,
    staged: kind !== "untracked" && selectedStatus[0] !== ".",
    modified: kind !== "untracked" && selectedStatus[1] !== ".",
    conflicted: kind === "unmerged" || /U/u.test(selectedStatus),
    sanitized: pathValue.sanitized || (original?.sanitized ?? false),
  });
}

export function parseGitNumstat(output: string): readonly GitDiffFile[] {
  return parseNumstat(output);
}

function parseNumstat(output: string): readonly GitDiffFile[] {
  const files: GitDiffFile[] = [];
  const nulDelimited = output.includes("\0");
  const records = nulDelimited ? output.split("\0") : output.split(/\r?\n/u);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length === 0) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab) continue;
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    let rawPath = record.slice(secondTab + 1);
    let rawOriginalPath: string | undefined;
    if (nulDelimited && rawPath.length === 0) {
      rawOriginalPath = records[index + 1] ?? "";
      rawPath = records[index + 2] ?? "";
      index += 2;
    }
    const pathValue = sanitizePath(rawPath);
    const originalPath = rawOriginalPath === undefined ? undefined : sanitizePath(rawOriginalPath);
    const binary = added === "-" || deleted === "-";
    files.push(
      Object.freeze({
        path: pathValue.text,
        ...(originalPath === undefined ? {} : { originalPath: originalPath.text }),
        additions: binary ? 0 : numericCount(added),
        deletions: binary ? 0 : numericCount(deleted),
        binary,
        sanitized: pathValue.sanitized || (originalPath?.sanitized ?? false),
      }),
    );
  }
  return Object.freeze(files);
}

function porcelainRecords(output: string): string[] {
  const records: string[] = [];
  let start = 0;
  while (start < output.length) {
    const terminator = output.startsWith("# ", start) ? "\n" : "\0";
    const end = output.indexOf(terminator, start);
    if (end < 0) {
      records.push(output.slice(start));
      break;
    }
    records.push(output.slice(start, end));
    start = end + 1;
  }
  return records;
}

async function verifyGitWorkspace(
  boundary: WorkspaceBoundary,
  runner: GitCommandRunner,
  signal: AbortSignal,
): Promise<void> {
  try {
    const gitEntry = await boundary.revalidate(await boundary.resolve(".git", "read"));
    if (!(await stat(gitEntry.realPath ?? gitEntry.absolutePath)).isDirectory()) {
      throw new GitInspectionError("Linked Git directories are not supported by workspace tools");
    }
    const result = await runGit(
      runner,
      ["rev-parse", "--show-toplevel"],
      boundary.rootPath,
      signal,
      4_096,
    );
    const reported = path.resolve(result.stdout.trim());
    if (!samePath(reported, boundary.rootPath)) {
      throw new GitInspectionError("Git reported a root outside the configured workspace");
    }
  } catch (error) {
    if (error instanceof CancellationError || signal.aborted)
      throw new CancellationError(signal.reason);
    if (error instanceof GitInspectionError) throw error;
    throw new GitInspectionError("Git workspace verification failed", error);
  }
}

async function validatePaths(
  boundary: WorkspaceBoundary,
  requested: readonly string[],
): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const requestedPath of requested) {
    const resolved = await boundary.resolve(requestedPath, "write");
    const verified = await boundary.revalidate(resolved);
    paths.push(
      verified.relativePath.length === 0 ? "." : verified.relativePath.split("\\").join("/"),
    );
  }
  return Object.freeze(paths);
}

async function runGit(
  runner: GitCommandRunner,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  maxStdoutBytes: number,
): Promise<GitCommandResult> {
  try {
    return await runner.run(["--no-pager", "-c", "color.ui=false", ...args], {
      cwd,
      signal,
      timeoutMs: 10_000,
      maxStdoutBytes,
      maxStderrBytes: 65_536,
    });
  } catch (error) {
    if (signal.aborted) throw new CancellationError(signal.reason);
    throw new GitInspectionError(`Git ${args[0] ?? "command"} failed`, error);
  }
}

async function runDiffForScope(
  runner: GitCommandRunner,
  scope: GitDiffInput["scope"],
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  maxStdoutBytes: number,
): Promise<GitCommandResult> {
  const prefix = scope === "staged" ? ["--cached"] : scope === "all" ? ["HEAD"] : [];
  try {
    return await runGit(runner, ["diff", ...prefix, ...args], cwd, signal, maxStdoutBytes);
  } catch (error) {
    if (scope !== "all" || signal.aborted) throw error;
    const staged = await runGit(runner, ["diff", "--cached", ...args], cwd, signal, maxStdoutBytes);
    const unstaged = await runGit(runner, ["diff", ...args], cwd, signal, maxStdoutBytes);
    return Object.freeze({
      stdout: `${staged.stdout}${unstaged.stdout}`,
      stderr: `${staged.stderr}${unstaged.stderr}`,
      ...(staged.stdoutTruncated || unstaged.stdoutTruncated ? { stdoutTruncated: true } : {}),
      ...(staged.stderrTruncated || unstaged.stderrTruncated ? { stderrTruncated: true } : {}),
    });
  }
}

function splitFields(input: string, count: number): string[] | undefined {
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < count; index += 1) {
    const separator = input.indexOf(" ", start);
    if (separator < 0) return undefined;
    fields.push(input.slice(start, separator));
    start = separator + 1;
  }
  fields.push(input.slice(start));
  return fields;
}

function nullableBranch(value: string): string | null {
  const sanitized = sanitizePath(value).text;
  return sanitized === "(initial)" || sanitized === "(detached)" ? null : sanitized;
}

function sanitizePath(value: string): { readonly text: string; readonly sanitized: boolean } {
  let sanitized = false;
  const text = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) {
        sanitized = true;
        return "�";
      }
      return character;
    })
    .join("");
  return Object.freeze({ text, sanitized });
}

function sanitizeDiff(value: string): {
  readonly text: string;
  readonly sanitizedCharacters: number;
} {
  let sanitizedCharacters = 0;
  const text = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (
        codePoint <= 8 ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        (codePoint >= 127 && codePoint <= 159)
      ) {
        sanitizedCharacters += 1;
        return "�";
      }
      return character;
    })
    .join("");
  return Object.freeze({ text, sanitizedCharacters });
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

function numericCount(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}
