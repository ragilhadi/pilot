import { describe, expect, it } from "vitest";
import { encodeMessage, LanguageServerProtocolError, MessageDecoder } from "../src/index.js";

describe("LSP base protocol framing", () => {
  it("round-trips a message", () => {
    const decoder = new MessageDecoder();
    const encoded = encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { a: 1 } });
    expect(decoder.push(encoded)).toEqual([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { a: 1 } },
    ]);
  });

  // A chunk boundary can fall anywhere, including inside a header or a multi-byte character, so
  // the decoder buffers bytes rather than text.
  it("reassembles a message split across arbitrary byte boundaries", () => {
    const encoded = encodeMessage({ jsonrpc: "2.0", method: "note", params: { text: "héllo ✓" } });
    for (const size of [1, 2, 7, 13]) {
      const decoder = new MessageDecoder();
      const messages = [];
      for (let offset = 0; offset < encoded.byteLength; offset += size) {
        messages.push(...decoder.push(encoded.subarray(offset, offset + size)));
      }
      expect(messages).toEqual([{ jsonrpc: "2.0", method: "note", params: { text: "héllo ✓" } }]);
    }
  });

  it("returns every complete message in one chunk and keeps the partial tail", () => {
    const decoder = new MessageDecoder();
    const first = encodeMessage({ jsonrpc: "2.0", id: 1, method: "a" });
    const second = encodeMessage({ jsonrpc: "2.0", id: 2, method: "b" });
    const combined = Buffer.concat([first, second]);
    expect(decoder.push(combined.subarray(0, first.byteLength + 4))).toHaveLength(1);
    expect(decoder.push(combined.subarray(first.byteLength + 4))).toEqual([
      { jsonrpc: "2.0", id: 2, method: "b" },
    ]);
  });

  it("measures Content-Length in bytes, not characters", () => {
    const decoder = new MessageDecoder();
    const params = { text: "日本語テキスト" };
    const [message] = decoder.push(encodeMessage({ jsonrpc: "2.0", method: "note", params }));
    expect(message).toEqual({ jsonrpc: "2.0", method: "note", params });
  });

  it("accepts a case-insensitive header and extra headers", () => {
    const decoder = new MessageDecoder();
    const body = Buffer.from('{"jsonrpc":"2.0","method":"x"}', "utf8");
    const framed = Buffer.concat([
      Buffer.from(
        `Content-Type: application/vscode-jsonrpc\r\ncontent-length: ${body.byteLength}\r\n\r\n`,
        "ascii",
      ),
      body,
    ]);
    expect(decoder.push(framed)).toEqual([{ jsonrpc: "2.0", method: "x" }]);
  });

  it("rejects a frame with no Content-Length", () => {
    const decoder = new MessageDecoder();
    expect(() => decoder.push(Buffer.from("Content-Type: x\r\n\r\n{}", "utf8"))).toThrow(
      LanguageServerProtocolError,
    );
  });

  it("rejects a body that is not JSON", () => {
    const decoder = new MessageDecoder();
    expect(() => decoder.push(Buffer.from("Content-Length: 3\r\n\r\nnot", "utf8"))).toThrow(
      LanguageServerProtocolError,
    );
  });
});
