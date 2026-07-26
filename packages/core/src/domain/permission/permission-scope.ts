import * as z from "zod";
import { boundedIdentifier, toolNameSchema as toolName } from "../../shared/schema-fragments.js";
import { ToolRiskSchema } from "../tool/index.js";
import { ActionFingerprintSchema } from "./permission-primitives.js";

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

export type PermissionScope = z.output<typeof PermissionScopeSchema>;
export type PermissionRuleMatcher = z.output<typeof PermissionRuleMatcherSchema>;
