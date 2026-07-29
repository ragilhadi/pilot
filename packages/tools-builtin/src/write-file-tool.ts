import { createHash } from "node:crypto";
import { defineTool, PilotError, type ToolDefinition } from "@pilotrun/core";
import * as z from "zod";
import type { ChangeJournal } from "./change-journal.js";
import type { WorkspaceFileSystem } from "./workspace-file-system.js";
import {
  collectDiagnostics,
  DiagnosticsReportSchema,
  type DiagnosticsCollectorOptions,
} from "./diagnostics-reporting.js";


const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

/** SHA-256 of the empty string; the "before" state of any newly created file. */
const emptyContentSha256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

export const WriteFileInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4_096)
      .describe(
        'Workspace-relative path to write, for example "src/new-module.ts". Parent directories ' +
          "must already exist.",
      ),
    content: z.string().max(1_000_000).describe("The complete contents of the file."),
    baseSha256: sha256Schema
      .optional()
      .describe(
        "Omit to create a new file; the call fails if the path already exists. To replace an " +
          "existing file's entire contents, pass the sha256 from a read_file of that file.",
      ),
  })
  .strict()
  .readonly();

export const WriteFileOutputSchema = z
  .object({
    path: z.string().min(1),
    sha256: sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
    lineCount: z.number().int().nonnegative(),
    created: z.boolean(),
    journalSequence: z.number().int().positive(),
    diagnostics: DiagnosticsReportSchema.optional(),
  })
  .strict()
  .readonly();

export type WriteFileInput = z.output<typeof WriteFileInputSchema>;
export type WriteFileOutput = z.output<typeof WriteFileOutputSchema>;

export function createWriteFileTool(
  fileSystem: WorkspaceFileSystem,
  journal: ChangeJournal,
  options: DiagnosticsCollectorOptions = {},
): ToolDefinition<typeof WriteFileInputSchema, typeof WriteFileOutputSchema> {
  return defineTool({
    name: "write_file",
    description:
      "Create a new text file, or replace an existing file's entire contents.\n\n" +
      "Use this only for new files. To change part of an existing file use edit (single localized " +
      "change) or apply_patch (several changes at once) — rewriting a whole file to alter a few " +
      "lines risks discarding content you have not read.\n\n" +
      "Without baseSha256 this creates a new file and fails if the path already exists. To " +
      "deliberately overwrite an existing file, read it first and pass its sha256 as baseSha256.\n\n" +
      'Example: {"path": "src/new-module.ts", "content": "export const value = 1;\\n"}',
    inputSchema: WriteFileInputSchema,
    outputSchema: WriteFileOutputSchema,
    metadata: {
      risk: "workspace-write",
      concurrency: "exclusive",
      timeoutMs: 15_000,
      maxOutputBytes: 1_500_000,
      requiredPermissions: ["workspace.write"],
    },
    execute: async (input, context) => {
      const lineCount = countLines(input.content);
      if (input.baseSha256 === undefined) {
        const created = await fileSystem.createUtf8({
          path: input.path,
          content: input.content,
          signal: context.signal,
        });
        const diagnostics = await collectDiagnostics(
          options.port,
          created.path,
          input.content,
          context.signal,
        );
        const entry = journal.recordApplied({
          runId: context.runId,
          callId: context.callId,
          path: created.path,
          beforeSha256: emptyContentSha256,
          afterSha256: created.sha256,
          additions: lineCount,
          deletions: 0,
          originalContent: "",
        });
        return {
          output: Object.freeze({
            path: created.path,
            sha256: created.sha256,
            sizeBytes: created.sizeBytes,
            lineCount,
            created: true,
            journalSequence: entry.sequence,
            ...(diagnostics === undefined ? {} : { diagnostics }),
          }),
          metadata: {
            changed: true,
            created: true,
            sourcePath: created.path,
            beforeSha256: emptyContentSha256,
            afterSha256: created.sha256,
            journalSequence: entry.sequence,
          },
        };
      }

      const original = await fileSystem.readUtf8(input.path, context.signal);
      assertBaseMatches(input.baseSha256, original.sha256, original.path);
      const replacement = await fileSystem.replaceUtf8Atomic({
        path: input.path,
        expectedSha256: input.baseSha256,
        content: input.content,
        signal: context.signal,
      });
      const diagnostics = await collectDiagnostics(
        options.port,
        replacement.path,
        input.content,
        context.signal,
      );
      const entry = journal.recordApplied({
        runId: context.runId,
        callId: context.callId,
        path: replacement.path,
        beforeSha256: replacement.beforeSha256,
        afterSha256: replacement.afterSha256,
        additions: lineCount,
        deletions: countLines(original.content),
        originalContent: original.content,
      });
      return {
        output: Object.freeze({
          path: replacement.path,
          sha256: replacement.afterSha256,
          sizeBytes: replacement.sizeBytes,
          lineCount,
          created: false,
          journalSequence: entry.sequence,
          ...(diagnostics === undefined ? {} : { diagnostics }),
        }),
        metadata: {
          changed: true,
          created: false,
          sourcePath: replacement.path,
          beforeSha256: replacement.beforeSha256,
          afterSha256: replacement.afterSha256,
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
      message: "The overwrite target changed before it could be replaced",
      safeMessage: "The target file changed after it was read",
      metadata: { path, expectedSha256: expected, actualSha256: actual },
    });
  }
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r\n|\r|\n/u).length;
}
