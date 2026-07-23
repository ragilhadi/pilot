import { lstat, stat } from "node:fs/promises";
import { realpath as realpathCallback, type Stats } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

// fs/promises' realpath does not resolve Windows 8.3 short names (e.g. RUNNER~1),
// while git and other external tools report the long form. Using the native
// variant keeps this boundary's canonical paths comparable to what those tools emit.
const realpath = promisify(realpathCallback.native);
import {
  PilotError,
  type WorkspaceAccess,
  type WorkspaceBoundary,
  type WorkspacePath,
} from "@pilot/core";

export type WorkspacePathErrorReason =
  | "absolute-path"
  | "broken-link"
  | "empty-path"
  | "io-error"
  | "lexical-escape"
  | "not-found"
  | "outside-real-root"
  | "root-not-directory"
  | "root-not-found"
  | "unresolved-write-parent"
  | "windows-drive-path";

export class WorkspacePathError extends PilotError {
  readonly reason: WorkspacePathErrorReason;

  constructor(
    code:
      | "PILOT_WORKSPACE_IO"
      | "PILOT_WORKSPACE_PATH_ESCAPE"
      | "PILOT_WORKSPACE_PATH_INVALID"
      | "PILOT_WORKSPACE_PATH_NOT_FOUND"
      | "PILOT_WORKSPACE_WRITE_PARENT_INVALID",
    reason: WorkspacePathErrorReason,
    message: string,
    metadata: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super({
      code,
      message,
      safeMessage:
        code === "PILOT_WORKSPACE_PATH_ESCAPE"
          ? "The requested path resolves outside the workspace"
          : "The requested workspace path is unavailable or invalid",
      metadata: { reason, ...metadata },
      ...(cause === undefined ? {} : { cause }),
    });
    this.reason = reason;
  }
}

/** Node filesystem implementation of lexical plus canonical workspace containment. */
export class NodeWorkspaceBoundary implements WorkspaceBoundary {
  readonly rootPath: string;

  private constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  static async create(rootInput: string): Promise<NodeWorkspaceBoundary> {
    const lexicalRoot = path.resolve(rootInput);
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(lexicalRoot);
    } catch (error) {
      throw new WorkspacePathError(
        "PILOT_WORKSPACE_PATH_NOT_FOUND",
        "root-not-found",
        `Workspace root ${lexicalRoot} does not exist`,
        { rootPath: lexicalRoot },
        error,
      );
    }

    let rootStats: Stats;
    try {
      rootStats = await stat(canonicalRoot);
    } catch (error) {
      throw new WorkspacePathError(
        "PILOT_WORKSPACE_IO",
        "io-error",
        `Workspace root ${canonicalRoot} cannot be inspected`,
        { rootPath: canonicalRoot },
        error,
      );
    }
    if (!rootStats.isDirectory()) {
      throw new WorkspacePathError(
        "PILOT_WORKSPACE_PATH_INVALID",
        "root-not-directory",
        `Workspace root ${canonicalRoot} is not a directory`,
        { rootPath: canonicalRoot },
      );
    }
    return new NodeWorkspaceBoundary(canonicalRoot);
  }

  async resolve(requestedPath: string, access: WorkspaceAccess): Promise<WorkspacePath> {
    validateRequestedPath(requestedPath);
    const absolutePath = path.resolve(this.rootPath, requestedPath);
    assertContained(this.rootPath, absolutePath, "lexical-escape", requestedPath);
    const relativePath = portableRelativePath(this.rootPath, absolutePath);

    const targetStatus = await inspectPath(absolutePath);
    if (targetStatus === "broken-link") {
      throw new WorkspacePathError(
        "PILOT_WORKSPACE_PATH_INVALID",
        "broken-link",
        `Workspace path ${requestedPath} is a broken symbolic link`,
        { requestedPath },
      );
    }

    if (targetStatus === "missing") {
      if (access === "read") {
        await assertNearestExistingAncestorContained(
          this.rootPath,
          path.dirname(absolutePath),
          requestedPath,
        );
        throw new WorkspacePathError(
          "PILOT_WORKSPACE_PATH_NOT_FOUND",
          "not-found",
          `Workspace path ${requestedPath} does not exist`,
          { requestedPath },
        );
      }
      const parentPath = path.dirname(absolutePath);
      const parentStatus = await inspectPath(parentPath);
      if (parentStatus !== "existing") {
        throw new WorkspacePathError(
          "PILOT_WORKSPACE_WRITE_PARENT_INVALID",
          "unresolved-write-parent",
          `The parent of workspace write path ${requestedPath} does not exist`,
          { requestedPath },
        );
      }
      const parentRealPath = await canonicalPath(parentPath, requestedPath);
      assertContained(this.rootPath, parentRealPath, "outside-real-root", requestedPath);
      const parentStats = await stat(parentRealPath);
      if (!parentStats.isDirectory()) {
        throw new WorkspacePathError(
          "PILOT_WORKSPACE_WRITE_PARENT_INVALID",
          "unresolved-write-parent",
          `The parent of workspace write path ${requestedPath} is not a directory`,
          { requestedPath },
        );
      }
      return verifiedPath({
        access,
        rootPath: this.rootPath,
        absolutePath,
        relativePath,
        exists: false,
      });
    }

    const targetRealPath = await canonicalPath(absolutePath, requestedPath);
    assertContained(this.rootPath, targetRealPath, "outside-real-root", requestedPath);
    return verifiedPath({
      access,
      rootPath: this.rootPath,
      absolutePath,
      relativePath,
      realPath: targetRealPath,
      exists: true,
    });
  }

  async revalidate(resolved: WorkspacePath): Promise<WorkspacePath> {
    if (resolved.rootPath !== this.rootPath) {
      throw new WorkspacePathError(
        "PILOT_WORKSPACE_PATH_INVALID",
        "lexical-escape",
        "A workspace path was resolved by a different workspace boundary",
      );
    }
    return this.resolve(
      resolved.relativePath.length === 0 ? "." : resolved.relativePath,
      resolved.access,
    );
  }
}

