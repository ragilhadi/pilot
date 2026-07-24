import { describe, expect, it } from "vitest";
import { copyToClipboard, encodeOsc52, MAX_OSC52_BASE64_LENGTH } from "../src/tui/clipboard.js";

const ESC = "\u001b";
const BEL = "\u0007";

describe("encodeOsc52", () => {
  it("wraps base64-encoded text in an OSC 52 clipboard sequence", () => {
    const sequence = encodeOsc52("hello");
    const base64 = Buffer.from("hello", "utf8").toString("base64");
    expect(sequence).toBe(`${ESC}]52;c;${base64}${BEL}`);
  });

  it("round-trips UTF-8 content through base64", () => {
    const sequence = encodeOsc52("café ☕");
    const prefix = `${ESC}]52;c;`;
    const payload = sequence?.slice(prefix.length, -1) ?? "";
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe("café ☕");
  });

  it("returns undefined when the payload exceeds the safe size", () => {
    const oversized = "a".repeat(MAX_OSC52_BASE64_LENGTH); // base64 grows ~4/3, so this overflows
    expect(encodeOsc52(oversized)).toBeUndefined();
  });
});

describe("copyToClipboard", () => {
  it("writes the sequence to the terminal and reports success", () => {
    let written = "";
    const ok = copyToClipboard({ write: (data) => (written += data) }, "copy me");
    expect(ok).toBe(true);
    expect(written).toContain(`${ESC}]52;c;`);
  });

  it("does not write and reports failure when the payload is too large", () => {
    let writes = 0;
    const ok = copyToClipboard({ write: () => (writes += 1) }, "a".repeat(MAX_OSC52_BASE64_LENGTH));
    expect(ok).toBe(false);
    expect(writes).toBe(0);
  });
});
