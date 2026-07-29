import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findProjectRoot,
  LanguageServerClient,
  LspDiagnosticsService,
  pythonLanguageServer,
  serverForPath,
  typescriptLanguageServer,
  builtinLanguageServers,
} from "../src/index.js";
import { createFakeLanguageServer, diagnostic } from "./fake-language-server.js";

const signal = () => new AbortController().signal;
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(files: readonly string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pilot-lsp-"));
  workspaces.push(root);
  for (const file of files) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "", "utf8");
  }
  return root;
}

describe("serverForPath", () => {
  it.each([
    ["src/index.ts", "typescript"],
    ["src/app.tsx", "typescript"],
    ["scripts/build.mjs", "typescript"],
    ["api/main.py", "pyright"],
    ["api/types.pyi", "pyright"],
  ])("routes %s to %s", (file, id) => {
    expect(serverForPath(builtinLanguageServers, file)?.id).toBe(id);
  });

  it.each(["README.md", "Cargo.toml", "notes", "image.png"])("has no server for %s", (file) => {
    expect(serverForPath(builtinLanguageServers, file)).toBeUndefined();
  });
});

describe("findProjectRoot", () => {
  // A server rooted at the repository root in a monorepo loads every project; one rooted too deep
  // misses the tsconfig that defines the file's types.
  it("roots each project at its own nearest marker", async () => {
    const root = await workspace([
      "package.json",
      "apps/web/tsconfig.json",
      "apps/web/src/index.ts",
      "services/api/pyproject.toml",
      "services/api/app/main.py",
    ]);

    await expect(
      findProjectRoot(typescriptLanguageServer, path.join(root, "apps/web/src/index.ts"), root),
    ).resolves.toBe(path.join(root, "apps/web"));
    await expect(
      findProjectRoot(pythonLanguageServer, path.join(root, "services/api/app/main.py"), root),
    ).resolves.toBe(path.join(root, "services/api"));
  });

  it("falls back to the workspace root when no marker exists", async () => {
    const root = await workspace(["src/index.ts"]);
    await expect(
      findProjectRoot(typescriptLanguageServer, path.join(root, "src/index.ts"), root),
    ).resolves.toBe(root);
  });

  it("never walks above the workspace root", async () => {
    const root = await workspace(["nested/deep/src/index.ts"]);
    const inner = path.join(root, "nested");
    await expect(
      findProjectRoot(typescriptLanguageServer, path.join(root, "nested/deep/src/index.ts"), inner),
    ).resolves.toBe(inner);
  });
});

