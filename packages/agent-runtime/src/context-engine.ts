import {
  AgentMessageSchema,
  CancellationError,
  JsonValueSchema,
  PilotError,
  type AgentMessage,
  type JsonObject,
  type RunId,
  type SessionId,
} from "@pilotrun/core";

export type ContextContent = AgentMessage | string;
export type ContextTrust = "trusted" | "untrusted";
export type ContextProvenanceKind =
  | "conversation"
  | "diagnostic"
  | "git-diff"
  | "instructions"
  | "plan"
  | "repository-summary"
  | "subagent-result"
  | "system-policy"
  | "task-state"
  | "tool-result"
  | "user-message"
  | "workspace-file";

export interface ContextProvenance {
  readonly kind: ContextProvenanceKind;
  readonly trust: ContextTrust;
  readonly reference: string;
  readonly sha256?: `sha256:${string}`;
}

export interface ContextCandidate {
  readonly id: string;
  readonly content: ContextContent;
  /** A trusted source may provide a conservative estimate; the engine never uses less than its own estimate. */
  readonly estimatedTokens?: number;
  readonly relevance: number;
  readonly mandatory: boolean;
  readonly provenance: ContextProvenance;
  /** Equal non-empty keys identify semantically interchangeable candidates. */
  readonly deduplicationKey?: string;
}

export interface ContextCollectionContext {
  readonly runId: RunId;
  readonly sessionId?: SessionId;
  readonly cycle: number;
  readonly targetPaths: readonly string[];
  readonly metadata?: JsonObject;
  readonly signal: AbortSignal;
}

export interface ContextSource {
  readonly id: string;
  /** Higher values are selected first. */
  readonly priority: number;
  /** Optional hard cap shared by all candidates emitted by this source. */
  readonly tokenBudget?: number;
  collect(context: ContextCollectionContext): Promise<readonly ContextCandidate[]>;
}

export interface ContextTokenEstimate {
  readonly tokens: number;
  readonly method: string;
}

export interface ContextTokenEstimator {
  estimate(content: ContextContent): ContextTokenEstimate;
}

export type ContextFreshness =
  | { readonly status: "unversioned" }
  | { readonly status: "not-checked"; readonly expectedSha256: `sha256:${string}` }
  | { readonly status: "current"; readonly expectedSha256: `sha256:${string}` }
  | {
      readonly status: "stale";
      readonly expectedSha256: `sha256:${string}`;
      readonly actualSha256?: `sha256:${string}`;
    };

export type ContextFreshnessVerification = Extract<
  ContextFreshness,
  { readonly status: "current" | "stale" }
>;

export interface ContextFreshnessVerifier {
  verify(
    provenance: ContextProvenance & { readonly sha256: `sha256:${string}` },
    signal: AbortSignal,
  ): Promise<ContextFreshnessVerification>;
}

export interface CollectedContextCandidate extends Omit<ContextCandidate, "estimatedTokens"> {
  readonly estimatedTokens: number;
  readonly tokenEstimate: ContextTokenEstimate;
  readonly freshness: ContextFreshness;
  readonly sourceId: string;
  readonly sourcePriority: number;
  readonly sourceTokenBudget?: number;
}

export type ContextExclusionReason =
  | "duplicate"
  | "source-budget-exhausted"
  | "stale-content"
  | "total-budget-exhausted";

export type ExcludedContextCandidate =
  | {
      readonly candidate: CollectedContextCandidate;
      readonly reason: "source-budget-exhausted" | "total-budget-exhausted";
      readonly availableTokens: number;
    }
  | {
      readonly candidate: CollectedContextCandidate;
      readonly reason: "duplicate";
      readonly duplicateOf: string;
    }
  | {
      readonly candidate: CollectedContextCandidate;
      readonly reason: "stale-content";
      readonly expectedSha256: `sha256:${string}`;
      readonly actualSha256?: `sha256:${string}`;
    };

