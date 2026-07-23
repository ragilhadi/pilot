import { open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  CancellationError,
  PilotError,
  type WorkspaceBoundary,
  type WorkspacePath,
} from "@pilotrun/core";
import { type GitCommandRunner, type GitMetadata, inspectGitMetadata } from "./git-metadata.js";
import { type IgnoreRuleSource, loadRepositoryIgnoreRules } from "./ignore-rules.js";
import { WorkspacePathError } from "./workspace-boundary.js";

export interface RepositoryDiscoveryOptions {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly maxFileSizeBytes?: number;
  readonly binarySampleBytes?: number;
  readonly maxIgnoreFileBytes?: number;
  readonly signal?: AbortSignal;
}

export type RepositoryEntry =
  | { readonly path: string; readonly kind: "directory" }
  | { readonly path: string; readonly kind: "symlink" }
  | {
      readonly path: string;
      readonly kind: "file";
      readonly sizeBytes: number;
      readonly classification: "binary" | "text" | "too-large";
    };

export interface RepositoryLanguage {
  readonly name: string;
  readonly fileCount: number;
}

export interface RepositoryCommandHints {
  readonly build?: string;
  readonly test?: string;
  readonly lint?: string;
  readonly typecheck?: string;
}

export interface RepositorySnapshot {
  readonly rootPath: string;
  readonly entries: readonly RepositoryEntry[];
  readonly truncated: boolean;
  readonly ignoredEntries: number;
  readonly unsafeLinksSkipped: number;
  readonly ignoreRules: readonly {
    readonly source: IgnoreRuleSource;
    readonly pattern: string;
    readonly negated: boolean;
  }[];
  readonly languages: readonly RepositoryLanguage[];
  readonly packageManagers: readonly string[];
  readonly buildTools: readonly string[];
  readonly commandHints: RepositoryCommandHints;
  readonly importantDirectories: readonly string[];
  readonly generatedDirectories: readonly string[];
  readonly packageDirectories: readonly string[];
  readonly instructionFiles: readonly string[];
  readonly git: GitMetadata;
}

