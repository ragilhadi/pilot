import { PilotError } from "../../errors/pilot-error.js";

export type SkillErrorCode =
  | "PILOT_SKILL_DOCUMENT_INVALID"
  | "PILOT_SKILL_LIMIT"
  | "PILOT_SKILL_NOT_FOUND"
  | "PILOT_SKILL_REQUIREMENT_UNMET"
  | "PILOT_PROMPT_TEMPLATE_INVALID";

const safeMessages: Readonly<Record<SkillErrorCode, string>> = Object.freeze({
  PILOT_SKILL_DOCUMENT_INVALID: "A skill document is invalid",
  PILOT_SKILL_LIMIT: "A skill exceeds a configured limit",
  PILOT_SKILL_NOT_FOUND: "The requested skill is not available",
  PILOT_SKILL_REQUIREMENT_UNMET: "The skill's requirements are not met",
  PILOT_PROMPT_TEMPLATE_INVALID: "A prompt template is invalid",
});

/**
 * Errors raised while parsing or expanding skill and prompt-template documents.
 *
 * Skill files are authored by hand, frequently by the project rather than the user, so the
 * unsafe message names the exact line at fault while the safe message stays generic.
 */
export class SkillError extends PilotError {
  constructor(
    code: SkillErrorCode,
    message: string,
    metadata: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super({
      code,
      message,
      safeMessage: safeMessages[code],
      metadata,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}
