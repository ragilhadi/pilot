import { runId, sessionId } from "@pilot/core";
import { describe, expect, it, vi } from "vitest";
import {
  ContextEngine,
  ContextEngineError,
  resolveContextBudget,
  selectContext,
  Utf8HeuristicTokenEstimator,
  type CollectedContextCandidate,
  type ContextCollectionContext,
  type ContextSource,
} from "../src/index.js";

function collectionContext(signal = new AbortController().signal): ContextCollectionContext {
  return {
    runId: runId("run-context"),
    sessionId: sessionId("session-context"),
    cycle: 1,
    targetPaths: ["src/main.ts"],
    signal,
  };
}

function candidate(
  id: string,
  estimatedTokens: number,
  options: { readonly mandatory?: boolean; readonly relevance?: number } = {},
) {
  return {
    id,
    content: `content:${id}`,
    estimatedTokens,
    relevance: options.relevance ?? 0.5,
    mandatory: options.mandatory ?? false,
    provenance: {
      kind: "workspace-file" as const,
      trust: "untrusted" as const,
      reference: `src/${id}.ts`,
    },
  };
}

const testTokenEstimator = {
  estimate() {
    return { tokens: 1, method: "test" };
  },
};

function contextEngine(sources: readonly ContextSource[]) {
  return new ContextEngine(sources, { tokenEstimator: testTokenEstimator });
}

function source(
  id: string,
  priority: number,
  candidates: ReturnType<typeof candidate>[],
  tokenBudget?: number,
): ContextSource {
  return {
    id,
    priority,
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    async collect() {
      return candidates;
    },
  };
}

