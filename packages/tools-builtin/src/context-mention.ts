import { open, stat } from "node:fs/promises";
import { CancellationError, type WorkspaceBoundary } from "@pilotrun/core";
import { loadRepositoryIgnoreRules, type RepositoryIgnoreRules } from "./ignore-rules.js";
import { WorkspacePathError } from "./workspace-boundary.js";

/**
 * A single `@` mention parsed out of a composer submission, before it is
 * resolved against the workspace.
 */
export interface ParsedMention {
  /** The verbatim token as typed, e.g. `@src/foo.ts` or `@"a b.ts"`. */
  readonly raw: string;
  /** The path portion with any surrounding quotes and the leading `@` removed. */
  readonly path: string;
}

/** Why a mention was not turned into attached context. */
export type MentionSkipReason =
  | "ignored"
  | "not-found"
  | "outside-workspace"
  | "not-a-file"
  | "budget-exceeded"
  | "unreadable";

export interface MentionAttachment {
  /** The verbatim token as typed. */
  readonly raw: string;
  /** Workspace-relative POSIX path that was read. */
  readonly path: string;
  /** Number of content bytes included (after any truncation). */
  readonly bytes: number;
  /** True when the file was larger than the byte budget and was cut short. */
  readonly truncated: boolean;
  /** Decoded UTF-8 file content included as context. */
  readonly content: string;
}

export interface SkippedMention {
  /** The verbatim token as typed. */
  readonly raw: string;
  /** Best-effort workspace-relative path (falls back to the typed path). */
  readonly path: string;
  readonly reason: MentionSkipReason;
  /**
   * For `ignored`, the ignore source that matched (e.g. `.gitignore`). For
   * other reasons this is omitted.
   */
  readonly detail?: string;
}

export interface ContextMentionResolution {
  /** Original text with a trailing `<context>` section per attached file. */
  readonly augmentedText: string;
  readonly attachments: readonly MentionAttachment[];
  /** Mentions that were not attached, including every ignore-blocked file. */
  readonly skipped: readonly SkippedMention[];
}

export interface ResolveContextMentionsOptions {
  readonly text: string;
  readonly boundary: WorkspaceBoundary;
  /**
   * Pre-loaded ignore rules. When omitted they are loaded from the workspace so
   * `.gitignore`, `.ignore`, `.pilotignore`, and the protected builtins are all
   * honoured. Reusing a pre-loaded instance avoids re-reading the ignore files
   * on every turn.
   */
  readonly ignoreRules?: RepositoryIgnoreRules;
  /** Maximum bytes read from any single file. Defaults to 64 KiB. */
  readonly maxFileBytes?: number;
  /** Maximum total bytes across all attachments. Defaults to 256 KiB. */
  readonly maxTotalBytes?: number;
  /** Maximum number of files attached in one turn. Defaults to 20. */
  readonly maxFiles?: number;
  /** Size limit for each ignore file when loading rules. Defaults to 256 KiB. */
  readonly maxIgnoreFileBytes?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_MAX_FILE_BYTES = 65_536;
const DEFAULT_MAX_TOTAL_BYTES = 262_144;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_IGNORE_FILE_BYTES = 262_144;
const READ_CHUNK_BYTES = 65_536;

// `@` must sit at a token boundary (start of input or after whitespace) so that
// email addresses such as `name@example.com` are never treated as mentions.
// It is followed by either a double-quoted path (which may contain spaces) or an
// unquoted run of non-whitespace characters.
const MENTION_PATTERN = /(?<=^|\s)@(?:"([^"\n]+)"|([^\s"]+))/gu;

// Trailing characters that are almost always sentence punctuation rather than
// part of a filename, and are trimmed from unquoted mentions. A trailing `.` is
// intentionally preserved because it is common in real filenames.
const TRAILING_PUNCTUATION = /[,;:!?)\]}>'"]+$/u;

/**
 * Extracts `@` mentions from composer text. Quoted mentions (`@"a b.ts"`)
 * preserve spaces; unquoted mentions have trailing sentence punctuation trimmed.
 */
export function parseMentions(text: string): readonly ParsedMention[] {
  const mentions: ParsedMention[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const quoted = match[1];
    if (quoted !== undefined) {
      mentions.push(Object.freeze({ raw: match[0], path: quoted }));
      continue;
    }
    const rawPath = match[2] ?? "";
    const trimmed = rawPath.replace(TRAILING_PUNCTUATION, "");
    if (trimmed.length === 0) {
      continue;
    }
    const raw = trimmed === rawPath ? match[0] : `@${trimmed}`;
    mentions.push(Object.freeze({ raw, path: trimmed }));
  }
  return Object.freeze(mentions);
}

/**
 * Resolves `@` mentions in composer text into attached file context.
 *
 * Every resolved path is checked against the workspace ignore rules *before* it
 * is read, so files hidden by `.gitignore`, `.ignore`, `.pilotignore`, or the
 * protected builtins (for example a `.env` file) are reported as skipped and
 * their contents are never loaded. Paths that escape the workspace boundary are
 * likewise refused.
 */
