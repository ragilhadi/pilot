import { createHash } from "node:crypto";
import path from "node:path";
import { PilotError, type PilotErrorCode } from "@pilot/core";

const maximumPatchBytes = 1_000_000;
const maximumHunks = 1_000;
const maximumPatchLines = 100_000;

export type PatchLineKind = "add" | "context" | "delete";
export type PatchLineEnding = "cr" | "crlf" | "lf" | "mixed" | "none";

export interface UnifiedPatchLine {
  readonly kind: PatchLineKind;
  readonly text: string;
  readonly noNewlineAtEnd: boolean;
}

export interface UnifiedPatchHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly section: string;
  readonly lines: readonly UnifiedPatchLine[];
}

export interface UnifiedPatch {
  readonly path: string;
  readonly oldPath: string;
  readonly newPath: string;
  readonly hunks: readonly UnifiedPatchHunk[];
  readonly additions: number;
  readonly deletions: number;
  readonly diff: string;
}

export interface ApplyUnifiedPatchInput {
  readonly patch: string | UnifiedPatch;
  readonly originalContent: string;
  readonly baseSha256: string;
}

export interface UnifiedPatchPreview {
  readonly path: string;
  readonly diff: string;
  readonly hunks: number;
  readonly additions: number;
  readonly deletions: number;
  readonly originalSha256: string;
  readonly resultingSha256: string;
}

export interface AppliedUnifiedPatch {
  readonly content: string;
  readonly originalSha256: string;
  readonly resultingSha256: string;
  readonly originalLineEnding: PatchLineEnding;
  readonly resultingLineEnding: PatchLineEnding;
  readonly lineEndingsPreserved: boolean;
  readonly preview: UnifiedPatchPreview;
}

type PatchErrorCode = Extract<
  PilotErrorCode,
  | "PILOT_PATCH_BASE_MISMATCH"
  | "PILOT_PATCH_HUNK_CONFLICT"
  | "PILOT_PATCH_INVALID"
  | "PILOT_PATCH_UNSUPPORTED"
>;

export class UnifiedPatchError extends PilotError {
  constructor(
    code: PatchErrorCode,
    message: string,
    metadata: Readonly<Record<string, unknown>> = {},
    safeMessage?: string,
  ) {
    super({
      code,
      message,
      safeMessage: safeMessage ?? safeMessageFor(code),
      metadata,
    });
  }
}

