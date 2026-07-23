import { defineTool, type ToolDefinition } from "@pilotrun/core";
import * as z from "zod";
import type { ChangeJournal } from "./change-journal.js";
import {
  applyUnifiedPatchToContent,
  parseUnifiedPatch,
  UnifiedPatchError,
} from "./unified-patch.js";
import type { WorkspaceFileSystem } from "./workspace-file-system.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const ApplyPatchInputSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    baseSha256: sha256Schema,
    patch: z.string().min(1).max(200_000),
  })
  .strict()
  .readonly();

export const ApplyPatchPreviewSchema = z
  .object({
    path: z.string().min(1),
    diff: z.string().min(1),
    hunks: z.number().int().positive(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    originalSha256: sha256Schema,
    resultingSha256: sha256Schema,
  })
  .strict()
  .readonly();

export const ApplyPatchOutputSchema = z
  .object({
    path: z.string().min(1),
    beforeSha256: sha256Schema,
    afterSha256: sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
    originalLineEnding: z.enum(["cr", "crlf", "lf", "mixed", "none"]),
    resultingLineEnding: z.enum(["cr", "crlf", "lf", "mixed", "none"]),
    lineEndingsPreserved: z.boolean(),
    journalSequence: z.number().int().positive(),
    preview: ApplyPatchPreviewSchema,
  })
  .strict()
  .readonly();

export type ApplyPatchInput = z.output<typeof ApplyPatchInputSchema>;
export type ApplyPatchOutput = z.output<typeof ApplyPatchOutputSchema>;

export function createApplyPatchTool(
  fileSystem: WorkspaceFileSystem,
  journal: ChangeJournal,
): ToolDefinition<typeof ApplyPatchInputSchema, typeof ApplyPatchOutputSchema> {
  return defineTool({
    name: "apply_patch",
    description:
      "Apply an approved, SHA-256-guarded unified diff to one existing UTF-8 workspace file using atomic replacement.",
    inputSchema: ApplyPatchInputSchema,
    outputSchema: ApplyPatchOutputSchema,
    metadata: {
      risk: "workspace-write",
      concurrency: "exclusive",
      timeoutMs: 15_000,
      maxOutputBytes: 1_500_000,
      requiredPermissions: ["workspace.write"],
    },
    execute: async (input, context) => {
      const parsed = parseUnifiedPatch(input.patch);
      if (parsed.path !== input.path) {
        throw new UnifiedPatchError(
          "PILOT_PATCH_INVALID",
          "Patch header path does not match the requested workspace path",
          { requestedPath: input.path, patchPath: parsed.path },
        );
      }
      const original = await fileSystem.readUtf8(input.path, context.signal);
      const applied = applyUnifiedPatchToContent({
        patch: parsed,
        originalContent: original.content,
        baseSha256: input.baseSha256,
      });
      const replacement = await fileSystem.replaceUtf8Atomic({
        path: input.path,
        expectedSha256: input.baseSha256,
        content: applied.content,
        signal: context.signal,
      });
      if (replacement.afterSha256 !== applied.resultingSha256) {
        throw new UnifiedPatchError(
          "PILOT_PATCH_HUNK_CONFLICT",
          "Atomic replacement produced an unexpected content hash",
          { path: replacement.path },
        );
      }
      const entry = journal.recordApplied({
        runId: context.runId,
        callId: context.callId,
        path: replacement.path,
        beforeSha256: replacement.beforeSha256,
        afterSha256: replacement.afterSha256,
        additions: applied.preview.additions,
        deletions: applied.preview.deletions,
        originalContent: original.content,
      });
      return {
        output: Object.freeze({
          path: replacement.path,
          beforeSha256: replacement.beforeSha256,
          afterSha256: replacement.afterSha256,
          sizeBytes: replacement.sizeBytes,
          originalLineEnding: applied.originalLineEnding,
          resultingLineEnding: applied.resultingLineEnding,
          lineEndingsPreserved: applied.lineEndingsPreserved,
          journalSequence: entry.sequence,
          preview: applied.preview,
        }),
        metadata: {
          changed: true,
          sourcePath: replacement.path,
          beforeSha256: replacement.beforeSha256,
          afterSha256: replacement.afterSha256,
          journalSequence: entry.sequence,
        },
      };
    },
  });
}