async function assertNearestExistingAncestorContained(
  rootPath: string,
  startPath: string,
  requestedPath: string,
): Promise<void> {
  let candidate = startPath;
  while (true) {
    const status = await inspectPath(candidate);
    if (status === "existing") {
      const candidateRealPath = await canonicalPath(candidate, requestedPath);
      assertContained(rootPath, candidateRealPath, "outside-real-root", requestedPath);
      return;
    }
    if (status === "broken-link") {
      throw new WorkspacePathError(
        "PILOT_WORKSPACE_PATH_INVALID",
        "broken-link",
        `Workspace path ${requestedPath} crosses a broken symbolic link`,
        { requestedPath },
      );
    }
    if (candidate === rootPath) {
      return;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return;
    }
    candidate = parent;
  }
}

function validateRequestedPath(requestedPath: string): void {
  if (requestedPath.trim().length === 0 || requestedPath.includes("\0")) {
    throw new WorkspacePathError(
      "PILOT_WORKSPACE_PATH_INVALID",
      "empty-path",
      "Workspace paths must be non-empty and contain no null bytes",
    );
  }
  if (path.isAbsolute(requestedPath) || path.win32.isAbsolute(requestedPath)) {
    throw new WorkspacePathError(
      "PILOT_WORKSPACE_PATH_INVALID",
      "absolute-path",
      "Workspace paths must be relative",
      { requestedPath },
    );
  }
  if (/^[a-z]:/iu.test(requestedPath)) {
    throw new WorkspacePathError(
      "PILOT_WORKSPACE_PATH_INVALID",
      "windows-drive-path",
      "Drive-qualified workspace paths are not allowed",
      { requestedPath },
    );
  }
  const windowsNormalized = path.win32.normalize(requestedPath);
  if (windowsNormalized === ".." || windowsNormalized.startsWith("..\\")) {
    throw new WorkspacePathError(
      "PILOT_WORKSPACE_PATH_ESCAPE",
      "lexical-escape",
      "Workspace paths cannot traverse above the workspace root",
      { requestedPath },
    );
  }
}

function assertContained(
  rootPath: string,
  candidatePath: string,
  reason: "lexical-escape" | "outside-real-root",
  requestedPath: string,
): void {
  const relative = path.relative(rootPath, candidatePath);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new WorkspacePathError(
    "PILOT_WORKSPACE_PATH_ESCAPE",
    reason,
    `Workspace path ${requestedPath} resolves outside ${rootPath}`,
    { requestedPath },
  );
}

async function inspectPath(targetPath: string): Promise<"broken-link" | "existing" | "missing"> {
  try {
    await lstat(targetPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return "missing";
    }
    throw new WorkspacePathError(
      "PILOT_WORKSPACE_IO",
      "io-error",
      `Workspace path ${targetPath} cannot be inspected`,
      {},
      error,
    );
  }
  try {
    await realpath(targetPath);
    return "existing";
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return "broken-link";
    }
    throw new WorkspacePathError(
      "PILOT_WORKSPACE_IO",
      "io-error",
      `Workspace path ${targetPath} cannot be resolved`,
      {},
      error,
    );
  }
}

async function canonicalPath(targetPath: string, requestedPath: string): Promise<string> {
  try {
    return await realpath(targetPath);
  } catch (error) {
    throw new WorkspacePathError(
      "PILOT_WORKSPACE_IO",
      "io-error",
      `Workspace path ${requestedPath} cannot be resolved`,
      { requestedPath },
      error,
    );
  }
}

function portableRelativePath(rootPath: string, absolutePath: string): string {
  return path.relative(rootPath, absolutePath).split(path.sep).join("/");
}

interface VerifiedPathInput {
  readonly access: WorkspaceAccess;
  readonly rootPath: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly realPath?: string;
  readonly exists: boolean;
}

function verifiedPath(input: VerifiedPathInput): WorkspacePath {
  return Object.freeze(input) as WorkspacePath;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
