import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import {
  CancellationError,
  defineTool,
  PilotError,
  type PilotErrorCode,
  type ToolDefinition,
  type WorkspaceBoundary,
} from "@pilotrun/core";
import * as z from "zod";

const defaultMaximumFileBytes = 5_000_000;
const hardMaximumFileBytes = 10_000_000;
/**
 * A default read used to be able to return 100 KB in a single tool result, which dominated the
 * context window and made one `read_file` look like it cost tens of thousands of tokens. Bound it
 * by lines first — the unit the model actually reasons in — and keep the byte cap as a backstop.
 */
const defaultMaximumLines = 2_000;
const defaultMaximumContentBytes = 40_000;
const hardMaximumContentBytes = 100_000;
/** Keeps one minified or generated line from consuming the entire result. */
const maximumLineCharacters = 2_000;
const readChunkBytes = 65_536;

export const ReadFileInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4_096)
      .describe(
        'Workspace-relative path to the file, for example "src/index.ts". Absolute paths and ' +
          "paths outside the workspace are rejected.",
      ),
    startLine: z
      .number()
      .int()
      .positive()
      .default(1)
      .describe(
        "First line to return, 1-based. When a previous call reported truncated: true, pass its " +
          "nextStartLine here to continue from where it stopped.",
      ),
    endLine: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Last line to return, 1-based and inclusive. Omit to read to the end of the file, " +
          "subject to the output size limit.",
      ),
    maxFileSizeBytes: z
      .number()
      .int()
      .positive()
      .max(hardMaximumFileBytes)
      .default(defaultMaximumFileBytes)
      .describe("Refuse to open files larger than this. Rarely worth setting."),
    limit: z
      .number()
      .int()
      .positive()
      .max(10_000)
      .default(defaultMaximumLines)
      .describe(
        "Maximum number of lines to return in one call. Defaults to 2000; lower it to sample a " +
          "large file cheaply.",
      ),
    maxContentBytes: z
      .number()
      .int()
      .min(1_024)
      .max(hardMaximumContentBytes)
      .default(defaultMaximumContentBytes)
      .describe("Byte backstop on the returned content. The line limit usually binds first."),
  })
  .strict()
  .refine(
    ({ startLine, endLine }) => endLine === undefined || endLine >= startLine,
    "endLine must be greater than or equal to startLine",
  )
  .readonly();

export const ReadFileProvenanceSchema = z
  .object({
    source: z.literal("workspace-file"),
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    untrusted: z.literal(true),
  })
  .strict()
  .readonly();

export const ReadFileOutputSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().nonnegative(),
    totalLines: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    encoding: z.literal("utf-8"),
    hasBom: z.boolean(),
    lineEnding: z.enum(["lf", "crlf", "cr", "mixed", "none"]),
    /** Every content line is prefixed with its 1-based number and a tab, like `cat -n`. */
    contentFormat: z.literal("numbered-lines"),
    truncated: z.boolean(),
    truncationReason: z.enum(["output-bytes", "line-limit"]).optional(),
    nextStartLine: z.number().int().positive().optional(),
    lineTruncated: z.boolean(),
    sanitizedCharacters: z.number().int().nonnegative(),
    provenance: ReadFileProvenanceSchema,
  })
  .strict()
  .readonly();

export type ReadFileInput = z.output<typeof ReadFileInputSchema>;
export type ReadFileOutput = z.output<typeof ReadFileOutputSchema>;

type ReadFileErrorCode = Extract<
  PilotErrorCode,
  | "PILOT_READ_FILE_BINARY"
  | "PILOT_READ_FILE_FAILED"
  | "PILOT_READ_FILE_INVALID_ENCODING"
  | "PILOT_READ_FILE_INVALID_RANGE"
  | "PILOT_READ_FILE_INVALID_TARGET"
  | "PILOT_READ_FILE_TOO_LARGE"
>;

