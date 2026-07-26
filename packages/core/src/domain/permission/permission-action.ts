import * as z from "zod";
import { JsonValueSchema } from "../../shared/json.js";
import { boundedIdentifier, toolNameSchema as toolName } from "../../shared/schema-fragments.js";
import { ToolRiskSchema } from "../tool/index.js";

export const ToolPermissionActionSchema = z
  .object({
    kind: z.literal("tool"),
    toolName,
    risk: ToolRiskSchema,
    requiredPermissions: z.array(boundedIdentifier).max(64).readonly(),
    input: JsonValueSchema,
  })
  .strict()
  .readonly();

export const CommandPermissionActionSchema = z
  .object({
    kind: z.literal("command"),
    executable: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !value.includes("\0")),
    args: z
      .array(
        z
          .string()
          .max(32_768)
          .refine((value) => !value.includes("\0")),
      )
      .max(1_000)
      .readonly(),
    cwd: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !value.includes("\0")),
    environment: z.record(z.string().min(1).max(256), z.string().max(65_536)).readonly(),
    risk: ToolRiskSchema,
    requiredPermissions: z.array(boundedIdentifier).max(64).readonly(),
  })
  .strict()
  .readonly();

export const PermissionActionSchema = z.discriminatedUnion("kind", [
  ToolPermissionActionSchema,
  CommandPermissionActionSchema,
]);

export type ToolPermissionAction = z.output<typeof ToolPermissionActionSchema>;
export type CommandPermissionAction = z.output<typeof CommandPermissionActionSchema>;
export type PermissionAction = z.output<typeof PermissionActionSchema>;
