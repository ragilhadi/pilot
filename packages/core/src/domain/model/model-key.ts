import * as z from "zod";
import type { Brand } from "../../shared/brand.js";
import { providerIdSchema } from "../../shared/schema-fragments.js";
import { ModelContractValidationError } from "../../errors/model-error.js";

export type ModelKey = Brand<string, "ModelKey">;

const modelIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => value.trim() === value && !/\s/u.test(value),
    "Model IDs cannot contain whitespace",
  );

export const ModelKeySchema: z.ZodType<ModelKey> = z
  .string()
  .superRefine((value, context) => {
    const separator = value.indexOf("/");
    if (separator <= 0 || separator === value.length - 1) {
      context.addIssue({
        code: "custom",
        message: "Model keys must use provider/model format",
      });
      return;
    }

    const providerResult = providerIdSchema.safeParse(value.slice(0, separator));
    const modelResult = modelIdSchema.safeParse(value.slice(separator + 1));
    if (!providerResult.success || !modelResult.success) {
      context.addIssue({
        code: "custom",
        message: "Model key contains an invalid provider or model identifier",
      });
    }
  })
  .transform((value) => value as ModelKey);

export interface ParsedModelKey {
  readonly key: ModelKey;
  readonly providerId: string;
  readonly modelId: string;
}

export function parseModelKey(input: unknown): ParsedModelKey {
  const result = ModelKeySchema.safeParse(input);
  if (!result.success) {
    throw new ModelContractValidationError("model key", result.error.issues.length, result.error);
  }

  const separator = result.data.indexOf("/");
  return Object.freeze({
    key: result.data,
    providerId: result.data.slice(0, separator),
    modelId: result.data.slice(separator + 1),
  });
}
