import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@pilotrun/core";
import * as z from "zod";
import type { ChangeJournal } from "./change-journal.js";
import type { WorkspaceFileSystem } from "./workspace-file-system.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

/** SHA-256 of the empty string; the "before" state of any newly created file. */
const emptyContentSha256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

export const WriteFileInputSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    content: z.string().max(1_000_000),
  })
  .strict()
  .readonly();

export const WriteFileOutputSchema = z
  .object({
    path: z.string().min(1),
    sha256: sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
    lineCount: z.number().int().nonnegative(),
    journalSequence: z.number().int().positive(),
  })
  .strict()
  .readonly();

export type WriteFileInput = z.output<typeof WriteFileInputSchema>;
export type WriteFileOutput = z.output<typeof WriteFileOutputSchema>;

export function createWriteFileTool(
  fileSystem: WorkspaceFileSystem,
  journal: ChangeJournal,
): ToolDefinition<typeof WriteFileInputSchema, typeof WriteFileOutputSchema> {
  return defineTool({
    name: "write_file",
    description:
      "Create one new UTF-8 workspace file with the given content. Fails if the file already exists; use apply_patch to modify an existing file.",
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
      const created = await fileSystem.createUtf8({
        path: input.path,
        content: input.content,
        signal: context.signal,
      });
      const lineCount = countLines(input.content);
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
          journalSequence: entry.sequence,
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
    },
  });
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r\n|\r|\n/u).length;
}
