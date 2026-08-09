import {
  parsePromptTemplate,
  parseSkillDocument,
  PilotError,
  type PromptTemplate,
  type Sha256Digest,
  sha256Digest,
  type SkillDocument,
  SkillError,
  SkillNameSchema,
} from "@pilotrun/core";
import type {
  DocumentDirectoryEntry,
  DocumentDirectoryReader,
  DocumentOrigin,
} from "./workspace-document-reader.js";

export type SkillTrust = "trusted-user" | "untrusted-project";

export type SkillDiagnosticReason =
  | "invalid-manifest"
  | "invalid-name"
  | "limit-exceeded"
  | "missing-definition"
  | "name-mismatch"
  | "outside-workspace"
  | "read-failed"
  | "shadowed"
  | "too-large"
  | "unsupported-entry";

export interface SkillDiagnostic {
  readonly path: string;
  readonly reason: SkillDiagnosticReason;
  readonly detail: string;
}

/** Provenance shared by every discovered skill and prompt template. */
export interface DiscoveredDocument {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly displayPath: string;
  readonly realPath: string;
  readonly origin: DocumentOrigin;
  readonly trust: SkillTrust;
  readonly bytes: number;
  readonly sha256: Sha256Digest;
}

export interface DiscoveredSkill extends DiscoveredDocument {
  readonly manifest: SkillDocument["manifest"];
  /** The instructions handed to the model, only once the user activates the skill. */
  readonly body: string;
}

export interface DiscoveredPromptTemplate extends DiscoveredDocument {
  readonly template: PromptTemplate;
}

export interface SkillCatalog {
  readonly skills: readonly DiscoveredSkill[];
  readonly diagnostics: readonly SkillDiagnostic[];
  readonly totalBytes: number;
}

export interface PromptTemplateCatalog {
  readonly templates: readonly DiscoveredPromptTemplate[];
  readonly diagnostics: readonly SkillDiagnostic[];
  readonly totalBytes: number;
}

export interface SkillDiscoveryOptions {
  /** Workspace-relative directory holding project skills, e.g. `.pilot/skills`. */
  readonly workspaceDirectory?: string;
  /** Absolute directory holding the user's own skills, e.g. `<dataDirectory>/skills`. */
  readonly globalDirectory?: string;
  readonly maximumFileBytes: number;
  readonly maximumTotalBytes: number;
  readonly maximumDocuments: number;
}

export class SkillDiscoveryError extends PilotError {
  constructor(message: string, metadata: Readonly<Record<string, unknown>> = {}) {
    super({
      code: "PILOT_SKILL_DOCUMENT_INVALID",
      message,
      safeMessage: "Skill discovery input is invalid",
      metadata,
    });
  }
}

/**
 * Reads the skill catalogue without activating anything.
 *
 * Discovery is deliberately inert: it validates, hashes, and reports, and it is the only thing
 * that runs unprompted. A skill's instructions reach the model only after the user activates it,
 * so a repository that ships a skill file has published a proposal, not an instruction.
 *
 * A malformed or oversized skill produces a diagnostic and is skipped rather than failing the
 * command — one bad project file must not make `pilot skills` unusable.
 */
export class SkillDiscovery {
  readonly #reader: DocumentDirectoryReader;

  constructor(reader: DocumentDirectoryReader) {
    this.#reader = reader;
  }

  async discover(options: SkillDiscoveryOptions): Promise<SkillCatalog> {
    const collected = await collect(this.#reader, options, {
      label: "skill",
      idPrefix: "skill",
      directoryFileName: "SKILL.md",
      parse: (text, location) => {
        const document = parseSkillDocument(text, location);
        return { name: document.manifest.name, value: document };
      },
    });
    return Object.freeze({
      skills: Object.freeze(
        collected.documents.map(({ provenance, value }) =>
          Object.freeze({
            ...provenance,
            description: value.manifest.description,
            manifest: value.manifest,
            body: value.body,
          }),
        ),
      ),
      diagnostics: collected.diagnostics,
      totalBytes: collected.totalBytes,
    });
  }
}

