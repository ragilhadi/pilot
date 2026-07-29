import * as z from "zod";

/**
 * Diagnostics reported for a workspace file by an external analyzer (a language server today).
 *
 * This lives in core as a port so that the edit tools can surface "your change does not compile"
 * without `@pilotrun/tools-builtin` depending on a subprocess-spawning package. With no
 * implementation injected the tools behave exactly as they did before.
 */
export const DiagnosticSeveritySchema = z.enum(["error", "warning"]);

export type DiagnosticSeverity = z.output<typeof DiagnosticSeveritySchema>;

export const WorkspaceDiagnosticSchema = z
  .object({
    severity: DiagnosticSeveritySchema,
    /** One-based, matching what read_file's gutter shows and what humans say. */
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    message: z.string().min(1),
    /** The analyzer that produced it, e.g. "ts" or "pyright". */
    source: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
  })
  .strict()
  .readonly();

export type WorkspaceDiagnostic = z.output<typeof WorkspaceDiagnosticSchema>;

/**
 * Why a report contains what it contains.
 *
 * `unavailable` and `timeout` are deliberately distinct from an empty `ready`: "no language server
 * for this file" and "the server did not answer in time" must not be read as "this file is clean".
 */
export const DiagnosticsStatusSchema = z.enum(["ready", "unavailable", "timeout", "unsupported"]);

export type DiagnosticsStatus = z.output<typeof DiagnosticsStatusSchema>;

export const WorkspaceDiagnosticsReportSchema = z
  .object({
    status: DiagnosticsStatusSchema,
    items: z.array(WorkspaceDiagnosticSchema).readonly(),
    errorCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
    /** Set when items were dropped to stay within the report limit. */
    truncated: z.boolean().optional(),
    /** Human-readable reason, present for every non-`ready` status. */
    detail: z.string().min(1).optional(),
  })
  .strict()
  .readonly();

export type WorkspaceDiagnosticsReport = z.output<typeof WorkspaceDiagnosticsReportSchema>;

export interface WorkspaceDiagnosticsRequest {
  /** Workspace-relative path, as the tools use. */
  readonly path: string;
  /** Current file content, so the analyzer sees the edit without waiting for a filesystem watcher. */
  readonly content: string;
  readonly signal: AbortSignal;
}

export interface WorkspaceDiagnosticsPort {
  /** Reports diagnostics for the file as given. Never throws; failures come back as a status. */
  check(request: WorkspaceDiagnosticsRequest): Promise<WorkspaceDiagnosticsReport>;
}

export function emptyDiagnosticsReport(
  status: DiagnosticsStatus,
  detail?: string,
): WorkspaceDiagnosticsReport {
  return Object.freeze({
    status,
    items: Object.freeze([]),
    errorCount: 0,
    warningCount: 0,
    ...(detail === undefined ? {} : { detail }),
  });
}

/** Errors first, then by position, so a truncated report keeps the most actionable entries. */
export function summarizeDiagnostics(
  items: readonly WorkspaceDiagnostic[],
  maximumItems: number,
): WorkspaceDiagnosticsReport {
  const ordered = [...items].sort(
    (left, right) =>
      severityRank(left.severity) - severityRank(right.severity) ||
      left.line - right.line ||
      left.column - right.column,
  );
  const kept = ordered.slice(0, maximumItems);
  return Object.freeze({
    status: "ready" as const,
    items: Object.freeze(kept),
    errorCount: items.filter(({ severity }) => severity === "error").length,
    warningCount: items.filter(({ severity }) => severity === "warning").length,
    ...(ordered.length > kept.length ? { truncated: true } : {}),
  });
}

function severityRank(severity: DiagnosticSeverity): number {
  return severity === "error" ? 0 : 1;
}