/** Parses the supported single-file, modification-only unified diff format. */
export function parseUnifiedPatch(input: string): UnifiedPatch {
  const sizeBytes = Buffer.byteLength(input, "utf8");
  if (sizeBytes === 0 || sizeBytes > maximumPatchBytes || input.includes("\0")) {
    throw invalidPatch("Patch input is empty, oversized, or contains a null byte", { sizeBytes });
  }
  const normalized = input.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) {
    throw invalidPatch("Patch control lines must use LF or CRLF line endings");
  }
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > maximumPatchLines) {
    throw invalidPatch("Patch exceeds the line limit", { lineCount: lines.length });
  }
  if (lines.length < 3 || !lines[0]?.startsWith("--- ") || !lines[1]?.startsWith("+++ ")) {
    throw invalidPatch("Patch must begin with --- and +++ file headers");
  }

  const oldPath = parseHeaderPath(lines[0].slice(4), "old");
  const newPath = parseHeaderPath(lines[1].slice(4), "new");
  if (oldPath === "/dev/null" || newPath === "/dev/null") {
    throw unsupportedPatch(
      "File creation and deletion are not supported",
      { oldPath, newPath },
      "apply_patch only modifies an existing UTF-8 file; it cannot create or delete files. " +
        "To add this file, ask the user to create it first (an empty file is fine), then submit " +
        "a normal patch against that existing, empty file.",
    );
  }
  const portableOldPath = normalizePatchPath(oldPath);
  const portableNewPath = normalizePatchPath(newPath);
  if (portableOldPath !== portableNewPath) {
    throw unsupportedPatch("File renames are not supported", {
      oldPath: portableOldPath,
      newPath: portableNewPath,
    });
  }

  const hunks: UnifiedPatchHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let index = 2;
  while (index < lines.length) {
    const header = lines[index];
    if (header?.startsWith("--- ") || header?.startsWith("+++ ")) {
      throw unsupportedPatch("Multi-file patches are not supported");
    }
    const match = header?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/u);
    if (match === null || match === undefined) {
      throw invalidPatch("Expected a valid unified diff hunk header", {
        patchLine: index + 1,
      });
    }
    if (hunks.length >= maximumHunks) {
      throw invalidPatch("Patch exceeds the hunk limit", { maximumHunks });
    }
    const oldStart = parseCoordinate(match[1], "old start", index + 1);
    const oldCount = parseCoordinate(match[2] ?? "1", "old count", index + 1);
    const newStart = parseCoordinate(match[3], "new start", index + 1);
    const newCount = parseCoordinate(match[4] ?? "1", "new count", index + 1);
    if ((oldCount > 0 && oldStart === 0) || (newCount > 0 && newStart === 0)) {
      throw invalidPatch("Non-empty hunk ranges must begin at line 1 or later", {
        patchLine: index + 1,
      });
    }
    index += 1;
    const hunkLines: MutablePatchLine[] = [];
    while (index < lines.length && !lines[index]?.startsWith("@@ ")) {
      const line = lines[index] ?? "";
      if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        throw unsupportedPatch("Multi-file patches are not supported");
      }
      if (line === "\\ No newline at end of file") {
        const previous = hunkLines.at(-1);
        if (previous === undefined || previous.noNewlineAtEnd) {
          throw invalidPatch("No-newline marker has no preceding patch line", {
            patchLine: index + 1,
          });
        }
        previous.noNewlineAtEnd = true;
        index += 1;
        continue;
      }
      const prefix = line[0];
      const kind =
        prefix === " " ? "context" : prefix === "+" ? "add" : prefix === "-" ? "delete" : undefined;
      if (kind === undefined) {
        throw invalidPatch("Hunk lines must begin with space, +, or -", {
          patchLine: index + 1,
        });
      }
      hunkLines.push({ kind, text: line.slice(1), noNewlineAtEnd: false });
      if (kind === "add") additions += 1;
      if (kind === "delete") deletions += 1;
      index += 1;
    }
    const observedOldCount = hunkLines.filter(({ kind }) => kind !== "add").length;
    const observedNewCount = hunkLines.filter(({ kind }) => kind !== "delete").length;
    if (observedOldCount !== oldCount || observedNewCount !== newCount) {
      throw invalidPatch("Hunk line counts do not match its header", {
        hunk: hunks.length + 1,
        oldCount,
        observedOldCount,
        newCount,
        observedNewCount,
      });
    }
    hunks.push(
      Object.freeze({
        oldStart,
        oldCount,
        newStart,
        newCount,
        section: match[5] ?? "",
        lines: Object.freeze(hunkLines.map((line) => Object.freeze({ ...line }))),
      }),
    );
  }
  if (hunks.length === 0) throw invalidPatch("Patch must contain at least one hunk");
  validateNoNewlineMarkers(hunks);

  return Object.freeze({
    path: portableOldPath,
    oldPath: portableOldPath,
    newPath: portableNewPath,
    hunks: Object.freeze(hunks),
    additions,
    deletions,
    diff: normalized.endsWith("\n") ? normalized : `${normalized}\n`,
  });
}

