import path from "node:path";
import { describe, expect, it } from "vitest";
import { LanguageServerClient, pathToFileUri, typescriptLanguageServer } from "../src/index.js";
import {
  createFakeLanguageServer,
  diagnostic,
  type FakeServerOptions,
} from "./fake-language-server.js";

const workspace = path.resolve("/workspace/project");
const file = path.join(workspace, "src", "index.ts");
const signal = () => new AbortController().signal;

function client(options: FakeServerOptions = {}) {
  const server = createFakeLanguageServer(options);
  const subject = new LanguageServerClient({
    definition: typescriptLanguageServer,
    rootPath: workspace,
    spawnProcess: () => server.process,
  });
  return { server, subject };
}

describe("LanguageServerClient", () => {
  it("performs the initialize handshake before any document notification", async () => {
    const { server, subject } = client({ publishOnVersion: () => [] });
    await subject.diagnose(file, "export const a = 1;", ".ts", 500, signal());

    const methods = server.received.flatMap((message) =>
      "method" in message ? [message.method] : [],
    );
    expect(methods.slice(0, 3)).toEqual(["initialize", "initialized", "textDocument/didOpen"]);
  });

  it("opens a document once and sends didChange afterwards", async () => {
    const { server, subject } = client({ publishOnVersion: () => [] });
    await subject.diagnose(file, "first", ".ts", 500, signal());
    await subject.diagnose(file, "second", ".ts", 500, signal());

    const methods = server.received.flatMap((message) =>
      "method" in message ? [message.method] : [],
    );
    expect(methods.filter((method) => method === "textDocument/didOpen")).toHaveLength(1);
    expect(methods.filter((method) => method === "textDocument/didChange")).toHaveLength(1);
  });

  it("converts LSP positions to the one-based coordinates the rest of Pilot uses", async () => {
    const { subject } = client({
      publishOnVersion: () => [diagnostic(41, 8, "Property 'nmae' does not exist on type 'User'.")],
    });
    const items = await subject.diagnose(file, "x", ".ts", 500, signal());
    expect(items).toEqual([
      {
        severity: "error",
        line: 42,
        column: 9,
        message: "Property 'nmae' does not exist on type 'User'.",
        source: "ts",
        code: "2339",
      },
    ]);
  });

  it("drops hints and information, keeping errors and warnings", async () => {
    const { subject } = client({
      publishOnVersion: () => [
        diagnostic(0, 0, "an error", 1),
        diagnostic(1, 0, "a warning", 2),
        diagnostic(2, 0, "an information note", 3),
        diagnostic(3, 0, "a hint", 4),
      ],
    });
    const items = await subject.diagnose(file, "x", ".ts", 500, signal());
    expect(items?.map(({ severity, message }) => `${severity}:${message}`)).toEqual([
      "error:an error",
      "warning:a warning",
    ]);
  });

  it("waits for a publish that arrives after the change", async () => {
    const { subject } = client({
      publishDelayMs: 20,
      publishOnVersion: () => [diagnostic(0, 0, "late but fresh")],
    });
    const items = await subject.diagnose(file, "x", ".ts", 1_000, signal());
    expect(items?.[0]?.message).toBe("late but fresh");
  });

  // The whole point of the version handshake: a report for the previous revision would send the
  // model chasing an error it already fixed.
  it("never reports diagnostics published for an older version", async () => {
    const { subject } = client({
      publishOnVersion: (version) =>
        version === 1 ? [diagnostic(0, 0, "stale error from before the edit")] : undefined,
    });
    const first = await subject.diagnose(file, "broken", ".ts", 500, signal());
    expect(first?.[0]?.message).toBe("stale error from before the edit");

    const second = await subject.diagnose(file, "fixed", ".ts", 100, signal());
    expect(second).toBeUndefined();
  });

  it("accepts a fresh publish from a server that omits the version", async () => {
    const { subject } = client({
      reportVersion: false,
      publishOnVersion: (version) => [diagnostic(0, 0, `for version ${version}`)],
    });
    expect((await subject.diagnose(file, "a", ".ts", 500, signal()))?.[0]?.message).toBe(
      "for version 1",
    );
    expect((await subject.diagnose(file, "b", ".ts", 500, signal()))?.[0]?.message).toBe(
      "for version 2",
    );
  });

  it("returns undefined rather than blocking forever when the server stays silent", async () => {
    const { subject } = client({ publishOnVersion: () => undefined });
    expect(await subject.diagnose(file, "x", ".ts", 50, signal())).toBeUndefined();
  });

  it("gives up when the caller aborts", async () => {
    const { subject } = client({ publishOnVersion: () => undefined });
    const controller = new AbortController();
    const pending = subject.diagnose(file, "x", ".ts", 10_000, controller.signal);
    controller.abort();
    expect(await pending).toBeUndefined();
  });

  it("answers the configuration request servers block on during startup", async () => {
    const { server, subject } = client({ publishOnVersion: () => [] });
    const started = subject.start();
    server.process.stdout.write(
      Buffer.from(
        `Content-Length: 64\r\n\r\n${JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "workspace/configuration",
        }).padEnd(64, " ")}`,
        "utf8",
      ),
    );
    await started;
    await subject.diagnose(file, "x", ".ts", 200, signal());
    expect(server.received.some((message) => "method" in message)).toBe(true);
  });

  it("reports a server that exits during startup as unavailable", async () => {
    const { server, subject } = client({ stallInitialize: true });
    const started = subject.start();
    // Spawning resolves the command first, so the client attaches its listeners a tick later.
    await new Promise((resolve) => setTimeout(resolve, 5));
    server.process.emit("error", new Error("spawn ENOENT"));
    await expect(started).rejects.toMatchObject({ code: "PILOT_LSP_UNAVAILABLE" });
  });

  it("uses the file URI the server published, normalized", async () => {
    const { subject } = client({
      publishOnVersion: (_version, uri) => {
        expect(uri).toBe(pathToFileUri(file));
        return [diagnostic(0, 0, "matched")];
      },
    });
    expect((await subject.diagnose(file, "x", ".ts", 500, signal()))?.[0]?.message).toBe("matched");
  });
});

