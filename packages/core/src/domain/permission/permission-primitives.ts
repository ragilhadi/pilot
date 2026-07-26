import * as z from "zod";

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

export type PermissionEffect = z.output<typeof PermissionEffectSchema>;
export type PermissionRuleSource = z.output<typeof PermissionRuleSourceSchema>;
export type ActionFingerprint = z.output<typeof ActionFingerprintSchema>;
