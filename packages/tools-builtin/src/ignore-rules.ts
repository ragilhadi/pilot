import { readFile, stat } from "node:fs/promises";
import { CancellationError, PilotError, type WorkspaceBoundary } from "@pilotrun/core";
import { WorkspacePathError } from "./workspace-boundary.js";

export type IgnoreRuleSource = "builtin" | ".gitignore" | ".ignore" | ".pilotignore";

export interface IgnoreRule {
  readonly source: IgnoreRuleSource;
  readonly pattern: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly regex: RegExp;
}

export interface IgnoreDecision {
  readonly ignored: boolean;
  readonly source?: IgnoreRuleSource;
  readonly pattern?: string;
}

export class IgnoreRulesError extends PilotError {
  constructor(message: string, metadata: Readonly<Record<string, unknown>>) {
    super({
      code: "PILOT_REPOSITORY_DISCOVERY_INVALID",
      message,
      safeMessage: "Repository ignore rules could not be loaded safely",
      metadata,
    });
  }
}

const protectedBuiltins = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".turbo/",
] as const;

export class RepositoryIgnoreRules {
  readonly #builtins: readonly IgnoreRule[];
  readonly #configured: readonly IgnoreRule[];

  constructor(configured: readonly IgnoreRule[]) {
    this.#builtins = Object.freeze(
      protectedBuiltins.map((pattern) => compileIgnoreRule("builtin", pattern, false)),
    );
    this.#configured = Object.freeze([...configured]);
  }

  static parse(
    sources: readonly {
      readonly source: Exclude<IgnoreRuleSource, "builtin">;
      readonly content: string;
    }[],
  ): RepositoryIgnoreRules {
    const rules: IgnoreRule[] = [];
    for (const { source, content } of sources) {
      for (const rawLine of content.split(/\r?\n/u)) {
        const parsed = parseLine(source, rawLine);
        if (parsed !== undefined) {
          rules.push(parsed);
        }
      }
    }
    return new RepositoryIgnoreRules(rules);
  }

  get rules(): readonly IgnoreRule[] {
    return Object.freeze([...this.#builtins, ...this.#configured]);
  }

  evaluate(relativePath: string, isDirectory: boolean): IgnoreDecision {
    const normalized = normalizePath(relativePath);
    for (const rule of this.#builtins) {
      if (matches(rule, normalized, isDirectory)) {
        return Object.freeze({ ignored: true, source: rule.source, pattern: rule.pattern });
      }
    }

    let decision: IgnoreDecision = Object.freeze({ ignored: false });
    for (const rule of this.#configured) {
      if (matches(rule, normalized, isDirectory)) {
        decision = rule.negated
          ? Object.freeze({ ignored: false, source: rule.source, pattern: rule.pattern })
          : Object.freeze({ ignored: true, source: rule.source, pattern: rule.pattern });
      }
    }
    return decision;
  }
}

export async function loadRepositoryIgnoreRules(
  boundary: WorkspaceBoundary,
  options: { readonly maxIgnoreFileBytes: number; readonly signal?: AbortSignal },
): Promise<RepositoryIgnoreRules> {
  const sources: { source: ".gitignore" | ".ignore" | ".pilotignore"; content: string }[] = [];
  for (const source of [".gitignore", ".ignore", ".pilotignore"] as const) {
    if (options.signal?.aborted === true) {
      throw new CancellationError(options.signal.reason);
    }
    try {
      const resolved = await boundary.resolve(source, "read");
      const fileStats = await stat(resolved.realPath ?? resolved.absolutePath);
      if (fileStats.size > options.maxIgnoreFileBytes) {
        throw new IgnoreRulesError(`Ignore file ${source} exceeds its size limit`, {
          source,
          limit: options.maxIgnoreFileBytes,
          observed: fileStats.size,
        });
      }
      const verified = await boundary.revalidate(resolved);
      sources.push({
        source,
        content: await readFile(verified.realPath ?? verified.absolutePath, "utf8"),
      });
    } catch (error) {
      if (error instanceof WorkspacePathError && error.code === "PILOT_WORKSPACE_PATH_NOT_FOUND") {
        continue;
      }
      throw error;
    }
  }
  return RepositoryIgnoreRules.parse(sources);
}

function parseLine(
  source: Exclude<IgnoreRuleSource, "builtin">,
  rawLine: string,
): IgnoreRule | undefined {
  let line = rawLine.trim();
  if (line.length === 0 || line.startsWith("#")) {
    return undefined;
  }
  if (line.startsWith("\\#") || line.startsWith("\\!")) {
    line = line.slice(1);
  }
  const negated = line.startsWith("!");
  const pattern = negated ? line.slice(1) : line;
  if (pattern.length === 0) {
    return undefined;
  }
  return compileIgnoreRule(source, pattern, negated);
}

function compileIgnoreRule(
  source: IgnoreRuleSource,
  rawPattern: string,
  negated: boolean,
): IgnoreRule {
  const normalizedPattern = normalizePath(rawPattern);
  const directoryOnly = normalizedPattern.endsWith("/");
  const withoutTrailingSlash = directoryOnly ? normalizedPattern.slice(0, -1) : normalizedPattern;
  const anchored = withoutTrailingSlash.startsWith("/");
  const body = anchored ? withoutTrailingSlash.slice(1) : withoutTrailingSlash;
  const hasSlash = body.includes("/");
  const expression = globExpression(body);
  const prefix = anchored || hasSlash ? "^" : "(?:^|.*/)";
  const suffix = directoryOnly ? "(?:/.*)?$" : "$";
  return Object.freeze({
    source,
    pattern: rawPattern,
    negated,
    directoryOnly,
    regex: new RegExp(`${prefix}${expression}${suffix}`, "u"),
  });
}

function globExpression(pattern: string): string {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") {
          index += 1;
        }
        if (pattern[index + 1] === "/") {
          index += 1;
          output += "(?:.*/)?";
        } else {
          output += ".*";
        }
      } else {
        output += "[^/]*";
      }
    } else if (character === "?") {
      output += "[^/]";
    } else {
      output += escapeRegex(character ?? "");
    }
  }
  return output;
}

function matches(rule: IgnoreRule, relativePath: string, isDirectory: boolean): boolean {
  if (rule.directoryOnly && !isDirectory && !relativePath.includes("/")) {
    return false;
  }
  return rule.regex.test(relativePath);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.-]/gu, "\\$&");
}