export class ReadFileToolError extends PilotError {
  constructor(
    code: ReadFileErrorCode,
    message: string,
    metadata: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super({
      code,
      message,
      safeMessage: safeMessageFor(code),
      metadata,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

export function createReadFileTool(
  boundary: WorkspaceBoundary,
): ToolDefinition<typeof ReadFileInputSchema, typeof ReadFileOutputSchema> {
  return defineTool({
    name: "read_file",
    description:
      "Read the contents of a UTF-8 text file in the workspace.\n\n" +
      "Use this before editing any file. The result's sha256 is the hash of the whole file, and " +
      "edit and apply_patch both require it as baseSha256 — so always read a file immediately " +
      "before you change it, and use the sha256 from that read.\n\n" +
      "Each returned line is prefixed with its line number and a tab, like `cat -n`. The gutter " +
      "is NOT part of the file: when copying text into edit's oldString or into an apply_patch " +
      "hunk, strip the number and the tab and copy only what follows.\n\n" +
      "To find files, use glob or grep first; do not guess paths. To read a specific region, pass " +
      "startLine and endLine. Returns at most 2000 lines per call; if the result has " +
      "truncated: true, call again with startLine set to the returned nextStartLine.\n\n" +
      'Example: {"path": "src/index.ts", "startLine": 1, "endLine": 120}',
    inputSchema: ReadFileInputSchema,
    outputSchema: ReadFileOutputSchema,
    metadata: {
      risk: "read-only",
      concurrency: "parallel-safe",
      timeoutMs: 10_000,
      maxOutputBytes: 262_144,
      requiredPermissions: ["workspace.read"],
    },
    execute: async (input, context) => {
      throwIfCancelled(context.signal);
      const resolved = await boundary.resolve(input.path, "read");
      const verified = await boundary.revalidate(resolved);
      const absolutePath = verified.realPath ?? verified.absolutePath;
      const bytes = await readBoundedFile(absolutePath, input.maxFileSizeBytes, context.signal);
      throwIfCancelled(context.signal);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const hasBom =
        bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      const text = decodeUtf8(bytes);
      assertTextContent(bytes, text);
      const selected = selectContent(text, input);
      if (selected.totalLines > 0 && input.startLine > selected.totalLines) {
        throw new ReadFileToolError(
          "PILOT_READ_FILE_INVALID_RANGE",
          `startLine ${input.startLine} is beyond the file's ${selected.totalLines} lines`,
          {
            path: verified.relativePath,
            startLine: input.startLine,
            totalLines: selected.totalLines,
          },
        );
      }
      const portablePath = verified.relativePath.split("\\").join("/");
      const provenance = Object.freeze({
        source: "workspace-file" as const,
        path: portablePath,
        sha256,
        untrusted: true as const,
      });
      const output: ReadFileOutput = Object.freeze({
        path: portablePath,
        content: selected.content,
        startLine: input.startLine,
        endLine: selected.endLine,
        totalLines: selected.totalLines,
        sizeBytes: bytes.length,
        sha256,
        encoding: "utf-8",
        hasBom,
        lineEnding: detectLineEnding(text),
        contentFormat: "numbered-lines",
        truncated: selected.truncated,
        ...(selected.truncationReason === undefined
          ? {}
          : { truncationReason: selected.truncationReason }),
        ...(selected.nextStartLine === undefined ? {} : { nextStartLine: selected.nextStartLine }),
        lineTruncated: selected.lineTruncated,
        sanitizedCharacters: selected.sanitizedCharacters,
        provenance,
      });
      return {
        output,
        metadata: {
          untrusted: true,
          truncated: output.truncated,
          sourcePath: portablePath,
          sha256,
          sanitizedCharacters: output.sanitizedCharacters,
        },
      };
    },
  });
}

interface SelectedContent {
  readonly content: string;
  readonly endLine: number;
  readonly totalLines: number;
  readonly truncated: boolean;
  readonly truncationReason?: "output-bytes" | "line-limit";
  readonly nextStartLine?: number;
  /** True when at least one returned line was clipped, not only when the result ends mid-line. */
  readonly lineTruncated: boolean;
  readonly sanitizedCharacters: number;
}

async function readBoundedFile(
  absolutePath: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    const flags =
      process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    handle = await open(absolutePath, flags);
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new ReadFileToolError(
        "PILOT_READ_FILE_INVALID_TARGET",
        "The read target is not a regular file",
        { path: absolutePath },
      );
    }
    if (stats.size > maximumBytes) throw tooLargeError(maximumBytes, stats.size);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      throwIfCancelled(signal);
      const buffer = Buffer.allocUnsafe(Math.min(readChunkBytes, maximumBytes + 1 - totalBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maximumBytes) throw tooLargeError(maximumBytes, totalBytes);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, totalBytes);
  } catch (error) {
    if (error instanceof CancellationError || error instanceof ReadFileToolError) throw error;
    throw new ReadFileToolError(
      "PILOT_READ_FILE_FAILED",
      "The workspace file could not be read",
      { path: absolutePath },
      error,
    );
  } finally {
    await handle?.close();
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ReadFileToolError(
      "PILOT_READ_FILE_INVALID_ENCODING",
      "The file is not valid UTF-8",
      {},
      error,
    );
  }
}

function assertTextContent(bytes: Buffer, text: string): void {
  if (bytes.includes(0)) {
    throw new ReadFileToolError("PILOT_READ_FILE_BINARY", "The file contains null bytes");
  }
  let suspicious = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isUnsafeControl(codePoint)) suspicious += 1;
  }
  if (text.length > 0 && suspicious / text.length > 0.3) {
    throw new ReadFileToolError(
      "PILOT_READ_FILE_BINARY",
      "The file contains too many non-text control characters",
    );
  }
}

