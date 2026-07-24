import { describe, expect, it } from "vitest";
import { extractCodeBlocks } from "../src/tui/code-blocks.js";

describe("extractCodeBlocks", () => {
  it("captures language and body for a fenced block", () => {
    const blocks = extractCodeBlocks(
      ["Intro text", "```bash", "g++ -std=c++11 file.cpp", "./a.out", "```", "Outro"].join("\n"),
    );
    expect(blocks).toEqual([{ lang: "bash", code: "g++ -std=c++11 file.cpp\n./a.out" }]);
  });

  it("captures multiple blocks and omits the language when absent", () => {
    const blocks = extractCodeBlocks(
      ["```", "plain", "```", "between", "```ts", "const x = 1;", "```"].join("\n"),
    );
    expect(blocks).toEqual([{ code: "plain" }, { lang: "ts", code: "const x = 1;" }]);
  });

  it("uses only the first info-string token as the language", () => {
    const blocks = extractCodeBlocks(["```js title=demo", "run();", "```"].join("\n"));
    expect(blocks[0]?.lang).toBe("js");
  });

  it("captures an unterminated trailing fence so streaming replies stay copyable", () => {
    const blocks = extractCodeBlocks(["```python", "print('hi')"].join("\n"));
    expect(blocks).toEqual([{ lang: "python", code: "print('hi')" }]);
  });

  it("does not treat a shorter run of backticks as a closing fence", () => {
    const blocks = extractCodeBlocks(["````", "``` still inside", "````"].join("\n"));
    expect(blocks).toEqual([{ code: "``` still inside" }]);
  });

  it("returns nothing when there is no fenced code", () => {
    expect(extractCodeBlocks("just prose with `inline` code")).toEqual([]);
  });
});
