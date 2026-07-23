import {
  JsonValueSchema,
  type CheckpointRepository,
  type JsonObject,
  type JsonValue,
  type PersistedCheckpoint,
  type PersistenceRepositories,
  type RunId,
  type SessionId,
} from "@pilotrun/core";
import type { RunCheckpoint, RunCheckpointWriter } from "./application-runner.js";
import type { MonotonicClock } from "./run-budget.js";

export interface ThrottledCheckpointPolicy {
  /** Minimum time between durable model-stream snapshots for the same run. */
  readonly streamIntervalMs: number;
}

interface PendingRunCheckpoint {
  latestStream: RunCheckpoint | undefined;
  lastStreamWrittenAtMs: number | undefined;
}

/**
 * Coalesces only high-frequency stream snapshots. Lifecycle checkpoints are never dropped and force
 * the latest partial stream state to durable storage first.
 */
export class ThrottledRunCheckpointWriter implements RunCheckpointWriter {
  readonly #delegate: RunCheckpointWriter;
  readonly #clock: MonotonicClock;
  readonly #policy: ThrottledCheckpointPolicy;
  readonly #runs = new Map<RunId, PendingRunCheckpoint>();
  #queue: Promise<void> = Promise.resolve();

  constructor(
    delegate: RunCheckpointWriter,
    clock: MonotonicClock,
    policy: ThrottledCheckpointPolicy,
  ) {
    if (
      !Number.isSafeInteger(policy.streamIntervalMs) ||
      policy.streamIntervalMs < 0 ||
      policy.streamIntervalMs > 60_000
    ) {
      throw new RangeError("streamIntervalMs must be an integer between 0 and 60000");
    }
    this.#delegate = delegate;
    this.#clock = clock;
    this.#policy = Object.freeze({ ...policy });
  }

  write(checkpoint: RunCheckpoint): Promise<void> {
    return this.#enqueue(() => this.#write(checkpoint));
  }

  /** Flushes the newest coalesced snapshot for every run. */
  flush(): Promise<void> {
    return this.#enqueue(async () => {
      for (const state of this.#runs.values()) await this.#flushRun(state);
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #write(checkpoint: RunCheckpoint): Promise<void> {
    const run = checkpoint.state.runId;
    const state = this.#runs.get(run) ?? {
      latestStream: undefined,
      lastStreamWrittenAtMs: undefined,
    };
    this.#runs.set(run, state);

    if (checkpoint.reason !== "model.stream.event") {
      await this.#flushRun(state);
      await this.#delegate.write(checkpoint);
      if (checkpoint.reason === "run.terminal") this.#runs.delete(run);
      return;
    }

    const now = this.#now();
    if (
      state.lastStreamWrittenAtMs === undefined ||
      now - state.lastStreamWrittenAtMs >= this.#policy.streamIntervalMs
    ) {
      await this.#delegate.write(checkpoint);
      state.latestStream = undefined;
      state.lastStreamWrittenAtMs = now;
      return;
    }
    state.latestStream = checkpoint;
  }

  async #flushRun(state: PendingRunCheckpoint): Promise<void> {
    const pending = state.latestStream;
    if (pending === undefined) return;
    await this.#delegate.write(pending);
    state.latestStream = undefined;
    state.lastStreamWrittenAtMs = this.#now();
  }

  #now(): number {
    const value = this.#clock.nowMilliseconds();
    if (!Number.isFinite(value)) throw new RangeError("Monotonic checkpoint clock must be finite");
    return value;
  }
}

/** Maps runtime checkpoints to provider-neutral durable records without persisting reasoning text. */
export class RepositoryRunCheckpointWriter implements RunCheckpointWriter {
  readonly #repository: CheckpointRepository;

  constructor(repository: CheckpointRepository) {
    this.#repository = repository;
  }

  async write(checkpoint: RunCheckpoint): Promise<void> {
    await this.#repository.append(toPersistedCheckpoint(checkpoint));
  }
}

/** Persists both the ordered checkpoint and its owning run's latest lifecycle state. */
export class RepositoryRunLifecycleCheckpointWriter implements RunCheckpointWriter {
  readonly #repositories: PersistenceRepositories;
  readonly #sessionId: SessionId;

  constructor(repositories: PersistenceRepositories, sessionId: SessionId) {
    this.#repositories = repositories;
    this.#sessionId = sessionId;
  }

  async write(checkpoint: RunCheckpoint): Promise<void> {
    const persisted = toPersistedCheckpoint(checkpoint);
    const current = await this.#repositories.runs.load(persisted.runId);
    const state = jsonObjectProperty(persisted.payload, "state");
    const terminal = ["aborted", "completed", "failed"].includes(checkpoint.state.kind);
    const status =
      checkpoint.state.kind === "completed"
        ? "completed"
        : checkpoint.state.kind === "failed"
          ? "failed"
          : checkpoint.state.kind === "aborted"
            ? "aborted"
            : "running";
    const record = Object.freeze({
      id: persisted.runId,
      sessionId: this.#sessionId,
      status,
      state,
      ...(checkpoint.state.kind === "failed" ? { error: jsonObjectProperty(state, "error") } : {}),
      startedAt: current?.startedAt ?? checkpoint.occurredAt,
      updatedAt: checkpoint.occurredAt,
      ...(terminal ? { completedAt: checkpoint.occurredAt } : {}),
    });
    if (current === undefined) await this.#repositories.runs.create(record);
    await this.#repositories.checkpoints.append(persisted);
    await this.#repositories.runs.save(record);
  }
}

export function toPersistedCheckpoint(checkpoint: RunCheckpoint): PersistedCheckpoint {
  const stream = checkpoint.stream;
  const payload = toJsonObject({
    schemaVersion: checkpoint.schemaVersion,
    state: checkpoint.state,
    budget: checkpoint.budget,
    ...(stream === undefined
      ? {}
      : {
          stream: {
            phase: stream.phase,
            partial: stream.phase !== "completed",
            ...(stream.responseId === undefined ? {} : { responseId: stream.responseId }),
            ...(stream.lastSequence === undefined ? {} : { lastSequence: stream.lastSequence }),
            content: {
              text: stream.content.text,
              toolCalls: stream.content.toolCalls,
              ...(stream.content.usage === undefined ? {} : { usage: stream.content.usage }),
              ...(stream.content.providerMetadata === undefined
                ? {}
                : { providerMetadata: stream.content.providerMetadata }),
            },
            reasoning: { persisted: false },
          },
        }),
  });
  return Object.freeze({
    runId: checkpoint.state.runId,
    sequence: checkpoint.sequence,
    reason: checkpoint.reason,
    payload,
    createdAt: checkpoint.occurredAt,
  });
}

function toJsonObject(value: unknown): JsonObject {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError("Checkpoint is not JSON serializable", { cause: error });
  }
  const parsed: JsonValue = JsonValueSchema.parse(JSON.parse(serialized));
  if (!isJsonObject(parsed)) throw new TypeError("Checkpoint payload must be a JSON object");
  return parsed;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonObjectProperty(value: JsonObject, key: string): JsonObject {
  const property = value[key];
  if (property === undefined || !isJsonObject(property)) {
    throw new TypeError(`Checkpoint ${key} must be a JSON object`);
  }
  return property;
}
