import { describe, expect, it } from "vitest";
import { parseToolCallArguments } from "../src/index.js";

describe("parseToolCallArguments", () => {
  it.each([
    { name: "an empty string", raw: "" },
    { name: "whitespace only", raw: "   \n " },
    { name: "the literal null", raw: "null" },
    { name: "the literal undefined", raw: "undefined" },
  ])("treats $name as an empty argument object", ({ raw }) => {
    // The common weak-model shape for a zero-parameter tool. This used to abort the whole run.
    expect(parseToolCallArguments(raw)).toEqual({ input: {}, malformed: false });
  });

  it("parses ordinary JSON arguments unchanged", () => {
    expect(parseToolCallArguments('{"path":"README.md","startLine":3}')).toEqual({
      input: { path: "README.md", startLine: 3 },
      malformed: false,
    });
  });

  it("recovers arguments wrapped in a Markdown code fence", () => {
    const raw = '```json\n{"path":"README.md"}\n```';
    expect(parseToolCallArguments(raw)).toEqual({
      input: { path: "README.md" },
      malformed: false,
    });
  });

  it("recovers double-encoded arguments", () => {
    const raw = JSON.stringify('{"path":"README.md"}');
    expect(parseToolCallArguments(raw)).toEqual({
      input: { path: "README.md" },
      malformed: false,
    });
  });

  it("degrades unrecoverable arguments to an empty object instead of throwing", () => {
    const result = parseToolCallArguments('{"path":');

    expect(result.malformed).toBe(true);
    expect(result.input).toEqual({});
    expect(result.raw).toBe('{"path":');
  });

  it("bounds the raw excerpt it reports back", () => {
    const result = parseToolCallArguments(`{"path":"${"a".repeat(5_000)}`);

    expect(result.malformed).toBe(true);
    expect(result.raw?.length).toBe(400);
  });

  it("keeps a non-object JSON value so the tool schema can reject it precisely", () => {
    expect(parseToolCallArguments('"README.md"')).toEqual({
      input: "README.md",
      malformed: false,
    });
  });
});