/**
 * Reads the prompt-template catalogue. Templates are plain single files; unlike skills they carry
 * no permission surface, because expansion produces text the user then sends as their own turn.
 */
export class PromptTemplateDiscovery {
  readonly #reader: DocumentDirectoryReader;

  constructor(reader: DocumentDirectoryReader) {
    this.#reader = reader;
  }

  async discover(options: SkillDiscoveryOptions): Promise<PromptTemplateCatalog> {
    const collected = await collect(this.#reader, options, {
      label: "prompt template",
      idPrefix: "prompt",
      parse: (text, location) => {
        const template = parsePromptTemplate(text, location);
        return { name: template.manifest.name, value: template };
      },
    });
    return Object.freeze({
      templates: Object.freeze(
        collected.documents.map(({ provenance, value }) =>
          Object.freeze({
            ...provenance,
            description: value.manifest.description,
            template: value,
          }),
        ),
      ),
      diagnostics: collected.diagnostics,
      totalBytes: collected.totalBytes,
    });
  }
}

interface DocumentLayout<Value> {
  readonly label: string;
  /** Prefix of the stable candidate id, which appears in context snapshots. */
  readonly idPrefix: string;
  /** When set, a subdirectory holding this file is also a valid definition. */
  readonly directoryFileName?: string;
  parse(text: string, location: string): { readonly name: string; readonly value: Value };
}

interface CollectedDocument<Value> {
  readonly provenance: Omit<DiscoveredDocument, "description">;
  readonly value: Value;
}

interface Collected<Value> {
  readonly documents: readonly CollectedDocument<Value>[];
  readonly diagnostics: readonly SkillDiagnostic[];
  readonly totalBytes: number;
}

interface Candidate {
  readonly origin: DocumentOrigin;
  readonly name: string;
  /** Path passed to the reader: workspace-relative for projects, absolute for the global root. */
  readonly path: string;
}