/** `cat -n` style gutter: a right-aligned line number, a tab, then the line's text. */
function lineNumberPrefix(lineNumber: number): string {
  return `${String(lineNumber).padStart(6, " ")}\t`;
}

function selectContent(text: string, input: ReadFileInput): SelectedContent {
  const rendered: string[] = [];
  let usedBytes = 0;
  let endLine = 0;
  let totalLines = 0;
  let returnedLines = 0;
  let sanitizedCharacters = 0;
  let lineTruncated = false;
  let truncated = false;
  let truncationReason: SelectedContent["truncationReason"];
  let nextStartLine: number | undefined;

  const stopAt = (lineNumber: number, reason: NonNullable<SelectedContent["truncationReason"]>) => {
    truncated = true;
    truncationReason ??= reason;
    nextStartLine ??= lineNumber;
  };

  const consumeLine = (line: string, lineNumber: number, terminator: string) => {
    if (
      lineNumber < input.startLine ||
      (input.endLine !== undefined && lineNumber > input.endLine) ||
      truncated
    ) {
      return;
    }
    if (returnedLines >= input.limit) {
      stopAt(lineNumber, "line-limit");
      return;
    }

    const safeCharacters: string[] = [];
    for (const character of line) {
      if (safeCharacters.length >= maximumLineCharacters) {
        // A single very long line is clipped rather than allowed to fill the whole budget.
        safeCharacters.push("…");
        lineTruncated = true;
        break;
      }
      const codePoint = character.codePointAt(0) ?? 0;
      const unsafe = isUnsafeControl(codePoint);
      safeCharacters.push(unsafe ? "�" : character);
      if (unsafe) sanitizedCharacters += 1;
    }

    // The file's own terminator is preserved, so text copied out of a CRLF file still matches it
    // byte for byte when it comes back through edit's oldString.
    const entry = `${lineNumberPrefix(lineNumber)}${safeCharacters.join("")}${terminator}`;
    const entryBytes = Buffer.byteLength(entry, "utf8");
    if (usedBytes + entryBytes > input.maxContentBytes) {
      // Always return something, so a tiny byte budget cannot produce an empty result whose
      // nextStartLine points back at the same line forever.
      if (returnedLines > 0) {
        stopAt(lineNumber, "output-bytes");
        return;
      }
      const overhead = lineNumberPrefix(lineNumber).length + terminator.length;
      const room = Math.max(0, input.maxContentBytes - overhead);
      const clipped = truncateUtf8Characters(safeCharacters.join(""), room);
      const clippedEntry = `${lineNumberPrefix(lineNumber)}${clipped}${terminator}`;
      rendered.push(clippedEntry);
      usedBytes += Buffer.byteLength(clippedEntry, "utf8");
      returnedLines += 1;
      endLine = lineNumber;
      lineTruncated = true;
      stopAt(lineNumber + 1, "output-bytes");
      return;
    }
    rendered.push(entry);
    usedBytes += entryBytes;
    returnedLines += 1;
    endLine = lineNumber;
  };

  if (text.length > 0) {
    let lineStart = 0;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character !== "\r" && character !== "\n") continue;
      const terminatorEnd = character === "\r" && text[index + 1] === "\n" ? index + 2 : index + 1;
      totalLines += 1;
      consumeLine(text.slice(lineStart, index), totalLines, text.slice(index, terminatorEnd));
      index = terminatorEnd - 1;
      lineStart = terminatorEnd;
    }
    if (lineStart < text.length) {
      totalLines += 1;
      consumeLine(text.slice(lineStart), totalLines, "");
    }
  }

  // nextStartLine is only meaningful while there is more file left to read.
  const hasMore = nextStartLine !== undefined && nextStartLine <= totalLines;
  return Object.freeze({
    content: rendered.join(""),
    endLine,
    totalLines,
    truncated,
    ...(truncationReason === undefined ? {} : { truncationReason }),
    ...(hasMore && nextStartLine !== undefined ? { nextStartLine } : {}),
    lineTruncated,
    sanitizedCharacters,
  }) satisfies SelectedContent;
}

