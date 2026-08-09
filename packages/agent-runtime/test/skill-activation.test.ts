import { type PermissionAction, runId, type Sha256Digest } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import {
  assertNarrowingRules,
  createActiveSkillContextSource,
  type DiscoveredSkill,
  PermissionPolicyEngine,
  SkillActivationRegistry,
  skillRestrictionRules,
} from "../src/index.js";

const clock = { now: () => new Date("2026-08-09T10:00:00.000Z") };

function discoveredSkill(overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return {
    id: "skill:review-diff:0123456789abcdef",
    name: "review-diff",
    description: "Review a working diff",
    displayPath: ".pilot/skills/review-diff/SKILL.md",
    realPath: "/repo/.pilot/skills/review-diff/SKILL.md",
    origin: "workspace",
    trust: "untrusted-project",
    bytes: 128,
    sha256: `sha256:${"a".repeat(64)}` as Sha256Digest,
    body: "Read the diff, then report findings.",
    manifest: {
      name: "review-diff",
      description: "Review a working diff",
      requiresTools: ["grep"],
      deniesTools: ["run_command"],
      confirmsRisks: ["workspace-write"],
    },
    ...overrides,
  } as DiscoveredSkill;
}

function toolAction(toolName: string, risk: PermissionAction["risk"]): PermissionAction {
  return {
    kind: "tool",
    toolName,
    risk,
    requiredPermissions: [],
    input: {},
  } as PermissionAction;
}

const evaluationContext = {
  sessionId: "session-1",
  runId: "run-1",
  callId: "call-1",
  workspaceId: "/repo",
  applicationId: "pilot-cli",
};

describe("skill activation", () => {
  it("activates a skill only when the tools it depends on are registered", () => {
    const registry = new SkillActivationRegistry({
      sessionId: "session-1",
      clock,
      toolNames: () => ["read_file"],
    });

    const rejected = registry.activate(discoveredSkill());
    expect(rejected).toMatchObject({ status: "rejected", reason: "missing-tools" });
    expect(rejected.status === "rejected" ? rejected.missingTools : []).toEqual(["grep"]);
    expect(registry.active()).toEqual([]);
  });

  it("records provenance and refuses a second activation of the same skill", () => {
    const registry = new SkillActivationRegistry({
      sessionId: "session-1",
      clock,
      toolNames: () => ["grep", "run_command"],
    });

    const activated = registry.activate(discoveredSkill());
    expect(activated.status).toBe("activated");
    expect(registry.active()).toHaveLength(1);
    expect(registry.active()[0]).toMatchObject({
      name: "review-diff",
      trust: "untrusted-project",
      displayPath: ".pilot/skills/review-diff/SKILL.md",
      activatedAt: "2026-08-09T10:00:00.000Z",
    });
    expect(registry.activate(discoveredSkill())).toMatchObject({
      status: "rejected",
      reason: "already-active",
    });
  });

  it("only ever produces denying or asking rules", () => {
    const rules = skillRestrictionRules(discoveredSkill().manifest, "session-1");

    expect(rules.map(({ id, effect }) => `${id}=${effect}`)).toEqual([
      "skill.review-diff.deny.tool.run_command=deny",
      "skill.review-diff.confirm.risk.workspace-write=ask",
    ]);
    expect(rules.every((rule) => rule.source === "session")).toBe(true);
    expect(rules.every((rule) => rule.scope?.kind === "session")).toBe(true);
    expect(() =>
      assertNarrowingRules("review-diff", [
        { ...rules[0], id: "widened", effect: "allow", hard: false },
      ]),
    ).toThrow(/would grant permission/u);
  });

  it("makes the policy engine stricter while active and restores it on deactivation", () => {
    const permissions = new PermissionPolicyEngine({ clock });
    const registry = new SkillActivationRegistry({
      sessionId: "session-1",
      clock,
      permissions,
      toolNames: () => ["grep", "run_command", "read_file"],
    });
    const readOnlyRun = {
      action: toolAction("run_command", "read-only"),
      context: evaluationContext,
    };
    const readOnlyRead = {
      action: toolAction("read_file", "read-only"),
      context: evaluationContext,
    };

    // The built-in policy allows read-only actions outright.
    expect(permissions.evaluate(readOnlyRun).effect).toBe("allow");

    registry.activate(discoveredSkill());
    expect(permissions.evaluate(readOnlyRun).effect).toBe("deny");
    expect(permissions.evaluate(readOnlyRead).effect).toBe("allow");
    expect(
      permissions.evaluate({
        action: toolAction("write_file", "workspace-write"),
        context: evaluationContext,
      }).effect,
    ).toBe("ask");

    expect(registry.deactivate("review-diff")).toBe(true);
    expect(permissions.evaluate(readOnlyRun).effect).toBe("allow");
    expect(registry.deactivate("review-diff")).toBe(false);
  });

  it("cannot loosen a rule another session-level source already applied", () => {
    const permissions = new PermissionPolicyEngine({
      clock,
      rules: [
        {
          id: "session.deny.grep",
          source: "session",
          effect: "deny",
          reason: "The user denied grep for this session",
          matcher: { kind: "tool", toolName: "grep" },
          hard: false,
        },
      ],
    });
    const registry = new SkillActivationRegistry({
      sessionId: "session-1",
      clock,
      permissions,
      toolNames: () => ["grep", "run_command"],
    });

    registry.activate(discoveredSkill());

    expect(
      permissions.evaluate({ action: toolAction("grep", "read-only"), context: evaluationContext })
        .effect,
    ).toBe("deny");
  });

  it("exposes active skills as mandatory, digest-tagged context candidates", async () => {
    const registry = new SkillActivationRegistry({
      sessionId: "session-1",
      clock,
      toolNames: () => ["grep", "run_command"],
    });
    registry.activate(discoveredSkill());

    const source = createActiveSkillContextSource(registry);
    const candidates = await source.collect({
      runId: runId("run-1"),
      cycle: 1,
      targetPaths: ["."],
      signal: new AbortController().signal,
    });

    expect(source.priority).toBe(3_000);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: "skill:review-diff",
      mandatory: true,
      provenance: {
        kind: "skill",
        trust: "untrusted",
        reference: ".pilot/skills/review-diff/SKILL.md",
      },
    });
    expect(String(candidates[0]?.content)).toContain("Read the diff, then report findings.");
  });

  it("treats a skill from the user's own directory as trusted context", async () => {
    const registry = new SkillActivationRegistry({
      sessionId: "session-1",
      clock,
      toolNames: () => ["grep", "run_command"],
    });
    registry.activate(discoveredSkill({ origin: "global", trust: "trusted-user" }));

    const candidates = await createActiveSkillContextSource(registry).collect({
      runId: runId("run-1"),
      cycle: 1,
      targetPaths: ["."],
      signal: new AbortController().signal,
    });

    expect(candidates[0]?.provenance.trust).toBe("trusted");
  });
});
