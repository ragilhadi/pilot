import * as z from "zod";
import { boundedIdentifier } from "../../shared/schema-fragments.js";

/**
 * A clarification is the agent asking its user a question mid-run — the inverse of a permission
 * approval, where the user is asked to authorize something the agent proposed. It is modelled as a
 * separate port from `UserInteraction` because it carries no policy decision and grants no
 * authority: the only thing it returns is text the user chose to provide.
 */
export const ClarificationOptionSchema = z
  .object({
    label: z.string().min(1).max(200),
    description: z.string().min(1).max(500).optional(),
  })
  .strict()
  .readonly();

export const ClarificationRequestSchema = z
  .object({
    requestId: boundedIdentifier,
    question: z.string().min(1).max(2_000),
    options: z.array(ClarificationOptionSchema).max(8).readonly(),
    /** False when the caller wants one of `options` and nothing else. */
    allowsFreeformAnswer: z.boolean(),
  })
  .strict()
  .readonly();

export const ClarificationResponseSchema = z
  .object({
    answer: z.string().min(1).max(4_000),
    /** Index into the request's `options` when the user picked one, absent when freeform. */
    selectedOption: z.number().int().nonnegative().max(7).optional(),
  })
  .strict()
  .readonly();

export type ClarificationOption = z.output<typeof ClarificationOptionSchema>;
export type ClarificationRequest = z.output<typeof ClarificationRequestSchema>;
export type ClarificationResponse = z.output<typeof ClarificationResponseSchema>;

export interface UserClarification {
  /**
   * Resolves once the user answers. Rejects with a `CancellationError` when `signal` aborts, and
   * with a `PILOT_QUESTION_UNAVAILABLE` error when no one is there to answer (a piped or
   * non-interactive session), so the caller can continue without one instead of hanging.
   */
  requestClarification(
    request: ClarificationRequest,
    signal: AbortSignal,
  ): Promise<ClarificationResponse>;
}
