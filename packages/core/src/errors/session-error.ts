import { PilotError } from "./pilot-error.js";

export type SessionErrorReason =
  | "created-at-regressed"
  | "duplicate-message"
  | "duplicate-session"
  | "message-session-mismatch"
  | "non-terminal-message"
  | "parent-mismatch"
  | "session-not-found"
  | "stale-revision";

export class SessionError extends PilotError {
  readonly reason: SessionErrorReason;

  constructor(
    code: "PILOT_SESSION_CONFLICT" | "PILOT_SESSION_INVALID_MESSAGE" | "PILOT_SESSION_NOT_FOUND",
    reason: SessionErrorReason,
    message: string,
    metadata: Readonly<Record<string, unknown>> = {},
  ) {
    super({
      code,
      message,
      safeMessage:
        code === "PILOT_SESSION_NOT_FOUND"
          ? "The requested session does not exist"
          : "The session update is invalid",
      metadata: { reason, ...metadata },
    });
    this.reason = reason;
  }
}
