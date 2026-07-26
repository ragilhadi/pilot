import * as z from "zod";

export const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().positive(),
    baseDelayMs: z.number().int().nonnegative(),
    maxDelayMs: z.number().int().nonnegative(),
    jitterRatio: z.number().finite().min(0).max(1),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.baseDelayMs > policy.maxDelayMs) {
      context.addIssue({
        code: "custom",
        path: ["baseDelayMs"],
        message: "Base retry delay cannot exceed the maximum delay",
      });
    }
  })
  .readonly();

export type RetryPolicy = z.output<typeof RetryPolicySchema>;
