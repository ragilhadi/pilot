import * as z from "zod";

export const TokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    estimatedCostUsd: z.number().finite().nonnegative().optional(),
    source: z.enum(["estimated", "mixed", "provider"]),
  })
  .strict()
  .superRefine((usage, context) => {
    const hasMeasurement = Object.entries(usage).some(
      ([key, value]) => key !== "source" && value !== undefined,
    );
    if (!hasMeasurement) {
      context.addIssue({ code: "custom", message: "Usage must contain at least one measurement" });
    }
  })
  .readonly();

export type TokenUsage = z.output<typeof TokenUsageSchema>;