export class RepositoryDiscoveryError extends PilotError {
  constructor(message: string, metadata: Readonly<Record<string, unknown>> = {}, cause?: unknown) {
    super({
      code: "PILOT_REPOSITORY_DISCOVERY_INVALID",
      message,
      safeMessage: "Repository discovery could not run with the requested limits",
      metadata,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

interface RequiredOptions {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxFileSizeBytes: number;
  readonly binarySampleBytes: number;
  readonly maxIgnoreFileBytes: number;
  readonly signal?: AbortSignal;
}

interface DirectoryWork {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly depth: number;
}

const importantDirectoryNames = new Set(["app", "apps", "lib", "packages", "src", "test", "tests"]);
const generatedDirectoryNames = new Set([
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const instructionNames = new Set(["AGENTS.md", "CLAUDE.md", "COPILOT.md", "GEMINI.md"]);
const binaryExtensions = new Set([
  ".7z",
  ".avi",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".doc",
  ".docx",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".so",
  ".tar",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

export class RepositoryDiscovery {
  readonly #boundary: WorkspaceBoundary;
  readonly #gitRunner: GitCommandRunner | undefined;

  constructor(dependencies: {
    readonly boundary: WorkspaceBoundary;
    readonly gitRunner?: GitCommandRunner;
  }) {
    this.#boundary = dependencies.boundary;
    this.#gitRunner = dependencies.gitRunner;
  }

  async discover(optionsInput: RepositoryDiscoveryOptions = {}): Promise<RepositorySnapshot> {
    const options = parseOptions(optionsInput);
    throwIfCancelled(options.signal);
    const rootEntries = await readdir(this.#boundary.rootPath, { withFileTypes: true });
    const rootNames = new Set(rootEntries.map(({ name }) => name));
    const ignoreRules = await loadRepositoryIgnoreRules(this.#boundary, options);
    const entries: RepositoryEntry[] = [];
    const languages = new Map<string, number>();
    const importantDirectories = new Set<string>();
    const generatedDirectories = new Set<string>();
    const packageDirectories = new Set<string>();
    const instructionFiles = new Set<string>();
    let ignoredEntries = 0;
    let unsafeLinksSkipped = 0;
    let truncated = false;
    const queue: DirectoryWork[] = [
      { relativePath: "", absolutePath: this.#boundary.rootPath, depth: 0 },
    ];

    for (const entry of rootEntries) {
      if (entry.isDirectory() && importantDirectoryNames.has(entry.name)) {
        importantDirectories.add(entry.name);
      }
      if (entry.isDirectory() && generatedDirectoryNames.has(entry.name)) {
        generatedDirectories.add(entry.name);
      }
    }

    while (queue.length > 0 && !truncated) {
      throwIfCancelled(options.signal);
      const current = queue.shift();
      if (current === undefined) {
        break;
      }
      const children = (await readdir(current.absolutePath, { withFileTypes: true })).sort(
        (left, right) => left.name.localeCompare(right.name),
      );
      for (const child of children) {
        throwIfCancelled(options.signal);
        const relativePath = joinPortable(current.relativePath, child.name);
        const isDirectory = child.isDirectory();
        if (ignoreRules.evaluate(relativePath, isDirectory).ignored) {
          ignoredEntries += 1;
          continue;
        }
        if (entries.length >= options.maxEntries) {
          truncated = true;
          break;
        }

        let resolved: WorkspacePath;
        try {
          resolved = await this.#boundary.resolve(relativePath, "read");
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
        if (isDirectory) {
          entries.push(Object.freeze({ path: relativePath, kind: "directory" }));
          if (current.depth < options.maxDepth) {
            queue.push({
              relativePath,
              absolutePath: resolved.realPath ?? resolved.absolutePath,
              depth: current.depth + 1,
            });
          }
          continue;
        }
        if (!child.isFile()) {
          continue;
        }

        const fileStats = await stat(resolved.realPath ?? resolved.absolutePath);
        const classification =
          fileStats.size > options.maxFileSizeBytes
            ? "too-large"
            : await classifyFile(
                this.#boundary,
                resolved,
                options.binarySampleBytes,
                options.signal,
              );
        entries.push(
          Object.freeze({
            path: relativePath,
            kind: "file",
            sizeBytes: fileStats.size,
            classification,
          }),
        );
        if (classification === "text") {
          const language = languageForPath(relativePath);
          if (language !== undefined) {
            languages.set(language, (languages.get(language) ?? 0) + 1);
          }
        }
        if (child.name === "package.json") {
          packageDirectories.add(current.relativePath.length === 0 ? "." : current.relativePath);
        }
        if (instructionNames.has(child.name)) {
          instructionFiles.add(relativePath);
        }
      }
    }

    const packageJson = await readRootPackageJson(this.#boundary, options);
    const gitEntrySafe = await isGitEntrySafe(this.#boundary, rootNames.has(".git"), options);
    const git: GitMetadata = gitEntrySafe
      ? await inspectGitMetadata({
          workspaceRoot: this.#boundary.rootPath,
          hasGitEntry: true,
          ...(this.#gitRunner === undefined ? {} : { runner: this.#gitRunner }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
      : Object.freeze({
          available: false,
          reason: rootNames.has(".git") ? "git-entry-unsafe" : "git-directory-missing",
        });

    return Object.freeze({
      rootPath: this.#boundary.rootPath,
      entries: Object.freeze(entries),
      truncated,
      ignoredEntries,
      unsafeLinksSkipped,
      ignoreRules: Object.freeze(
        ignoreRules.rules.map(({ source, pattern, negated }) =>
          Object.freeze({ source, pattern, negated }),
        ),
      ),
      languages: Object.freeze(
        [...languages.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, fileCount]) => Object.freeze({ name, fileCount })),
      ),
      packageManagers: Object.freeze(detectPackageManagers(rootNames, packageJson)),
      buildTools: Object.freeze(detectBuildTools(rootNames, packageJson)),
      commandHints: Object.freeze(commandHints(packageJson)),
      importantDirectories: Object.freeze([...importantDirectories].sort()),
      generatedDirectories: Object.freeze([...generatedDirectories].sort()),
      packageDirectories: Object.freeze([...packageDirectories].sort()),
      instructionFiles: Object.freeze([...instructionFiles].sort()),
      git,
    });
  }
}

async function isGitEntrySafe(
  boundary: WorkspaceBoundary,
  present: boolean,
  options: RequiredOptions,
): Promise<boolean> {
  if (!present) {
    return false;
  }
  try {
    const entry = await boundary.resolve(".git", "read");
    const entryStats = await stat(entry.realPath ?? entry.absolutePath);
    if (entryStats.isDirectory()) {
      return true;
    }
    if (!entryStats.isFile() || entryStats.size > 4_096) {
      return false;
    }
    const verified = await boundary.revalidate(entry);
    const content = await readFile(verified.realPath ?? verified.absolutePath, "utf8");
    const match = /^gitdir:\s*(.+)\s*$/imu.exec(content);
    const gitDirectory = match?.[1];
    if (gitDirectory === undefined) {
      return false;
    }
    const relativeTarget = path.isAbsolute(gitDirectory)
      ? gitDirectory
      : path.relative(boundary.rootPath, path.resolve(boundary.rootPath, gitDirectory));
    await boundary.resolve(relativeTarget, "read");
    throwIfCancelled(options.signal);
    return true;
  } catch (error) {
    if (error instanceof CancellationError) {
      throw error;
    }
    if (error instanceof WorkspacePathError) {
      return false;
    }
    return false;
  }
}

async function classifyFile(
  boundary: WorkspaceBoundary,
  resolved: WorkspacePath,
  sampleBytes: number,
  signal?: AbortSignal,
): Promise<"binary" | "text"> {
  if (binaryExtensions.has(path.extname(resolved.relativePath).toLocaleLowerCase("en-US"))) {
    return "binary";
  }
  throwIfCancelled(signal);
  const verified = await boundary.revalidate(resolved);
  const handle = await open(verified.realPath ?? verified.absolutePath, "r");
  try {
    const buffer = Buffer.alloc(sampleBytes);
    const { bytesRead } = await handle.read(buffer, 0, sampleBytes, 0);
    return isBinary(buffer.subarray(0, bytesRead)) ? "binary" : "text";
  } finally {
    await handle.close();
  }
}

function isBinary(sample: Uint8Array): boolean {
  if (sample.includes(0)) {
    return true;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    return true;
  }
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      suspicious += 1;
    }
  }
  return sample.length > 0 && suspicious / sample.length > 0.3;
}

async function readRootPackageJson(
  boundary: WorkspaceBoundary,
  options: RequiredOptions,
): Promise<Record<string, unknown> | undefined> {
  try {
    const resolved = await boundary.resolve("package.json", "read");
    const fileStats = await stat(resolved.realPath ?? resolved.absolutePath);
    if (fileStats.size > options.maxFileSizeBytes) {
      return undefined;
    }
    const verified = await boundary.revalidate(resolved);
    const parsed: unknown = JSON.parse(
      await readFile(verified.realPath ?? verified.absolutePath, "utf8"),
    );
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (error instanceof WorkspacePathError && error.code === "PILOT_WORKSPACE_PATH_NOT_FOUND") {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function commandHints(packageJson: Record<string, unknown> | undefined): RepositoryCommandHints {
  if (packageJson === undefined || !isRecord(packageJson.scripts)) {
    return {};
  }
  const scripts = packageJson.scripts;
  return {
    ...(typeof scripts.build === "string"
      ? { build: packageScriptCommand(packageJson, "build") }
      : {}),
    ...(typeof scripts.test === "string"
      ? { test: packageScriptCommand(packageJson, "test") }
      : {}),
    ...(typeof scripts.lint === "string"
      ? { lint: packageScriptCommand(packageJson, "lint") }
      : {}),
    ...(typeof scripts.typecheck === "string"
      ? { typecheck: packageScriptCommand(packageJson, "typecheck") }
      : {}),
  };
}

function packageScriptCommand(packageJson: Record<string, unknown>, script: string): string {
  const declared = packageJson.packageManager;
  const manager = typeof declared === "string" ? declared.split("@")[0] : undefined;
  if (manager === "pnpm" || manager === "yarn" || manager === "bun") {
    return `${manager} ${script}`;
  }
  return `npm run ${script}`;
}

function detectPackageManagers(
  rootNames: ReadonlySet<string>,
  packageJson: Record<string, unknown> | undefined,
): string[] {
  const managers: string[] = [];
  if (rootNames.has("pnpm-lock.yaml")) managers.push("pnpm");
  if (rootNames.has("yarn.lock")) managers.push("yarn");
  if (rootNames.has("package-lock.json")) managers.push("npm");
  if (rootNames.has("bun.lock") || rootNames.has("bun.lockb")) managers.push("bun");
  if (rootNames.has("uv.lock")) managers.push("uv");
  if (rootNames.has("poetry.lock")) managers.push("poetry");
  if (rootNames.has("Cargo.lock")) managers.push("cargo");
  const declared = packageJson?.packageManager;
  if (typeof declared === "string") {
    const name = declared.split("@")[0];
    if (name !== undefined && name.length > 0 && !managers.includes(name)) managers.push(name);
  }
  return managers.sort();
}

function detectBuildTools(
  rootNames: ReadonlySet<string>,
  packageJson: Record<string, unknown> | undefined,
): string[] {
  const tools = new Set<string>();
  if ([...rootNames].some((name) => name === "tsconfig.json" || name.startsWith("tsconfig.")))
    tools.add("typescript");
  if ([...rootNames].some((name) => /^vite\.config\./u.test(name))) tools.add("vite");
  if (rootNames.has("Cargo.toml")) tools.add("cargo");
  if (rootNames.has("pyproject.toml")) tools.add("python");
  const scripts = packageJson?.scripts;
  if (isRecord(scripts) && typeof scripts.build === "string") tools.add("package-script");
  return [...tools].sort();
}

function languageForPath(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLocaleLowerCase("en-US");
  return languageByExtension[extension];
}

const languageByExtension: Readonly<Record<string, string>> = Object.freeze({
  ".c": "C",
  ".cpp": "C++",
  ".cs": "C#",
  ".css": "CSS",
  ".go": "Go",
  ".html": "HTML",
  ".java": "Java",
  ".js": "JavaScript",
  ".json": "JSON",
  ".jsx": "JavaScript",
  ".kt": "Kotlin",
  ".md": "Markdown",
  ".php": "PHP",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".sh": "Shell",
  ".sql": "SQL",
  ".swift": "Swift",
  ".toml": "TOML",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".xml": "XML",
  ".yaml": "YAML",
  ".yml": "YAML",
});

function parseOptions(input: RepositoryDiscoveryOptions): RequiredOptions {
  const output: RequiredOptions = {
    maxDepth: input.maxDepth ?? 3,
    maxEntries: input.maxEntries ?? 5_000,
    maxFileSizeBytes: input.maxFileSizeBytes ?? 1_048_576,
    binarySampleBytes: input.binarySampleBytes ?? 8_192,
    maxIgnoreFileBytes: input.maxIgnoreFileBytes ?? 262_144,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  for (const [name, value] of Object.entries(output)) {
    const minimum = name === "maxDepth" ? 0 : 1;
    if (name !== "signal" && (!Number.isInteger(value) || (value as number) < minimum)) {
      throw new RepositoryDiscoveryError(
        `${name} must be ${minimum === 0 ? "a non-negative" : "a positive"} integer`,
        { name, value },
      );
    }
  }
  if (output.maxDepth > 32) {
    throw new RepositoryDiscoveryError("maxDepth cannot exceed 32", { maxDepth: output.maxDepth });
  }
  return output;
}

function joinPortable(parent: string, child: string): string {
  return parent.length === 0 ? child : `${parent}/${child}`;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CancellationError(signal.reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
