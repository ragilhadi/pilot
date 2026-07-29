import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * A language server Pilot knows how to start.
 *
 * Two servers, not thirty. TypeScript and Python cover the repositories Pilot is actually used on,
 * and each one here is wired end to end and tested; a table of declarations for languages nobody
 * verified would only make the "unavailable" path more common without making it more useful.
 */
export interface LanguageServerDefinition {
  readonly id: string;
  /** Lower-case file extensions, with the leading dot. */
  readonly extensions: readonly string[];
  /**
   * Files that mark a project root, most specific first. The nearest ancestor containing one wins;
   * without a match the workspace root is used.
   */
  readonly rootMarkers: readonly string[];
  readonly command: string;
  readonly args: readonly string[];
  /** LSP `languageId` for `textDocument/didOpen`. */
  languageId(extension: string): string;
  /** Shown when the binary is missing, so the user knows exactly how to enable it. */
  readonly installHint: string;
  /** Server-specific `initializationOptions`, given the resolved project and workspace roots. */
  initializationOptions?(projectRoot: string, workspaceRoot: string): Record<string, unknown>;
  /**
   * Overrides `command`/`args` when the right server depends on what the project installs.
   * Returning `undefined` falls back to the declared command.
   */
  resolveCommand?(
    projectRoot: string,
    workspaceRoot: string,
  ): Promise<{ readonly command: string; readonly args: readonly string[] } | undefined>;
}

export const typescriptLanguageServer: LanguageServerDefinition = Object.freeze({
  id: "typescript",
  extensions: Object.freeze([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]),
  rootMarkers: Object.freeze(["tsconfig.json", "jsconfig.json", "package.json"]),
  command: "typescript-language-server",
  args: Object.freeze(["--stdio"]),
  languageId: (extension: string) => {
    if (extension === ".tsx") return "typescriptreact";
    if (extension === ".jsx") return "javascriptreact";
    return extension.startsWith(".t") ? "typescript" : "javascript";
  },
  installHint: "npm install -g typescript-language-server typescript",
  // typescript-language-server refuses to start unless it can resolve a `typescript` install, and
  // it looks only from the project root outwards. That fails in exactly the layouts Pilot is used
  // on: a pnpm workspace keeps the real package under the repository root's `.pnpm` store, so a
  // server rooted at `packages/core` finds nothing and exits with "Could not find a valid
  // TypeScript installation". Resolving tsserver ourselves — from the project root first, then the
  // workspace root — and handing over the path makes both layouts work.
  initializationOptions: (projectRoot: string, workspaceRoot: string) => {
    const tsserverPath = resolveFrom("typescript/lib/tsserver.js", [projectRoot, workspaceRoot]);
    return tsserverPath === undefined ? {} : { tsserver: { path: tsserverPath } };
  },
  /**
   * TypeScript 7 replaced `tsserver.js` with a native binary that speaks LSP itself, so a project
   * on 7.x has no tsserver for `typescript-language-server` to drive and that server exits during
   * initialize. Prefer the project's own native binary when there is one; fall back to
   * `typescript-language-server` for 5.x and 6.x.
   */
  resolveCommand: async (projectRoot: string, workspaceRoot: string) => {
    const native = await resolveNativeTypescript([projectRoot, workspaceRoot]);
    // `-stdio` is not optional: `--lsp` alone prints "only stdio is supported" and exits 1.
    return native === undefined ? undefined : { command: native, args: ["--lsp", "-stdio"] };
  },
});

/** First directory from which `specifier` resolves, using Node's own resolution. */
function resolveFrom(specifier: string, directories: readonly string[]): string | undefined {
  for (const directory of directories) {
    try {
      return createRequire(path.join(directory, "package.json")).resolve(specifier);
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Path to the TypeScript >= 7 native executable a project installs, if any. */
async function resolveNativeTypescript(
  directories: readonly string[],
): Promise<string | undefined> {
  const manifestPath = resolveFrom("typescript/package.json", directories);
  if (manifestPath === undefined) return undefined;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version?: unknown };
    const major = Number.parseInt(String(manifest.version ?? "").split(".")[0] ?? "", 10);
    if (!Number.isInteger(major) || major < 7) return undefined;
    // getExePath knows how the platform-specific package is named and where its binary sits, so
    // ask it rather than reimplementing that mapping.
    const module = (await import(
      pathToFileUri(path.join(path.dirname(manifestPath), "lib", "getExePath.js"))
    )) as { default?: () => string };
    const exePath = module.default?.();
    return exePath !== undefined && (await exists(exePath)) ? exePath : undefined;
  } catch {
    return undefined;
  }
}

export const pythonLanguageServer: LanguageServerDefinition = Object.freeze({
  id: "pyright",
  extensions: Object.freeze([".py", ".pyi"]),
  rootMarkers: Object.freeze([
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "Pipfile",
    "requirements.txt",
  ]),
  command: "pyright-langserver",
  args: Object.freeze(["--stdio"]),
  languageId: () => "python",
  installHint: "npm install -g pyright  (or: pip install pyright)",
});

export const builtinLanguageServers: readonly LanguageServerDefinition[] = Object.freeze([
  typescriptLanguageServer,
  pythonLanguageServer,
]);

export function serverForPath(
  servers: readonly LanguageServerDefinition[],
  filePath: string,
): LanguageServerDefinition | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (extension.length === 0) return undefined;
  return servers.find((server) => server.extensions.includes(extension));
}

/**
 * Nearest ancestor of `absolutePath` holding one of the server's root markers, never above
 * `workspaceRoot`.
 *
 * Rooting matters: a server rooted at the repository root in a monorepo loads every project's
 * files, and one rooted too deep misses the `tsconfig.json` that defines the file's types. Walking
 * up to the nearest marker gives a TypeScript app and a Python service in the same repository one
 * correctly-scoped server each, with no configuration.
 */
export async function findProjectRoot(
  server: LanguageServerDefinition,
  absolutePath: string,
  workspaceRoot: string,
): Promise<string> {
  const stopAt = path.resolve(workspaceRoot);
  let directory = path.dirname(path.resolve(absolutePath));
  while (true) {
    for (const marker of server.rootMarkers) {
      if (await exists(path.join(directory, marker))) return directory;
    }
    if (directory === stopAt) return stopAt;
    const parent = path.dirname(directory);
    // Stop at the filesystem root, and never walk out of the workspace.
    if (parent === directory || !isInside(stopAt, parent)) return stopAt;
    directory = parent;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** `file://` URI for an absolute path, with Windows drive letters and separators handled. */
export function pathToFileUri(absolutePath: string): string {
  const normalized = path.resolve(absolutePath).split(path.sep).join("/");
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(withLeadingSlash).replace(/[?#]/gu, (character) =>
    character === "?" ? "%3F" : "%23",
  )}`;
}

export function fileUriToPath(uri: string): string {
  const withoutScheme = decodeURI(uri.replace(/^file:\/\//u, ""));
  const trimmed = /^\/[a-zA-Z]:/u.test(withoutScheme) ? withoutScheme.slice(1) : withoutScheme;
  return path.normalize(trimmed);
}
