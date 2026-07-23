import {
  ModelContractValidationError,
  ModelError,
  ModelFailureSchema,
  toSafeErrorSnapshot,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("ModelError", () => {
  it.each([
    ["authentication", "PILOT_MODEL_AUTHENTICATION", false],
    ["cancelled", "PILOT_CANCELLED", false],
    ["context-limit", "PILOT_MODEL_CONTEXT_LIMIT", false],
    ["invalid-request", "PILOT_MODEL_INVALID_REQUEST", false],
    ["provider-error", "PILOT_MODEL_FAILED", true],
    ["rate-limit", "PILOT_MODEL_RATE_LIMIT", true],
    ["unavailable", "PILOT_MODEL_UNAVAILABLE", true],
  ] as const)("maps %s failures to a stable code", (kind, code, retryable) => {
    const error = new ModelError({
      kind,
      providerId: "example",
      modelId: "model",
      message: "internal provider response containing a secret",
    });

    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(error.toFailure()).toMatchObject({ kind, code, retryable });
    expect(JSON.stringify(error.toFailure())).not.toContain("secret");
  });

  it("preserves safe retry hints without exposing the internal cause", () => {
    const error = new ModelError({
      kind: "rate-limit",
      providerId: "example",
      modelId: "model",
      message: "authorization=secret",
      statusCode: 429,
      retryAfterMs: 2_000,
      cause: new Error("secret response body"),
    });

    const failure = error.toFailure();
    expect(ModelFailureSchema.parse(failure)).toEqual(failure);
    expect(failure).toMatchObject({ statusCode: 429, retryAfterMs: 2_000 });
    expect(JSON.stringify(toSafeErrorSnapshot(error))).not.toContain("secret");
  });

  it("rejects a failure code that disagrees with its kind", () => {
    expect(
      ModelFailureSchema.safeParse({
        kind: "authentication",
        code: "PILOT_MODEL_RATE_LIMIT",
        message: "Authentication failed",
        retryable: false,
        providerId: "example",
        modelId: "model",
      }).success,
    ).toBe(false);
  });
});

describe("ModelContractValidationError", () => {
  it("reports only the contract and issue count to clients", () => {
    const error = new ModelContractValidationError(
      "model request",
      3,
      new Error("secret invalid input"),
    );

    expect(toSafeErrorSnapshot(error)).toEqual({
      code: "PILOT_INVALID_MODEL_DATA",
      message: "The model request has an invalid structure",
      retryable: false,
      metadata: { contract: "model request", issueCount: 3 },
    });
  });
});
