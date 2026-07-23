import * as z from "zod";
import { PilotError, type PilotErrorCode } from "./errors.js";

export const ModelFailureKindSchema = z.enum([
  "authentication",
  "cancelled",
  "context-limit",
  "invalid-request",
  "provider-error",
  "rate-limit",
  "unavailable",
]);

export type ModelFailureKind = z.output<typeof ModelFailureKindSchema>;

const modelErrorCodeByKind = {
  authentication: "PILOT_MODEL_AUTHENTICATION",
  cancelled: "PILOT_CANCELLED",
  "context-limit": "PILOT_MODEL_CONTEXT_LIMIT",
  "invalid-request": "PILOT_MODEL_INVALID_REQUEST",
  "provider-error": "PILOT_MODEL_FAILED",
  "rate-limit": "PILOT_MODEL_RATE_LIMIT",
  unavailable: "PILOT_MODEL_UNAVAILABLE",
} as const satisfies Record<ModelFailureKind, PilotErrorCode>;

const retryableByKind = {
  authentication: false,
  cancelled: false,
  "context-limit": false,
  "invalid-request": false,
  "provider-error": true,
  "rate-limit": true,
  unavailable: true,
} as const satisfies Record<ModelFailureKind, boolean>;

const safeMessageByKind = {
  authentication: "Model provider authentication failed",
  cancelled: "The model request was cancelled",
  "context-limit": "The model request exceeded the context limit",
  "invalid-request": "The model provider rejected the request",
  "provider-error": "The model provider returned an error",
  "rate-limit": "The model provider rate limit was reached",
  unavailable: "The model provider is temporarily unavailable",
} as const satisfies Record<ModelFailureKind, string>;

export const ModelFailureSchema = z
  .object({
    kind: ModelFailureKindSchema,
    code: z.enum([
      "PILOT_CANCELLED",
      "PILOT_MODEL_AUTHENTICATION",
      "PILOT_MODEL_CONTEXT_LIMIT",
      "PILOT_MODEL_FAILED",
      "PILOT_MODEL_INVALID_REQUEST",
      "PILOT_MODEL_RATE_LIMIT",
      "PILOT_MODEL_UNAVAILABLE",
    ]),
    message: z.string().min(1),
    retryable: z.boolean(),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    statusCode: z.number().int().min(100).max(599).optional(),
    retryAfterMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((failure, context) => {
    if (failure.code !== modelErrorCodeByKind[failure.kind]) {
      context.addIssue({
        code: "custom",
        path: ["code"],
        message: `Failure code does not match kind ${failure.kind}`,
      });
    }
  })
  .readonly();

export type ModelFailure = z.output<typeof ModelFailureSchema>;

export interface ModelErrorOptions {
  readonly kind: ModelFailureKind;
  readonly providerId: string;
  readonly modelId: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class ModelError extends PilotError {
  readonly kind: ModelFailureKind;
  readonly providerId: string;
  readonly modelId: string;
  readonly statusCode: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(options: ModelErrorOptions) {
    const metadata = {
      providerId: options.providerId,
      modelId: options.modelId,
      ...(options.statusCode === undefined ? {} : { statusCode: options.statusCode }),
      ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    };
    super({
      code: modelErrorCodeByKind[options.kind],
      message: options.message,
      safeMessage: safeMessageByKind[options.kind],
      retryable: options.retryable ?? retryableByKind[options.kind],
      metadata,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.kind = options.kind;
    this.providerId = options.providerId;
    this.modelId = options.modelId;
    this.statusCode = options.statusCode;
    this.retryAfterMs = options.retryAfterMs;
  }

  toFailure(): ModelFailure {
    return ModelFailureSchema.parse({
      kind: this.kind,
      code: this.code,
      message: this.safeMessage,
      retryable: this.retryable,
      providerId: this.providerId,
      modelId: this.modelId,
      ...(this.statusCode === undefined ? {} : { statusCode: this.statusCode }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    });
  }
}

export class ModelContractValidationError extends PilotError {
  readonly contract: string;
  readonly issueCount: number;

  constructor(contract: string, issueCount: number, cause: unknown) {
    super({
      code: "PILOT_INVALID_MODEL_DATA",
      message: `${contract} validation failed with ${issueCount} issue(s)`,
      safeMessage: `The ${contract} has an invalid structure`,
      metadata: { contract, issueCount },
      cause,
    });
    this.contract = contract;
    this.issueCount = issueCount;
  }
}
