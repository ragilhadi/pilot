import {
  CancellationError,
  PilotError,
  type ClarificationRequest,
  type ClarificationResponse,
  type UserClarification,
} from "@pilotrun/core";

export type ClarificationInputResult = "accepted" | "invalid" | "none";

/** Matches `ClarificationResponseSchema`'s bound on `answer`. */
const maxAnswerCharacters = 4_000;

interface PendingClarification {
  readonly request: ClarificationRequest;
  readonly resolve: (response: ClarificationResponse) => void;
  readonly reject: (error: unknown) => void;
  readonly abort: () => void;
  readonly signal: AbortSignal;
}

export class ClarificationUnavailableError extends PilotError {
  constructor(message: string, metadata: Readonly<Record<string, unknown>> = {}) {
    super({
      code: "PILOT_QUESTION_UNAVAILABLE",
      message,
      safeMessage: "No interactive user is available to answer a question",
      metadata,
    });
  }
}

/**
 * Bridges the chat loop's sole stdin reader to an awaiting `question` tool call, mirroring
 * `CliUserInteraction`. The difference is what an unanswerable question means: a permission request
 * with no one to answer it must deny, while a question simply has no answer, so `close()` fails the
 * call and lets the model continue on its own assumption.
 */
export class CliUserClarification implements UserClarification {
  readonly #onRequest: (request: ClarificationRequest) => void;
  #pending: PendingClarification | undefined;
  #closed = false;

  constructor(onRequest: (request: ClarificationRequest) => void) {
    this.#onRequest = onRequest;
  }

  get pendingRequest(): ClarificationRequest | undefined {
    return this.#pending?.request;
  }

  requestClarification(
    request: ClarificationRequest,
    signal: AbortSignal,
  ): Promise<ClarificationResponse> {
    if (this.#closed) {
      return Promise.reject(
        new ClarificationUnavailableError("The chat input is closed", {
          requestId: request.requestId,
        }),
      );
    }
    if (this.#pending !== undefined) {
      return Promise.reject(
        new ClarificationUnavailableError("A question is already awaiting an answer", {
          requestId: request.requestId,
        }),
      );
    }
    if (signal.aborted) return Promise.reject(new CancellationError(signal.reason));

    return new Promise((resolve, reject) => {
      const abort = () => {
        if (this.#pending?.request.requestId !== request.requestId) return;
        this.#pending = undefined;
        reject(new CancellationError(signal.reason));
      };
      this.#pending = { request, resolve, reject, abort, signal };
      signal.addEventListener("abort", abort, { once: true });
      this.#onRequest(request);
    });
  }

  /** Feeds one line of user input to the pending question. */
  respond(line: string): ClarificationInputResult {
    const pending = this.#pending;
    if (pending === undefined) return "none";
    const response = parseResponse(line, pending.request);
    if (response === undefined) return "invalid";

    this.#settle(pending);
    pending.resolve(response);
    return "accepted";
  }

  /** Fails the pending question because no answer can arrive (end of input, session ending). */
  close(): void {
    this.#closed = true;
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#settle(pending);
    pending.reject(
      new ClarificationUnavailableError("The chat input closed before the question was answered", {
        requestId: pending.request.requestId,
      }),
    );
  }

  #settle(pending: PendingClarification): void {
    this.#pending = undefined;
    pending.signal.removeEventListener("abort", pending.abort);
  }
}

/**
 * Accepts either a 1-based option number, an exact (case-insensitive) option label, or — when the
 * question allows it — whatever the user typed. Options are matched first so that a question whose
 * option labels happen to be numbers still resolves by position.
 */
function parseResponse(
  line: string,
  request: ClarificationRequest,
): ClarificationResponse | undefined {
  // Bounded to the clarification contract's answer limit so a pasted wall of text answers the
  // question instead of failing it.
  const answer = line.trim().slice(0, maxAnswerCharacters);
  if (answer.length === 0) return undefined;

  const selectedOption = selectedOptionIndex(answer, request.options);
  const option = selectedOption === undefined ? undefined : request.options[selectedOption];
  if (option !== undefined && selectedOption !== undefined) {
    return { answer: option.label, selectedOption };
  }
  return request.allowsFreeformAnswer ? { answer } : undefined;
}

function selectedOptionIndex(
  answer: string,
  options: ClarificationRequest["options"],
): number | undefined {
  const ordinal = /^[1-9][0-9]?$/u.test(answer) ? Number.parseInt(answer, 10) - 1 : undefined;
  if (ordinal !== undefined && ordinal < options.length) return ordinal;
  const byLabel = options.findIndex(
    (option) => option.label.toLowerCase() === answer.toLowerCase(),
  );
  return byLabel < 0 ? undefined : byLabel;
}
