import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PilotError, type WorkspaceDiagnostic } from "@pilotrun/core";
import { resolveInvocation } from "./executable-lookup.js";
import {
  encodeMessage,
  isNotification,
  isRequest,
  isResponse,
  MessageDecoder,
  type JsonRpcMessage,
} from "./json-rpc.js";
import { fileUriToPath, pathToFileUri, type LanguageServerDefinition } from "./server-registry.js";

export class LanguageServerUnavailableError extends PilotError {
  constructor(serverId: string, installHint: string, reason?: string, cause?: unknown) {
    super({
      code: "PILOT_LSP_UNAVAILABLE",
      // The server's own words matter here. "typescript-language-server could not be started" sends
      // the user hunting for a missing binary; "Could not find a valid TypeScript installation"
      // tells them the actual problem, which is usually a missing dependency in the project.
      message:
        reason === undefined
          ? `Language server ${serverId} could not be started`
          : `Language server ${serverId} could not be started: ${reason}`,
      safeMessage: `Diagnostics are unavailable: install it with \`${installHint}\``,
      metadata: { serverId, installHint, ...(reason === undefined ? {} : { reason }) },
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface PublishedDiagnostics {
  readonly version: number | undefined;
  readonly items: readonly WorkspaceDiagnostic[];
  readonly receivedAt: number;
}

export interface LanguageServerClientOptions {
  readonly definition: LanguageServerDefinition;
  readonly rootPath: string;
  /** Workspace root, used as a fallback when resolving server-side tooling. */
  readonly workspaceRoot?: string;
  /** Injected in tests to avoid spawning a real server. */
  readonly spawnProcess?: () =>
    | ChildProcessWithoutNullStreams
    | Promise<ChildProcessWithoutNullStreams>;
  readonly now?: () => number;
}

/**
 * One language-server process, driven over stdio.
 *
 * Owns exactly the slice of LSP that diagnostics need: the initialize handshake, document
 * open/change/close, and `publishDiagnostics`. Everything else the server sends — progress,
 * telemetry, registration requests — is acknowledged or ignored so a chatty server cannot wedge
 * the client.
 */
export class LanguageServerClient {
  readonly definition: LanguageServerDefinition;
  readonly rootPath: string;
  readonly #workspaceRoot: string;
  readonly #now: () => number;
  readonly #spawnProcess: () =>
    | ChildProcessWithoutNullStreams
    | Promise<ChildProcessWithoutNullStreams>;
  readonly #decoder = new MessageDecoder();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #diagnostics = new Map<string, PublishedDiagnostics>();
  readonly #waiters = new Set<(uri: string) => void>();
  readonly #openVersions = new Map<string, number>();
  #process: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  #ready: Promise<void> | undefined;
  #stopped = false;
  #exitReason: string | undefined;
  #supportsPullDiagnostics = false;

  constructor(options: LanguageServerClientOptions) {
    this.definition = options.definition;
    this.rootPath = options.rootPath;
    this.#workspaceRoot = options.workspaceRoot ?? options.rootPath;
    this.#now = options.now ?? (() => Date.now());
    this.#spawnProcess =
      options.spawnProcess ??
      (async () => {
        // A project may install its own server binary; only fall back to a PATH lookup when it
        // has not.
        const resolved = await options.definition.resolveCommand?.(
          options.rootPath,
          options.workspaceRoot ?? options.rootPath,
        );
        const invocation = await resolveInvocation(
          resolved?.command ?? options.definition.command,
          resolved?.args ?? options.definition.args,
        );
        return spawn(invocation.executable, [...invocation.args], {
          cwd: options.rootPath,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
          ...(invocation.windowsVerbatimArguments === true
            ? { windowsVerbatimArguments: true }
            : {}),
        }) as ChildProcessWithoutNullStreams;
      });
  }

  /** Starts and initializes the server at most once; later calls await the same handshake. */
  start(): Promise<void> {
    this.#ready ??= this.#startOnce();
    return this.#ready;
  }

  async #startOnce(): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = await this.#spawnProcess();
    } catch (error) {
      throw new LanguageServerUnavailableError(
        this.definition.id,
        this.definition.installHint,
        error instanceof Error ? error.message : undefined,
        error,
      );
    }
    this.#process = child;

    // ENOENT arrives asynchronously on 'error', so a spawn that "succeeded" can still be a missing
    // binary. Fail the handshake rather than hanging until the request timeout.
    const spawnFailure = new Promise<never>((_resolve, reject) => {
      child.once("error", (error) => {
        this.#exitReason = "the server executable could not be started";
        reject(
          new LanguageServerUnavailableError(
            this.definition.id,
            this.definition.installHint,
            error instanceof Error ? error.message : undefined,
            error,
          ),
        );
      });
      child.once("exit", (code) => {
        this.#exitReason = `the server exited with code ${code ?? "unknown"}`;
        this.#failPending(
          new LanguageServerUnavailableError(
            this.definition.id,
            this.definition.installHint,
            this.#exitReason,
          ),
        );
      });
    });

    child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
    // Drained and discarded: an unread stderr pipe fills and blocks the server.
    child.stderr.resume();

    const initializeResult = await Promise.race([
      this.#request("initialize", {
        processId: process.pid,
        clientInfo: { name: "pilot" },
        rootUri: pathToFileUri(this.rootPath),
        workspaceFolders: [
          {
            uri: pathToFileUri(this.rootPath),
            name: this.rootPath.split(/[\\/]/u).at(-1) ?? "root",
          },
        ],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            publishDiagnostics: { relatedInformation: false, versionSupport: true },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          },
          workspace: { workspaceFolders: true, configuration: true },
        },
        initializationOptions:
          this.definition.initializationOptions?.(this.rootPath, this.#workspaceRoot) ?? {},
      }),
      spawnFailure,
    ]);
    // LSP 3.17 lets a server publish diagnostics (push) or expect the client to ask (pull).
    // TypeScript 7's native server only pulls, and waiting for a publish it will never send reads
    // as a timeout on every single edit.
    this.#supportsPullDiagnostics = hasDiagnosticProvider(initializeResult);
    this.#notify("initialized", {});
  }

  /**
   * Makes the server aware of the file's current content and returns the diagnostics it publishes
   * for that exact revision.
   *
   * Freshness is the whole point. Reporting the previous revision's diagnostics after an edit would
   * send the model chasing an error it already fixed, so a publish only counts when the server
   * echoes a version at least as new as the one just sent, or (for servers that omit the version)
   * when it arrives after the change was sent. If nothing fresh arrives in the budget the caller
   * gets `undefined` and reports a timeout — never stale data.
   */
  async diagnose(
    absolutePath: string,
    content: string,
    extension: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<readonly WorkspaceDiagnostic[] | undefined> {
    await this.start();
    const uri = pathToFileUri(absolutePath);
    const previousVersion = this.#openVersions.get(uri);
    const version = (previousVersion ?? 0) + 1;
    this.#openVersions.set(uri, version);
    const sentAt = this.#now();

    if (previousVersion === undefined) {
      this.#notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.definition.languageId(extension),
          version,
          text: content,
        },
      });
    } else {
      this.#notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    }

    const fresh = (): readonly WorkspaceDiagnostic[] | undefined => {
      const published = this.#diagnostics.get(uri);
      if (published === undefined) return undefined;
      if (published.version !== undefined) {
        return published.version >= version ? published.items : undefined;
      }
      return published.receivedAt >= sentAt ? published.items : undefined;
    };

    if (this.#supportsPullDiagnostics) return this.#pull(uri, timeoutMs, signal);
    const immediate = fresh();
    if (immediate !== undefined) return immediate;
    return this.#awaitPublish(uri, fresh, timeoutMs, signal);
  }

  /**
   * Asks the server for this document's diagnostics and waits for the answer.
   *
   * A pull response describes the document the server has just been told about, so it is fresh by
   * construction — no version handshake needed. The timeout still yields `undefined` rather than
   * anything stale.
   */
  async #pull(
    uri: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<readonly WorkspaceDiagnostic[] | undefined> {
    const abandon = new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      timer.unref?.();
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve(undefined);
        },
        { once: true },
      );
    });
    try {
      const result = await Promise.race([
        this.#request("textDocument/diagnostic", { textDocument: { uri } }),
        abandon,
      ]);
      if (result === undefined) return undefined;
      const report = result as { kind?: unknown; items?: unknown };
      if (!Array.isArray(report.items)) return undefined;
      return Object.freeze(report.items.flatMap((entry) => toWorkspaceDiagnostic(entry)));
    } catch {
      return undefined;
    }
  }

  #awaitPublish(
    uri: string,
    fresh: () => readonly WorkspaceDiagnostic[] | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<readonly WorkspaceDiagnostic[] | undefined> {
    return new Promise((resolve) => {
      const settle = (value: readonly WorkspaceDiagnostic[] | undefined) => {
        clearTimeout(timer);
        this.#waiters.delete(listener);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const listener = (published: string) => {
        if (published !== uri) return;
        const items = fresh();
        if (items !== undefined) settle(items);
      };
      const onAbort = () => settle(undefined);
      const timer = setTimeout(() => settle(undefined), timeoutMs);
      timer.unref?.();
      this.#waiters.add(listener);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  get exitReason(): string | undefined {
    return this.#exitReason;
  }

  async stop(graceMs = 1_000): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const child = this.#process;
    if (child === undefined) return;
    try {
      // Politely first: an abrupt kill can leave a pyright worker behind.
      await Promise.race([
        this.#request("shutdown", null),
        new Promise((resolve) => setTimeout(resolve, graceMs).unref?.()),
      ]);
      this.#notify("exit", undefined);
    } catch {
      // A server that is already gone needs no shutdown.
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, graceMs);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      if (child.exitCode !== null) {
        clearTimeout(timer);
        resolve();
      }
    });
    this.#failPending(
      new LanguageServerUnavailableError(
        this.definition.id,
        this.definition.installHint,
        "the server was shut down",
      ),
    );
  }

  #receive(chunk: Buffer): void {
    let messages: readonly JsonRpcMessage[];
    try {
      messages = this.#decoder.push(chunk);
    } catch {
      // A desynchronized stream cannot be recovered by guessing; drop the rest and let requests
      // time out into an "unavailable" report.
      return;
    }
    for (const message of messages) this.#dispatch(message);
  }

  #dispatch(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      const pending = typeof message.id === "number" ? this.#pending.get(message.id) : undefined;
      if (pending === undefined) return;
      this.#pending.delete(message.id as number);
      if (message.error === undefined) pending.resolve(message.result);
      else {
        pending.reject(
          new LanguageServerUnavailableError(
            this.definition.id,
            this.definition.installHint,
            message.error.message,
          ),
        );
      }
      return;
    }
    if (isRequest(message)) {
      // Servers ask for configuration and dynamic registration during startup and block until
      // answered. Empty answers are valid and keep the handshake moving.
      this.#send({
        jsonrpc: "2.0",
        id: message.id,
        result: message.method === "workspace/configuration" ? [{}] : null,
      });
      return;
    }
    if (isNotification(message) && message.method === "textDocument/publishDiagnostics") {
      this.#storeDiagnostics(message.params);
    }
  }

  #storeDiagnostics(params: unknown): void {
    if (typeof params !== "object" || params === null) return;
    const payload = params as {
      uri?: unknown;
      version?: unknown;
      diagnostics?: unknown;
    };
    if (typeof payload.uri !== "string" || !Array.isArray(payload.diagnostics)) return;
    const uri = pathToFileUri(fileUriToPath(payload.uri));
    this.#diagnostics.set(uri, {
      version: typeof payload.version === "number" ? payload.version : undefined,
      items: Object.freeze(payload.diagnostics.flatMap((entry) => toWorkspaceDiagnostic(entry))),
      receivedAt: this.#now(),
    });
    for (const waiter of [...this.#waiters]) waiter(uri);
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  #notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  #send(message: JsonRpcMessage): void {
    const child = this.#process;
    if (child === undefined || child.stdin.destroyed) return;
    child.stdin.write(encodeMessage(message));
  }

  #failPending(error: unknown): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(error);
    }
    for (const waiter of [...this.#waiters]) waiter("");
  }
}