describe("ContextEngine", () => {
  it("selects mandatory then priority/relevance order within total and source budgets", async () => {
    const engine = contextEngine([
      source(
        "files",
        50,
        [
          candidate("less-relevant", 3, { relevance: 0.2 }),
          candidate("best", 3, { relevance: 0.9 }),
        ],
        4,
      ),
      source("policy", 100, [candidate("policy", 2, { mandatory: true, relevance: 0 })]),
      source("diagnostics", 25, [candidate("diagnostic", 2, { relevance: 1 })]),
    ]);

    const result = await engine.prepare(collectionContext(), { maximumTokens: 8 });

    expect(result.selected.map(({ id }) => id)).toEqual(["policy", "best", "diagnostic"]);
    expect(result.excluded).toMatchObject([
      {
        candidate: { id: "less-relevant", sourceId: "files" },
        reason: "source-budget-exhausted",
        availableTokens: 1,
      },
    ]);
    expect(result).toMatchObject({
      maximumTokens: 8,
      selectedTokens: 7,
      remainingTokens: 1,
      sourceUsage: { diagnostics: 2, files: 3, policy: 2 },
    });
    expect(result.selected[1]).toMatchObject({
      sourcePriority: 50,
      sourceTokenBudget: 4,
      provenance: { trust: "untrusted", reference: "src/best.ts" },
    });
    expect(Object.isFrozen(result.selected)).toBe(true);
    expect(Object.isFrozen(result.sourceUsage)).toBe(true);
  });

  it("is deterministic across source and candidate collection order", async () => {
    const first = contextEngine([
      source("beta", 10, [candidate("z", 1), candidate("a", 1)]),
      source("alpha", 10, [candidate("m", 1)]),
    ]);
    const second = contextEngine([
      source("alpha", 10, [candidate("m", 1)]),
      source("beta", 10, [candidate("a", 1), candidate("z", 1)]),
    ]);

    const [left, right] = await Promise.all([
      first.prepare(collectionContext(), { maximumTokens: 3 }),
      second.prepare(collectionContext(), { maximumTokens: 3 }),
    ]);

    expect(left.selected.map(({ sourceId, id }) => `${sourceId}:${id}`)).toEqual([
      "alpha:m",
      "beta:a",
      "beta:z",
    ]);
    expect(right).toEqual(left);
  });

  it("reports optional total-budget exclusions without exceeding the limit", async () => {
    const result = await contextEngine([
      source("conversation", 20, [candidate("recent", 4), candidate("older", 4)]),
    ]).prepare(collectionContext(), { maximumTokens: 5 });

    expect(result.selected.map(({ id }) => id)).toEqual(["older"]);
    expect(result.excluded).toMatchObject([
      {
        candidate: { id: "recent" },
        reason: "total-budget-exhausted",
        availableTokens: 1,
      },
    ]);
    expect(result.selectedTokens).toBeLessThanOrEqual(result.maximumTokens);
  });

  it("fails closed when mandatory context cannot fit total or source budgets", () => {
    const total = collected("mandatory-total", 6, { mandatory: true });
    const perSource = collected("mandatory-source", 3, {
      mandatory: true,
      sourceTokenBudget: 2,
    });

    expect(() => selectContext([total], 5)).toThrowError(ContextEngineError);
    expect(captureError(() => selectContext([total], 5))).toMatchObject({
      code: "PILOT_CONTEXT_BUDGET",
      metadata: { limitingBudget: "total" },
    });
    expect(captureError(() => selectContext([perSource], 5))).toMatchObject({
      code: "PILOT_CONTEXT_BUDGET",
      metadata: { limitingBudget: "source" },
    });
  });

  it("rejects ambiguous registrations and malformed candidates", async () => {
    const duplicate = source("same", 1, []);
    expect(() => new ContextEngine([duplicate, duplicate])).toThrowError(ContextEngineError);

    const duplicateCandidates = contextEngine([
      source("one", 1, [candidate("duplicate", 1)]),
      source("two", 2, [candidate("duplicate", 1)]),
    ]);
    await expect(
      duplicateCandidates.prepare(collectionContext(), { maximumTokens: 5 }),
    ).rejects.toMatchObject({ code: "PILOT_CONTEXT_INVALID" });

    expect(() =>
      selectContext([collected("invalid", 1, { relevance: Number.NaN })], 5),
    ).toThrowError(ContextEngineError);
    expect(() =>
      selectContext([collected("one", 1), { ...collected("two", 1), sourcePriority: 2 }], 5),
    ).toThrowError(ContextEngineError);
  });

  it("collects each source once and honors cancellation", async () => {
    const collect = vi.fn(async () => [candidate("one", 1)]);
    const engine = contextEngine([{ id: "source", priority: 1, collect }]);
    await engine.prepare(collectionContext(), { maximumTokens: 5 });
    expect(collect).toHaveBeenCalledOnce();

    const controller = new AbortController();
    controller.abort("stop");
    await expect(
      engine.prepare(collectionContext(controller.signal), { maximumTokens: 5 }),
    ).rejects.toMatchObject({
      code: "PILOT_CANCELLED",
    });
    expect(collect).toHaveBeenCalledOnce();
  });

  it("uses conservative UTF-8 estimates and never trusts a smaller source estimate", async () => {
    const estimator = new Utf8HeuristicTokenEstimator({ bytesPerToken: 3, framingTokens: 2 });
    expect(estimator.estimate("abc")).toEqual({ tokens: 3, method: "utf8-bytes/3+2" });
    expect(estimator.estimate("😀")).toEqual({ tokens: 4, method: "utf8-bytes/3+2" });

    const result = await new ContextEngine([
      source("files", 1, [candidate("underestimated", 1)]),
    ]).prepare(collectionContext(), { maximumTokens: 100 });
    expect(result.selected[0]?.tokenEstimate).toMatchObject({
      tokens: expect.any(Number),
      method: "utf8-bytes/3+4",
    });
    expect(result.selected[0]?.estimatedTokens).toBeGreaterThan(1);
  });

  it("intersects configured/model limits before reserving output and fixed input", async () => {
    const budget = resolveContextBudget({
      configuredContextTokens: 100,
      modelContextTokens: 80,
      reservedOutputTokens: 20,
      reservedInputTokens: 10,
    });
    expect(budget).toEqual({
      configuredContextTokens: 100,
      modelContextTokens: 80,
      effectiveContextTokens: 80,
      reservedOutputTokens: 20,
      reservedInputTokens: 10,
      availableCandidateTokens: 50,
    });

    const result = await contextEngine([source("files", 1, [candidate("file", 40)])]).prepare(
      collectionContext(),
      {
        budget: {
          configuredContextTokens: 100,
          modelContextTokens: 80,
          reservedOutputTokens: 20,
          reservedInputTokens: 10,
        },
      },
    );
    expect(result.maximumTokens).toBe(50);
    expect(result.budget).toEqual(budget);
    expect(() =>
      resolveContextBudget({ configuredContextTokens: 10, reservedOutputTokens: 10 }),
    ).toThrowError(ContextEngineError);
  });

  it("deduplicates by explicit keys and hashes while preserving stable prompt order", async () => {
    const sharedHash = `sha256:${"b".repeat(64)}` as const;
    const engine = contextEngine([
      source("low", 1, [
        {
          ...candidate("hash-copy", 2),
          provenance: { ...candidate("hash-copy", 2).provenance, sha256: sharedHash },
        },
      ]),
      source("high", 10, [
        { ...candidate("z-selected", 2, { relevance: 1 }), deduplicationKey: "logical:file" },
        {
          ...candidate("a-stable-first", 2, { relevance: 0 }),
          provenance: { ...candidate("a-stable-first", 2).provenance, sha256: sharedHash },
        },
        { ...candidate("duplicate", 2), deduplicationKey: "logical:file" },
      ]),
    ]);

    const result = await engine.prepare(collectionContext(), { maximumTokens: 20 });
    expect(result.selected.map(({ id }) => id)).toEqual(["a-stable-first", "z-selected"]);
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "duplicate",
          duplicateOf: "z-selected",
          candidate: expect.objectContaining({ id: "duplicate" }),
        }),
        expect.objectContaining({
          reason: "duplicate",
          duplicateOf: "a-stable-first",
          candidate: expect.objectContaining({ id: "hash-copy" }),
        }),
      ]),
    );
  });

  it("excludes stale optional content and fails closed for stale mandatory content", async () => {
    const expectedSha256 = `sha256:${"c".repeat(64)}` as const;
    const actualSha256 = `sha256:${"d".repeat(64)}` as const;
    const staleCandidate = (mandatory: boolean) => ({
      ...candidate(mandatory ? "mandatory-stale" : "optional-stale", 2, { mandatory }),
      provenance: {
        ...candidate("stale", 2).provenance,
        sha256: expectedSha256,
      },
    });
    const dependencies = {
      tokenEstimator: testTokenEstimator,
      freshnessVerifier: {
        async verify() {
          return { status: "stale" as const, expectedSha256, actualSha256 };
        },
      },
    };

    const optional = await new ContextEngine(
      [source("files", 1, [staleCandidate(false)])],
      dependencies,
    ).prepare(collectionContext(), { maximumTokens: 10 });
    expect(optional.selected).toEqual([]);
    expect(optional.excluded).toMatchObject([
      { reason: "stale-content", expectedSha256, actualSha256 },
    ]);

    await expect(
      new ContextEngine([source("files", 1, [staleCandidate(true)])], dependencies).prepare(
        collectionContext(),
        { maximumTokens: 10 },
      ),
    ).rejects.toMatchObject({ code: "PILOT_CONTEXT_STALE" });
  });
});

function collected(
  id: string,
  estimatedTokens: number,
  options: {
    readonly mandatory?: boolean;
    readonly relevance?: number;
    readonly sourceTokenBudget?: number;
  } = {},
): CollectedContextCandidate {
  return {
    ...candidate(id, estimatedTokens, options),
    sourceId: "source",
    sourcePriority: 1,
    tokenEstimate: { tokens: estimatedTokens, method: "test" },
    freshness: { status: "unversioned" },
    ...(options.sourceTokenBudget === undefined
      ? {}
      : { sourceTokenBudget: options.sourceTokenBudget }),
  };
}

function captureError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw");
}
