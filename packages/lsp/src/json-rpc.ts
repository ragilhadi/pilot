import { PilotError } from "@pilotrun/core";

/**
 * The LSP base protocol: `Content-Length`-framed JSON-RPC 2.0 over a duplex byte stream.
 *
 * Implemented here rather than pulled from `vscode-jsonrpc` because Pilot needs a small slice of
 * the protocol (initialize, three document notifications, publishDiagnostics, shutdown) and the
 * framing is short enough that a dependency costs more than it saves.
 */

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type JsonRpcMessage = JsonRpcNotification | JsonRpcRequest | JsonRpcResponse;

export class LanguageServerProtocolError extends PilotError {
  constructor(message: string, metadata: Readonly<Record<string, unknown>> = {}, cause?: unknown) {
    super({
      code: "PILOT_LSP_PROTOCOL",
      message,
      safeMessage: "The language server returned an invalid message",
      metadata,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

/** Bytes for one framed message. */
export function encodeMessage(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"), body]);
}

/**
 * Incremental decoder for the framed stream.
 *
 * Framing is byte-oriented and a chunk boundary can fall anywhere, including inside a header or
 * mid-way through a multi-byte character — so the buffer is kept as bytes and only the completed
 * body is decoded as UTF-8.
 */
export class MessageDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  /** Appends a chunk and returns every message that became complete. */
  push(chunk: Uint8Array): readonly JsonRpcMessage[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const messages: JsonRpcMessage[] = [];
    while (true) {
      const message = this.#shift();
      if (message === undefined) break;
      messages.push(message);
    }
    return messages;
  }

  #shift(): JsonRpcMessage | undefined {
    const separator = this.#buffer.indexOf("\r\n\r\n");
    if (separator === -1) return undefined;
    const headerText = this.#buffer.subarray(0, separator).toString("ascii");
    const length = contentLength(headerText);
    const bodyStart = separator + 4;
    if (this.#buffer.byteLength < bodyStart + length) return undefined;
    const body = this.#buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    this.#buffer = this.#buffer.subarray(bodyStart + length);
    try {
      return JSON.parse(body) as JsonRpcMessage;
    } catch (error) {
      throw new LanguageServerProtocolError("Language server sent invalid JSON", {}, error);
    }
  }
}

function contentLength(headerText: string): number {
  for (const line of headerText.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    if (line.slice(0, separator).trim().toLowerCase() !== "content-length") continue;
    const value = Number(line.slice(separator + 1).trim());
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new LanguageServerProtocolError("Language server sent an invalid Content-Length", {
        header: line,
      });
    }
    return value;
  }
  throw new LanguageServerProtocolError("Language server message has no Content-Length header");
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && !("method" in message);
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}
