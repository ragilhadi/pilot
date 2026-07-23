export interface ServerSentEvent {
  readonly data: string;
  readonly event?: string;
  readonly id?: string;
}

/** Parses SSE framing across arbitrary byte chunks, including CRLF and multiline data fields. */
export async function* parseServerSentEvents(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<ServerSentEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let firstLine = true;
  let dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  const dispatch = (): ServerSentEvent | undefined => {
    if (dataLines.length === 0) {
      event = undefined;
      return undefined;
    }

    const result = Object.freeze({
      data: dataLines.join("\n"),
      ...(event === undefined ? {} : { event }),
      ...(id === undefined ? {} : { id }),
    });
    dataLines = [];
    event = undefined;
    return result;
  };

  const consumeLine = (rawLine: string): ServerSentEvent | undefined => {
    let line = rawLine;
    if (firstLine) {
      firstLine = false;
      line = line.replace(/^\uFEFF/u, "");
    }
    if (line.length === 0) {
      return dispatch();
    }
    if (line.startsWith(":")) {
      return undefined;
    }

    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    switch (field) {
      case "data":
        dataLines.push(value);
        break;
      case "event":
        event = value;
        break;
      case "id":
        if (!value.includes("\0")) {
          id = value;
        }
        break;
    }
    return undefined;
  };

  const drainLines = (final: boolean): ServerSentEvent[] => {
    const events: ServerSentEvent[] = [];
    while (true) {
      const lineEnding = buffer.search(/[\r\n]/u);
      if (lineEnding < 0) {
        break;
      }
      const character = buffer[lineEnding];
      if (character === "\r" && lineEnding === buffer.length - 1 && !final) {
        break;
      }
      const width = character === "\r" && buffer[lineEnding + 1] === "\n" ? 2 : 1;
      const dispatched = consumeLine(buffer.slice(0, lineEnding));
      buffer = buffer.slice(lineEnding + width);
      if (dispatched !== undefined) {
        events.push(dispatched);
      }
    }
    if (final && buffer.length > 0) {
      const dispatched = consumeLine(buffer);
      buffer = "";
      if (dispatched !== undefined) {
        events.push(dispatched);
      }
    }
    return events;
  };

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    for (const dispatched of drainLines(false)) {
      yield dispatched;
    }
  }

  buffer += decoder.decode();
  for (const dispatched of drainLines(true)) {
    yield dispatched;
  }
  const finalEvent = dispatch();
  if (finalEvent !== undefined) {
    yield finalEvent;
  }
}

export async function* readableStreamChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}
