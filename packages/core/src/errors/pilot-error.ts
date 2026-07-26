import type { PilotErrorCode } from "./pilot-error-codes.js";

export type { PilotErrorCode };

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
