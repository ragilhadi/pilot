import * as z from "zod";
import { ToolRiskSchema } from "./tools.js";
import { JsonValueSchema } from "./messages.js";

export const PermissionEffectSchema = z.enum(["allow", "deny", "ask"]);
export const PermissionRuleSourceSchema = z.enum([
  "builtin",
  "global",
  "project",
  "session",
  "cli",
  "interactive",
]);
export const ActionFingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

const boundedIdentifier = z.string().min(1).max(256);
const toolName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u);

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

export const PermissionScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("once"), callId: boundedIdentifier })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("session"), sessionId: boundedIdentifier })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("exact-action"), fingerprint: ActionFingerprintSchema })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("tool"), toolName })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("workspace"), workspaceId: boundedIdentifier })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("application"), applicationId: boundedIdentifier })
    .strict()
    .readonly(),
]);

export const PermissionRuleMatcherSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("any") })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("action-kind"), actionKind: z.enum(["tool", "command"]) })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("risk"), risks: z.array(ToolRiskSchema).min(1).readonly() })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("permission"), permission: boundedIdentifier })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("tool"), toolName })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("exact-action"), fingerprint: ActionFingerprintSchema })
    .strict()
    .readonly(),
]);

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

export type PermissionEffect = z.output<typeof PermissionEffectSchema>;
export type PermissionRuleSource = z.output<typeof PermissionRuleSourceSchema>;
export type ActionFingerprint = z.output<typeof ActionFingerprintSchema>;
export type ToolPermissionAction = z.output<typeof ToolPermissionActionSchema>;
export type CommandPermissionAction = z.output<typeof CommandPermissionActionSchema>;
export type PermissionAction = z.output<typeof PermissionActionSchema>;
export type PermissionScope = z.output<typeof PermissionScopeSchema>;
export type PermissionRuleMatcher = z.output<typeof PermissionRuleMatcherSchema>;
export type PermissionRule = z.output<typeof PermissionRuleSchema>;
export type PermissionDecision = z.output<typeof PermissionDecisionSchema>;
export type PermissionEvaluationContext = z.output<typeof PermissionEvaluationContextSchema>;
export type PermissionAuditRecord = z.output<typeof PermissionAuditRecordSchema>;
export type PermissionApprovalScopeKind = z.output<typeof PermissionApprovalScopeKindSchema>;
export type PermissionApprovalRequest = z.output<typeof PermissionApprovalRequestSchema>;
export type PermissionApprovalResponse = z.output<typeof PermissionApprovalResponseSchema>;

export interface UserInteraction {
  requestPermission(
    request: PermissionApprovalRequest,
    signal: AbortSignal,
  ): Promise<PermissionApprovalResponse>;
}
