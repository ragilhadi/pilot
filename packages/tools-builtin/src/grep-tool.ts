import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  CancellationError,
  defineTool,
  PilotError,
  type ToolDefinition,
  type WorkspaceBoundary,
} from "@pilotrun/core";
import * as z from "zod";
import { compileGlobPattern } from "./glob-pattern.js";
import { WorkspacePathError } from "./workspace-boundary.js";

const maximumToolOutputBytes = 240_000;
const maximumRunnerOutputBytes = 2_500_000;
const maximumStderrBytes = 32_768;

export const GrepInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(1_000)
      .refine(
        (value) => !/[\0\r\n]/u.test(value),
        "Search queries cannot contain line breaks or null bytes",
      ),
    mode: z.enum(["literal", "regex"]).default("literal"),
    path: z.string().min(1).max(4_096).default("."),
    glob: z.string().min(1).max(256).optional(),
    caseSensitive: z.boolean().default(true),
    includeHidden: z.boolean().default(false),
    maxResults: z.number().int().min(1).max(500).default(100),
    maxFileSizeBytes: z.number().int().min(1).max(100_000_000).default(2_000_000),
    maxExcerptChars: z.number().int().min(40).max(1_000).default(300),
  })
  .strict()
  .readonly();

export const GrepMatchSchema = z
  .object({
    path: z.string().min(1),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    excerpt: z.string(),
    matchText: z.string(),
    excerptTruncated: z.boolean(),
    sanitized: z.boolean(),
  })
  .strict()
  .readonly();

export const GrepOutputSchema = z
  .object({
    root: z.string(),
    query: z.string(),
    mode: z.enum(["literal", "regex"]),
    matches: z.array(GrepMatchSchema).max(500).readonly(),
    filesSearched: z.number().int().nonnegative(),
    sanitizedMatches: z.number().int().nonnegative(),
    truncated: z.boolean(),
    truncationReason: z.enum(["result-limit", "output-bytes", "runner-output-limit"]).optional(),
  })
  .strict()
  .readonly();

export type GrepInput = z.output<typeof GrepInputSchema>;
export type GrepMatch = z.output<typeof GrepMatchSchema>;
export type GrepOutput = z.output<typeof GrepOutputSchema>;

export interface RipgrepRunRequest {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly onLine: (line: string) => boolean;
}

export interface RipgrepRunResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stoppedBy?: "consumer" | "output-limit" | "timeout";
}

export interface RipgrepRunner {
  run(request: RipgrepRunRequest): Promise<RipgrepRunResult>;
}

export class GrepToolError extends PilotError {
  constructor(
    code: "PILOT_GREP_FAILED" | "PILOT_GREP_PATTERN_INVALID" | "PILOT_GREP_UNAVAILABLE",
    message: string,
    cause?: unknown,
  ) {
    super({
      code,
      message,
      safeMessage:
        code === "PILOT_GREP_PATTERN_INVALID"
          ? "The regular expression is invalid"
          : code === "PILOT_GREP_UNAVAILABLE"
            ? "ripgrep is required but is not available"
            : "Repository search failed",
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

export class NodeRipgrepRunner implements RipgrepRunner {
  readonly #executable: string;

  constructor(executable = "rg") {
    this.#executable = executable;
  }

  run(request: RipgrepRunRequest): Promise<RipgrepRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#executable, request.args, {
        cwd: request.cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1" },
      });
      const decoder = new StringDecoder("utf8");
      let pending = "";
      let stdoutBytes = 0;
      let stderr = "";
      let stoppedBy: RipgrepRunResult["stoppedBy"];
      let callbackError: unknown;
      let spawnError: unknown;
      let cancelled = false;
      let settled = false;

      const stop = (reason: NonNullable<RipgrepRunResult["stoppedBy"]>) => {
        stoppedBy ??= reason;
        child.kill();
      };
      const abort = () => {
        cancelled = true;
        child.kill();
      };
      const timeout = setTimeout(() => stop("timeout"), request.timeoutMs);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();

      child.stdout.on("data", (chunk: Buffer) => {
        if (stoppedBy !== undefined || cancelled) return;
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > request.maxStdoutBytes) {
          stop("output-limit");
          return;
        }
        pending += decoder.write(chunk);
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            if (!request.onLine(line)) {
              stop("consumer");
              return;
            }
          } catch (error) {
            callbackError = error;
            child.kill();
            return;
          }
          newline = pending.indexOf("\n");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(stderr, "utf8") >= request.maxStderrBytes) return;
        stderr += chunk.toString("utf8").slice(0, request.maxStderrBytes);
      });
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", abort);
        if (cancelled) {
          reject(new CancellationError(request.signal.reason));
          return;
        }
        if (callbackError !== undefined) {
          reject(callbackError);
          return;
        }
        if (spawnError !== undefined) {
          reject(
            isExecutableMissing(spawnError)
              ? new GrepToolError(
                  "PILOT_GREP_UNAVAILABLE",
                  "ripgrep executable was not found",
                  spawnError,
                )
              : new GrepToolError("PILOT_GREP_FAILED", "ripgrep could not start", spawnError),
          );
          return;
        }
        resolve(
          Object.freeze({
            exitCode,
            stderr: sanitizeDiagnostic(stderr),
            ...(stoppedBy === undefined ? {} : { stoppedBy }),
          }),
        );
      });
    });
  }
}

