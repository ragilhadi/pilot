import {
  type ActionFingerprint,
  type Clock,
  type JsonValue,
  PermissionActionSchema,
  type PermissionAction,
  PermissionAuditRecordSchema,
  type PermissionAuditRecord,
  PermissionDecisionSchema,
  type PermissionDecision,
  PermissionEvaluationContextSchema,
  type PermissionEvaluationContext,
  PermissionRuleSchema,
  type PermissionRule,
  type PermissionRuleMatcher,
  type PermissionRuleSource,
  type PermissionScope,
  PilotError,
} from "@pilot/core";

export const permissionSourcePrecedence: Readonly<Record<PermissionRuleSource, number>> =
  Object.freeze({
    builtin: 100,
    global: 200,
    project: 300,
    session: 400,
    cli: 500,
    interactive: 600,
  });

export class PermissionPolicyError extends PilotError {
  constructor(
    code: "PILOT_PERMISSION_POLICY_INVALID" | "PILOT_PERMISSION_RULE_CONFLICT",
    message: string,
    metadata: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super({
      code,
      message,
      safeMessage:
        code === "PILOT_PERMISSION_RULE_CONFLICT"
          ? "A permission rule identifier is already registered"
          : "The permission policy is invalid",
      metadata,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

export class PermissionAuditLog {
  readonly #records: PermissionAuditRecord[] = [];

  append(input: Omit<PermissionAuditRecord, "sequence">): PermissionAuditRecord {
    const record = PermissionAuditRecordSchema.parse({
      ...input,
      sequence: this.#records.length + 1,
    });
    this.#records.push(record);
    return record;
  }

  entries(): readonly PermissionAuditRecord[] {
    return Object.freeze([...this.#records]);
  }
}

export interface PermissionPolicyEngineOptions {
  readonly clock: Clock;
  readonly rules?: readonly PermissionRule[];
  readonly includeBuiltinDefaults?: boolean;
  readonly auditLog?: PermissionAuditLog;
}

export interface PermissionEvaluationInput {
  readonly action: PermissionAction;
  readonly context: PermissionEvaluationContext;
}

/** Deterministic policy evaluation with explicit source precedence and immutable audit records. */
export class PermissionPolicyEngine {
  readonly #clock: Clock;
  readonly #rules = new Map<string, PermissionRule>();
  readonly #auditLog: PermissionAuditLog;

  constructor(options: PermissionPolicyEngineOptions) {
    this.#clock = options.clock;
    this.#auditLog = options.auditLog ?? new PermissionAuditLog();
    const initial = [
      ...(options.includeBuiltinDefaults === false ? [] : builtinPermissionRules()),
      ...(options.rules ?? []),
    ];
    for (const rule of initial) this.addRule(rule);
  }

  addRule(input: PermissionRule): PermissionRule {
    const parsed = parseRule(input);
    if (this.#rules.has(parsed.id)) {
      throw new PermissionPolicyError(
        "PILOT_PERMISSION_RULE_CONFLICT",
        `Permission rule ${parsed.id} is already registered`,
        { ruleId: parsed.id },
      );
    }
    this.#rules.set(parsed.id, parsed);
    return parsed;
  }

  removeRule(ruleId: string): boolean {
    if (this.#rules.get(ruleId)?.hard) return false;
    return this.#rules.delete(ruleId);
  }

  rules(): readonly PermissionRule[] {
    return Object.freeze(
      [...this.#rules.values()].sort((left, right) => left.id.localeCompare(right.id)),
    );
  }

  auditEntries(): readonly PermissionAuditRecord[] {
    return this.#auditLog.entries();
  }

  evaluate(input: PermissionEvaluationInput): PermissionDecision {
    const action = parseAction(input.action);
    const context = parseContext(input.context);
    const actionFingerprint = fingerprintPermissionAction(action);
    const matching = [...this.#rules.values()]
      .filter(
        (rule) =>
          matcherMatches(rule.matcher, action, actionFingerprint) &&
          scopeMatches(rule.scope, action, context, actionFingerprint),
      )
      .sort((left, right) => compareRules(right, left));
    const hardDenials = matching.filter((rule) => rule.hard);
    const selected = hardDenials[0] ?? matching[0];
    const decision = PermissionDecisionSchema.parse({
      effect: selected?.effect ?? "ask",
      reason: selected?.reason ?? "No permission rule matched the requested action",
      actionFingerprint,
      ...(selected === undefined
        ? {}
        : {
            ruleId: selected.id,
            source: selected.source,
            ...(selected.scope === undefined ? {} : { scope: selected.scope }),
          }),
      evaluatedRuleIds: matching.map(({ id }) => id),
    });
    this.#auditLog.append({
      occurredAt: this.#clock.now().toISOString(),
      context,
      action: {
        kind: action.kind,
        risk: action.risk,
        name: action.kind === "tool" ? action.toolName : action.executable,
        fingerprint: actionFingerprint,
      },
      decision,
    });
    return decision;
  }
}

export function fingerprintPermissionAction(input: PermissionAction): ActionFingerprint {
  const action = parseAction(input);
  const canonical = canonicalJson(action as unknown as JsonValue);
  return `sha256:${sha256Hex(canonical)}` as ActionFingerprint;
}

export function builtinPermissionRules(): readonly PermissionRule[] {
  return Object.freeze(
    [
      {
        id: "builtin.destructive.deny",
        source: "builtin",
        effect: "deny",
        reason: "Destructive actions are denied by the built-in safety boundary",
        matcher: { kind: "risk", risks: ["destructive"] },
        hard: true,
      },
      {
        id: "builtin.read-only.allow",
        source: "builtin",
        effect: "allow",
        reason: "Read-only workspace inspection is allowed by default",
        matcher: { kind: "risk", risks: ["read-only"] },
      },
      {
        id: "builtin.other.ask",
        source: "builtin",
        effect: "ask",
        reason: "Actions that are not read-only require a permission decision",
        matcher: { kind: "any" },
      },
    ].map(parseRule),
  );
}

function parseRule(input: unknown): PermissionRule {
  const parsed = PermissionRuleSchema.safeParse(input);
  if (!parsed.success) {
    throw new PermissionPolicyError(
      "PILOT_PERMISSION_POLICY_INVALID",
      "Permission rule validation failed",
      { issueCount: parsed.error.issues.length },
      parsed.error,
    );
  }
  return parsed.data;
}

function parseAction(input: PermissionAction): PermissionAction {
  const parsed = PermissionActionSchema.safeParse(input);
  if (!parsed.success) {
    throw new PermissionPolicyError(
      "PILOT_PERMISSION_POLICY_INVALID",
      "Permission action validation failed",
      { issueCount: parsed.error.issues.length },
      parsed.error,
    );
  }
  return parsed.data;
}

function parseContext(input: PermissionEvaluationContext): PermissionEvaluationContext {
  const parsed = PermissionEvaluationContextSchema.safeParse(input);
  if (!parsed.success) {
    throw new PermissionPolicyError(
      "PILOT_PERMISSION_POLICY_INVALID",
      "Permission evaluation context validation failed",
      { issueCount: parsed.error.issues.length },
      parsed.error,
    );
  }
  return parsed.data;
}

function matcherMatches(
  matcher: PermissionRuleMatcher,
  action: PermissionAction,
  fingerprint: ActionFingerprint,
): boolean {
  switch (matcher.kind) {
    case "any":
      return true;
    case "action-kind":
      return matcher.actionKind === action.kind;
    case "risk":
      return matcher.risks.includes(action.risk);
    case "permission":
      return action.requiredPermissions.includes(matcher.permission);
    case "tool":
      return action.kind === "tool" && matcher.toolName === action.toolName;
    case "exact-action":
      return matcher.fingerprint === fingerprint;
  }
}

function scopeMatches(
  scope: PermissionScope | undefined,
  action: PermissionAction,
  context: PermissionEvaluationContext,
  fingerprint: ActionFingerprint,
): boolean {
  if (scope === undefined) return true;
  switch (scope.kind) {
    case "once":
      return scope.callId === context.callId;
    case "session":
      return scope.sessionId === context.sessionId;
    case "exact-action":
      return scope.fingerprint === fingerprint;
    case "tool":
      return action.kind === "tool" && scope.toolName === action.toolName;
    case "workspace":
      return scope.workspaceId === context.workspaceId;
    case "application":
      return scope.applicationId === context.applicationId;
  }
}

function compareRules(left: PermissionRule, right: PermissionRule): number {
  return (
    Number(left.hard) - Number(right.hard) ||
    permissionSourcePrecedence[left.source] - permissionSourcePrecedence[right.source] ||
    ruleSpecificity(left) - ruleSpecificity(right) ||
    effectRestriction(left.effect) - effectRestriction(right.effect) ||
    right.id.localeCompare(left.id)
  );
}

function ruleSpecificity(rule: PermissionRule): number {
  const matcher = {
    any: 0,
    "action-kind": 10,
    risk: 20,
    permission: 30,
    tool: 40,
    "exact-action": 60,
  }[rule.matcher.kind];
  const scope =
    rule.scope === undefined
      ? 0
      : {
          application: 2,
          workspace: 4,
          session: 6,
          tool: 20,
          once: 30,
          "exact-action": 40,
        }[rule.scope.kind];
  return matcher + scope;
}

function effectRestriction(effect: PermissionRule["effect"]): number {
  return { allow: 1, ask: 2, deny: 3 }[effect];
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] ?? null)}`)
    .join(",")}}`;
}

const sha256Constants = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Hex(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const bitLength = input.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15] ?? 0;
      const word2 = words[index - 2] ?? 0;
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }

    let a = hash[0] ?? 0;
    let b = hash[1] ?? 0;
    let c = hash[2] ?? 0;
    let d = hash[3] ?? 0;
    let e = hash[4] ?? 0;
    let f = hash[5] ?? 0;
    let g = hash[6] ?? 0;
    let h = hash[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const upperE = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 =
        (h + upperE + choose + (sha256Constants[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const upperA = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (upperA + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = ((hash[0] ?? 0) + a) >>> 0;
    hash[1] = ((hash[1] ?? 0) + b) >>> 0;
    hash[2] = ((hash[2] ?? 0) + c) >>> 0;
    hash[3] = ((hash[3] ?? 0) + d) >>> 0;
    hash[4] = ((hash[4] ?? 0) + e) >>> 0;
    hash[5] = ((hash[5] ?? 0) + f) >>> 0;
    hash[6] = ((hash[6] ?? 0) + g) >>> 0;
    hash[7] = ((hash[7] ?? 0) + h) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}
