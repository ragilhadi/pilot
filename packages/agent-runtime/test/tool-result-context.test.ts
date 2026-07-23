import { toolCallId } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import { ToolResultContextError, ToolResultContextFormatter } from "../src/index.js";

function format(
  output: Parameters<ToolResultContextFormatter["format"]>[0]["output"],
  maximumBytes = 700,
) {
  return new ToolResultContextFormatter({ maximumBytes }).format({
    callId: toolCallId("call-large"),
    toolName: "read_file",
    output,
  });
}

describe("ToolResultContextFormatter", () => {
  it("preserves results that already fit", () => {
    const output = { path: "src/main.ts", content: "small" };
    const result = format(output);

    expect(result).toEqual({
      output,
      truncated: false,
      serializedBytes: new TextEncoder().encode(JSON.stringify(output)).byteLength,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("keeps Unicode-safe head and tail content within the serialized byte limit", () => {
    const original = `BEGIN\n${'😀line\\"\u0000\n'.repeat(300)}END`;
    const result = format(original, 800);

    expect(result.truncated).toBe(true);
    expect(result.serializedBytes).toBeLessThanOrEqual(800);
    expect(new TextEncoder().encode(JSON.stringify(result.output)).byteLength).toBe(
      result.serializedBytes,
    );
    expect(result.output).toMatchObject({
      head: expect.stringMatching(/^BEGIN/u),
      tail: expect.stringMatching(/END$/u),
      pilotTruncation: {
        schemaVersion: 1,
        strategy: "head-tail",
        untrusted: true,
        contentType: "text",
        maximumBytes: 800,
        originalBytes: expect.any(Number),
        retainedBytes: expect.any(Number),
        omittedBytes: expect.any(Number),
        omittedCharacters: expect.any(Number),
        retrieval: {
          action: "request-narrower-result",
          toolName: "read_file",
          callId: "call-large",
        },
      },
    });
    expect(result.truncation?.originalBytes).toBe(
      (result.truncation?.retainedBytes ?? 0) + (result.truncation?.omittedBytes ?? 0),
    );
    expect(JSON.stringify(result.output)).not.toContain("�");
  });

  it("canonicalizes structured output so equivalent objects truncate identically", () => {
    const long = "x".repeat(2_000);
    const left = format({ z: long, a: { second: long, first: 1 } });
    const right = format({ a: { first: 1, second: long }, z: long });

    expect(left.truncated).toBe(true);
    expect(right).toEqual(left);
    expect(left.truncation).toMatchObject({ contentType: "json" });
  });

  it("rejects unsafe policy values and metadata that cannot fit", () => {
    expect(() => new ToolResultContextFormatter({ maximumBytes: 511 })).toThrowError(
      ToolResultContextError,
    );
    expect(
      () => new ToolResultContextFormatter({ maximumBytes: 1_000, headShare: 0.2 }),
    ).toThrowError(ToolResultContextError);

    const formatter = new ToolResultContextFormatter({ maximumBytes: 512 });
    expect(() =>
      formatter.format({
        callId: toolCallId("x".repeat(1_000)),
        toolName: "read_file",
        output: "y".repeat(2_000),
      }),
    ).toThrowError(ToolResultContextError);
  });
});