function hasDiagnosticProvider(initializeResult: unknown): boolean {
  if (typeof initializeResult !== "object" || initializeResult === null) return false;
  const capabilities = (initializeResult as { capabilities?: unknown }).capabilities;
  if (typeof capabilities !== "object" || capabilities === null) return false;
  return (capabilities as { diagnosticProvider?: unknown }).diagnosticProvider !== undefined;
}

/**
 * Converts one LSP diagnostic, dropping hints and information.
 *
 * Those two severities are editor affordances — "this import could be a type import", "this
 * variable is unused in a way the linter tolerates". Forwarding them spends prompt tokens on
 * non-defects and teaches the model to skim the field that is supposed to mean "you broke it".
 */
function toWorkspaceDiagnostic(entry: unknown): readonly WorkspaceDiagnostic[] {
  if (typeof entry !== "object" || entry === null) return [];
  const diagnostic = entry as {
    range?: { start?: { line?: unknown; character?: unknown } };
    severity?: unknown;
    message?: unknown;
    source?: unknown;
    code?: unknown;
  };
  const severity =
    diagnostic.severity === 1 ? "error" : diagnostic.severity === 2 ? "warning" : undefined;
  if (severity === undefined) return [];
  if (typeof diagnostic.message !== "string" || diagnostic.message.trim().length === 0) return [];
  const line = diagnostic.range?.start?.line;
  const character = diagnostic.range?.start?.character;
  return [
    Object.freeze({
      severity,
      // LSP positions are zero-based; every human-facing surface in Pilot is one-based.
      line: typeof line === "number" ? line + 1 : 1,
      column: typeof character === "number" ? character + 1 : 1,
      message: diagnostic.message.trim(),
      ...(typeof diagnostic.source === "string" && diagnostic.source.length > 0
        ? { source: diagnostic.source }
        : {}),
      ...(typeof diagnostic.code === "string" || typeof diagnostic.code === "number"
        ? { code: String(diagnostic.code) }
        : {}),
    }),
  ];
}
