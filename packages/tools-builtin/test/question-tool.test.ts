import {
  CancellationError,
  runId,
  toolCallId,
  type ClarificationRequest,
  type ClarificationResponse,
  type UserClarification,
} from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import { createQuestionTool, QuestionInputSchema } from "../src/index.js";

function context(signal = new AbortController().signal) {
  return { runId: runId("run-question"), callId: toolCallId("call-question"), signal };
}

function clarificationPort(
  answer: (request: ClarificationRequest) => Promise<ClarificationResponse>,
): UserClarification & { readonly requests: ClarificationRequest[] } {
  const requests: ClarificationRequest[] = [];
  return {
    requests,
    async requestClarification(request) {
      requests.push(request);
      return await answer(request);
    },
  };
}

describe("question tool", () => {
  it("forwards the question and returns the selected option", async () => {
    const port = clarificationPort(async () => ({ answer: "SQLite", selectedOption: 0 }));
    const tool = createQuestionTool(port);

    const result = await tool.execute(
      QuestionInputSchema.parse({
        question: "Which database should the adapter target?",
        options: [{ label: "SQLite", description: "Matches persistence" }, { label: "Postgres" }],
      }),
      context(),
    );

    expect(port.requests[0]).toMatchObject({
      requestId: "call-question",
      question: "Which database should the adapter target?",
      allowsFreeformAnswer: true,
      options: [{ label: "SQLite", description: "Matches persistence" }, { label: "Postgres" }],
    });
    expect(result.output).toEqual({
      question: "Which database should the adapter target?",
      answer: "SQLite",
      selectedOption: { index: 0, label: "SQLite" },
      freeform: false,
    });
    expect(result.metadata).toMatchObject({
      answered: true,
      freeform: false,
      selectedOptionIndex: 0,
    });
  });

  it("sanitizes a freeform answer and keeps a question without options answerable", async () => {
    const port = clarificationPort(async () => ({
      answer: "  keep the existing schema  ",
    }));

    const result = await createQuestionTool(port).execute(
      QuestionInputSchema.parse({
        question: "How should this behave?",
        allowFreeformAnswer: false,
      }),
      context(),
    );

    // allowFreeformAnswer:false with no options would be unanswerable, so it is forced back on.
    expect(port.requests[0]?.allowsFreeformAnswer).toBe(true);
    expect(result.output.freeform).toBe(true);
    expect(result.output.answer).toBe("keep the existing schema");
  });

  it("declares a permission-free, exclusive contract and bounds model-facing input", () => {
    const tool = createQuestionTool(clarificationPort(async () => ({ answer: "yes" })));

    expect(tool.metadata).toMatchObject({
      risk: "read-only",
      concurrency: "exclusive",
      requiredPermissions: [],
    });
    expect(tool.metadata.timeoutMs).toBe(300_000);
    expect(() => tool.inputSchema.parse({ question: "" })).toThrow();
    expect(() => tool.inputSchema.parse({ question: "Pick one\nor two" })).toThrow();
    expect(() =>
      tool.inputSchema.parse({
        question: "Pick one",
        options: Array.from({ length: 9 }, (_, index) => ({ label: `option ${index}` })),
      }),
    ).toThrow();
    expect(() => tool.inputSchema.parse({ question: "Pick one", extra: true })).toThrow();
  });

  it("reports an unanswerable question as a non-retryable failure", async () => {
    const port = clarificationPort(async () => {
      throw new Error("no interactive user");
    });

    await expect(
      createQuestionTool(port).execute(
        QuestionInputSchema.parse({ question: "Which one?" }),
        context(),
      ),
    ).rejects.toMatchObject({ code: "PILOT_QUESTION_UNAVAILABLE", retryable: false });
  });

  it("rejects an answer that selects an option which was never offered", async () => {
    const port = clarificationPort(async () => ({ answer: "Third", selectedOption: 5 }));

    await expect(
      createQuestionTool(port).execute(
        QuestionInputSchema.parse({
          question: "Which one?",
          options: [{ label: "First" }, { label: "Second" }],
        }),
        context(),
      ),
    ).rejects.toMatchObject({ code: "PILOT_QUESTION_RESPONSE_INVALID" });
  });

  it("rejects a freeform answer when the question required one of its options", async () => {
    const port = clarificationPort(async () => ({ answer: "something else entirely" }));

    await expect(
      createQuestionTool(port).execute(
        QuestionInputSchema.parse({
          question: "Which one?",
          options: [{ label: "First" }, { label: "Second" }],
          allowFreeformAnswer: false,
        }),
        context(),
      ),
    ).rejects.toMatchObject({ code: "PILOT_QUESTION_RESPONSE_INVALID" });
  });

  it("propagates cancellation instead of reporting a tool failure", async () => {
    const controller = new AbortController();
    const port = clarificationPort(async () => {
      controller.abort("user cancelled");
      throw new CancellationError(controller.signal.reason);
    });

    await expect(
      createQuestionTool(port).execute(
        QuestionInputSchema.parse({ question: "Which one?" }),
        context(controller.signal),
      ),
    ).rejects.toBeInstanceOf(CancellationError);
  });
});
