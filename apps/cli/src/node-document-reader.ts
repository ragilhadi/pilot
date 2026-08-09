import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  DocumentDirectoryEntry,
  DocumentDirectoryReader,
  DocumentDirectoryRequest,
  DocumentListResult,
  DocumentReadRequest,
  DocumentReadResult,
  DocumentRejectionReason,
} from "@pilotrun/agent-runtime";

/**
 * Reads the bounded UTF-8 text documents that live beside the code — `AGENTS.md` instruction
 * files, skill definitions, and prompt templates.
 *
 * Workspace paths are confined twice: lexically before any I/O, and again against the real path
 * after symlink resolution, so neither a `..` segment nor a symlink can read outside the
 * repository. Global paths are the user's own data directory and are read as given.
 */
export class NodeWorkspaceDocumentReader implements DocumentDirectoryReader {
  readonly #workspaceRoot: string;
  readonly #workspaceRealRoot: string;

  private constructor(workspaceRoot: string, workspaceRealRoot: string) {
    this.#workspaceRoot = workspaceRoot;
    this.#workspaceRealRoot = workspaceRealRoot;
  }

  static async create(workspaceRoot: string): Promise<NodeWorkspaceDocumentReader> {
    const resolved = path.resolve(workspaceRoot);
    return new NodeWorkspaceDocumentReader(resolved, await realpath(resolved));
  }

  async read(request: DocumentReadRequest): Promise<DocumentReadResult> {
    const candidate = this.#resolve(request);
    if (candidate === undefined) {
      return rejected("outside-workspace", "The document path escapes the workspace");
    }
    try {
      const real = await realpath(candidate);
      if (request.kind === "workspace" && !isContained(this.#workspaceRealRoot, real)) {
        return rejected("outside-workspace", "The document symlink resolves outside the workspace");
      }
      const metadata = await stat(real);
      if (!metadata.isFile()) return rejected("read-failed", "The document path is not a file");
      if (metadata.size > request.maximumBytes) {
        return rejected("too-large", `The document exceeds ${request.maximumBytes} bytes`);
      }
      const bytes = await readFile(real);
      if (bytes.byteLength > request.maximumBytes) {
        return rejected("too-large", `The document exceeds ${request.maximumBytes} bytes`);
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return rejected("read-failed", "The document is not valid UTF-8");
      }
      return Object.freeze({
        status: "found",
        displayPath: request.kind === "global" ? candidate : request.path,
        realPath: real,
        content,
        bytes: bytes.byteLength,
      });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return Object.freeze({ status: "missing" });
      return rejected("read-failed", `The document read failed (${errorCode(error) ?? "unknown"})`);
    }
  }

  async list(request: DocumentDirectoryRequest): Promise<DocumentListResult> {
    const candidate = this.#resolve(request);
    if (candidate === undefined) {
      return rejected("outside-workspace", "The directory path escapes the workspace");
    }
    try {
      const real = await realpath(candidate);
      if (request.kind === "workspace" && !isContained(this.#workspaceRealRoot, real)) {
        return rejected("outside-workspace", "The directory resolves outside the workspace");
      }
      const found = await readdir(real, { withFileTypes: true });
      const entries: DocumentDirectoryEntry[] = [];
      for (const entry of found) {
        // Symlinked entries are classified by their target so a linked skill directory still
        // works; `read` re-checks containment before any of its bytes are used.
        const kind = entry.isSymbolicLink()
          ? await symlinkKind(path.join(real, entry.name))
          : entry.isFile()
            ? "file"
            : entry.isDirectory()
              ? "directory"
              : undefined;
        if (kind !== undefined) entries.push(Object.freeze({ name: entry.name, kind }));
      }
      return Object.freeze({ status: "listed", entries: Object.freeze(entries) });
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return Object.freeze({ status: "missing" });
      if (code === "ENOTDIR") return rejected("read-failed", "The path is not a directory");
      return rejected("read-failed", `The directory read failed (${code ?? "unknown"})`);
    }
  }

  /** Resolves a request path, returning `undefined` when a workspace path escapes lexically. */
  #resolve(request: DocumentReadRequest | DocumentDirectoryRequest): string | undefined {
    if (request.kind === "global") return path.resolve(request.path);
    const candidate = path.resolve(this.#workspaceRoot, ...request.path.split("/"));
    return isContained(this.#workspaceRoot, candidate) ? candidate : undefined;
  }
}

async function symlinkKind(target: string): Promise<"file" | "directory" | undefined> {
  try {
    const metadata = await stat(target);
    return metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : undefined;
  } catch {
    return undefined;
  }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function rejected(
  reason: DocumentRejectionReason,
  detail: string,
): {
  readonly status: "rejected";
  readonly reason: DocumentRejectionReason;
  readonly detail: string;
} {
  return Object.freeze({ status: "rejected", reason, detail });
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}