export interface ContextBudgetRequest {
  readonly configuredContextTokens: number;
  readonly modelContextTokens?: number;
  readonly reservedOutputTokens: number;
  readonly reservedInputTokens?: number;
}

export interface ResolvedContextBudget {
  readonly configuredContextTokens: number;
  readonly modelContextTokens?: number;
  readonly effectiveContextTokens: number;
  readonly reservedOutputTokens: number;
  readonly reservedInputTokens: number;
  readonly availableCandidateTokens: number;
}

export interface ContextEngineDependencies {
  readonly tokenEstimator?: ContextTokenEstimator;
  readonly freshnessVerifier?: ContextFreshnessVerifier;
}

export interface ContextSelection {
  readonly maximumTokens: number;
  readonly budget: ResolvedContextBudget;
  readonly selected: readonly CollectedContextCandidate[];
  readonly excluded: readonly ExcludedContextCandidate[];
  readonly selectedTokens: number;
  readonly remainingTokens: number;
  readonly sourceUsage: Readonly<Record<string, number>>;
}

export type ContextPreparationOptions =
  | { readonly budget: ContextBudgetRequest; readonly maximumTokens?: never }
  | { readonly budget?: never; readonly maximumTokens: number };

export class ContextEngineError extends PilotError {
  constructor(
    code: "PILOT_CONTEXT_BUDGET" | "PILOT_CONTEXT_INVALID" | "PILOT_CONTEXT_STALE",
    message: string,
    metadata: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super({
      code,
      message,
      safeMessage:
        code === "PILOT_CONTEXT_BUDGET"
          ? "Mandatory model context does not fit the configured budget"
          : code === "PILOT_CONTEXT_STALE"
            ? "Mandatory model context changed and must be collected again"
            : "A context source or candidate is invalid",
      metadata,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

/** Collects source candidates and selects a deterministic, budget-bounded context snapshot. */
export class ContextEngine {
  readonly #sources: readonly ContextSource[];
  readonly #tokenEstimator: ContextTokenEstimator;
  readonly #freshnessVerifier: ContextFreshnessVerifier | undefined;

  constructor(sources: readonly ContextSource[], dependencies: ContextEngineDependencies = {}) {
    this.#sources = normalizeSources(sources);
    this.#tokenEstimator = dependencies.tokenEstimator ?? new Utf8HeuristicTokenEstimator();
    this.#freshnessVerifier = dependencies.freshnessVerifier;
  }

  async prepare(
    context: ContextCollectionContext,
    options: ContextPreparationOptions,
  ): Promise<ContextSelection> {
    const budget = resolvePreparationBudget(options);
    const normalizedContext = normalizeCollectionContext(context);
    throwIfCancelled(normalizedContext.signal);

    const batches = await Promise.all(
      this.#sources.map(async (source) => {
        const candidates = await source.collect(normalizedContext);
        throwIfCancelled(normalizedContext.signal);
        if (!Array.isArray(candidates)) {
          throw new ContextEngineError(
            "PILOT_CONTEXT_INVALID",
            `Context source ${source.id} returned a non-array result`,
            { sourceId: source.id },
          );
        }
        return Promise.all(
          candidates.map((candidate) =>
            normalizeCandidate(
              source,
              candidate,
              this.#tokenEstimator,
              this.#freshnessVerifier,
              normalizedContext.signal,
            ),
          ),
        );
      }),
    );

    return selectContext(batches.flat(), budget);
  }
}

export class Utf8HeuristicTokenEstimator implements ContextTokenEstimator {
  readonly #bytesPerToken: number;
  readonly #framingTokens: number;

  constructor(options: { readonly bytesPerToken?: number; readonly framingTokens?: number } = {}) {
    this.#bytesPerToken = options.bytesPerToken ?? 3;
    this.#framingTokens = options.framingTokens ?? 4;
    if (!Number.isSafeInteger(this.#bytesPerToken) || this.#bytesPerToken < 1) {
      throw new ContextEngineError("PILOT_CONTEXT_INVALID", "bytesPerToken must be positive");
    }
    if (!Number.isSafeInteger(this.#framingTokens) || this.#framingTokens < 0) {
      throw new ContextEngineError("PILOT_CONTEXT_INVALID", "framingTokens cannot be negative");
    }
  }

  estimate(content: ContextContent): ContextTokenEstimate {
    const serialized = typeof content === "string" ? content : JSON.stringify(content);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    return Object.freeze({
      tokens: safeTokenSum(Math.ceil(bytes / this.#bytesPerToken), this.#framingTokens),
      method: `utf8-bytes/${this.#bytesPerToken}+${this.#framingTokens}`,
    });
  }
}

export function resolveContextBudget(request: ContextBudgetRequest): ResolvedContextBudget {
  validatePositiveInteger(request.configuredContextTokens, "configuredContextTokens");
  if (request.modelContextTokens !== undefined) {
    validatePositiveInteger(request.modelContextTokens, "modelContextTokens");
  }
  validatePositiveInteger(request.reservedOutputTokens, "reservedOutputTokens");
  const reservedInputTokens = request.reservedInputTokens ?? 0;
  validateNonnegativeInteger(reservedInputTokens, "reservedInputTokens");
  const effectiveContextTokens = Math.min(
    request.configuredContextTokens,
    request.modelContextTokens ?? Number.MAX_SAFE_INTEGER,
  );
  const reservedTokens = safeTokenSum(request.reservedOutputTokens, reservedInputTokens);
  if (reservedTokens >= effectiveContextTokens) {
    throw new ContextEngineError(
      "PILOT_CONTEXT_BUDGET",
      "Context reservations leave no capacity for candidates",
      {
        effectiveContextTokens,
        reservedOutputTokens: request.reservedOutputTokens,
        reservedInputTokens,
      },
    );
  }
  return Object.freeze({
    configuredContextTokens: request.configuredContextTokens,
    ...(request.modelContextTokens === undefined
      ? {}
      : { modelContextTokens: request.modelContextTokens }),
    effectiveContextTokens,
    reservedOutputTokens: request.reservedOutputTokens,
    reservedInputTokens,
    availableCandidateTokens: effectiveContextTokens - reservedTokens,
  });
}

export function selectContext(
  candidates: readonly CollectedContextCandidate[],
  budgetInput: number | ResolvedContextBudget,
): ContextSelection {
  const budget =
    typeof budgetInput === "number"
      ? legacyContextBudget(budgetInput)
      : normalizeBudget(budgetInput);
  const maximumTokens = budget.availableCandidateTokens;
  const normalized = candidates.map((candidate) => normalizeCollectedCandidate(candidate));
  const identifiers = new Set<string>();
  const sourceDefinitions = new Map<
    string,
    { readonly priority: number; readonly tokenBudget?: number }
  >();
  for (const candidate of normalized) {
    if (identifiers.has(candidate.id)) {
      throw new ContextEngineError(
        "PILOT_CONTEXT_INVALID",
        `Context candidate ID ${candidate.id} is duplicated`,
        { candidateId: candidate.id },
      );
    }
    identifiers.add(candidate.id);
    const previousSource = sourceDefinitions.get(candidate.sourceId);
    if (
      previousSource !== undefined &&
      (previousSource.priority !== candidate.sourcePriority ||
        previousSource.tokenBudget !== candidate.sourceTokenBudget)
    ) {
      throw new ContextEngineError(
        "PILOT_CONTEXT_INVALID",
        `Context source ${candidate.sourceId} has inconsistent candidate metadata`,
        { sourceId: candidate.sourceId },
      );
    }
    sourceDefinitions.set(candidate.sourceId, {
      priority: candidate.sourcePriority,
      ...(candidate.sourceTokenBudget === undefined
        ? {}
        : { tokenBudget: candidate.sourceTokenBudget }),
    });
  }

  const ordered = [...normalized].sort(compareCandidate);
  const selected: CollectedContextCandidate[] = [];
  const excluded: ExcludedContextCandidate[] = [];
  const deduplicationWinners = new Map<string, string>();
  const sourceUsage: Record<string, number> = {};
  let selectedTokens = 0;

  for (const candidate of ordered) {
    if (candidate.freshness.status === "stale") {
      if (candidate.mandatory) {
        throw new ContextEngineError(
          "PILOT_CONTEXT_STALE",
          `Mandatory context candidate ${candidate.id} is stale`,
          {
            candidateId: candidate.id,
            sourceId: candidate.sourceId,
            expectedSha256: candidate.freshness.expectedSha256,
            ...(candidate.freshness.actualSha256 === undefined
              ? {}
              : { actualSha256: candidate.freshness.actualSha256 }),
          },
        );
      }
      excluded.push(
        Object.freeze({
          candidate,
          reason: "stale-content",
          expectedSha256: candidate.freshness.expectedSha256,
          ...(candidate.freshness.actualSha256 === undefined
            ? {}
            : { actualSha256: candidate.freshness.actualSha256 }),
        }),
      );
      continue;
    }

    const deduplicationKey = candidate.deduplicationKey ?? candidate.provenance.sha256;
    if (deduplicationKey !== undefined) {
      const winner = deduplicationWinners.get(deduplicationKey);
      if (winner !== undefined) {
        excluded.push(Object.freeze({ candidate, reason: "duplicate", duplicateOf: winner }));
        continue;
      }
    }

    const usedBySource = sourceUsage[candidate.sourceId] ?? 0;
    const availableForSource =
      candidate.sourceTokenBudget === undefined
        ? Number.MAX_SAFE_INTEGER
        : candidate.sourceTokenBudget - usedBySource;
    const availableTotal = maximumTokens - selectedTokens;
    const sourceFits = candidate.estimatedTokens <= availableForSource;
    const totalFits = candidate.estimatedTokens <= availableTotal;

    if (!sourceFits || !totalFits) {
      if (candidate.mandatory) {
        const limitingBudget = !sourceFits ? "source" : "total";
        throw new ContextEngineError(
          "PILOT_CONTEXT_BUDGET",
          `Mandatory context candidate ${candidate.id} exceeds the ${limitingBudget} budget`,
          {
            candidateId: candidate.id,
            sourceId: candidate.sourceId,
            estimatedTokens: candidate.estimatedTokens,
            availableTokens: !sourceFits ? Math.max(0, availableForSource) : availableTotal,
            limitingBudget,
          },
        );
      }
      excluded.push(
        Object.freeze({
          candidate,
          reason: !sourceFits ? "source-budget-exhausted" : "total-budget-exhausted",
          availableTokens: Math.max(0, !sourceFits ? availableForSource : availableTotal),
        }),
      );
      continue;
    }

    selected.push(candidate);
    if (deduplicationKey !== undefined) {
      deduplicationWinners.set(deduplicationKey, candidate.id);
    }
    selectedTokens = safeTokenSum(selectedTokens, candidate.estimatedTokens);
    sourceUsage[candidate.sourceId] = safeTokenSum(usedBySource, candidate.estimatedTokens);
  }

  return Object.freeze({
    maximumTokens,
    budget,
    selected: Object.freeze(selected.sort(comparePromptOrder)),
    excluded: Object.freeze(excluded),
    selectedTokens,
    remainingTokens: maximumTokens - selectedTokens,
    sourceUsage: Object.freeze(
      Object.fromEntries(
        Object.entries(sourceUsage).sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
  });
}

function normalizeSources(sources: readonly ContextSource[]): readonly ContextSource[] {
  const identifiers = new Set<string>();
  const normalized = sources.map((source) => {
    validateIdentifier(source.id, "source ID");
    if (identifiers.has(source.id)) {
      throw new ContextEngineError(
        "PILOT_CONTEXT_INVALID",
        `Context source ID ${source.id} is duplicated`,
        { sourceId: source.id },
      );
    }
    identifiers.add(source.id);
    if (!Number.isSafeInteger(source.priority)) {
      throw new ContextEngineError(
        "PILOT_CONTEXT_INVALID",
        `Context source ${source.id} has an invalid priority`,
        { sourceId: source.id },
      );
    }
    if (source.tokenBudget !== undefined) {
      validatePositiveInteger(source.tokenBudget, `token budget for ${source.id}`);
    }
    if (typeof source.collect !== "function") {
      throw new ContextEngineError(
        "PILOT_CONTEXT_INVALID",
        `Context source ${source.id} has no collector`,
        { sourceId: source.id },
      );
    }
    return Object.freeze({ ...source });
  });
  return Object.freeze(
    normalized.sort((left, right) =>
      left.priority === right.priority
        ? left.id.localeCompare(right.id)
        : right.priority - left.priority,
    ),
  );
}

async function normalizeCandidate(
  source: ContextSource,
  candidate: ContextCandidate,
  estimator: ContextTokenEstimator,
  freshnessVerifier: ContextFreshnessVerifier | undefined,
  signal: AbortSignal,
): Promise<CollectedContextCandidate> {
  const content = normalizeContent(candidate.id, candidate.content);
  const automaticEstimate = normalizeTokenEstimate(candidate.id, estimator.estimate(content));
  if (candidate.estimatedTokens !== undefined) {
    validatePositiveInteger(candidate.estimatedTokens, `estimated tokens for ${candidate.id}`);
  }
  const estimatedTokens = Math.max(candidate.estimatedTokens ?? 0, automaticEstimate.tokens);
  const tokenEstimate = Object.freeze({
    tokens: estimatedTokens,
    method:
      candidate.estimatedTokens !== undefined &&
      candidate.estimatedTokens >= automaticEstimate.tokens
        ? "source-conservative-estimate"
        : automaticEstimate.method,
  });
  const provenance = normalizeProvenance(candidate.id, candidate.provenance);
  const freshness = await inspectFreshness(candidate.id, provenance, freshnessVerifier, signal);
  throwIfCancelled(signal);
  return normalizeCollectedCandidate({
    ...candidate,
    content,
    provenance,
    estimatedTokens,
    tokenEstimate,
    freshness,
    sourceId: source.id,
    sourcePriority: source.priority,
    ...(source.tokenBudget === undefined ? {} : { sourceTokenBudget: source.tokenBudget }),
  });
}

function normalizeCollectedCandidate(
  candidate: CollectedContextCandidate,
): CollectedContextCandidate {
  validateIdentifier(candidate.id, "candidate ID");
  validateIdentifier(candidate.sourceId, "source ID");
  validatePositiveInteger(candidate.estimatedTokens, `estimated tokens for ${candidate.id}`);
  const tokenEstimate = normalizeTokenEstimate(candidate.id, candidate.tokenEstimate);
  if (tokenEstimate.tokens !== candidate.estimatedTokens) {
    throw new ContextEngineError(
      "PILOT_CONTEXT_INVALID",
      `Context candidate ${candidate.id} has inconsistent token estimate metadata`,
      { candidateId: candidate.id },
    );
  }
  if (!Number.isSafeInteger(candidate.sourcePriority)) {
    throw new ContextEngineError(
      "PILOT_CONTEXT_INVALID",
      `Context candidate ${candidate.id} has an invalid source priority`,
      { candidateId: candidate.id },
    );
  }
  if (candidate.sourceTokenBudget !== undefined) {
    validatePositiveInteger(candidate.sourceTokenBudget, `source budget for ${candidate.id}`);
  }
  if (!Number.isFinite(candidate.relevance) || candidate.relevance < 0 || candidate.relevance > 1) {
    throw new ContextEngineError(
      "PILOT_CONTEXT_INVALID",
      `Context candidate ${candidate.id} relevance must be between 0 and 1`,
      { candidateId: candidate.id },
    );
  }
  if (typeof candidate.mandatory !== "boolean") {
    throw new ContextEngineError(
      "PILOT_CONTEXT_INVALID",
      `Context candidate ${candidate.id} has an invalid mandatory flag`,
      { candidateId: candidate.id },
    );
  }
  const content = normalizeContent(candidate.id, candidate.content);
  const provenance = normalizeProvenance(candidate.id, candidate.provenance);
  if (candidate.deduplicationKey !== undefined) {
    validateIdentifier(candidate.deduplicationKey, `deduplication key for ${candidate.id}`, 1_024);
  }
  const freshness = normalizeFreshness(candidate.id, candidate.freshness, provenance.sha256);
  return Object.freeze({ ...candidate, content, provenance, tokenEstimate, freshness });
}

function normalizeContent(candidateId: string, content: ContextContent): ContextContent {
  if (typeof content === "string") {
    if (content.length === 0) {
      throw new ContextEngineError(
        "PILOT_CONTEXT_INVALID",
        `Context candidate ${candidateId} has empty content`,
        { candidateId },
      );
    }
    return content;
  }
  const parsed = AgentMessageSchema.safeParse(content);
  if (!parsed.success) {
    throw new ContextEngineError(
      "PILOT_CONTEXT_INVALID",
      `Context candidate ${candidateId} contains an invalid message`,
      { candidateId, issueCount: parsed.error.issues.length },
      parsed.error,
    );
  }
  return parsed.data;
}

function normalizeProvenance(
  candidateId: string,
  provenance: ContextProvenance,
): ContextProvenance {
  const kinds: ReadonlySet<string> = new Set([
    "conversation",
    "diagnostic",
    "git-diff",
    "instructions",
    "plan",
    "repository-summary",
    "subagent-result",
    "system-policy",
    "task-state",
    "tool-result",
    "user-message",
    "workspace-file",
  ]);
  if (!kinds.has(provenance.kind)) {
    throw new ContextEngineError(
      "PILOT_CONTEXT_INVALID",
      `Context candidate ${candidateId} has an invalid provenance kind`,
      { candidateId },
    );
  }
  if (provenance.trust !== "trusted" && provenance.trust !== "untrusted") {
    throw new ContextEngineError(
      "PILOT_CONTEXT_INVALID",
      `Context candidate ${candidateId} has an invalid trust label`,
      { candidateId },
    );
  }
  validateIdentifier(provenance.reference, `provenance reference for ${candidateId}`, 1_024);
  if (provenance.sha256 !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(provenance.sha256)) {
    throw new ContextEngineError(
      "PILOT_CONTEXT_INVALID",
      `Context candidate ${candidateId} has an invalid SHA-256 provenance value`,
      { candidateId },
    );
  }
  return Object.freeze({ ...provenance });
}

function normalizeTokenEstimate(
  candidateId: string,
  estimate: ContextTokenEstimate,
): ContextTokenEstimate {
  if (typeof estimate !== "object" || estimate === null) {
    throw new ContextEngineError(
      "PILOT_CONTEXT_INVALID",
      `Token estimator returned an invalid result for ${candidateId}`,
      { candidateId },
    );
  }
  validatePositiveInteger(estimate.tokens, `token estimate for ${candidateId}`);
  validateIdentifier(estimate.method, `token estimate method for ${candidateId}`, 256);
  return Object.freeze({ tokens: estimate.tokens, method: estimate.method });
}

async function inspectFreshness(
  candidateId: string,
  provenance: ContextProvenance,
  verifier: ContextFreshnessVerifier | undefined,
  signal: AbortSignal,
): Promise<ContextFreshness> {
  if (provenance.sha256 === undefined) return Object.freeze({ status: "unversioned" });
  if (verifier === undefined) {
    return Object.freeze({ status: "not-checked", expectedSha256: provenance.sha256 });
  }
  throwIfCancelled(signal);
  const result = await verifier.verify(
    provenance as ContextProvenance & { readonly sha256: `sha256:${string}` },
    signal,
  );
  return normalizeFreshness(candidateId, result, provenance.sha256);
}

function normalizeFreshness(
  candidateId: string,
  freshness: ContextFreshness,
  provenanceSha256: `sha256:${string}` | undefined,
): ContextFreshness {
  if (typeof freshness !== "object" || freshness === null) {
    throw new ContextEngineError(
      "PILOT_CONTEXT_INVALID",
      `Context candidate ${candidateId} has invalid freshness metadata`,
      { candidateId },
    );
  }
  if (provenanceSha256 === undefined) {
    if (freshness.status !== "unversioned") {
      throw new ContextEngineError(
        "PILOT_CONTEXT_INVALID",
        `Unversioned context candidate ${candidateId} has hash freshness metadata`,
        { candidateId },
      );
    }
    return Object.freeze({ status: "unversioned" });
  }
  if (freshness.status === "unversioned" || !("expectedSha256" in freshness)) {
    throw new ContextEngineError(
      "PILOT_CONTEXT_INVALID",
      `Versioned context candidate ${candidateId} lacks hash freshness metadata`,
      { candidateId },
    );
  }
  validateSha256(freshness.expectedSha256, candidateId);
  if (freshness.expectedSha256 !== provenanceSha256) {
    throw new ContextEngineError(
      "PILOT_CONTEXT_INVALID",
      `Context candidate ${candidateId} freshness hash does not match provenance`,
      { candidateId },
    );
  }
  if (freshness.status === "stale") {
    if (freshness.actualSha256 !== undefined) validateSha256(freshness.actualSha256, candidateId);
    return Object.freeze({
      status: "stale",
      expectedSha256: freshness.expectedSha256,
      ...(freshness.actualSha256 === undefined ? {} : { actualSha256: freshness.actualSha256 }),
    });
  }
  if (freshness.status !== "current" && freshness.status !== "not-checked") {
    throw new ContextEngineError(
      "PILOT_CONTEXT_INVALID",
      `Context candidate ${candidateId} has an unknown freshness status`,
      { candidateId },
    );
  }
  return Object.freeze({ status: freshness.status, expectedSha256: freshness.expectedSha256 });
}

function validateSha256(value: string, candidateId: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new ContextEngineError(
      "PILOT_CONTEXT_INVALID",
      `Context candidate ${candidateId} has invalid freshness hash metadata`,
      { candidateId },
    );
  }
}

function compareCandidate(
  left: CollectedContextCandidate,
  right: CollectedContextCandidate,
): number {
  if (left.mandatory !== right.mandatory) return left.mandatory ? -1 : 1;
  if (left.sourcePriority !== right.sourcePriority) {
    return right.sourcePriority - left.sourcePriority;
  }
  if (left.relevance !== right.relevance) return right.relevance - left.relevance;
  if (left.sourceId !== right.sourceId) return left.sourceId.localeCompare(right.sourceId);
  return left.id.localeCompare(right.id);
}

function comparePromptOrder(
  left: CollectedContextCandidate,
  right: CollectedContextCandidate,
): number {
  if (left.sourcePriority !== right.sourcePriority)
    return right.sourcePriority - left.sourcePriority;
  if (left.sourceId !== right.sourceId) return left.sourceId.localeCompare(right.sourceId);
  return left.id.localeCompare(right.id);
}

function resolvePreparationBudget(options: ContextPreparationOptions): ResolvedContextBudget {
  if (options.budget !== undefined) return resolveContextBudget(options.budget);
  return legacyContextBudget(options.maximumTokens);
}

function legacyContextBudget(maximumTokens: number): ResolvedContextBudget {
  validatePositiveInteger(maximumTokens, "maximumTokens");
  return Object.freeze({
    configuredContextTokens: maximumTokens,
    effectiveContextTokens: maximumTokens,
    reservedOutputTokens: 0,
    reservedInputTokens: 0,
    availableCandidateTokens: maximumTokens,
  });
}

function normalizeBudget(budget: ResolvedContextBudget): ResolvedContextBudget {
  validatePositiveInteger(budget.configuredContextTokens, "configuredContextTokens");
  if (budget.modelContextTokens !== undefined) {
    validatePositiveInteger(budget.modelContextTokens, "modelContextTokens");
  }
  validatePositiveInteger(budget.effectiveContextTokens, "effectiveContextTokens");
  validateNonnegativeInteger(budget.reservedOutputTokens, "reservedOutputTokens");
  validateNonnegativeInteger(budget.reservedInputTokens, "reservedInputTokens");
  validatePositiveInteger(budget.availableCandidateTokens, "availableCandidateTokens");
  const expectedEffective = Math.min(
    budget.configuredContextTokens,
    budget.modelContextTokens ?? Number.MAX_SAFE_INTEGER,
  );
  const expectedAvailable =
    expectedEffective - safeTokenSum(budget.reservedOutputTokens, budget.reservedInputTokens);
  if (
    budget.effectiveContextTokens !== expectedEffective ||
    budget.availableCandidateTokens !== expectedAvailable ||
    expectedAvailable < 1
  ) {
    throw new ContextEngineError(
      "PILOT_CONTEXT_INVALID",
      "Resolved context budget metadata is inconsistent",
    );
  }
  return Object.freeze({ ...budget });
}

function normalizeCollectionContext(context: ContextCollectionContext): ContextCollectionContext {
  validateIdentifier(context.runId, "context run ID");
  if (context.sessionId !== undefined) validateIdentifier(context.sessionId, "context session ID");
  if (!Number.isSafeInteger(context.cycle) || context.cycle < 1) {
    throw new ContextEngineError("PILOT_CONTEXT_INVALID", "Context cycle must be positive");
  }
  if (!Array.isArray(context.targetPaths)) {
    throw new ContextEngineError("PILOT_CONTEXT_INVALID", "Context target paths must be an array");
  }
  for (const targetPath of context.targetPaths) {
    validateIdentifier(targetPath, "context target path", 4_096);
  }
  if (!(context.signal instanceof AbortSignal)) {
    throw new ContextEngineError("PILOT_CONTEXT_INVALID", "Context signal is invalid");
  }
  if (context.metadata !== undefined) {
    const metadata = JsonValueSchema.safeParse(context.metadata);
    if (!metadata.success || Array.isArray(metadata.data) || metadata.data === null) {
      throw new ContextEngineError(
        "PILOT_CONTEXT_INVALID",
        "Context collection metadata is invalid",
        { issueCount: metadata.success ? 1 : metadata.error.issues.length },
        metadata.success ? undefined : metadata.error,
      );
    }
  }
  return Object.freeze({
    ...context,
    targetPaths: Object.freeze([...context.targetPaths]),
    ...(context.metadata === undefined ? {} : { metadata: Object.freeze({ ...context.metadata }) }),
  });
}

function validateIdentifier(value: string, label: string, maximumLength = 128): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    containsControlCharacter(value)
  ) {
    throw new ContextEngineError("PILOT_CONTEXT_INVALID", `${label} is invalid`);
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return true;
  }
  return false;
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ContextEngineError("PILOT_CONTEXT_INVALID", `${label} must be a positive integer`);
  }
}

function validateNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ContextEngineError("PILOT_CONTEXT_INVALID", `${label} must be nonnegative`);
  }
}

function safeTokenSum(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new ContextEngineError("PILOT_CONTEXT_INVALID", "Context token accounting overflowed");
  }
  return sum;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancellationError(signal.reason);
}
