import * as z from "zod";
import { boundedIdentifier } from "../../shared/schema-fragments.js";
import { PermissionEffectSchema, PermissionRuleSourceSchema } from "./permission-primitives.js";
import { PermissionRuleMatcherSchema, PermissionScopeSchema } from "./permission-scope.js";

export const PermissionRuleSchema = z
  .object({
    id: boundedIdentifier,
    source: PermissionRuleSourceSchema,
    effect: PermissionEffectSchema,
    reason: z.string().min(1).max(2_000),
    matcher: PermissionRuleMatcherSchema,
    scope: PermissionScopeSchema.optional(),
    hard: z.boolean().default(false),
  })
  .strict()
  .refine((rule) => !rule.hard || rule.effect === "deny", "Only deny rules may be hard")
  .readonly();

export type PermissionRule = z.output<typeof PermissionRuleSchema>;
