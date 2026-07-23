import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  CancellationError,
  PilotError,
  type WorkspaceBoundary,
  type WorkspacePath,
} from "@pilotrun/core";

const defaultMaximumFileBytes = 10_000_000;

export interface WorkspaceFileSnapshot {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mode: number;
}

export interface AtomicReplaceInput {
  readonly path: string;
  readonly expectedSha256: string;
  readonly content: string;
  readonly signal: AbortSignal;
}

export interface AtomicReplaceResult {
  readonly path: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly sizeBytes: number;
}

export interface CreateFileInput {
  readonly path: string;
  readonly content: string;
  readonly signal: AbortSignal;
}

export interface CreateFileResult {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** Filesystem port used by patch services and in-memory contract tests. */
export interface WorkspaceFileSystem {
  readUtf8(path: string, signal: AbortSignal): Promise<WorkspaceFileSnapshot>;
  replaceUtf8Atomic(input: AtomicReplaceInput): Promise<AtomicReplaceResult>;
  createUtf8(input: CreateFileInput): Promise<CreateFileResult>;
}

export interface NodeWorkspaceFileSystemOptions {
  readonly maximumFileBytes?: number;
  readonly temporaryId?: () => string;
}

export class AtomicWriteError extends PilotError {
  constructor(message: string, metadata: Readonly<Record<string, unknown>> = {}, cause?: unknown) {
    super({
      code: "PILOT_ATOMIC_WRITE_FAILED",
      message,
      safeMessage: "The workspace file could not be replaced atomically",
      metadata,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

export class WorkspaceFileExistsError extends PilotError {
  constructor(relativePath: string) {
    super({
      code: "PILOT_WORKSPACE_FILE_EXISTS",
      message: `Workspace file ${relativePath} already exists`,
      safeMessage:
        "create_file only creates new files. The target already exists; use apply_patch to modify it.",
      metadata: { path: relativePath.split("\\").join("/") },
    });
  }
}

/** Node adapter using a same-directory temporary file and atomic rename. */
export class NodeWorkspaceFileSystem implements WorkspaceFileSystem {
  readonly #boundary: WorkspaceBoundary;
  readonly #maximumFileBytes: number;
  readonly #temporaryId: () => string;

  constructor(boundary: WorkspaceBoundary, options: NodeWorkspaceFileSystemOptions = {}) {
    this.#boundary = boundary;
    this.#maximumFileBytes = options.maximumFileBytes ?? defaultMaximumFileBytes;
    this.#temporaryId = options.temporaryId ?? randomUUID;
  }

  async readUtf8(requestedPath: string, signal: AbortSignal): Promise<WorkspaceFileSnapshot> {
    throwIfCancelled(signal);
    const resolved = await this.#boundary.resolve(requestedPath, "read");
    const verified = await this.#boundary.revalidate(resolved);
    const bytes = await safeReadRegularFile(verified, this.#maximumFileBytes, signal);
    const fileStats = await safeStat(verified);
    return snapshot(verified.relativePath, bytes, fileStats.mode);
  }

  async replaceUtf8Atomic(input: AtomicReplaceInput): Promise<AtomicReplaceResult> {
    if (!/^[a-f0-9]{64}$/u.test(input.expectedSha256)) {
      throw new AtomicWriteError("expectedSha256 must be a lowercase SHA-256 digest");
    }
    const replacementBytes = Buffer.from(input.content, "utf8");
    if (replacementBytes.length > this.#maximumFileBytes) {
      throw new AtomicWriteError("Replacement content exceeds the file-size limit", {
        maximumBytes: this.#maximumFileBytes,
        observedBytes: replacementBytes.length,
      });
    }
    throwIfCancelled(input.signal);
    const resolved = await this.#boundary.resolve(input.path, "write");
    if (!resolved.exists) {
      throw new AtomicWriteError("Atomic patch replacement requires an existing file", {
        path: resolved.relativePath,
      });
    }
    const verified = await this.#boundary.revalidate(resolved);
    const targetPath = verified.realPath ?? verified.absolutePath;
    const beforeBytes = await safeReadRegularFile(verified, this.#maximumFileBytes, input.signal);
    const beforeSha256 = digest(beforeBytes);
    assertExpectedHash(input.expectedSha256, beforeSha256, verified.relativePath);
    const targetStats = await safeStat(verified);
    const temporaryPath = path.join(
      path.dirname(targetPath),
      `.pilot-${path.basename(targetPath)}-${this.#temporaryId()}.tmp`,
    );
    let temporaryExists = false;
    try {
      throwIfCancelled(input.signal);
      const handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        targetStats.mode & 0o777,
      );
      temporaryExists = true;
      try {
        await handle.chmod(targetStats.mode & 0o777);
        await handle.writeFile(replacementBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }

      throwIfCancelled(input.signal);
      const finalVerified = await this.#boundary.revalidate(verified);
      if ((finalVerified.realPath ?? finalVerified.absolutePath) !== targetPath) {
        throw new AtomicWriteError("The target path changed while preparing its replacement", {
          path: verified.relativePath,
        });
      }
      const finalBytes = await safeReadRegularFile(
        finalVerified,
        this.#maximumFileBytes,
        input.signal,
      );
      assertExpectedHash(input.expectedSha256, digest(finalBytes), verified.relativePath);
      throwIfCancelled(input.signal);
      await rename(temporaryPath, targetPath);
      temporaryExists = false;
      return Object.freeze({
        path: verified.relativePath.split("\\").join("/"),
        beforeSha256,
        afterSha256: digest(replacementBytes),
        sizeBytes: replacementBytes.length,
      });
    } catch (error) {
      if (error instanceof PilotError) throw error;
      throw new AtomicWriteError(
        "Atomic workspace replacement failed",
        { path: verified.relativePath },
        error,
      );
    } finally {
      if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async createUtf8(input: CreateFileInput): Promise<CreateFileResult> {
    const contentBytes = Buffer.from(input.content, "utf8");
    if (contentBytes.length > this.#maximumFileBytes) {
      throw new AtomicWriteError("New file content exceeds the file-size limit", {
        maximumBytes: this.#maximumFileBytes,
        observedBytes: contentBytes.length,
      });
    }
    throwIfCancelled(input.signal);
    const resolved = await this.#boundary.resolve(input.path, "write");
    if (resolved.exists) {
      throw new WorkspaceFileExistsError(resolved.relativePath);
    }
    const targetPath = resolved.absolutePath;
    try {
      throwIfCancelled(input.signal);
      // O_EXCL makes creation atomic and race-safe: it fails rather than
      // clobbering if the file appears between the boundary check and open.
      const handle = await open(
        targetPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o666,
      );
      try {
        await handle.writeFile(contentBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return Object.freeze({
        path: resolved.relativePath.split("\\").join("/"),
        sha256: digest(contentBytes),
        sizeBytes: contentBytes.length,
      });
    } catch (error) {
      if (error instanceof PilotError) throw error;
      if (isErrnoException(error) && error.code === "EEXIST") {
        throw new WorkspaceFileExistsError(resolved.relativePath);
      }
      throw new AtomicWriteError(
        "The workspace file could not be created",
        { path: resolved.relativePath },
        error,
      );
    }
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function safeReadRegularFile(
  resolved: WorkspacePath,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  try {
    return await readRegularFile(resolved, maximumBytes, signal);
  } catch (error) {
    if (error instanceof PilotError) throw error;
    throw new AtomicWriteError(
      "Patch target could not be read",
      { path: resolved.relativePath },
      error,
    );
  }
}

async function safeStat(resolved: WorkspacePath): Promise<Stats> {
  try {
    return await stat(resolved.realPath ?? resolved.absolutePath);
  } catch (error) {
    throw new AtomicWriteError(
      "Patch target metadata could not be read",
      { path: resolved.relativePath },
      error,
    );
  }
}

async function readRegularFile(
  resolved: WorkspacePath,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const absolutePath = resolved.realPath ?? resolved.absolutePath;
  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(absolutePath, flags);
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) {
      throw new AtomicWriteError("Patch targets must be regular files", {
        path: resolved.relativePath,
      });
    }
    if (fileStats.size > maximumBytes) {
      throw new AtomicWriteError("Patch target exceeds the file-size limit", {
        path: resolved.relativePath,
        maximumBytes,
        observedBytes: fileStats.size,
      });
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      throwIfCancelled(signal);
      const buffer = Buffer.allocUnsafe(Math.min(65_536, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) {
        throw new AtomicWriteError("Patch target exceeds the file-size limit", {
          path: resolved.relativePath,
          maximumBytes,
          observedBytes: total,
        });
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function snapshot(path: string, bytes: Buffer, mode: number): WorkspaceFileSnapshot {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new AtomicWriteError("Patch target is not valid UTF-8", { path }, error);
  }
  if (bytes.includes(0)) throw new AtomicWriteError("Patch target appears to be binary", { path });
  return Object.freeze({
    path: path.split("\\").join("/"),
    content,
    sha256: digest(bytes),
    sizeBytes: bytes.length,
    mode: mode & 0o777,
  });
}

function assertExpectedHash(expected: string, actual: string, path: string): void {
  if (expected !== actual) {
    throw new PilotError({
      code: "PILOT_PATCH_BASE_MISMATCH",
      message: "The patch target changed before atomic replacement",
      safeMessage: "The target file changed after it was read",
      metadata: { path, expectedSha256: expected, actualSha256: actual },
    });
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancellationError(signal.reason);
}
