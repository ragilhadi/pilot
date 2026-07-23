import { PilotError } from "@pilotrun/core";

export type InstructionTrust = "trusted-user" | "untrusted-project";

export interface InstructionTarget {
  readonly path: string;
  readonly kind: "directory" | "file";
}

export interface InstructionReadRequest {
  readonly kind: "global" | "workspace";
  readonly path: string;
  readonly maximumBytes: number;
}

export type InstructionReadResult =
  | { readonly status: "missing" }
  | {
      readonly status: "rejected";
      readonly reason: "outside-workspace" | "read-failed" | "too-large";
      readonly detail: string;
    }
  | {
      readonly status: "found";
      readonly displayPath: string;
      readonly realPath: string;
      readonly content: string;
      readonly bytes: number;
    };

export interface InstructionFileReader {
  read(request: InstructionReadRequest): Promise<InstructionReadResult>;
}

export interface InstructionDocument {
  readonly id: string;
  readonly displayPath: string;
  readonly realPath: string;
  readonly scope: string;
  readonly trust: InstructionTrust;
  readonly precedence: number;
  readonly content: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly appliesTo: readonly string[];
}

export interface InstructionDiagnostic {
  readonly path: string;
  readonly reason: "outside-workspace" | "read-failed" | "too-large";
  readonly detail: string;
}

export interface InstructionPrecedenceNotice {
  readonly target: string;
  readonly lowerDocumentId: string;
  readonly higherDocumentId: string;
  readonly relationship: "more-specific-scope" | "project-over-global";
  readonly semanticConflictRequiresReview: true;
}

export interface InstructionDiscoveryResult {
  readonly documents: readonly InstructionDocument[];
  readonly diagnostics: readonly InstructionDiagnostic[];
  readonly precedenceNotices: readonly InstructionPrecedenceNotice[];
  readonly totalBytes: number;
}

export interface InstructionDiscoveryOptions {
  readonly targets: readonly InstructionTarget[];
  readonly globalPath?: string;
  readonly maximumFileBytes: number;
  readonly maximumTotalBytes: number;
  readonly maximumScopeDepth?: number;
}

export class InstructionDiscoveryError extends PilotError {
  constructor(
    code: "PILOT_INSTRUCTIONS_INVALID" | "PILOT_INSTRUCTIONS_LIMIT",
    message: string,
    metadata: Readonly<Record<string, unknown>> = {},
  ) {
    super({
      code,
      message,
      safeMessage:
        code === "PILOT_INSTRUCTIONS_LIMIT"
          ? "Project instructions exceed the configured limit"
          : "Project instruction discovery input is invalid",
      metadata,
    });
  }
}

interface Candidate {
  readonly kind: "global" | "workspace";
  readonly path: string;
  readonly scope: string;
  readonly precedence: number;
  readonly targets: Set<string>;
}

export class InstructionDiscovery {
  readonly #reader: InstructionFileReader;

  constructor(reader: InstructionFileReader) {
    this.#reader = reader;
  }

  async discover(options: InstructionDiscoveryOptions): Promise<InstructionDiscoveryResult> {
    validateLimit(options.maximumFileBytes, "maximumFileBytes");
    validateLimit(options.maximumTotalBytes, "maximumTotalBytes");
    if (options.targets.length === 0) {
      throw new InstructionDiscoveryError(
        "PILOT_INSTRUCTIONS_INVALID",
        "At least one instruction target is required",
      );
    }
    const maximumDepth = options.maximumScopeDepth ?? 64;
    if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 0 || maximumDepth > 256) {
      throw new InstructionDiscoveryError(
        "PILOT_INSTRUCTIONS_INVALID",
        "maximumScopeDepth must be between 0 and 256",
      );
    }
    const targets = [
      ...new Map(
        options.targets.map((target) => {
          const normalized = normalizeTarget(target.path);
          return [normalized, Object.freeze({ ...target, path: normalized })] as const;
        }),
      ).values(),
    ].sort((left, right) => left.path.localeCompare(right.path));
    const candidates = new Map<string, Candidate>();
    if (options.globalPath !== undefined) {
      candidates.set(`global:${options.globalPath}`, {
        kind: "global",
        path: options.globalPath,
        scope: "global",
        precedence: 0,
        targets: new Set(targets.map(({ path }) => path)),
      });
    }
    for (const target of targets) {
      const directory = target.kind === "file" ? parentScope(target.path) : target.path;
      const scopes = ancestorScopes(directory);
      if (scopes.length - 1 > maximumDepth) {
        throw new InstructionDiscoveryError(
          "PILOT_INSTRUCTIONS_LIMIT",
          `Instruction target ${target.path} exceeds the scope-depth limit`,
          { target: target.path, maximumDepth },
        );
      }
      for (const [depth, scope] of scopes.entries()) {
        const candidatePath = scope === "." ? "AGENTS.md" : `${scope}/AGENTS.md`;
        const key = `workspace:${candidatePath}`;
        const existing = candidates.get(key);
        if (existing !== undefined) existing.targets.add(target.path);
        else {
          candidates.set(key, {
            kind: "workspace",
            path: candidatePath,
            scope,
            precedence: 1_000 + depth,
            targets: new Set([target.path]),
          });
        }
      }
    }

