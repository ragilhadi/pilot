import { readdir, stat } from "node:fs/promises";
import {
  CancellationError,
  defineTool,
  PilotError,
  type ToolDefinition,
  type WorkspaceBoundary,
  type WorkspacePath,
} from "@pilotrun/core";
import * as z from "zod";
import { compileGlobPattern } from "./glob-pattern.js";
import { loadRepositoryIgnoreRules } from "./ignore-rules.js";
import { WorkspacePathError } from "./workspace-boundary.js";

const maximumOutputBytes = 240_000;
const maximumIgnoreFileBytes = 262_144;

export const FileListEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({ path: z.string().min(1), kind: z.literal("directory") })
    .strict()
    .readonly(),
  z
    .object({
      path: z.string().min(1),
      kind: z.literal("file"),
      sizeBytes: z.number().int().nonnegative(),
    })
    .strict()
    .readonly(),
  z
    .object({ path: z.string().min(1), kind: z.literal("symlink") })
    .strict()
    .readonly(),
]);

const traversalFields = {
  path: z.string().min(1).max(4_096).default("."),
  maxDepth: z.number().int().min(1).max(32),
  limit: z.number().int().min(1).max(2_000),
  includeHidden: z.boolean().default(false),
} as const;

export const ListFilesInputSchema = z
  .object({
    path: traversalFields.path,
    maxDepth: traversalFields.maxDepth.default(1),
    limit: traversalFields.limit.default(200),
    includeHidden: traversalFields.includeHidden,
  })
  .strict()
  .readonly();

export const GlobInputSchema = z
  .object({
    pattern: z.string().min(1).max(256),
    path: traversalFields.path,
    maxDepth: traversalFields.maxDepth.default(20),
    limit: traversalFields.limit.default(200),
    includeHidden: traversalFields.includeHidden,
    kind: z.enum(["any", "directory", "file"]).default("file"),
  })
  .strict()
  .readonly();

const ResultMetadataSchema = z
  .object({
    truncated: z.boolean(),
    truncationReason: z.enum(["limit", "output-bytes", "scan-limit"]).optional(),
    scannedEntries: z.number().int().nonnegative(),
    ignoredEntries: z.number().int().nonnegative(),
    hiddenEntries: z.number().int().nonnegative(),
    unsafeLinksSkipped: z.number().int().nonnegative(),
  })
  .strict();

export const ListFilesOutputSchema = ResultMetadataSchema.extend({
  root: z.string(),
  entries: z.array(FileListEntrySchema).max(2_000).readonly(),
})
  .strict()
  .readonly();

export const GlobOutputSchema = ResultMetadataSchema.extend({
  root: z.string(),
  pattern: z.string(),
  matches: z.array(FileListEntrySchema).max(2_000).readonly(),
})
  .strict()
  .readonly();

export type FileListEntry = z.output<typeof FileListEntrySchema>;
export type ListFilesInput = z.output<typeof ListFilesInputSchema>;
export type ListFilesOutput = z.output<typeof ListFilesOutputSchema>;
export type GlobInput = z.output<typeof GlobInputSchema>;
export type GlobOutput = z.output<typeof GlobOutputSchema>;

export class FileToolError extends PilotError {
  constructor(message: string, metadata: Readonly<Record<string, unknown>> = {}) {
    super({
      code: "PILOT_FILE_TOOL_INVALID_TARGET",
      message,
      safeMessage: "The file listing target is not a readable workspace directory",
      metadata,
    });
  }
}

export interface BuiltinFileListTools {
  readonly listFiles: ToolDefinition<typeof ListFilesInputSchema, typeof ListFilesOutputSchema>;
  readonly glob: ToolDefinition<typeof GlobInputSchema, typeof GlobOutputSchema>;
}

