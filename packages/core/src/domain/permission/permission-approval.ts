import * as z from "zod";
import { boundedIdentifier } from "../../shared/schema-fragments.js";
import { PermissionActionSchema } from "./permission-action.js";
import {
  PermissionDecisionSchema,
  PermissionEvaluationContextSchema,
} from "./permission-decision.js";

export const PermissionApprovalScopeKindSchema = z.enum([
  "once",
  "session",
  "exact-action",
  "tool",
  "workspace",
  "application",
]);

export const PermissionApprovalRequestSchema = z
  .object({
    requestId: boundedIdentifier,
    action: PermissionActionSchema,
    context: PermissionEvaluationContextSchema,
    policyDecision: PermissionDecisionSchema.refine(
      (decision) => decision.effect === "ask",
      "Approval requests require an ask policy decision",
    ),
    availableScopes: z.array(PermissionApprovalScopeKindSchema).min(1).readonly(),
  })
  .strict()
  .readonly();

export const PermissionApprovalResponseSchema = z
  .object({
    effect: z.enum(["allow", "deny"]),
    scope: PermissionApprovalScopeKindSchema.default("once"),
    reason: z.string().min(1).max(2_000).optional(),
  })
  .strict()
  .readonly();

export type PermissionApprovalScopeKind = z.output<typeof PermissionApprovalScopeKindSchema>;
export type PermissionApprovalRequest = z.output<typeof PermissionApprovalRequestSchema>;
export type PermissionApprovalResponse = z.output<typeof PermissionApprovalResponseSchema>;

export interface UserInteraction {
  requestPermission(
    request: PermissionApprovalRequest,
    signal: AbortSignal,
  ): Promise<PermissionApprovalResponse>;
}
