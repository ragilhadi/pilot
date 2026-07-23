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

/** Process-local journal with hash-guarded rollback data kept out of public records. */
export class InMemoryChangeJournal implements ChangeJournal {
  readonly #clock: Clock;
  readonly #entries: ChangeJournalEntry[] = [];
  readonly #originalContent = new Map<number, string>();
  readonly #rolledBack = new Set<number>();

  constructor(clock: Clock) {
    this.#clock = clock;
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
    this.#originalContent.set(entry.sequence, input.originalContent);
    return entry;
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
