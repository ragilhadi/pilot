import { chatTemplateOverheads, parseAgentMessage, parseModelRequest } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import {
  describeGenericRequestPayload,
  RequestTokenAccountant,
  ScriptAwareHeuristicCounter,
  TokenCounterContextEstimator,
} from "../src/token-accounting.js";

let messageCounter = 0;

const provenanceFor = (role: "user" | "assistant" | "system") => {
  if (role === "system") return { kind: "system", source: "builtin" } as const;
  if (role === "assistant") {
    return { kind: "model", providerId: "fake", modelId: "test" } as const;
  }
  return { kind: "user", channel: "cli" } as const;
};

const message = (role: "user" | "assistant" | "system", text: string) => {
  messageCounter += 1;
  return parseAgentMessage({
    schemaVersion: 1,
    id: `message-${messageCounter}`,
    sessionId: "session-1",
    runId: "run-1",
    role,
    status: "complete",
    parts: [{ type: "text", text }],
    createdAt: "2026-07-22T00:00:00.000Z",
    provenance: provenanceFor(role),
  });
};

const readFileTool = {
  name: "read_file",
  description: "Read a file from the workspace and return its contents with line numbers.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path of the file to read." },
      offset: { type: "number", description: "First line to return, 1-indexed." },
      limit: { type: "number", description: "Maximum number of lines to return." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { content: { type: "string" }, truncated: { type: "boolean" } },
  },
} as const;

const counter = new ScriptAwareHeuristicCounter();
const accountant = new RequestTokenAccountant(counter);

describe("ScriptAwareHeuristicCounter", () => {
  it("charges code more per byte than prose", () => {
    const prose =
      "The context engine selects candidates by relevance and keeps the mandatory ones. " +
      "Everything else competes for whatever budget is left over after the reservations.";
    const code = [
      "export function selectContext(candidates, budget) {",
      "  const selected = [];",
      "  for (const candidate of candidates) {",
      "    if (candidate.estimatedTokens <= budget.remaining) {",
      "      selected.push(candidate);",
      "    }",
      "  }",
      "  return selected;",
      "}",
    ].join("\n");

    const proseBytesPerToken = Buffer.byteLength(prose) / counter.count(prose);
    const codeBytesPerToken = Buffer.byteLength(code) / counter.count(code);

    expect(proseBytesPerToken).toBeGreaterThan(codeBytesPerToken);
    // The flat divisor this replaced would have produced exactly 4 for both.
    expect(codeBytesPerToken).toBeLessThan(4);
  });

  it("charges structured payloads the most per byte", () => {
    const json = JSON.stringify({
      files: [
        { path: "a.ts", bytes: 12, hash: "9f2" },
        { path: "b.ts", bytes: 44, hash: "1ce" },
      ],
    });
    expect(Buffer.byteLength(json) / counter.count(json)).toBeLessThan(3.2);
  });

  it("counts CJK per code point rather than per byte", () => {
    const chinese = "上下文引擎按相关性选择候选项并保留必须保留的部分";
    const tokens = counter.count(chinese);
    // Three UTF-8 bytes per code point: a bytes/4 divisor would have charged well under one token
    // per character for text that really costs about one.
    expect(tokens).toBeGreaterThan(chinese.length * 0.8);
    expect(tokens).toBeLessThan(chinese.length * 1.2);
  });

  it("is stable across the sampling threshold", () => {
    const unit = "const value = compute(input, options);\n";
    const small = unit.repeat(100);
    const large = unit.repeat(4_000);
    expect(large.length).toBeGreaterThan(ScriptAwareHeuristicCounter.samplingThreshold);
    const smallRatio = Buffer.byteLength(small) / counter.count(small);
    const largeRatio = Buffer.byteLength(large) / counter.count(large);
    expect(Math.abs(smallRatio - largeRatio)).toBeLessThan(0.05);
  });

  it("counts empty text as nothing", () => {
    expect(counter.count("")).toBe(0);
  });
});

