import {
  type PilotErrorCode,
  type ToolRecovery,
  ToolRecoverySchema,
  type ToolRisk,
} from "@pilotrun/core";

export function recoveryForToolError(code: PilotErrorCode): ToolRecovery {
  switch (code) {
    case "PILOT_PATCH_BASE_MISMATCH":
    case "PILOT_PATCH_HUNK_CONFLICT":
      return recovery(
        "patch-conflict",
        "re-read-file",
        "none",
        true,
        "Re-read the target file, create a new hash-bound patch, and review it again",
      );
    case "PILOT_TOOL_INPUT_INVALID":
    case "PILOT_PATCH_INVALID":
      return recovery(
        "invalid-input",
        "revise-request",
        "none",
        true,
        "Revise the tool input before trying again",
      );
    case "PILOT_WORKSPACE_FILE_EXISTS":
      return recovery(
        "invalid-input",
        "revise-request",
        "none",
        true,
        "write_file only creates new files and the target already exists. Do not retry write_file; " +
          "read the file and use edit or apply_patch to modify it instead.",
      );
    case "PILOT_PATCH_UNSUPPORTED":
      return recovery(
        "invalid-input",
        "revise-request",
        "none",
        true,
        "This is not a malformed patch; apply_patch does not support this operation at all. Read " +
          "the error message for what to do instead, and do not retry the same operation with a " +
          "differently formatted patch.",
      );
    case "PILOT_COMMAND_SPAWN_FAILED":
    case "PILOT_COMMAND_EXECUTION_FAILED":
      return recovery(
        "command-failure",
        "inspect-command-output",
        "none",
        true,
        "Inspect the command error and revise the executable, arguments, or environment",
      );
    case "PILOT_EDIT_STRING_NOT_FOUND":
    case "PILOT_EDIT_STRING_NOT_UNIQUE":
      return recovery(
        "invalid-input",
        "re-read-file",
        "none",
        true,
        "Read the file again, then retry edit with a longer oldString that appears exactly once " +
          "(or set replaceAll when every occurrence should change)",
      );
    case "PILOT_WEB_FETCH_INVALID_URL":
    case "PILOT_GREP_PATTERN_INVALID":
    case "PILOT_FILE_TOOL_PATTERN_INVALID":
    case "PILOT_READ_FILE_INVALID_RANGE":
    case "PILOT_TODO_DUPLICATE_ID":
      return recovery(
        "invalid-input",
        "revise-request",
        "none",
        true,
        "Correct the argument named in the error message and call the tool again",
      );
    case "PILOT_TOOL_NOT_FOUND":
      return recovery(
        "invalid-input",
        "revise-request",
        "none",
        true,
        "That tool does not exist. Choose one of the available tools listed in the error metadata",
      );
    case "PILOT_WEB_FETCH_FAILED":
    case "PILOT_GIT_INSPECTION_FAILED":
    case "PILOT_GREP_FAILED":
      return recovery(
        "execution-failure",
        "retry",
        "none",
        true,
        "The operation failed without changing anything; inspect the error detail and either " +
          "retry once or choose a different approach",
      );
    case "PILOT_WEB_FETCH_BLOCKED":
    case "PILOT_WEB_FETCH_UNSUPPORTED_CONTENT":
    case "PILOT_READ_FILE_BINARY":
    case "PILOT_READ_FILE_INVALID_ENCODING":
    case "PILOT_READ_FILE_TOO_LARGE":
    case "PILOT_READ_FILE_INVALID_TARGET":
    case "PILOT_FILE_TOOL_INVALID_TARGET":
    case "PILOT_GREP_UNAVAILABLE":
    case "PILOT_COMMAND_ENVIRONMENT_DENIED":
      return recovery(
        "invalid-input",
        "revise-request",
        "none",
        false,
        "This target or content is not supported and retrying the same call will fail again; " +
          "choose a different target or approach",
      );
    case "PILOT_TOOL_TIMEOUT":
      return recovery(
        "timeout",
        "inspect-workspace",
        "unknown",
        false,
        "Inspect workspace state before deciding whether the timed-out action is safe to retry",
      );
    default:
      return recovery(
        "execution-failure",
        "inspect-workspace",
        "unknown",
        false,
        "Inspect current workspace state and the tool error before choosing another action",
      );
  }
}

export function permissionDeniedRecovery(interactionUnavailable: boolean): ToolRecovery {
  return recovery(
    "permission-denied",
    interactionUnavailable ? "request-permission" : "revise-request",
    "none",
    interactionUnavailable,
    interactionUnavailable
      ? "Retry only in an interactive context where the action can be reviewed"
      : "Revise the requested action or continue without it",
  );
}

export function interruptedToolRecovery(risk: ToolRisk): ToolRecovery {
  const sideEffects = risk === "read-only" ? "none" : "unknown";
  return recovery(
    "interrupted",
    sideEffects === "none" ? "retry" : "inspect-workspace",
    sideEffects,
    sideEffects === "none",
    sideEffects === "none"
      ? "The read-only tool was interrupted and may be retried"
      : "The tool was interrupted; inspect workspace and external state before retrying",
  );
}

function recovery(
  kind: ToolRecovery["kind"],
  action: ToolRecovery["action"],
  sideEffects: ToolRecovery["sideEffects"],
  retryable: boolean,
  message: string,
): ToolRecovery {
  return ToolRecoverySchema.parse({ kind, action, sideEffects, retryable, message });
}