function truncateUtf8Characters(value: string, maximumBytes: number): string {
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes) break;
    characters.push(character);
    bytes += size;
  }
  return characters.join("");
}

function isUnsafeControl(codePoint: number): boolean {
  return (
    codePoint <= 8 ||
    codePoint === 11 ||
    codePoint === 12 ||
    (codePoint >= 14 && codePoint <= 31) ||
    (codePoint >= 127 && codePoint <= 159)
  );
}

function detectLineEnding(text: string): ReadFileOutput["lineEnding"] {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      crlf += 1;
      index += 1;
    } else if (text[index] === "\r") {
      cr += 1;
    } else if (text[index] === "\n") {
      lf += 1;
    }
  }
  const kinds = Number(lf > 0) + Number(crlf > 0) + Number(cr > 0);
  if (kinds === 0) return "none";
  if (kinds > 1) return "mixed";
  if (crlf > 0) return "crlf";
  if (cr > 0) return "cr";
  return "lf";
}

function tooLargeError(maximumBytes: number, observedBytes: number): ReadFileToolError {
  return new ReadFileToolError(
    "PILOT_READ_FILE_TOO_LARGE",
    `The file exceeds the ${maximumBytes}-byte input limit`,
    { maximumBytes, observedBytes },
  );
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancellationError(signal.reason);
}

function safeMessageFor(code: ReadFileErrorCode): string {
  switch (code) {
    case "PILOT_READ_FILE_BINARY":
      return "The requested file appears to be binary";
    case "PILOT_READ_FILE_INVALID_ENCODING":
      return "The requested file is not valid UTF-8";
    case "PILOT_READ_FILE_INVALID_RANGE":
      return "The requested line range is outside the file";
    case "PILOT_READ_FILE_INVALID_TARGET":
      return "The requested path is not a regular workspace file";
    case "PILOT_READ_FILE_TOO_LARGE":
      return "The requested file exceeds the configured read limit";
    default:
      return "The requested workspace file could not be read";
  }
}