const RipgrepEventSchema = z
  .object({
    type: z.enum(["begin", "match", "end", "summary"]),
    data: z.unknown(),
  })
  .passthrough();

const RipgrepPathSchema = z.object({ text: z.string().optional() }).passthrough();
const RipgrepMatchDataSchema = z
  .object({
    path: RipgrepPathSchema,
    lines: z.object({ text: z.string() }).passthrough(),
    line_number: z.number().int().positive(),
    submatches: z
      .array(
        z
          .object({
            match: z.object({ text: z.string() }).passthrough(),
            start: z.number().int().nonnegative(),
            end: z.number().int().nonnegative(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export function createGrepTool(
  boundary: WorkspaceBoundary,
  runner: RipgrepRunner = new NodeRipgrepRunner(),
): ToolDefinition<typeof GrepInputSchema, typeof GrepOutputSchema> {
  return defineTool({
    name: "grep",
    description:
      "Search text files inside the workspace using literal or safe ripgrep regular-expression mode with sanitized bounded excerpts.",
    inputSchema: GrepInputSchema,
    outputSchema: GrepOutputSchema,
    metadata: {
      risk: "read-only",
      concurrency: "parallel-safe",
      timeoutMs: 12_000,
      maxOutputBytes: 262_144,
      requiredPermissions: ["workspace.read"],
    },
    execute: async (input, context) => {
      if (input.glob !== undefined) compileGlobPattern(input.glob);
      const target = await boundary.resolve(input.path, "read");
      const verifiedTarget = await boundary.revalidate(target);
      const targetPath = verifiedTarget.realPath ?? verifiedTarget.absolutePath;
      const root = verifiedTarget.relativePath.length === 0 ? "." : verifiedTarget.relativePath;
      const args = await buildRipgrepArgs(boundary, input, targetPath);
      const matches: GrepMatch[] = [];
      const files = new Set<string>();
      let outputBytes = 2;
      let sanitizedMatches = 0;
      let truncationReason: GrepOutput["truncationReason"];

      const result = await runner.run({
        cwd: boundary.rootPath,
        args,
        signal: context.signal,
        timeoutMs: 10_000,
        maxStdoutBytes: maximumRunnerOutputBytes,
        maxStderrBytes: maximumStderrBytes,
        onLine: (line) => {
          if (line.length === 0) return true;
          const parsedEvent = RipgrepEventSchema.safeParse(parseJson(line));
          if (!parsedEvent.success) {
            throw new GrepToolError("PILOT_GREP_FAILED", "ripgrep emitted an invalid JSON event");
          }
          if (parsedEvent.data.type === "begin") {
            const begin = z
              .object({ path: RipgrepPathSchema })
              .passthrough()
              .safeParse(parsedEvent.data.data);
            if (begin.success && begin.data.path.text !== undefined)
              files.add(begin.data.path.text);
            return true;
          }
          if (parsedEvent.data.type !== "match") return true;
          const data = RipgrepMatchDataSchema.safeParse(parsedEvent.data.data);
          if (!data.success || data.data.path.text === undefined) {
            throw new GrepToolError("PILOT_GREP_FAILED", "ripgrep emitted malformed match data");
          }
          if (matches.length >= input.maxResults) {
            truncationReason = "result-limit";
            return false;
          }
          const match = normalizeMatch(boundary.rootPath, data.data, input.maxExcerptChars);
          const bytes = Buffer.byteLength(JSON.stringify(match), "utf8") + 1;
          if (outputBytes + bytes > maximumToolOutputBytes) {
            truncationReason = "output-bytes";
            return false;
          }
          matches.push(match);
          outputBytes += bytes;
          if (match.sanitized) sanitizedMatches += 1;
          return true;
        },
      });

      if (result.stoppedBy === "timeout") {
        throw new GrepToolError("PILOT_GREP_FAILED", "ripgrep exceeded its execution timeout");
      }
      if (result.stoppedBy === "output-limit") truncationReason = "runner-output-limit";
      if (result.exitCode !== 0 && result.exitCode !== 1 && result.stoppedBy === undefined) {
        throw new GrepToolError(
          looksLikeRegexError(result.stderr) ? "PILOT_GREP_PATTERN_INVALID" : "PILOT_GREP_FAILED",
          `ripgrep exited with code ${result.exitCode ?? "unknown"}`,
        );
      }

      matches.sort(
        (left, right) =>
          left.path.localeCompare(right.path) ||
          left.line - right.line ||
          left.column - right.column,
      );
      const output: GrepOutput = Object.freeze({
        root,
        query: input.query,
        mode: input.mode,
        matches: Object.freeze(matches),
        filesSearched: files.size,
        sanitizedMatches,
        truncated: truncationReason !== undefined,
        ...(truncationReason === undefined ? {} : { truncationReason }),
      });
      return {
        output,
        metadata: { untrusted: true, truncated: output.truncated, sanitizedMatches },
      };
    },
  });
}

async function buildRipgrepArgs(
  boundary: WorkspaceBoundary,
  input: GrepInput,
  targetPath: string,
): Promise<string[]> {
  const args = [
    "--json",
    "--sort",
    "path",
    "--no-follow",
    "--max-columns",
    "4096",
    "--max-columns-preview",
    "--max-filesize",
    String(input.maxFileSizeBytes),
    input.caseSensitive ? "--case-sensitive" : "--ignore-case",
    ...(input.mode === "literal" ? ["--fixed-strings"] : []),
    ...(input.includeHidden ? ["--hidden"] : []),
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!dist/**",
    "--glob",
    "!build/**",
    "--glob",
    "!coverage/**",
    "--glob",
    "!.next/**",
    "--glob",
    "!.turbo/**",
  ];
  if (input.glob !== undefined) args.push("--glob", input.glob);
  try {
    await boundary.resolve(".pilotignore", "read");
    args.push("--ignore-file", ".pilotignore");
  } catch (error) {
    if (!(error instanceof WorkspacePathError && error.code === "PILOT_WORKSPACE_PATH_NOT_FOUND")) {
      throw error;
    }
  }
  args.push("--regexp", input.query, "--", targetPath);
  return args;
}

function normalizeMatch(
  rootPath: string,
  data: z.output<typeof RipgrepMatchDataSchema>,
  maximumCharacters: number,
): GrepMatch {
  const rawPath = data.path.text ?? "";
  const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(rootPath, rawPath);
  const relativePath = path.relative(rootPath, absolutePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new GrepToolError("PILOT_GREP_FAILED", "ripgrep returned a path outside the workspace");
  }
  const submatch = data.submatches[0];
  if (submatch === undefined) {
    throw new GrepToolError("PILOT_GREP_FAILED", "ripgrep match contained no submatch");
  }
  const withoutTerminator = data.lines.text.replace(/[\r\n]+$/u, "");
  const excerpt = excerptAroundMatch(
    withoutTerminator,
    submatch.start,
    submatch.end,
    maximumCharacters,
  );
  const sanitizedExcerpt = sanitizeText(excerpt.text);
  const sanitizedMatch = sanitizeText(submatch.match.text);
  const safePath = sanitizeText(relativePath.split(path.sep).join("/"));
  return Object.freeze({
    path: safePath.text,
    line: data.line_number,
    column: submatch.start + 1,
    excerpt: sanitizedExcerpt.text,
    matchText: boundedExcerpt(sanitizedMatch.text, 200).text,
    excerptTruncated: excerpt.truncated,
    sanitized: safePath.changed || sanitizedExcerpt.changed || sanitizedMatch.changed,
  });
}

function boundedExcerpt(
  value: string,
  maximumCharacters: number,
): { text: string; truncated: boolean } {
  const characters = [...value];
  if (characters.length <= maximumCharacters) return { text: value, truncated: false };
  return { text: `${characters.slice(0, maximumCharacters - 1).join("")}…`, truncated: true };
}

function excerptAroundMatch(
  value: string,
  startByte: number,
  endByte: number,
  maximumCharacters: number,
): { text: string; truncated: boolean } {
  const characters = [...value];
  if (characters.length <= maximumCharacters) return { text: value, truncated: false };

  const bytes = Buffer.from(value, "utf8");
  const start = [...bytes.subarray(0, Math.min(startByte, bytes.length)).toString("utf8")].length;
  const end = [...bytes.subarray(0, Math.min(endByte, bytes.length)).toString("utf8")].length;
  const matchLength = Math.max(1, end - start);
  const initialContentLength = Math.max(1, maximumCharacters - 2);
  let windowStart = Math.max(0, start - Math.floor((initialContentLength - matchLength) / 2));
  let windowEnd = Math.min(characters.length, windowStart + initialContentLength);
  windowStart = Math.max(0, windowEnd - initialContentLength);

  const hasPrefix = windowStart > 0;
  const hasSuffix = windowEnd < characters.length;
  const contentLength = maximumCharacters - Number(hasPrefix) - Number(hasSuffix);
  windowStart = Math.max(0, start - Math.floor((contentLength - matchLength) / 2));
  windowEnd = Math.min(characters.length, windowStart + contentLength);
  windowStart = Math.max(0, windowEnd - contentLength);

  return {
    text: `${windowStart > 0 ? "…" : ""}${characters.slice(windowStart, windowEnd).join("")}${windowEnd < characters.length ? "…" : ""}`,
    truncated: true,
  };
}

function sanitizeText(value: string): { text: string; changed: boolean } {
  let text = "";
  let changed = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafe =
      codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      (codePoint >= 127 && codePoint <= 159);
    text += unsafe ? "�" : character;
    changed ||= unsafe;
  }
  return { text, changed };
}

function sanitizeDiagnostic(value: string): string {
  return sanitizeText(value).text.slice(0, maximumStderrBytes);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function looksLikeRegexError(stderr: string): boolean {
  return /regex parse error|error parsing regex|invalid regex/iu.test(stderr);
}

function isExecutableMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
