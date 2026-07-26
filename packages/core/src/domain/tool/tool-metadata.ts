import * as z from "zod";

export const ToolRiskSchema = z.enum([
  "read-only",
  "workspace-write",
  "network",
  "system-change",
  "destructive",
  "unknown",
]);

export const ToolMetadataSchema = z
  .object({
    risk: ToolRiskSchema,
    concurrency: z.enum(["parallel-safe", "exclusive"]),
    timeoutMs: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
    requiredPermissions: z.array(z.string().min(1)).readonly(),
  })
  .strict()
  .readonly();

export type ToolRisk = z.output<typeof ToolRiskSchema>;
export type ToolMetadata = z.output<typeof ToolMetadataSchema>;
