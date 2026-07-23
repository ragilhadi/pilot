import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  InstructionFileReader,
  InstructionReadRequest,
  InstructionReadResult,
} from "@pilotrun/agent-runtime";

export class NodeInstructionFileReader implements InstructionFileReader {
  readonly #workspaceRoot: string;
  readonly #workspaceRealRoot: string;

  private constructor(workspaceRoot: string, workspaceRealRoot: string) {
    this.#workspaceRoot = workspaceRoot;
    this.#workspaceRealRoot = workspaceRealRoot;
  }

  static async create(workspaceRoot: string): Promise<NodeInstructionFileReader> {
    const resolved = path.resolve(workspaceRoot);
    return new NodeInstructionFileReader(resolved, await realpath(resolved));
  }

  async read(request: InstructionReadRequest): Promise<InstructionReadResult> {
    const candidate =
      request.kind === "global"
        ? path.resolve(request.path)
        : path.resolve(this.#workspaceRoot, ...request.path.split("/"));
    if (request.kind === "workspace" && !isContained(this.#workspaceRoot, candidate)) {
      return rejected("outside-workspace", "Instruction path escapes the workspace");
    }
    try {
      const real = await realpath(candidate);
      if (request.kind === "workspace" && !isContained(this.#workspaceRealRoot, real)) {
        return rejected("outside-workspace", "Instruction symlink resolves outside the workspace");
      }
      const metadata = await stat(real);
      if (!metadata.isFile()) return rejected("read-failed", "Instruction path is not a file");
      if (metadata.size > request.maximumBytes) {
        return rejected("too-large", `Instruction file exceeds ${request.maximumBytes} bytes`);
      }
      const bytes = await readFile(real);
      if (bytes.byteLength > request.maximumBytes) {
        return rejected("too-large", `Instruction file exceeds ${request.maximumBytes} bytes`);
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return rejected("read-failed", "Instruction file is not valid UTF-8");
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
      return rejected("read-failed", `Instruction read failed (${errorCode(error) ?? "unknown"})`);
    }
  }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function rejected(
  reason: "outside-workspace" | "read-failed" | "too-large",
  detail: string,
): InstructionReadResult {
  return Object.freeze({ status: "rejected", reason, detail });
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}
