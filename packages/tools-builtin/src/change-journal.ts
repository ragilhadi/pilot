import { type Clock, PilotError, type RunId, type ToolCallId } from "@pilotrun/core";
import type { WorkspaceFileSystem } from "./workspace-file-system.js";

export type ChangeJournalOperation = "apply" | "rollback";

export interface ChangeJournalEntry {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly runId: RunId;
  readonly callId: ToolCallId;
  readonly operation: ChangeJournalOperation;
  readonly path: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly additions: number;
  readonly deletions: number;
  readonly relatedSequence?: number;
}

export interface AppliedChangeInput {
  readonly runId: RunId;
  readonly callId: ToolCallId;
  readonly path: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly additions: number;
  readonly deletions: number;
  readonly originalContent: string;
}

export interface RollbackChangeInput {
  readonly sequence: number;
  readonly runId: RunId;
  readonly callId: ToolCallId;
  readonly fileSystem: WorkspaceFileSystem;
  readonly signal: AbortSignal;
}

export interface ChangeJournal {
  recordApplied(input: AppliedChangeInput): ChangeJournalEntry;
  entries(runId?: RunId): readonly ChangeJournalEntry[];
  rollback(input: RollbackChangeInput): Promise<ChangeJournalEntry>;
}

export class ChangeJournalError extends PilotError {
  constructor(message: string, metadata: Readonly<Record<string, unknown>> = {}) {
    super({
      code: "PILOT_CHANGE_JOURNAL_INVALID",
      message,
      safeMessage: "The requested change-journal operation is invalid",
      metadata,
    });
  }
}

/** Default ceiling on retained rollback content, in bytes. */
export const defaultChangeJournalContentBytes = 8_000_000;

export interface InMemoryChangeJournalOptions {
  /** Ceiling on retained pre-edit content. Oldest originals are evicted first. */
  readonly maximumContentBytes?: number;
}

/** Process-local journal with hash-guarded rollback data kept out of public records. */
export class InMemoryChangeJournal implements ChangeJournal {
  readonly #clock: Clock;
  readonly #entries: ChangeJournalEntry[] = [];
  readonly #originalContent = new Map<number, string>();
  readonly #rolledBack = new Set<number>();
  readonly #maximumContentBytes: number;
  #retainedBytes = 0;

  constructor(clock: Clock, options: InMemoryChangeJournalOptions = {}) {
    this.#clock = clock;
    this.#maximumContentBytes = options.maximumContentBytes ?? defaultChangeJournalContentBytes;
  }

  recordApplied(input: AppliedChangeInput): ChangeJournalEntry {
    validateDigest(input.beforeSha256, "beforeSha256");
    validateDigest(input.afterSha256, "afterSha256");
    const entry = this.#append({
      runId: input.runId,
      callId: input.callId,
      operation: "apply",
      path: input.path,
      beforeSha256: input.beforeSha256,
      afterSha256: input.afterSha256,
      additions: input.additions,
      deletions: input.deletions,
    });
    this.#retain(entry.sequence, input.originalContent);
    return entry;
  }

  /**
   * Stores the pre-edit content that `rollback` would restore, evicting the oldest originals once
   * the budget is exceeded.
   *
   * Retention used to be unbounded: every edit, patch, and overwrite kept a full copy of the file
   * as it was before the change, for the lifetime of the process. A long session that repeatedly
   * rewrote large files grew without limit. Evicted entries stay in the journal — only their
   * rollback payload is dropped, and `rollback` already reports that as unavailable.
   */
  #retain(sequence: number, content: string): void {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.#maximumContentBytes) return; // Single file larger than the whole budget.
    this.#originalContent.set(sequence, content);
    this.#retainedBytes += bytes;
    for (const [candidate, retained] of this.#originalContent) {
      if (this.#retainedBytes <= this.#maximumContentBytes) break;
      if (candidate === sequence) continue;
      this.#originalContent.delete(candidate);
      this.#retainedBytes -= Buffer.byteLength(retained, "utf8");
    }
  }

  entries(runId?: RunId): readonly ChangeJournalEntry[] {
    return Object.freeze(
      this.#entries.filter((entry) => runId === undefined || entry.runId === runId),
    );
  }

  async rollback(input: RollbackChangeInput): Promise<ChangeJournalEntry> {
    const original = this.#entries[input.sequence - 1];
    const content = this.#originalContent.get(input.sequence);
    if (
      original === undefined ||
      original.operation !== "apply" ||
      original.runId !== input.runId ||
      content === undefined ||
      this.#rolledBack.has(input.sequence)
    ) {
      throw new ChangeJournalError("Change is unavailable or already rolled back", {
        sequence: input.sequence,
        runId: input.runId,
      });
    }
    const replacement = await input.fileSystem.replaceUtf8Atomic({
      path: original.path,
      expectedSha256: original.afterSha256,
      content,
      signal: input.signal,
    });
    this.#rolledBack.add(input.sequence);
    // The change is undone, so its pre-edit copy can never be needed again.
    this.#originalContent.delete(input.sequence);
    this.#retainedBytes -= Buffer.byteLength(content, "utf8");
    return this.#append({
      runId: input.runId,
      callId: input.callId,
      operation: "rollback",
      path: original.path,
      beforeSha256: replacement.beforeSha256,
      afterSha256: replacement.afterSha256,
      additions: original.deletions,
      deletions: original.additions,
      relatedSequence: original.sequence,
    });
  }

  #append(input: Omit<ChangeJournalEntry, "occurredAt" | "sequence">): ChangeJournalEntry {
    const entry = Object.freeze({
      sequence: this.#entries.length + 1,
      occurredAt: this.#clock.now().toISOString(),
      ...input,
    });
    this.#entries.push(entry);
    return entry;
  }
}

function validateDigest(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new ChangeJournalError(`${name} must be a lowercase SHA-256 digest`, { field: name });
  }
}
