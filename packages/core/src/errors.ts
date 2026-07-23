export type PilotErrorCode =
  | "PILOT_ATOMIC_WRITE_FAILED"
  | "PILOT_CHANGE_JOURNAL_INVALID"
  | "PILOT_COMMAND_ENVIRONMENT_DENIED"
  | "PILOT_COMMAND_EXECUTION_FAILED"
  | "PILOT_COMMAND_SPAWN_FAILED"
  | "PILOT_CONFIG_INVALID"
  | "PILOT_CONFIG_ENVIRONMENT_MISSING"
  | "PILOT_CANCELLED"
  | "PILOT_CONTEXT_BUDGET"
  | "PILOT_CONTEXT_COMPACTION"
  | "PILOT_CONTEXT_INVALID"
  | "PILOT_CONTEXT_STALE"
  | "PILOT_CONTEXT_TRUNCATION"
  | "PILOT_EVENT_DELIVERY_FAILED"
  | "PILOT_INVALID_IDENTIFIER"
  | "PILOT_INVALID_MESSAGE"
  | "PILOT_INSTRUCTIONS_INVALID"
  | "PILOT_INSTRUCTIONS_LIMIT"
  | "PILOT_INVALID_MODEL_DATA"
  | "PILOT_MODEL_AUTHENTICATION"
  | "PILOT_MODEL_CONTEXT_LIMIT"
  | "PILOT_MODEL_FAILED"
  | "PILOT_MODEL_INVALID_REQUEST"
  | "PILOT_MODEL_CAPABILITY_UNAVAILABLE"
  | "PILOT_MODEL_NOT_FOUND"
  | "PILOT_MODEL_RATE_LIMIT"
  | "PILOT_MODEL_REGISTRATION_CONFLICT"
  | "PILOT_MODEL_STREAM_PROTOCOL"
  | "PILOT_MODEL_UNAVAILABLE"
  | "PILOT_PERMISSION_POLICY_INVALID"
  | "PILOT_PERMISSION_INTERACTION_UNAVAILABLE"
  | "PILOT_PERMISSION_RESPONSE_INVALID"
  | "PILOT_PERMISSION_RULE_CONFLICT"
  | "PILOT_PATCH_BASE_MISMATCH"
  | "PILOT_PATCH_HUNK_CONFLICT"
  | "PILOT_PATCH_INVALID"
  | "PILOT_PATCH_UNSUPPORTED"
  | "PILOT_PERSISTENCE_FAILED"
  | "PILOT_PERSISTENCE_MIGRATION_FAILED"
  | "PILOT_RUN_BUDGET_INVALID"
  | "PILOT_RUN_BUDGET_EXHAUSTED"
  | "PILOT_RUN_INVALID_TRANSITION"
  | "PILOT_RUN_UNSUPPORTED_OPERATION"
  | "PILOT_SESSION_CONFLICT"
  | "PILOT_SESSION_INVALID_MESSAGE"
  | "PILOT_SESSION_NOT_FOUND"
  | "PILOT_TOOL_INPUT_INVALID"
  | "PILOT_TOOL_NOT_FOUND"
  | "PILOT_TOOL_OUTPUT_INVALID"
  | "PILOT_TOOL_OUTPUT_TOO_LARGE"
  | "PILOT_TOOL_REGISTRATION_CONFLICT"
  | "PILOT_TOOL_SCHEMA_UNSUPPORTED"
  | "PILOT_TOOL_CALL_CONFLICT"
  | "PILOT_TOOL_EXECUTION_FAILED"
  | "PILOT_TOOL_TIMEOUT"
  | "PILOT_UNEXPECTED_ERROR"
  | "PILOT_WORKSPACE_FILE_EXISTS"
  | "PILOT_WORKSPACE_IO"
  | "PILOT_WORKSPACE_PATH_ESCAPE"
  | "PILOT_WORKSPACE_PATH_INVALID"
  | "PILOT_WORKSPACE_PATH_NOT_FOUND"
  | "PILOT_WORKSPACE_WRITE_PARENT_INVALID"
  | "PILOT_REPOSITORY_DISCOVERY_INVALID"
  | "PILOT_REPOSITORY_DISCOVERY_LIMIT"
  | "PILOT_GIT_INSPECTION_FAILED"
  | "PILOT_FILE_TOOL_INVALID_TARGET"
  | "PILOT_FILE_TOOL_PATTERN_INVALID"
  | "PILOT_GREP_FAILED"
  | "PILOT_GREP_PATTERN_INVALID"
  | "PILOT_GREP_UNAVAILABLE"
  | "PILOT_READ_FILE_BINARY"
  | "PILOT_READ_FILE_FAILED"
  | "PILOT_READ_FILE_INVALID_ENCODING"
  | "PILOT_READ_FILE_INVALID_RANGE"
  | "PILOT_READ_FILE_INVALID_TARGET"
  | "PILOT_READ_FILE_TOO_LARGE";

export interface PilotErrorOptions {
  readonly code: PilotErrorCode;
  readonly message: string;
  readonly safeMessage?: string;
  readonly retryable?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** Base class for errors that cross Pilot package and UI boundaries. */
export class PilotError extends Error {
  readonly code: PilotErrorCode;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly metadata: Readonly<Record<string, unknown>>;

  constructor(options: PilotErrorOptions) {
    super(
      options.message,
      options.cause === undefined
        ? undefined
        : {
            cause: options.cause,
          },
    );
    this.name = new.target.name;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.safeMessage = options.safeMessage ?? options.message;
    this.metadata = Object.freeze({ ...options.metadata });
  }
}

export class InvalidIdentifierError extends PilotError {
  constructor(identifierType: string) {
    super({
      code: "PILOT_INVALID_IDENTIFIER",
      message: `${identifierType} must not be empty`,
      metadata: { identifierType },
    });
  }
}

export class CancellationError extends PilotError {
  constructor(cause?: unknown) {
    super({
      code: "PILOT_CANCELLED",
      message: "Operation was cancelled",
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

export class EventDeliveryError extends PilotError {
  readonly failureCount: number;

  constructor(failureCount: number, cause: unknown) {
    super({
      code: "PILOT_EVENT_DELIVERY_FAILED",
      message: `Failed to deliver an event to ${failureCount} subscriber(s)`,
      safeMessage: "One or more event subscribers failed",
      metadata: { failureCount },
      cause,
    });
    this.failureCount = failureCount;
  }
}

export class MessageValidationError extends PilotError {
  readonly issueCount: number;

  constructor(issueCount: number, cause: unknown) {
    super({
      code: "PILOT_INVALID_MESSAGE",
      message: `Message validation failed with ${issueCount} issue(s)`,
      safeMessage: "The message has an invalid structure",
      metadata: { issueCount },
      cause,
    });
    this.issueCount = issueCount;
  }
}

export interface SafeErrorSnapshot {
  readonly code: PilotErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Removes stack traces, causes, and unsafe messages before an error reaches a client. */
export function toSafeErrorSnapshot(error: unknown): SafeErrorSnapshot {
  if (error instanceof PilotError) {
    return {
      code: error.code,
      message: error.safeMessage,
      retryable: error.retryable,
      metadata: error.metadata,
    };
  }

  return {
    code: "PILOT_UNEXPECTED_ERROR",
    message: "An unexpected error occurred",
    retryable: false,
    metadata: {},
  };
}
