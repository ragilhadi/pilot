import * as z from "zod";
import { PilotError } from "../../errors/pilot-error.js";

export type ToolContractViolation = "input" | "output" | "schema";

/** One field-level schema violation, safe to hand back to the model. */
export interface ToolSchemaIssue {
  /** Dotted path to the offending field, or "(root)" when the whole object is wrong. */
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

/** Keeps the recovery hint bounded so a wildly wrong input cannot flood the prompt. */
const maximumReportedIssues = 10;

export class ToolContractError extends PilotError {
  readonly toolName: string;
  readonly violation: ToolContractViolation;
  readonly issues: readonly ToolSchemaIssue[];

  constructor(
    code:
      | "PILOT_TOOL_INPUT_INVALID"
      | "PILOT_TOOL_OUTPUT_INVALID"
      | "PILOT_TOOL_SCHEMA_UNSUPPORTED",
    toolName: string,
    violation: ToolContractViolation,
    message: string,
    cause?: unknown,
  ) {
    const issues = extractSchemaIssues(cause);
    super({
      code,
      message,
      safeMessage:
        violation === "schema"
          ? "The tool schema cannot be represented for a language model"
          : summarizeViolation(toolName, violation, issues),
      metadata: {
        toolName,
        violation,
        ...(issues.length === 0 ? {} : { issues }),
      },
      ...(cause === undefined ? {} : { cause }),
    });
    this.toolName = toolName;
    this.violation = violation;
    this.issues = issues;
  }
}

/**
 * Turns a zod failure into field-level detail the model can act on. Only paths, messages, and
 * issue codes are kept — never the offending values, so nothing from the input can leak back out
 * through an error envelope.
 */
export function extractSchemaIssues(cause: unknown): readonly ToolSchemaIssue[] {
  if (!(cause instanceof z.ZodError)) return Object.freeze([]);
  return Object.freeze(
    cause.issues.slice(0, maximumReportedIssues).map((issue) =>
      Object.freeze({
        path: issue.path.length === 0 ? "(root)" : issue.path.map(String).join("."),
        message: issue.message,
        code: issue.code,
      }),
    ),
  );
}

/**
 * A model that is only told "the input did not match its declared schema" has nothing to revise.
 * Naming the fields turns a guess into a targeted retry, which is the difference between a small
 * model recovering and looping.
 */
function summarizeViolation(
  toolName: string,
  violation: ToolContractViolation,
  issues: readonly ToolSchemaIssue[],
): string {
  const base = `The tool ${violation} did not match the schema declared by ${toolName}`;
  if (issues.length === 0) return `${base}.`;
  const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  return `${base}. ${issues.length === 1 ? "Problem" : "Problems"}: ${detail}`;
}
