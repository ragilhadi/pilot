import * as z from "zod";
import { boundedIdentifier } from "../../shared/schema-fragments.js";
import { ToolRiskSchema } from "../tool/index.js";
import {
  ActionFingerprintSchema,
  PermissionEffectSchema,
  PermissionRuleSourceSchema,
} from "./permission-primitives.js";
import { PermissionScopeSchema } from "./permission-scope.js";

export const PermissionDecisionSchema = z
  .object({
    effect: PermissionEffectSchema,
    reason: z.string().min(1).max(2_000),
    actionFingerprint: ActionFingerprintSchema,
    ruleId: boundedIdentifier.optional(),
    source: PermissionRuleSourceSchema.optional(),
    scope: PermissionScopeSchema.optional(),
    evaluatedRuleIds: z.array(boundedIdentifier).readonly(),
  })
  .strict()
  .readonly();

export const PermissionEvaluationContextSchema = z
  .object({
    runId: boundedIdentifier,
    callId: boundedIdentifier,
    sessionId: boundedIdentifier.optional(),
    workspaceId: boundedIdentifier.optional(),
    applicationId: boundedIdentifier.optional(),
  })
  .strict()
  .readonly();

export const PermissionAuditRecordSchema = z
  .object({
    sequence: z.number().int().positive(),
    occurredAt: z.iso.datetime({ offset: true }),
    context: PermissionEvaluationContextSchema,
    action: z
      .object({
        kind: z.enum(["tool", "command"]),
        risk: ToolRiskSchema,
        name: z.string().min(1).max(4_096),
        fingerprint: ActionFingerprintSchema,
      })
      .strict()
      .readonly(),
    decision: PermissionDecisionSchema,
  })
  .strict()
  .readonly();

export type PermissionDecision = z.output<typeof PermissionDecisionSchema>;
export type PermissionEvaluationContext = z.output<typeof PermissionEvaluationContextSchema>;
export type PermissionAuditRecord = z.output<typeof PermissionAuditRecordSchema>;
