import { CancellationError, type ClarificationRequest } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import { CliUserClarification } from "../src/cli-user-clarification.js";

function request(overrides: Partial<ClarificationRequest> = {}): ClarificationRequest {
  return {
    requestId: "call-question",
    question: "Which database should the adapter target?",
    options: [{ label: "SQLite", description: "Matches persistence" }, { label: "Postgres" }],
    allowsFreeformAnswer: true,
    ...overrides,
  };
}

describe("CliUserClarification", () => {
  it("answers by option number", async () => {
    let notified: ClarificationRequest | undefined;
    const clarification = new CliUserClarification((requested) => {
      notified = requested;
    });

    const pending = clarification.requestClarification(request(), new AbortController().signal);
    expect(notified?.requestId).toBe("call-question");
    expect(clarification.respond("2")).toBe("accepted");

    await expect(pending).resolves.toEqual({ answer: "Postgres", selectedOption: 1 });
    expect(clarification.pendingRequest).toBeUndefined();
  });

  it("answers by option label, case-insensitively", async () => {
    const clarification = new CliUserClarification(() => {});
    const pending = clarification.requestClarification(request(), new AbortController().signal);

    expect(clarification.respond("  sqlite ")).toBe("accepted");
    await expect(pending).resolves.toEqual({ answer: "SQLite", selectedOption: 0 });
  });

  it("passes anything else through as a freeform answer, bounded in length", async () => {
    const clarification = new CliUserClarification(() => {});
    const pending = clarification.requestClarification(request(), new AbortController().signal);

    expect(clarification.respond(`neither, use ${"x".repeat(5_000)}`)).toBe("accepted");
    const response = await pending;
    expect(response.selectedOption).toBeUndefined();
    expect(response.answer.length).toBe(4_000);
  });

  it("rejects an unmatched answer when the question requires one of its options", async () => {
    const clarification = new CliUserClarification(() => {});
    const pending = clarification.requestClarification(
      request({ allowsFreeformAnswer: false }),
      new AbortController().signal,
    );

    expect(clarification.respond("MySQL")).toBe("invalid");
    expect(clarification.respond("9")).toBe("invalid");
    expect(clarification.pendingRequest?.requestId).toBe("call-question");

    expect(clarification.respond("1")).toBe("accepted");
    await expect(pending).resolves.toEqual({ answer: "SQLite", selectedOption: 0 });
  });

  it("reports 'none' when no question is pending", () => {
    const clarification = new CliUserClarification(() => {});
    expect(clarification.respond("1")).toBe("none");
  });

  it("fails the pending question when the input closes, and every later question", async () => {
    const clarification = new CliUserClarification(() => {});
    const pending = clarification.requestClarification(request(), new AbortController().signal);

    clarification.close();

    await expect(pending).rejects.toMatchObject({ code: "PILOT_QUESTION_UNAVAILABLE" });
    expect(clarification.pendingRequest).toBeUndefined();
    await expect(
      clarification.requestClarification(request(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "PILOT_QUESTION_UNAVAILABLE" });
  });

  it("cancels the pending question when its signal aborts", async () => {
    const clarification = new CliUserClarification(() => {});
    const controller = new AbortController();
    const pending = clarification.requestClarification(request(), controller.signal);

    controller.abort("user cancelled");

    await expect(pending).rejects.toBeInstanceOf(CancellationError);
    expect(clarification.pendingRequest).toBeUndefined();
    expect(clarification.respond("1")).toBe("none");
  });

  it("refuses a second question while one is already awaiting an answer", async () => {
    const clarification = new CliUserClarification(() => {});
    const first = clarification.requestClarification(request(), new AbortController().signal);

    await expect(
      clarification.requestClarification(
        request({ requestId: "call-question-2" }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "PILOT_QUESTION_UNAVAILABLE" });

    expect(clarification.respond("1")).toBe("accepted");
    await expect(first).resolves.toEqual({ answer: "SQLite", selectedOption: 0 });
  });
});
