import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { encodeMessage, MessageDecoder, type JsonRpcMessage } from "../src/index.js";

export interface FakeServerOptions {
  /** Diagnostics to publish, keyed by the document version that triggers them. */
  readonly publishOnVersion?: (version: number, uri: string) => unknown[] | undefined;
  /** Echo the version back in publishDiagnostics; some real servers omit it. */
  readonly reportVersion?: boolean;
  /** Delay before publishing, to exercise the wait path. */
  readonly publishDelayMs?: number;
  /** Never answer `initialize`, to exercise a hung server. */
  readonly stallInitialize?: boolean;
  /** Advertise and serve LSP 3.17 pull diagnostics instead of pushing them. */
  readonly pullDiagnostics?: boolean;
}

export interface FakeLanguageServer {
  readonly process: ChildProcessWithoutNullStreams;
  readonly received: JsonRpcMessage[];
  exit(code?: number): void;
}

/**
 * A language server that speaks the real framed protocol over in-memory pipes.
 *
 * Testing against a stub object would leave the framing, the handshake, and the version handling
 * untested — which is where every bug in this package would live.
 */
export function createFakeLanguageServer(options: FakeServerOptions = {}): FakeLanguageServer {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  Object.assign(emitter, { stdin, stdout, stderr, pid: 4_242, exitCode: null, kill: () => true });

  const received: JsonRpcMessage[] = [];
  const lastVersion = new Map<string, number>();
  const decoder = new MessageDecoder();
  const send = (message: JsonRpcMessage) => stdout.write(encodeMessage(message));

  stdin.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      received.push(message);
      handle(message);
    }
  });

  function handle(message: JsonRpcMessage): void {
    if (!("method" in message)) return;
    if (message.method === "initialize") {
      if (options.stallInitialize) return;
      send({
        jsonrpc: "2.0",
        id: (message as { id: number }).id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            ...(options.pullDiagnostics ? { diagnosticProvider: { interFileDependencies: true } } : {}),
          },
        },
      });
      return;
    }
    if (message.method === "textDocument/diagnostic") {
      const uri = (message.params as { textDocument: { uri: string } }).textDocument.uri;
      const items = options.publishOnVersion?.(lastVersion.get(uri) ?? 1, uri) ?? [];
      send({
        jsonrpc: "2.0",
        id: (message as { id: number }).id,
        result: { kind: "full", items },
      });
      return;
    }
    if (message.method === "shutdown") {
      send({ jsonrpc: "2.0", id: (message as { id: number }).id, result: null });
      return;
    }
    if (
      message.method === "textDocument/didOpen" ||
      message.method === "textDocument/didChange"
    ) {
      const params = message.params as {
        textDocument: { uri: string; version: number };
      };
      const { uri, version } = params.textDocument;
      lastVersion.set(uri, version);
      if (options.pullDiagnostics) return;
      const diagnostics = options.publishOnVersion?.(version, uri);
      if (diagnostics === undefined) return;
      const publish = () =>
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            uri,
            ...(options.reportVersion === false ? {} : { version }),
            diagnostics,
          },
        });
      if (options.publishDelayMs === undefined) publish();
      else setTimeout(publish, options.publishDelayMs).unref?.();
    }
  }

  return {
    process: emitter,
    received,
    exit: (code = 0) => {
      Object.assign(emitter, { exitCode: code });
      emitter.emit("exit", code, null);
    },
  };
}

export function diagnostic(
  line: number,
  character: number,
  message: string,
  severity = 1,
): unknown {
  return {
    range: { start: { line, character }, end: { line, character: character + 1 } },
    severity,
    message,
    source: "ts",
    code: 2339,
  };
}
