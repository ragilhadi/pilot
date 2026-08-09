import {
  type Clock,
  type PermissionRule,
  PermissionRuleSchema,
  type Sha256Digest,
  SkillError,
  type SkillManifest,
} from "@pilotrun/core";
import type { ContextCandidate, ContextSource } from "./context-engine.js";
import type { DiscoveredSkill, SkillTrust } from "./skill-discovery.js";

/** The slice of the permission engine activation needs; `PermissionPolicyEngine` satisfies it. */
export interface SkillPermissionSink {
  addRule(rule: PermissionRule): unknown;
  removeRule(ruleId: string): boolean;
}

export interface ActiveSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly displayPath: string;
  readonly trust: SkillTrust;
  readonly sha256: Sha256Digest;
  readonly body: string;
  readonly requiredTools: readonly string[];
  /** The session-scoped rules this skill added; every one is a restriction. */
  readonly restrictions: readonly PermissionRule[];
  readonly activatedAt: string;
}

export type SkillActivation =
  | { readonly status: "activated"; readonly skill: ActiveSkill }
  | {
      readonly status: "rejected";
      readonly reason: "already-active" | "missing-tools";
      readonly detail: string;
      readonly missingTools?: readonly string[];
    };

export interface SkillActivationRegistryOptions {
  readonly sessionId: string;
  readonly clock: Clock;
  /** Rules are registered here so the policy engine enforces them for the rest of the session. */
  readonly permissions?: SkillPermissionSink;
  /** Evaluated on each activation, so a skill is checked against the tools actually registered. */
  readonly toolNames: () => readonly string[];
}

/**
 * Tracks which skills the user has switched on for this session.
 *
 * Activation is manual by design in this phase. Nothing here inspects the conversation or scores
 * relevance: a skill's instructions enter the prompt because the user asked for them, which keeps
 * the provenance of every instruction in the context window traceable to a person.
 */
export class SkillActivationRegistry {
  readonly #sessionId: string;
  readonly #clock: Clock;
  readonly #permissions: SkillPermissionSink | undefined;
  readonly #toolNames: () => readonly string[];
  readonly #active = new Map<string, ActiveSkill>();

  constructor(options: SkillActivationRegistryOptions) {
    this.#sessionId = options.sessionId;
    this.#clock = options.clock;
    this.#permissions = options.permissions;
    this.#toolNames = options.toolNames;
  }

  activate(skill: DiscoveredSkill): SkillActivation {
    if (this.#active.has(skill.name)) {
      return Object.freeze({
        status: "rejected",
        reason: "already-active",
        detail: `Skill ${skill.name} is already active`,
      });
    }
    const available = new Set(this.#toolNames());
    const missingTools = Object.freeze(
      (skill.manifest.requiresTools ?? []).filter((tool) => !available.has(tool)),
    );
    if (missingTools.length > 0) {
      return Object.freeze({
        status: "rejected",
        reason: "missing-tools",
        detail: `Skill ${skill.name} requires unavailable tools: ${missingTools.join(", ")}`,
        missingTools,
      });
    }

    const restrictions = skillRestrictionRules(skill.manifest, this.#sessionId);
    const registered: PermissionRule[] = [];
    try {
      for (const rule of restrictions) {
        this.#permissions?.addRule(rule);
        registered.push(rule);
      }
    } catch (error) {
      // Leave no half-applied policy behind: a skill either restricts fully or not at all.
      for (const rule of registered) this.#permissions?.removeRule(rule.id);
      throw error;
    }

    const active: ActiveSkill = Object.freeze({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      displayPath: skill.displayPath,
      trust: skill.trust,
      sha256: skill.sha256,
      body: skill.body,
      requiredTools: Object.freeze([...(skill.manifest.requiresTools ?? [])]),
      restrictions,
      activatedAt: this.#clock.now().toISOString(),
    });
    this.#active.set(skill.name, active);
    return Object.freeze({ status: "activated", skill: active });
  }

  deactivate(name: string): boolean {
    const active = this.#active.get(name);
    if (active === undefined) return false;
    for (const rule of active.restrictions) this.#permissions?.removeRule(rule.id);
    this.#active.delete(name);
    return true;
  }

  isActive(name: string): boolean {
    return this.#active.has(name);
  }

  active(): readonly ActiveSkill[] {
    return Object.freeze(
      [...this.#active.values()].sort((left, right) => left.name.localeCompare(right.name)),
    );
  }
}

/**
 * Translates a manifest's permission declarations into policy rules.
 *
 * A skill can only subtract authority. `deniesTools` becomes a session-scoped denial and
 * `confirmsRisks` forces an explicit prompt for a risk class that standing configuration might
 * otherwise allow silently; both outrank built-in and configured rules because `session` sits
 * above `builtin`, `global`, and `project` in the source precedence. There is deliberately no
 * manifest field that produces an `allow`, and {@link assertNarrowingRules} fails closed if a
 * future edit ever introduces one.
 */
export function skillRestrictionRules(
  manifest: SkillManifest,
  sessionId: string,
): readonly PermissionRule[] {
  const scope = { kind: "session", sessionId } as const;
  const rules = [
    ...(manifest.deniesTools ?? []).map((toolName) => ({
      id: `skill.${manifest.name}.deny.tool.${toolName}`,
      source: "session" as const,
      effect: "deny" as const,
      reason: `The active skill ${manifest.name} forbids ${toolName}`,
      matcher: { kind: "tool" as const, toolName },
      scope,
    })),
    ...(manifest.confirmsRisks ?? []).map((risk) => ({
      id: `skill.${manifest.name}.confirm.risk.${risk}`,
      source: "session" as const,
      effect: "ask" as const,
      reason: `The active skill ${manifest.name} requires confirmation for ${risk} actions`,
      matcher: { kind: "risk" as const, risks: [risk] },
      scope,
    })),
  ].map((rule) => PermissionRuleSchema.parse(rule));
  return assertNarrowingRules(manifest.name, Object.freeze(rules));
}

/** Fails closed unless every rule denies or asks; a skill must never widen what is permitted. */
export function assertNarrowingRules(
  skillName: string,
  rules: readonly PermissionRule[],
): readonly PermissionRule[] {
  const widening = rules.filter((rule) => rule.effect === "allow");
  if (widening.length > 0) {
    throw new SkillError(
      "PILOT_SKILL_REQUIREMENT_UNMET",
      `Skill ${skillName} would grant permission through ${widening.map(({ id }) => id).join(", ")}`,
      { skill: skillName, ruleIds: Object.freeze(widening.map(({ id }) => id)) },
    );
  }
  return rules;
}

/**
 * Exposes the active skills' instructions as a mandatory context source.
 *
 * Priority sits above project instructions and below the baseline system prompt: the user just
 * asked for this skill, so it outranks an `AGENTS.md` the repository happened to ship, but it can
 * never displace Pilot's own safety framing.
 */
export function createActiveSkillContextSource(registry: {
  active(): readonly ActiveSkill[];
}): ContextSource {
  return {
    id: "skills",
    priority: 3_000,
    collect: async (): Promise<readonly ContextCandidate[]> =>
      registry.active().map((skill) => ({
        id: `skill:${skill.name}`,
        content: [`# Active skill: ${skill.name}`, skill.description, "", skill.body].join("\n"),
        relevance: 1,
        mandatory: true,
        provenance: {
          kind: "skill" as const,
          trust: skill.trust === "trusted-user" ? ("trusted" as const) : ("untrusted" as const),
          reference: skill.displayPath,
          sha256: skill.sha256,
        },
        deduplicationKey: skill.sha256,
      })),
  };
}