export function createBuiltinFileListTools(boundary: WorkspaceBoundary): BuiltinFileListTools {
  const listFiles = defineTool({
    name: "list_files",
    description:
      "List files and directories below a workspace-relative directory with deterministic ordering and bounded output.",
    inputSchema: ListFilesInputSchema,
    outputSchema: ListFilesOutputSchema,
    metadata: readOnlyMetadata(10_000),
    execute: async (input, context) => {
      const walked = await walkWorkspace(boundary, input, context.signal);
      const selected = selectBounded(walked.entries, input.limit, walked.scanLimitReached);
      return {
        output: {
          root: walked.root,
          entries: selected.values,
          ...resultMetadata(walked, selected),
        },
        metadata: { untrusted: true, truncated: selected.truncated || walked.scanLimitReached },
      };
    },
  });

  const glob = defineTool({
    name: "glob",
    description:
      "Find workspace files or directories matching a relative glob pattern with deterministic ordering and bounded output.",
    inputSchema: GlobInputSchema,
    outputSchema: GlobOutputSchema,
    metadata: readOnlyMetadata(15_000),
    execute: async (input, context) => {
      const matcher = compileGlobPattern(input.pattern);
      const walked = await walkWorkspace(boundary, input, context.signal);
      const matches = walked.entries.filter((entry) => {
        const relativeToRoot = relativeFromBase(walked.root, entry.path);
        return kindMatches(input.kind, entry.kind) && matcher.test(relativeToRoot);
      });
      const selected = selectBounded(matches, input.limit, walked.scanLimitReached);
      return {
        output: {
          root: walked.root,
          pattern: input.pattern,
          matches: selected.values,
          ...resultMetadata(walked, selected),
        },
        metadata: { untrusted: true, truncated: selected.truncated || walked.scanLimitReached },
      };
    },
  });

  return Object.freeze({ listFiles, glob });
}

interface WalkInput {
  readonly path: string;
  readonly maxDepth: number;
  readonly limit: number;
  readonly includeHidden: boolean;
}

interface WalkResult {
  readonly root: string;
  readonly entries: readonly FileListEntry[];
  readonly scannedEntries: number;
  readonly ignoredEntries: number;
  readonly hiddenEntries: number;
  readonly unsafeLinksSkipped: number;
  readonly scanLimitReached: boolean;
}

async function walkWorkspace(
  boundary: WorkspaceBoundary,
  input: WalkInput,
  signal: AbortSignal,
): Promise<WalkResult> {
  throwIfCancelled(signal);
  const base = await boundary.resolve(input.path, "read");
  const baseStats = await stat(base.realPath ?? base.absolutePath);
  if (!baseStats.isDirectory()) {
    throw new FileToolError(`Workspace path ${input.path} is not a directory`, {
      path: input.path,
    });
  }
  const verifiedBase = await boundary.revalidate(base);
  const ignoreRules = await loadRepositoryIgnoreRules(boundary, {
    maxIgnoreFileBytes: maximumIgnoreFileBytes,
    signal,
  });
  const root = verifiedBase.relativePath.length === 0 ? "." : verifiedBase.relativePath;
  const entries: FileListEntry[] = [];
  const queue: { relativePath: string; depth: number }[] = [
    { relativePath: verifiedBase.relativePath, depth: 0 },
  ];
  const scanLimit = Math.min(50_000, Math.max(1_000, input.limit * 20));
  let scannedEntries = 0;
  let ignoredEntries = 0;
  let hiddenEntries = 0;
  let unsafeLinksSkipped = 0;
  let scanLimitReached = false;

  while (queue.length > 0 && !scanLimitReached) {
    throwIfCancelled(signal);
    const current = queue.shift();
    if (current === undefined) break;
    const currentPath = await boundary.resolve(
      current.relativePath.length === 0 ? "." : current.relativePath,
      "read",
    );
    const verifiedCurrent = await boundary.revalidate(currentPath);
    const children = (
      await readdir(verifiedCurrent.realPath ?? verifiedCurrent.absolutePath, {
        withFileTypes: true,
      })
    ).sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      throwIfCancelled(signal);
      scannedEntries += 1;
      if (scannedEntries > scanLimit) {
        scanLimitReached = true;
        break;
      }
      const relativePath = joinPortable(current.relativePath, child.name);
      if (!input.includeHidden && child.name.startsWith(".")) {
        hiddenEntries += 1;
        continue;
      }
      if (ignoreRules.evaluate(relativePath, child.isDirectory()).ignored) {
        ignoredEntries += 1;
        continue;
      }
      let resolved: WorkspacePath;
      try {
        resolved = await boundary.resolve(relativePath, "read");
      } catch (error) {
        if (error instanceof WorkspacePathError && error.code === "PILOT_WORKSPACE_PATH_ESCAPE") {
          unsafeLinksSkipped += 1;
          continue;
        }
        throw error;
      }
      if (child.isSymbolicLink()) {
        entries.push(Object.freeze({ path: relativePath, kind: "symlink" }));
        continue;
      }
      if (child.isDirectory()) {
        entries.push(Object.freeze({ path: relativePath, kind: "directory" }));
        const childDepth = current.depth + 1;
        if (childDepth < input.maxDepth) {
          queue.push({
            relativePath,
            depth: childDepth,
          });
        }
        continue;
      }
      if (child.isFile()) {
        const verifiedFile = await boundary.revalidate(resolved);
        const fileStats = await stat(verifiedFile.realPath ?? verifiedFile.absolutePath);
        entries.push(
          Object.freeze({ path: relativePath, kind: "file", sizeBytes: fileStats.size }),
        );
      }
    }
  }

  return Object.freeze({
    root,
    entries: Object.freeze(entries.sort((left, right) => left.path.localeCompare(right.path))),
    scannedEntries,
    ignoredEntries,
    hiddenEntries,
    unsafeLinksSkipped,
    scanLimitReached,
  });
}

