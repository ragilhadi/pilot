import { describe, expect, it } from "vitest";
import { parseServerSentEvents } from "../src/index.js";

const encoder = new TextEncoder();

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield encoder.encode(value);
  }
}

describe("parseServerSentEvents", () => {
  it("handles a BOM, CRLF, comments, fields split across chunks, and multiline data", async () => {
    const events = [];

    for await (const event of parseServerSentEvents(
      chunks(
        "\uFEFF: keepalive\r\nid: event-1\r\nevent: message\r\nda",
        "ta: first\r\ndata: second\r\n\r\n",
      ),
    )) {
      events.push(event);
    }

    expect(events).toEqual([{ id: "event-1", event: "message", data: "first\nsecond" }]);
  });

  it("dispatches a final event when the stream omits its trailing blank line", async () => {
    const events = [];

    for await (const event of parseServerSentEvents(chunks("data: final"))) {
      events.push(event);
    }

    expect(events).toEqual([{ data: "final" }]);
  });

  it("persists the last event ID and ignores retry fields", async () => {
    const events = [];

    for await (const event of parseServerSentEvents(
      chunks("id: 7\ndata: one\n\nretry: 1000\ndata: two\n\n"),
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { id: "7", data: "one" },
      { id: "7", data: "two" },
    ]);
  });

  it("accepts bare CR line endings split at a chunk boundary", async () => {
    const events = [];

    for await (const event of parseServerSentEvents(chunks("data: one\r", "\rdata: two\r\r"))) {
      events.push(event);
    }

    expect(events).toEqual([{ data: "one" }, { data: "two" }]);
  });
});
