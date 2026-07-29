import {
  emptyDiagnosticsReport,
  WorkspaceDiagnosticsReportSchema,
  type WorkspaceDiagnosticsPort,
  type WorkspaceDiagnosticsReport,
} from "@pilotrun/core";
import * as z from "zod";

/**
 * Shared plumbing for attaching language-server diagnostics to the result of the write that caused
 * them.
 *
 * Putting them here — rather than in a tool the model has to remember to call afterwards — is the
 * whole point. An error the model reads as part of the edit's own result gets fixed in the same
 * turn; one it has to go looking for usually is not looked for.
 */
export const DiagnosticsReportSchema = WorkspaceDiagnosticsReportSchema;

export const DiagnosticsFieldSchema = z
  .object({
    diagnostics: DiagnosticsReportSchema.optional().describe(
      "Language-server diagnostics for the file as written. `status` is `ready` when the report " +
        "is trustworthy, `unavailable` when no server could be started, `timeout` when the " +
        "server was too slow, and `unsupported` for file types with no server. Only `ready` with " +
        "an empty `items` means the file is clean.",
    ),
  })
  .partial();

export interface DiagnosticsCollectorOptions {
  readonly port?: WorkspaceDiagnosticsPort;
}

/**
 * Collects diagnostics without ever failing the write that produced them.
 *
 * The edit already landed and its result is already correct; a language server that crashes,
 * hangs, or returns nonsense must not turn a successful edit into a failed tool call.
 */
export async function collectDiagnostics(
  port: WorkspaceDiagnosticsPort | undefined,
  path: string,
  content: string,
  signal: AbortSignal,
): Promise<WorkspaceDiagnosticsReport | undefined> {
  if (port === undefined) return undefined;
  try {
    const report = await port.check({ path, content, signal });
    return WorkspaceDiagnosticsReportSchema.parse(report);
  } catch {
    return emptyDiagnosticsReport("unavailable", "The diagnostics provider failed for this file");
  }
}

/** One-line summary for a transcript or log line. */
export function describeDiagnostics(report: WorkspaceDiagnosticsReport | undefined): string {
  if (report === undefined) return "";
  if (report.status !== "ready") return report.status;
  if (report.errorCount === 0 && report.warningCount === 0) return "clean";
  return `${report.errorCount} error${report.errorCount === 1 ? "" : "s"}, ${report.warningCount} warning${report.warningCount === 1 ? "" : "s"}`;
}