/** Applies a parsed patch to in-memory UTF-8 content after optimistic-concurrency validation. */
export function applyUnifiedPatchToContent(input: ApplyUnifiedPatchInput): AppliedUnifiedPatch {
  if (!/^[a-f0-9]{64}$/u.test(input.baseSha256)) {
    throw invalidPatch("baseSha256 must be a lowercase SHA-256 digest");
  }
  const originalSha256 = sha256(input.originalContent);
  if (originalSha256 !== input.baseSha256) {
    throw new UnifiedPatchError(
      "PILOT_PATCH_BASE_MISMATCH",
      "The file content changed after the patch base was read",
      { expectedSha256: input.baseSha256, actualSha256: originalSha256 },
    );
  }
  const patch = parseUnifiedPatch(typeof input.patch === "string" ? input.patch : input.patch.diff);
  const original = splitContent(input.originalContent);
  const preferredEnding = preferredLineEnding(original.lines);
  const output: ContentLine[] = [];
  let sourceIndex = 0;

  for (const [hunkIndex, hunk] of patch.hunks.entries()) {
    const hunkSourceIndex = coordinateIndex(hunk.oldStart, hunk.oldCount);
    const hunkOutputIndex = coordinateIndex(hunk.newStart, hunk.newCount);
    if (hunkSourceIndex < sourceIndex || hunkSourceIndex > original.lines.length) {
      throw hunkConflict("Hunks overlap or reference a line outside the original file", hunkIndex, {
        oldStart: hunk.oldStart,
      });
    }
    output.push(...original.lines.slice(sourceIndex, hunkSourceIndex));
    sourceIndex = hunkSourceIndex;
    if (output.length !== hunkOutputIndex) {
      throw hunkConflict("The hunk's new-file coordinate is inconsistent", hunkIndex, {
        newStart: hunk.newStart,
        expectedNewStart: output.length + 1,
      });
    }

    for (const [lineIndex, line] of hunk.lines.entries()) {
      if (line.kind === "add") {
        output.push({ text: line.text, ending: line.noNewlineAtEnd ? "" : preferredEnding });
        continue;
      }
      const source = original.lines[sourceIndex];
      if (source === undefined || source.text !== line.text) {
        throw hunkConflict("Patch context does not match the original file", hunkIndex, {
          hunkLine: lineIndex + 1,
          originalLine: sourceIndex + 1,
        });
      }
      if (line.noNewlineAtEnd && source.ending !== "") {
        throw hunkConflict(
          "Patch expected the original line to have no terminating newline",
          hunkIndex,
          {
            hunkLine: lineIndex + 1,
            originalLine: sourceIndex + 1,
          },
        );
      }
      if (line.kind === "context") output.push(source);
      sourceIndex += 1;
    }
  }
  output.push(...original.lines.slice(sourceIndex));
  const content = `${original.bom}${output.map(({ text, ending }) => `${text}${ending}`).join("")}`;
  const resultingSha256 = sha256(content);
  const originalLineEnding = detectLineEnding(original.lines);
  const resultingLineEnding = detectLineEnding(output);
  return Object.freeze({
    content,
    originalSha256,
    resultingSha256,
    originalLineEnding,
    resultingLineEnding,
    lineEndingsPreserved:
      originalLineEnding === "none" ||
      originalLineEnding === "mixed" ||
      resultingLineEnding === originalLineEnding,
    preview: Object.freeze({
      path: patch.path,
      diff: patch.diff,
      hunks: patch.hunks.length,
      additions: patch.additions,
      deletions: patch.deletions,
      originalSha256,
      resultingSha256,
    }),
  });
}

interface MutablePatchLine {
  kind: PatchLineKind;
  text: string;
  noNewlineAtEnd: boolean;
}

interface ContentLine {
  readonly text: string;
  readonly ending: "" | "\r" | "\r\n" | "\n";
}

function splitContent(content: string): {
  readonly bom: string;
  readonly lines: readonly ContentLine[];
} {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom === "" ? content : content.slice(1);
  const lines: ContentLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\r" && text[index] !== "\n") continue;
    const ending =
      text[index] === "\r" && text[index + 1] === "\n" ? "\r\n" : (text[index] as "\r" | "\n");
    lines.push({ text: text.slice(start, index), ending });
    if (ending === "\r\n") index += 1;
    start = index + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), ending: "" });
  return Object.freeze({ bom, lines: Object.freeze(lines) });
}