export async function resolveContextMentions(
  options: ResolveContextMentionsOptions,
): Promise<ContextMentionResolution> {
  const mentions = parseMentions(options.text);
  if (mentions.length === 0) {
    return Object.freeze({ augmentedText: options.text, attachments: [], skipped: [] });
  }

  throwIfAborted(options.signal);
  const ignoreRules =
    options.ignoreRules ??
    (await loadRepositoryIgnoreRules(options.boundary, {
      maxIgnoreFileBytes: options.maxIgnoreFileBytes ?? DEFAULT_MAX_IGNORE_FILE_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }));

  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  const attachments: MentionAttachment[] = [];
  const skipped: SkippedMention[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const mention of mentions) {
    throwIfAborted(options.signal);

    const resolved = await resolveMentionPath(options.boundary, mention, skipped);
    if (resolved === undefined) {
      continue;
    }
    const relativePath = resolved.relativePath;
    if (seen.has(relativePath)) {
      continue;
    }

    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(resolved.realPath ?? resolved.absolutePath);
    } catch {
      skipped.push(Object.freeze({ raw: mention.raw, path: relativePath, reason: "not-found" }));
      continue;
    }

    const decision = ignoreRules.evaluate(relativePath, stats.isDirectory());
    if (decision.ignored) {
      // Security gate: an ignored path is never read.
      skipped.push(
        Object.freeze({
          raw: mention.raw,
          path: relativePath,
          reason: "ignored",
          ...(decision.source === undefined ? {} : { detail: decision.source }),
        }),
      );
      continue;
    }

    if (!stats.isFile()) {
      skipped.push(Object.freeze({ raw: mention.raw, path: relativePath, reason: "not-a-file" }));
      continue;
    }

    const remaining = maxTotalBytes - totalBytes;
    if (attachments.length >= maxFiles || remaining <= 0) {
      skipped.push(
        Object.freeze({ raw: mention.raw, path: relativePath, reason: "budget-exceeded" }),
      );
      continue;
    }

    const limit = Math.min(maxFileBytes, remaining);
    let read: { readonly content: string; readonly bytes: number; readonly truncated: boolean };
    try {
      read = await readBounded(
        resolved.realPath ?? resolved.absolutePath,
        limit,
        stats.size,
        options.signal,
      );
    } catch (error) {
      if (error instanceof CancellationError) {
        throw error;
      }
      skipped.push(Object.freeze({ raw: mention.raw, path: relativePath, reason: "unreadable" }));
      continue;
    }

    seen.add(relativePath);
    totalBytes += read.bytes;
    attachments.push(
      Object.freeze({
        raw: mention.raw,
        path: relativePath,
        bytes: read.bytes,
        truncated: read.truncated,
        content: read.content,
      }),
    );
  }

  return Object.freeze({
    augmentedText: buildAugmentedText(options.text, attachments),
    attachments: Object.freeze(attachments),
    skipped: Object.freeze(skipped),
  });
}

async function resolveMentionPath(
  boundary: WorkspaceBoundary,
  mention: ParsedMention,
  skipped: SkippedMention[],
): Promise<
  | { readonly relativePath: string; readonly absolutePath: string; readonly realPath?: string }
  | undefined
> {
  try {
    return await boundary.resolve(mention.path, "read");
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      const reason: MentionSkipReason =
        error.code === "PILOT_WORKSPACE_PATH_ESCAPE"
          ? "outside-workspace"
          : error.code === "PILOT_WORKSPACE_PATH_NOT_FOUND"
            ? "not-found"
            : "unreadable";
      skipped.push(Object.freeze({ raw: mention.raw, path: mention.path, reason }));
      return undefined;
    }
    throw error;
  }
}

async function readBounded(
  absolutePath: string,
  limit: number,
  size: number,
  signal: AbortSignal | undefined,
): Promise<{ readonly content: string; readonly bytes: number; readonly truncated: boolean }> {
  const handle = await open(absolutePath, "r");
  try {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead < limit) {
      throwIfAborted(signal);
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit - bytesRead));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) {
        break;
      }
      chunks.push(buffer.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
    }
    const content = Buffer.concat(chunks).toString("utf8");
    return { content, bytes: bytesRead, truncated: size > bytesRead };
  } finally {
    await handle.close();
  }
}

function buildAugmentedText(text: string, attachments: readonly MentionAttachment[]): string {
  if (attachments.length === 0) {
    return text;
  }
  const blocks = attachments
    .map((attachment) => {
      const truncatedAttribute = attachment.truncated ? ' truncated="true"' : "";
      return `<context path="${escapeAttribute(attachment.path)}"${truncatedAttribute}>\n${attachment.content}\n</context>`;
    })
    .join("\n\n");
  return `${text}\n\nThe user referenced these file(s) with @ mentions; their contents are included below as context.\n\n${blocks}`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CancellationError(signal.reason);
  }
}