async function collect<Value>(
  reader: DocumentDirectoryReader,
  options: SkillDiscoveryOptions,
  layout: DocumentLayout<Value>,
): Promise<Collected<Value>> {
  validatePositive(options.maximumFileBytes, "maximumFileBytes");
  validatePositive(options.maximumTotalBytes, "maximumTotalBytes");
  validatePositive(options.maximumDocuments, "maximumDocuments");
  if (options.maximumFileBytes > options.maximumTotalBytes) {
    throw new SkillDiscoveryError("maximumFileBytes cannot exceed maximumTotalBytes");
  }

  const diagnostics: SkillDiagnostic[] = [];
  const documents: CollectedDocument<Value>[] = [];
  const claimedNames = new Set<string>();
  let totalBytes = 0;

  // The user's own directory is read first so a project file can never take over a name the user
  // already defined for themselves: the later duplicate is reported as shadowed instead.
  const roots: readonly { readonly origin: DocumentOrigin; readonly path: string }[] = [
    ...(options.globalDirectory === undefined
      ? []
      : [{ origin: "global" as const, path: options.globalDirectory }]),
    ...(options.workspaceDirectory === undefined
      ? []
      : [{ origin: "workspace" as const, path: options.workspaceDirectory }]),
  ];

  for (const root of roots) {
    const listing = await reader.list({ kind: root.origin, path: root.path });
    if (listing.status === "missing") continue;
    if (listing.status === "rejected") {
      diagnostics.push(diagnostic(root.path, listing.reason, listing.detail));
      continue;
    }
    for (const candidate of candidatesFrom(root, listing.entries, layout, diagnostics)) {
      if (claimedNames.has(candidate.name)) {
        diagnostics.push(
          diagnostic(
            candidate.path,
            "shadowed",
            `${layout.label} ${candidate.name} is already defined by a higher-trust directory`,
          ),
        );
        continue;
      }
      if (documents.length >= options.maximumDocuments) {
        diagnostics.push(
          diagnostic(
            candidate.path,
            "limit-exceeded",
            `more than ${options.maximumDocuments} ${layout.label}s were found`,
          ),
        );
        break;
      }

      const result = await reader.read({
        kind: candidate.origin,
        path: candidate.path,
        maximumBytes: options.maximumFileBytes,
      });
      if (result.status === "missing") {
        diagnostics.push(
          diagnostic(candidate.path, "missing-definition", `no ${layout.label} file was found`),
        );
        continue;
      }
      if (result.status === "rejected") {
        diagnostics.push(diagnostic(candidate.path, result.reason, result.detail));
        continue;
      }
      if (totalBytes + result.bytes > options.maximumTotalBytes) {
        diagnostics.push(
          diagnostic(
            candidate.path,
            "limit-exceeded",
            `the total ${layout.label} byte limit of ${options.maximumTotalBytes} was reached`,
          ),
        );
        break;
      }

      let parsed: { readonly name: string; readonly value: Value };
      try {
        parsed = layout.parse(result.content, result.displayPath);
      } catch (error) {
        if (!(error instanceof SkillError)) throw error;
        diagnostics.push(diagnostic(candidate.path, "invalid-manifest", error.message));
        continue;
      }
      if (parsed.name !== candidate.name) {
        diagnostics.push(
          diagnostic(
            candidate.path,
            "name-mismatch",
            `the declared name ${parsed.name} does not match the file name ${candidate.name}`,
          ),
        );
        continue;
      }

      const sha256 = await sha256Digest(result.content);
      claimedNames.add(candidate.name);
      totalBytes += result.bytes;
      documents.push({
        provenance: Object.freeze({
          id: `${layout.idPrefix}:${candidate.name}:${sha256.slice("sha256:".length, "sha256:".length + 16)}`,
          name: candidate.name,
          displayPath: result.displayPath,
          realPath: result.realPath,
          origin: candidate.origin,
          trust: candidate.origin === "global" ? "trusted-user" : "untrusted-project",
          bytes: result.bytes,
          sha256,
        }),
        value: parsed.value,
      });
    }
  }

  documents.sort((left, right) => left.provenance.name.localeCompare(right.provenance.name));
  return Object.freeze({
    documents: Object.freeze(documents),
    diagnostics: Object.freeze(diagnostics),
    totalBytes,
  });
}

function candidatesFrom<Value>(
  root: { readonly origin: DocumentOrigin; readonly path: string },
  entries: readonly DocumentDirectoryEntry[],
  layout: DocumentLayout<Value>,
  diagnostics: SkillDiagnostic[],
): readonly Candidate[] {
  const candidates: Candidate[] = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const child = `${root.path}/${entry.name}`;
    const name =
      entry.kind === "file" && entry.name.endsWith(".md") ? entry.name.slice(0, -3) : entry.name;
    if (entry.kind === "file" && !entry.name.endsWith(".md")) {
      diagnostics.push(
        diagnostic(child, "unsupported-entry", `only .md ${layout.label} files are read`),
      );
      continue;
    }
    if (entry.kind === "directory" && layout.directoryFileName === undefined) {
      diagnostics.push(
        diagnostic(child, "unsupported-entry", `${layout.label}s must be single .md files`),
      );
      continue;
    }
    if (!SkillNameSchema.safeParse(name).success) {
      diagnostics.push(
        diagnostic(child, "invalid-name", `${name} is not a lowercase kebab-case name`),
      );
      continue;
    }
    candidates.push({
      origin: root.origin,
      name,
      path: entry.kind === "directory" ? `${child}/${layout.directoryFileName}` : child,
    });
  }
  return Object.freeze(candidates);
}

function diagnostic(path: string, reason: SkillDiagnosticReason, detail: string): SkillDiagnostic {
  return Object.freeze({ path, reason, detail });
}

function validatePositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SkillDiscoveryError(`${label} must be a positive integer`, { label });
  }
}
