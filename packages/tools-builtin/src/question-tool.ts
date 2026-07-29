import {
  CancellationError,
  ClarificationRequestSchema,
  ClarificationResponseSchema,
  defineTool,
  PilotError,
  type ClarificationRequest,
  type ClarificationResponse,
  type ToolDefinition,
  type UserClarification,
} from "@pilotrun/core";
import * as z from "zod";

const maxOptions = 8;
const maxAnswerCharacters = 4_000;
/**
 * A pending question blocks the agent loop until the user answers, so the ceiling is a
 * "walked away from the keyboard" backstop rather than a normal deadline. It stays well under the
 * default run budget (`maxElapsedMs`, 30 minutes) so an unanswered question ends as a recoverable
 * tool error instead of killing the whole turn.
 */
const defaultTimeoutMs = 300_000;

const questionOptionSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("A short label for this choice, shown to the user verbatim.")
      .refine((value) => !hasControlCharacter(value), "Option labels must be a single line"),
    description: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("Optional one-line explanation of what choosing this option means.")
      .refine(
        (value) => value === undefined || !hasControlCharacter(value),
        "Option descriptions must be a single line",
      ),
  })
  .strict()
  .readonly();

export const QuestionInputSchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .describe("The question to put to the user. Ask exactly one thing, in plain language.")
      .refine((value) => !hasControlCharacter(value), "The question must be a single line"),
    options: z
      .array(questionOptionSchema)
      .max(maxOptions)
      .default([])
      .readonly()
      .describe(
        "Optional concrete choices. Provide them whenever the answer is one of a small known " +
          "set — they are far easier to answer than an open question.",
      ),
    allowFreeformAnswer: z
      .boolean()
      .default(true)
      .describe(
        "Whether the user may answer in their own words instead of picking an option. Set false " +
          "only when an answer outside the listed options would be meaningless.",
      ),
  })
  .strict()
  .readonly();

export const QuestionOutputSchema = z
  .object({
    question: z.string(),
    answer: z.string(),
    /** Present only when the user picked one of the supplied options. */
    selectedOption: z
      .object({ index: z.number().int().nonnegative(), label: z.string() })
      .strict()
      .readonly()
      .optional(),
    freeform: z.boolean(),
  })
  .strict()
  .readonly();

export type QuestionInput = z.output<typeof QuestionInputSchema>;
export type QuestionOutput = z.output<typeof QuestionOutputSchema>;

type QuestionErrorCode = "PILOT_QUESTION_RESPONSE_INVALID" | "PILOT_QUESTION_UNAVAILABLE";