describe("pull diagnostics", () => {
  // LSP 3.17 lets a server expect the client to ask rather than publish. TypeScript 7's native
  // server only pulls; waiting for a push it will never send reads as a timeout on every edit.
  it("asks the server when it advertises a diagnosticProvider", async () => {
    const { server, subject } = client({
      pullDiagnostics: true,
      publishOnVersion: () => [diagnostic(2, 4, "pulled error")],
    });
    const items = await subject.diagnose(file, "x", ".ts", 500, signal());

    expect(items).toEqual([
      {
        severity: "error",
        line: 3,
        column: 5,
        message: "pulled error",
        source: "ts",
        code: "2339",
      },
    ]);
    const methods = server.received.flatMap((message) =>
      "method" in message ? [message.method] : [],
    );
    expect(methods).toContain("textDocument/diagnostic");
  });

  it("still reflects the newest content on a second check", async () => {
    const { subject } = client({
      pullDiagnostics: true,
      publishOnVersion: (version) => (version === 1 ? [diagnostic(0, 0, "first revision")] : []),
    });
    expect((await subject.diagnose(file, "a", ".ts", 500, signal()))?.[0]?.message).toBe(
      "first revision",
    );
    expect(await subject.diagnose(file, "b", ".ts", 500, signal())).toEqual([]);
  });

  it("does not pull from a server that only pushes", async () => {
    const { server, subject } = client({ publishOnVersion: () => [] });
    await subject.diagnose(file, "x", ".ts", 500, signal());
    const methods = server.received.flatMap((message) =>
      "method" in message ? [message.method] : [],
    );
    expect(methods).not.toContain("textDocument/diagnostic");
  });
});
