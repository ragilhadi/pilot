import * as z from "zod";

export const ToolRecoverySchema = z
  .object({
    kind: z.enum([
      "command-failure",
      "execution-failure",
      "interrupted",
      "invalid-input",
      "patch-conflict",
      "permission-denied",
      "timeout",
    ]),
    action: z.enum([
      "inspect-command-output",
      "inspect-workspace",
      "re-read-file",
      "request-permission",
      "retry",
      "revise-request",
    ]),
    sideEffects: z.enum(["none", "possible", "unknown"]),
    retryable: z.boolean(),
    message: z.string().min(1).max(1_000),
  })
  .strict()
  .readonly();

export type ToolRecovery = z.output<typeof ToolRecoverySchema>;
