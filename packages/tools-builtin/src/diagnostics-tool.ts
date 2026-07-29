import {
  defineTool,
  emptyDiagnosticsReport,
  type ToolDefinition,
  type WorkspaceDiagnosticsPort,
} from "@pilotrun/core";
import * as z from "zod";
import { DiagnosticsReportSchema } from "./diagnostics-reporting.js";
import type { WorkspaceFileSystem } from "./workspace-file-system.js";

export const DiagnosticsInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4_096)
      .describe('Workspace-relative path to check, for example "src/index.ts".'),
  })
  .strict()
  .readonly();

export const DiagnosticsOutputSchema = z
  .object({
    path: z.string().min(1),
    diagnostics: DiagnosticsReportSchema,
  })
  .strict()
  .readonly();

export type DiagnosticsInput = z.output<typeof DiagnosticsInputSchema>;
export type DiagnosticsOutput = z.output<typeof DiagnosticsOutputSchema>;

/**
 * On-demand diagnostics for a file the model has not just edited.
 *
 * The edit tools already attach diagnostics to their own results, which covers the common case.
 * This exists for the other one: confirming whether a problem the user described is still present,
 * or checking a file the model only read.
 */
export function createDiagnosticsTool(
  fileSystem: WorkspaceFileSystem,
  port: WorkspaceDiagnosticsPort,
): ToolDefinition<typeof DiagnosticsInputSchema, typeof DiagnosticsOutputSchema> {
  return defineTool({
    name: "diagnostics",
    description:
      "Report language-server errors and warnings for one file — type errors, unresolved " +
      "imports, undefined names.\n\n" +
      "You do not need this after edit, write_file, or apply_patch: those already return the " +
      "diagnostics for the file they changed. Use it to check a file you have only read, or to " +
      "confirm whether a problem you were told about still exists.\n\n" +
      "Check `status` before trusting an empty result: only `ready` means the file is clean. " +
      "`unavailable` means no language server could be started, `timeout` means it did not " +
      "answer in time, and `unsupported` means this file type has no server.\n\n" +
      'Example: {"path": "src/index.ts"}',
    inputSchema: DiagnosticsInputSchema,
    outputSchema: DiagnosticsOutputSchema,
    metadata: {
      risk: "read-only",
      concurrency: "parallel-safe",
      timeoutMs: 20_000,
      maxOutputBytes: 200_000,
      requiredPermissions: ["workspace.read"],
    },
    execute: async (input, context) => {
      const snapshot = await fileSystem.readUtf8(input.path, context.signal);
      const report = await port
        .check({ path: snapshot.path, content: snapshot.content, signal: context.signal })
        .catch(() =>
          emptyDiagnosticsReport("unavailable", "The diagnostics provider failed for this file"),
        );
      return {
        output: Object.freeze({ path: snapshot.path, diagnostics: report }),
        metadata: {
          status: report.status,
          errorCount: report.errorCount,
          warningCount: report.warningCount,
        },
      };
    },
  });
}
