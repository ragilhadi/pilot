import { defineTool, PilotError, type ToolDefinition } from "@pilotrun/core";
import * as z from "zod";
import type { ChangeJournal } from "./change-journal.js";
import type { WorkspaceFileSystem } from "./workspace-file-system.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const EditFileInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4_096)
      .describe('Workspace-relative path to the file to change, for example "src/index.ts".'),
    baseSha256: sha256Schema.describe(
      "The sha256 value from the read_file result for this exact file. Read the file first and " +
        "copy its sha256 here; the edit is rejected if the file changed since that read.",
    ),
    oldString: z
      .string()
      .min(1)
      .max(1_000_000)
      .describe(
        "The exact text to replace, copied verbatim from the file including indentation and " +
          "newlines. It must appear exactly once unless replaceAll is true — include a few " +
          "surrounding lines to make it unique.",
      ),
    newString: z
      .string()
      .max(1_000_000)
      .describe(
        "The replacement text. Pass an empty string to delete the matched text. Must differ from " +
          "oldString.",
      ),
    replaceAll: z
      .boolean()
      .default(false)
      .describe(
        "Replace every occurrence instead of requiring a unique match. Use for renaming a symbol " +
          "throughout a file.",
      ),
  })
  .strict()
  .refine(
    ({ oldString, newString }) => oldString !== newString,
    "oldString and newString must differ",
  )
  .readonly();

export const EditFileOutputSchema = z
  .object({
    path: z.string().min(1),
    beforeSha256: sha256Schema,
    afterSha256: sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
    replacements: z.number().int().positive(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    journalSequence: z.number().int().positive(),
  })
  .strict()
  .readonly();

export type EditFileInput = z.output<typeof EditFileInputSchema>;
export type EditFileOutput = z.output<typeof EditFileOutputSchema>;

type EditErrorCode = "PILOT_EDIT_STRING_NOT_FOUND" | "PILOT_EDIT_STRING_NOT_UNIQUE";

export class EditFileToolError extends PilotError {
  constructor(code: EditErrorCode, message: string, metadata: Readonly<Record<string, unknown>>) {
    super({
      code,
      message,
      safeMessage:
        code === "PILOT_EDIT_STRING_NOT_FOUND"
          ? "The text to replace was not found in the file"
          : "The text to replace is not unique; pass replaceAll or include more surrounding context",
      metadata,
    });
  }
}

export function createEditFileTool(
  fileSystem: WorkspaceFileSystem,
  journal: ChangeJournal,
): ToolDefinition<typeof EditFileInputSchema, typeof EditFileOutputSchema> {
  return defineTool({
    name: "edit",
    description:
      "Change part of an existing text file by replacing an exact string.\n\n" +
      "This is the preferred way to modify a file. Prefer it over apply_patch for a single " +
      "localized change, and over write_file for anything other than creating a new file.\n\n" +
      "Workflow: call read_file first, copy its sha256 into baseSha256, then pass the exact text " +
      "to replace as oldString. Copy oldString verbatim from what read_file returned, including " +
      "indentation. If the tool reports the text is not unique, include more surrounding lines " +
      "rather than retrying the same call.\n\n" +
      'Example: {"path": "src/config.ts", "baseSha256": "<sha256 from read_file>", ' +
      '"oldString": "  port: 3000,", "newString": "  port: 8080,"}',
    inputSchema: EditFileInputSchema,
    outputSchema: EditFileOutputSchema,
    metadata: {
      risk: "workspace-write",
      concurrency: "exclusive",
      timeoutMs: 15_000,
      maxOutputBytes: 1_500_000,
      requiredPermissions: ["workspace.write"],
    },
    execute: async (input, context) => {
      const original = await fileSystem.readUtf8(input.path, context.signal);
      assertBaseMatches(input.baseSha256, original.sha256, original.path);
      const occurrences = countOccurrences(original.content, input.oldString);
      if (occurrences === 0) {
        throw new EditFileToolError("PILOT_EDIT_STRING_NOT_FOUND", "oldString was not found", {
          path: original.path,
        });
      }
      if (occurrences > 1 && !input.replaceAll) {
        throw new EditFileToolError(
          "PILOT_EDIT_STRING_NOT_UNIQUE",
          `oldString matched ${occurrences} times but replaceAll is false`,
          { path: original.path, occurrences },
        );
      }
      const replacements = input.replaceAll ? occurrences : 1;
      const content = replaceStrings(
        original.content,
        input.oldString,
        input.newString,
        input.replaceAll,
      );
      const replacement = await fileSystem.replaceUtf8Atomic({
        path: input.path,
        expectedSha256: input.baseSha256,
        content,
        signal: context.signal,
      });
      const diff = computeLineDiff(original.content, content);
      const entry = journal.recordApplied({
        runId: context.runId,
        callId: context.callId,
        path: replacement.path,
        beforeSha256: replacement.beforeSha256,
        afterSha256: replacement.afterSha256,
        additions: diff.additions,
        deletions: diff.deletions,
        originalContent: original.content,
      });
      return {
        output: Object.freeze({
          path: replacement.path,
          beforeSha256: replacement.beforeSha256,
          afterSha256: replacement.afterSha256,
          sizeBytes: replacement.sizeBytes,
          replacements,
          additions: diff.additions,
          deletions: diff.deletions,
          journalSequence: entry.sequence,
        }),
        metadata: {
          changed: true,
          sourcePath: replacement.path,
          beforeSha256: replacement.beforeSha256,
          afterSha256: replacement.afterSha256,
          replacements,
          journalSequence: entry.sequence,
        },
      };
    },
  });
}

function assertBaseMatches(expected: string, actual: string, path: string): void {
  if (expected !== actual) {
    throw new PilotError({
      code: "PILOT_PATCH_BASE_MISMATCH",
      message: "The edit target changed before it could be modified",
      safeMessage: "The target file changed after it was read",
      metadata: { path, expectedSha256: expected, actualSha256: actual },
    });
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function replaceStrings(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  if (!replaceAll) {
    const index = content.indexOf(oldString);
    return content.slice(0, index) + newString + content.slice(index + oldString.length);
  }
  return content.split(oldString).join(newString);
}

/**
 * Line-level additions/deletions after trimming the common prefix and suffix.
 * Exact for a single contiguous edit region; for scattered replaceAll edits it
 * reports the enclosing changed span, which is a safe upper bound.
 */
function computeLineDiff(
  original: string,
  updated: string,
): { readonly additions: number; readonly deletions: number } {
  if (original === updated) return { additions: 0, deletions: 0 };
  const before = original.split(/\r\n|\r|\n/u);
  const after = updated.split(/\r\n|\r|\n/u);
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = Math.min(before.length, after.length) - prefix;
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    deletions: before.length - prefix - suffix,
    additions: after.length - prefix - suffix,
  };
}