function preferredLineEnding(lines: readonly ContentLine[]): "\r" | "\r\n" | "\n" {
  const counts = new Map<string, number>([
    ["\n", 0],
    ["\r\n", 0],
    ["\r", 0],
  ]);
  for (const { ending } of lines)
    if (ending !== "") counts.set(ending, (counts.get(ending) ?? 0) + 1);
  let selected: "\r" | "\r\n" | "\n" = "\n";
  for (const candidate of ["\r\n", "\r"] as const) {
    if ((counts.get(candidate) ?? 0) > (counts.get(selected) ?? 0)) selected = candidate;
  }
  return selected;
}

function detectLineEnding(lines: readonly ContentLine[]): PatchLineEnding {
  const endings = new Set(lines.map(({ ending }) => ending).filter((ending) => ending !== ""));
  if (endings.size === 0) return "none";
  if (endings.size > 1) return "mixed";
  const ending = [...endings][0];
  return ending === "\r\n" ? "crlf" : ending === "\r" ? "cr" : "lf";
}

function parseHeaderPath(header: string, side: "new" | "old"): string {
  const candidate = header.split("\t", 1)[0]?.trim() ?? "";
  if (candidate.length === 0) throw invalidPatch(`${side} file header has no path`);
  if (candidate.startsWith('"')) {
    throw unsupportedPatch("Quoted patch paths are not supported", { side });
  }
  return candidate;
}

function normalizePatchPath(input: string): string {
  const stripped = input.startsWith("a/") || input.startsWith("b/") ? input.slice(2) : input;
  if (
    stripped.length === 0 ||
    stripped.includes("\\") ||
    path.posix.isAbsolute(stripped) ||
    path.win32.isAbsolute(stripped) ||
    /^[a-z]:/iu.test(stripped)
  ) {
    throw invalidPatch("Patch paths must be portable workspace-relative paths", { path: input });
  }
  const normalized = path.posix.normalize(stripped);
  if (normalized === ".." || normalized.startsWith("../") || normalized !== stripped) {
    throw invalidPatch("Patch path traversal or normalization is not allowed", { path: input });
  }
  return normalized;
}

function parseCoordinate(value: string | undefined, name: string, patchLine: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalidPatch(`Hunk ${name} is invalid`, { patchLine });
  }
  return parsed;
}

function coordinateIndex(start: number, count: number): number {
  return count === 0 ? start : start - 1;
}

function validateNoNewlineMarkers(hunks: readonly UnifiedPatchHunk[]): void {
  const lines = hunks.flatMap(({ lines }) => lines);
  for (const side of ["old", "new"] as const) {
    let terminalMarkerSeen = false;
    for (const line of lines) {
      const belongsToSide = side === "old" ? line.kind !== "add" : line.kind !== "delete";
      if (!belongsToSide) continue;
      if (terminalMarkerSeen) {
        throw invalidPatch("A no-newline marker must describe the terminal line", { side });
      }
      if (line.noNewlineAtEnd) terminalMarkerSeen = true;
    }
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

function invalidPatch(message: string, metadata: Readonly<Record<string, unknown>> = {}) {
  return new UnifiedPatchError("PILOT_PATCH_INVALID", message, metadata);
}

function unsupportedPatch(
  message: string,
  metadata: Readonly<Record<string, unknown>> = {},
  safeMessage?: string,
) {
  return new UnifiedPatchError("PILOT_PATCH_UNSUPPORTED", message, metadata, safeMessage);
}

function hunkConflict(
  message: string,
  zeroBasedHunk: number,
  metadata: Readonly<Record<string, unknown>>,
) {
  return new UnifiedPatchError("PILOT_PATCH_HUNK_CONFLICT", message, {
    hunk: zeroBasedHunk + 1,
    ...metadata,
  });
}

function safeMessageFor(code: PatchErrorCode): string {
  switch (code) {
    case "PILOT_PATCH_BASE_MISMATCH":
      return "The target file changed after it was read";
    case "PILOT_PATCH_HUNK_CONFLICT":
      return "The patch no longer matches the target file";
    case "PILOT_PATCH_UNSUPPORTED":
      return "The patch uses an unsupported operation";
    default:
      return "The patch is invalid";
  }
}
