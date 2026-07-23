import { describe, expect, it } from "vitest";
import { sanitizeTerminalText } from "../src/index.js";

describe("terminal text sanitization", () => {
  it("preserves useful newlines while neutralizing terminal control sequences", () => {
    expect(sanitizeTerminalText("safe\rrewrite\r\nnext\tcell\u001b[2J\u009b31m")).toBe(
      "safe\nrewrite\nnext    cell�[2J�31m",
    );
  });
});