export class QuestionToolError extends PilotError {
  constructor(
    code: QuestionErrorCode,
    message: string,
    options: {
      readonly metadata?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
      readonly safeMessage?: string;
    } = {},
  ) {
    super({
      code,
      message,
      safeMessage:
        options.safeMessage ??
        (code === "PILOT_QUESTION_UNAVAILABLE"
          ? "No interactive user is available to answer a question"
          : "The answer returned for the question was not usable"),
      metadata: options.metadata ?? {},
      retryable: false,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
  }
}

export interface QuestionToolOptions {
  readonly timeoutMs?: number;
}

/**
 * Lets the agent ask its user a single blocking question. The tool owns no state: it renders the
 * request through the injected `UserClarification` port (the CLI bridges that to the chat loop's
 * stdin reader) and returns the sanitized answer.
 */
export function createQuestionTool(
  clarification: UserClarification,
  options: QuestionToolOptions = {},
): ToolDefinition<typeof QuestionInputSchema, typeof QuestionOutputSchema> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  return defineTool({
    name: "question",
    description:
      "Ask the user one question and wait for their answer.\n\n" +
      "Use it only when you are genuinely blocked on a decision that is theirs to make — an " +
      "ambiguous requirement with materially different readings, or a choice between approaches " +
      "with real trade-offs. Do not use it for anything you can settle by reading the repository, " +
      "and do not use it to ask permission: risky actions are approved separately.\n\n" +
      "Supply `options` whenever the answer is one of a small known set; a list is much easier to " +
      "answer than an open question. Asking costs the user their attention, so ask once, then act " +
      "on the answer.\n\n" +
      'Example: {"question": "Which database should the new adapter target?", "options": ' +
      '[{"label": "SQLite", "description": "Matches the existing persistence package"}, ' +
      '{"label": "Postgres"}]}',
    inputSchema: QuestionInputSchema,
    outputSchema: QuestionOutputSchema,
    // Asking a question changes nothing in the workspace, on the network, or on the machine, so it
    // is permission-free — prompting for approval to ask would be a second question about the
    // first. It is exclusive because it takes over the user's input until it is answered.
    metadata: {
      risk: "read-only",
      concurrency: "exclusive",
      timeoutMs,
      maxOutputBytes: 16_384,
      requiredPermissions: [],
    },
    execute: async (input, context) => {
      throwIfCancelled(context.signal);
      const request: ClarificationRequest = ClarificationRequestSchema.parse({
        requestId: context.callId,
        question: input.question,
        options: input.options.map((option) => ({
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
        // An options-only question with no options would be unanswerable.
        allowsFreeformAnswer: input.allowFreeformAnswer || input.options.length === 0,
      });

      let response: ClarificationResponse;
      try {
        response = await clarification.requestClarification(request, context.signal);
      } catch (error) {
        if (context.signal.aborted) throw new CancellationError(context.signal.reason);
        if (error instanceof QuestionToolError || error instanceof CancellationError) throw error;
        throw new QuestionToolError(
          "PILOT_QUESTION_UNAVAILABLE",
          "The question could not be put to the user",
          { metadata: { requestId: request.requestId }, cause: error },
        );
      }
      throwIfCancelled(context.signal);

      const output = toOutput(request, response);
      return {
        output,
        metadata: {
          answered: true,
          freeform: output.freeform,
          ...(output.selectedOption === undefined
            ? {}
            : { selectedOptionIndex: output.selectedOption.index }),
        },
      };
    },
  });
}

function toOutput(
  request: ClarificationRequest,
  rawResponse: ClarificationResponse,
): QuestionOutput {
  const parsed = ClarificationResponseSchema.safeParse(rawResponse);
  if (!parsed.success) {
    throw new QuestionToolError(
      "PILOT_QUESTION_RESPONSE_INVALID",
      "The clarification response did not match its contract",
      { metadata: { requestId: request.requestId, issueCount: parsed.error.issues.length } },
    );
  }
  const selectedIndex = parsed.data.selectedOption;
  const selected = selectedIndex === undefined ? undefined : request.options[selectedIndex];
  if (selectedIndex !== undefined && selected === undefined) {
    throw new QuestionToolError(
      "PILOT_QUESTION_RESPONSE_INVALID",
      "The clarification response selected an option that was not offered",
      { metadata: { requestId: request.requestId, selectedOption: selectedIndex } },
    );
  }
  if (selected === undefined && !request.allowsFreeformAnswer) {
    throw new QuestionToolError(
      "PILOT_QUESTION_RESPONSE_INVALID",
      "The question required one of its options but the answer selected none",
      { metadata: { requestId: request.requestId } },
    );
  }
  const answer = sanitizeAnswer(parsed.data.answer);
  if (answer.length === 0) {
    throw new QuestionToolError(
      "PILOT_QUESTION_RESPONSE_INVALID",
      "The clarification response was empty once sanitized",
      { metadata: { requestId: request.requestId } },
    );
  }
  return Object.freeze({
    question: request.question,
    answer,
    ...(selected === undefined || selectedIndex === undefined
      ? {}
      : { selectedOption: Object.freeze({ index: selectedIndex, label: selected.label }) }),
    freeform: selected === undefined,
  });
}

/**
 * The answer is the user's own text — trusted input, unlike fetched pages or command output — but
 * it still enters the model's context, so control characters are dropped and the length is bounded.
 */
function sanitizeAnswer(value: string): string {
  let text = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "\n" || character === "\t") {
      text += character;
      continue;
    }
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
    text += character;
  }
  return text.trim().slice(0, maxAnswerCharacters);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      return true;
    }
  }
  return false;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancellationError(signal.reason);
}
