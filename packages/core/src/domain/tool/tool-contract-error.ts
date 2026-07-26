import { PilotError } from "../../errors/pilot-error.js";

export type ToolContractViolation = "input" | "output" | "schema";

export class ToolContractError extends PilotError {
  readonly toolName: string;
  readonly violation: ToolContractViolation;

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
    super({
      code,
      message,
      safeMessage:
        violation === "schema"
          ? "The tool schema cannot be represented for a language model"
          : `The tool ${violation} did not match its declared schema`,
      metadata: { toolName, violation },
      ...(cause === undefined ? {} : { cause }),
    });
    this.toolName = toolName;
    this.violation = violation;
  }
}