    const documents: InstructionDocument[] = [];
    const diagnostics: InstructionDiagnostic[] = [];
    let totalBytes = 0;
    for (const candidate of [...candidates.values()].sort(compareCandidate)) {
      const result = await this.#reader.read({
        kind: candidate.kind,
        path: candidate.path,
        maximumBytes: options.maximumFileBytes,
      });
      if (result.status === "missing") continue;
      if (result.status === "rejected") {
        diagnostics.push(
          Object.freeze({ path: candidate.path, reason: result.reason, detail: result.detail }),
        );
        continue;
      }
      const actualBytes = new TextEncoder().encode(result.content).byteLength;
      if (result.bytes !== actualBytes || actualBytes > options.maximumFileBytes) {
        throw new InstructionDiscoveryError(
          "PILOT_INSTRUCTIONS_INVALID",
          `Instruction reader returned inconsistent byte metadata for ${candidate.path}`,
          { path: candidate.path, reportedBytes: result.bytes, actualBytes },
        );
      }
      totalBytes += actualBytes;
      if (totalBytes > options.maximumTotalBytes) {
        throw new InstructionDiscoveryError(
          "PILOT_INSTRUCTIONS_LIMIT",
          "Applicable instruction files exceed the total byte limit",
          { observedBytes: totalBytes, maximumBytes: options.maximumTotalBytes },
        );
      }
      const sha256 = await sha256Hex(result.content);
      documents.push(
        Object.freeze({
          id: `instruction:${sha256.slice(0, 16)}:${candidate.path}`,
          displayPath: result.displayPath,
          realPath: result.realPath,
          scope: candidate.scope,
          trust: candidate.kind === "global" ? "trusted-user" : "untrusted-project",
          precedence: candidate.precedence,
          content: result.content,
          bytes: actualBytes,
          sha256: `sha256:${sha256}`,
          appliesTo: Object.freeze([...candidate.targets].sort()),
        }),
      );
    }
    documents.sort((left, right) =>
      left.precedence === right.precedence
        ? left.displayPath.localeCompare(right.displayPath)
        : left.precedence - right.precedence,
    );
    return Object.freeze({
      documents: Object.freeze(documents),
      diagnostics: Object.freeze(diagnostics),
      precedenceNotices: Object.freeze(precedenceNotices(targets, documents)),
      totalBytes,
    });
  }
}

function precedenceNotices(
  targets: readonly InstructionTarget[],
  documents: readonly InstructionDocument[],
): InstructionPrecedenceNotice[] {
  const notices: InstructionPrecedenceNotice[] = [];
  for (const target of targets) {
    const applicable = documents.filter(({ appliesTo }) => appliesTo.includes(target.path));
    for (let index = 1; index < applicable.length; index += 1) {
      const lower = applicable[index - 1];
      const higher = applicable[index];
      if (lower === undefined || higher === undefined) continue;
      notices.push(
        Object.freeze({
          target: target.path,
          lowerDocumentId: lower.id,
          higherDocumentId: higher.id,
          relationship:
            lower.trust === "trusted-user" ? "project-over-global" : "more-specific-scope",
          semanticConflictRequiresReview: true,
        }),
      );
    }
  }
  return notices;
}

function normalizeTarget(value: string): string {
  const portable = value.replaceAll("\\", "/");
  const withoutPrefix = portable === "./" ? "." : portable.replace(/^\.\//u, "");
  const normalized = withoutPrefix === "." ? "." : withoutPrefix.replace(/\/$/u, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.includes("\0") ||
    normalized
      .split("/")
      .some(
        (segment) => segment === "" || segment === ".." || (segment === "." && normalized !== "."),
      )
  ) {
    throw new InstructionDiscoveryError(
      "PILOT_INSTRUCTIONS_INVALID",
      `Instruction target ${value} must be a normalized workspace-relative path`,
      { target: value },
    );
  }
  return normalized === "." ? "." : normalized;
}

function parentScope(target: string): string {
  const separator = target.lastIndexOf("/");
  return separator < 0 ? "." : target.slice(0, separator);
}

function ancestorScopes(scope: string): readonly string[] {
  if (scope === ".") return ["."];
  const segments = scope.split("/");
  return [".", ...segments.map((_segment, index) => segments.slice(0, index + 1).join("/"))];
}

function compareCandidate(left: Candidate, right: Candidate): number {
  return left.precedence === right.precedence
    ? left.path.localeCompare(right.path)
    : left.precedence - right.precedence;
}

function validateLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InstructionDiscoveryError(
      "PILOT_INSTRUCTIONS_INVALID",
      `${label} must be a positive integer`,
    );
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