interface Selection {
  readonly values: readonly FileListEntry[];
  readonly truncated: boolean;
  readonly reason?: "limit" | "output-bytes";
}

type TruncationReason = "limit" | "output-bytes" | "scan-limit";

interface ResultMetadata {
  readonly truncated: boolean;
  readonly truncationReason?: TruncationReason;
  readonly scannedEntries: number;
  readonly ignoredEntries: number;
  readonly hiddenEntries: number;
  readonly unsafeLinksSkipped: number;
}

function selectBounded(
  values: readonly FileListEntry[],
  limit: number,
  scanLimitReached: boolean,
): Selection {
  const selected: FileListEntry[] = [];
  let bytes = 2;
  let reason: Selection["reason"];
  for (const value of values) {
    if (selected.length >= limit) {
      reason = "limit";
      break;
    }
    const valueBytes = Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
    if (bytes + valueBytes > maximumOutputBytes) {
      reason = "output-bytes";
      break;
    }
    selected.push(value);
    bytes += valueBytes;
  }
  return Object.freeze({
    values: Object.freeze(selected),
    truncated: reason !== undefined || scanLimitReached,
    ...(reason === undefined ? {} : { reason }),
  });
}

function resultMetadata(walked: WalkResult, selected: Selection): ResultMetadata {
  const truncationReason: TruncationReason | undefined = walked.scanLimitReached
    ? "scan-limit"
    : selected.reason;
  return {
    truncated: selected.truncated || walked.scanLimitReached,
    ...(truncationReason === undefined ? {} : { truncationReason }),
    scannedEntries: walked.scannedEntries,
    ignoredEntries: walked.ignoredEntries,
    hiddenEntries: walked.hiddenEntries,
    unsafeLinksSkipped: walked.unsafeLinksSkipped,
  };
}

function readOnlyMetadata(timeoutMs: number) {
  return {
    risk: "read-only",
    concurrency: "parallel-safe",
    timeoutMs,
    maxOutputBytes: 262_144,
    requiredPermissions: ["workspace.read"],
  } as const;
}

function relativeFromBase(base: string, entryPath: string): string {
  return base === "." ? entryPath : entryPath.slice(base.length + 1);
}

function kindMatches(requested: GlobInput["kind"], actual: FileListEntry["kind"]): boolean {
  return requested === "any" || requested === actual;
}

function joinPortable(parent: string, child: string): string {
  return parent.length === 0 ? child : `${parent}/${child}`;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancellationError(signal.reason);
}