describe("LspDiagnosticsService", () => {
  function service(
    root: string,
    options: Parameters<typeof createFakeLanguageServer>[0] = {},
    extra: { readonly timeoutMs?: number; readonly maximumItems?: number } = {},
  ) {
    const servers: LanguageServerClient[] = [];
    const subject = new LspDiagnosticsService({
      workspacePath: root,
      timeoutMs: extra.timeoutMs ?? 500,
      ...(extra.maximumItems === undefined ? {} : { maximumItems: extra.maximumItems }),
      createClient: (definition, rootPath) => {
        const fake = createFakeLanguageServer(options);
        const created = new LanguageServerClient({
          definition,
          rootPath,
          spawnProcess: () => fake.process,
        });
        servers.push(created);
        return created;
      },
    });
    return { subject, servers };
  }

  it("reports errors for the file just written", async () => {
    const root = await workspace(["tsconfig.json", "src/index.ts"]);
    const { subject } = service(root, {
      publishOnVersion: () => [
        diagnostic(4, 2, "Type 'string' is not assignable to type 'number'."),
      ],
    });

    const report = await subject.check({
      path: "src/index.ts",
      content: "const x: number = 'a';",
      signal: signal(),
    });
    expect(report).toMatchObject({
      status: "ready",
      errorCount: 1,
      warningCount: 0,
      items: [{ severity: "error", line: 5, column: 3 }],
    });
    await subject.shutdown();
  });

  it("reports a clean file as ready with no items", async () => {
    const root = await workspace(["tsconfig.json", "src/index.ts"]);
    const { subject } = service(root, { publishOnVersion: () => [] });
    await expect(
      subject.check({ path: "src/index.ts", content: "export const a = 1;", signal: signal() }),
    ).resolves.toMatchObject({ status: "ready", items: [], errorCount: 0 });
    await subject.shutdown();
  });

  // "No server for this file type" must never be mistaken for "this file is clean".
  it("marks a file type with no server as unsupported", async () => {
    const root = await workspace(["README.md"]);
    const { subject } = service(root);
    await expect(
      subject.check({ path: "README.md", content: "# hi", signal: signal() }),
    ).resolves.toMatchObject({ status: "unsupported", items: [] });
  });

  it("marks a silent server as timeout rather than clean", async () => {
    const root = await workspace(["tsconfig.json", "src/index.ts"]);
    const { subject } = service(root, { publishOnVersion: () => undefined }, { timeoutMs: 40 });
    const report = await subject.check({
      path: "src/index.ts",
      content: "x",
      signal: signal(),
    });
    expect(report.status).toBe("timeout");
    expect(report.detail).toContain("unknown rather than clean");
    await subject.shutdown();
  });

  it("reports a server that will not start as unavailable, with the install command", async () => {
    const root = await workspace(["tsconfig.json", "src/index.ts"]);
    const subject = new LspDiagnosticsService({
      workspacePath: root,
      createClient: (definition, rootPath) =>
        new LanguageServerClient({
          definition,
          rootPath,
          spawnProcess: () => {
            throw new Error("spawn ENOENT");
          },
        }),
    });
    const report = await subject.check({
      path: "src/index.ts",
      content: "x",
      signal: signal(),
    });
    expect(report.status).toBe("unavailable");
    expect(report.detail).toContain("typescript-language-server");
  });

  // Retrying a missing binary on every edit would add its spawn cost to every write.
  it("only tries an unavailable server once", async () => {
    const root = await workspace(["tsconfig.json", "src/index.ts"]);
    let attempts = 0;
    const subject = new LspDiagnosticsService({
      workspacePath: root,
      createClient: (definition, rootPath) => {
        attempts += 1;
        return new LanguageServerClient({
          definition,
          rootPath,
          spawnProcess: () => {
            throw new Error("spawn ENOENT");
          },
        });
      },
    });
    await subject.check({ path: "src/index.ts", content: "a", signal: signal() });
    await subject.check({ path: "src/index.ts", content: "b", signal: signal() });
    expect(attempts).toBe(1);
    expect([...subject.unavailableServers().keys()]).toEqual(["typescript"]);
  });

  it("reuses one server per project root and starts separate ones per project", async () => {
    const root = await workspace([
      "apps/web/tsconfig.json",
      "apps/web/src/a.ts",
      "apps/web/src/b.ts",
      "apps/admin/tsconfig.json",
      "apps/admin/src/c.ts",
    ]);
    const { subject, servers } = service(root, { publishOnVersion: () => [] });

    await subject.check({ path: "apps/web/src/a.ts", content: "a", signal: signal() });
    await subject.check({ path: "apps/web/src/b.ts", content: "b", signal: signal() });
    expect(servers).toHaveLength(1);

    await subject.check({ path: "apps/admin/src/c.ts", content: "c", signal: signal() });
    expect(servers).toHaveLength(2);
    expect(servers.map(({ rootPath }) => rootPath)).toEqual([
      path.join(root, "apps/web"),
      path.join(root, "apps/admin"),
    ]);
    await subject.shutdown();
  });

  it("orders errors before warnings and truncates the tail", async () => {
    const root = await workspace(["tsconfig.json", "src/index.ts"]);
    const { subject } = service(
      root,
      {
        publishOnVersion: () => [
          diagnostic(9, 0, "warning one", 2),
          diagnostic(1, 0, "error one", 1),
          diagnostic(2, 0, "error two", 1),
        ],
      },
      { maximumItems: 2 },
    );
    const report = await subject.check({ path: "src/index.ts", content: "x", signal: signal() });
    expect(report.items.map(({ message }) => message)).toEqual(["error one", "error two"]);
    expect(report).toMatchObject({ errorCount: 2, warningCount: 1, truncated: true });
    await subject.shutdown();
  });
});