describe("RequestTokenAccountant", () => {
  it("charges for tool definitions, which no message-only estimate ever saw", () => {
    const messages = [message("user", "list the files under packages/core")];
    const withoutTools = accountant.measure(
      describeGenericRequestPayload(parseModelRequest({ messages, tools: [] })),
    );
    const withTools = accountant.measure(
      describeGenericRequestPayload(parseModelRequest({ messages, tools: [readFileTool] })),
    );

    expect(withoutTools.bySegment["tool-definitions"]).toBe(0);
    expect(withTools.bySegment["tool-definitions"]).toBeGreaterThan(60);
    expect(withTools.totalTokens - withoutTools.totalTokens).toBe(
      withTools.bySegment["tool-definitions"],
    );
  });

  it("does not charge for an output schema the provider never receives", () => {
    const messages = [message("user", "hi")];
    const { outputSchema: _outputSchema, ...withoutOutputSchema } = readFileTool;
    const priced = accountant.measure(
      describeGenericRequestPayload(parseModelRequest({ messages, tools: [readFileTool] })),
    );
    const pricedWithout = accountant.measure(
      describeGenericRequestPayload(parseModelRequest({ messages, tools: [withoutOutputSchema] })),
    );
    expect(priced.bySegment["tool-definitions"]).toBe(pricedWithout.bySegment["tool-definitions"]);
  });

  it("attributes tool results to their own segment so a bloated window can be explained", () => {
    const request = parseModelRequest({
      messages: [
        message("user", "read the config"),
        parseAgentMessage({
          schemaVersion: 1,
          id: "message-tool",
          sessionId: "session-1",
          runId: "run-1",
          role: "tool",
          status: "complete",
          parts: [
            {
              type: "tool-result",
              callId: "call-1",
              toolName: "read_file",
              output: "x".repeat(4_000),
              isError: false,
            },
          ],
          createdAt: "2026-07-22T00:00:01.000Z",
          provenance: { kind: "tool", callId: "call-1", toolName: "read_file" },
        }),
      ],
      tools: [],
    });

    const occupancy = accountant.measure(describeGenericRequestPayload(request));
    expect(occupancy.bySegment["tool-result"]).toBeGreaterThan(occupancy.bySegment.message);
    expect(occupancy.totalTokens).toBe(
      Object.values(occupancy.bySegment).reduce((sum, value) => sum + value, 0) +
        chatTemplateOverheads.generationPrompt,
    );
  });

  it("charges an image far more than the few tokens its data URI would suggest", () => {
    const request = parseModelRequest({
      messages: [
        parseAgentMessage({
          schemaVersion: 1,
          id: "message-image",
          sessionId: "session-1",
          runId: "run-1",
          role: "user",
          status: "complete",
          parts: [
            { type: "text", text: "what is in this screenshot?" },
            {
              type: "image",
              mediaType: "image/png",
              source: { kind: "base64", data: "aGVsbG8=" },
            },
          ],
          createdAt: "2026-07-22T00:00:00.000Z",
          provenance: { kind: "user", channel: "cli" },
        }),
      ],
      tools: [],
    });
    expect(accountant.measure(describeGenericRequestPayload(request)).bySegment.image).toBe(
      chatTemplateOverheads.perImage,
    );
  });

  it("grows monotonically as a conversation grows", () => {
    const messages = [message("user", "first question about the repository")];
    let previous = 0;
    for (let turn = 0; turn < 6; turn += 1) {
      messages.push(message("assistant", `answer number ${turn} with some detail attached`));
      const occupancy = accountant.measure(
        describeGenericRequestPayload(parseModelRequest({ messages, tools: [readFileTool] })),
      );
      expect(occupancy.totalTokens).toBeGreaterThan(previous);
      previous = occupancy.totalTokens;
    }
  });

  it("reports the counter behind the figure so a heuristic is never mistaken for a count", () => {
    const occupancy = accountant.measure(
      describeGenericRequestPayload(
        parseModelRequest({ messages: [message("user", "hello")], tools: [] }),
      ),
    );
    expect(occupancy.method).toBe("script-heuristic");
    expect(occupancy.confidence).toBe("heuristic");
  });
});

describe("TokenCounterContextEstimator", () => {
  it("adds per-message template framing on top of the counted text", () => {
    const estimator = new TokenCounterContextEstimator(counter);
    const text = "a short candidate";
    expect(estimator.estimate(text).tokens).toBe(
      counter.count(text) + chatTemplateOverheads.perMessage,
    );
    expect(estimator.estimate(text).method).toContain("script-heuristic");
  });

  it("rejects a negative framing allowance", () => {
    expect(() => new TokenCounterContextEstimator(counter, { framingTokens: -1 })).toThrow();
  });
});
