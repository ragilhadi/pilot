import {
  PermissionActionSchema,
  PermissionRuleSchema,
  type PermissionAction,
  type PermissionEvaluationContext,
  type PermissionRule,
} from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import {
  fingerprintPermissionAction,
  PermissionPolicyEngine,
  PermissionPolicyError,
  permissionSourcePrecedence,
} from "../src/index.js";

const clock = { now: () => new Date("2026-07-22T01:00:00.000Z") };

function toolAction(
  overrides: Partial<Extract<PermissionAction, { kind: "tool" }>> = {},
): Extract<PermissionAction, { kind: "tool" }> {
  return PermissionActionSchema.parse({
    kind: "tool",
    toolName: "read_file",
    risk: "read-only",
    requiredPermissions: ["workspace.read"],
    input: { path: "README.md" },
    ...overrides,
  }) as Extract<PermissionAction, { kind: "tool" }>;
}

function context(
  overrides: Partial<PermissionEvaluationContext> = {},
): PermissionEvaluationContext {
  return {
    runId: "run-1",
    callId: "call-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    applicationId: "application-1",
    ...overrides,
  };
}

function rule(input: Omit<PermissionRule, "hard"> & { readonly hard?: boolean }): PermissionRule {
  return PermissionRuleSchema.parse(input);
}

describe("PermissionPolicyEngine built-in safety", () => {
  it("allows reads, asks for mutations, and hard-denies destructive actions", () => {
    const engine = new PermissionPolicyEngine({ clock });

    expect(engine.evaluate({ action: toolAction(), context: context() })).toMatchObject({
      effect: "allow",
      ruleId: "builtin.read-only.allow",
      source: "builtin",
    });
    expect(
      engine.evaluate({
        action: toolAction({
          toolName: "apply_patch",
          risk: "workspace-write",
          requiredPermissions: ["workspace.write"],
        }),
        context: context({ callId: "call-2" }),
      }),
    ).toMatchObject({ effect: "ask", ruleId: "builtin.other.ask" });
    expect(
      engine.evaluate({
        action: toolAction({
          toolName: "delete_path",
          risk: "destructive",
          requiredPermissions: ["workspace.delete"],
        }),
        context: context({ callId: "call-3" }),
      }),
    ).toMatchObject({ effect: "deny", ruleId: "builtin.destructive.deny" });
  });

  it("does not let a higher-precedence CLI allow override a hard safety denial", () => {
    const engine = new PermissionPolicyEngine({
      clock,
      rules: [
        rule({
          id: "cli.allow-delete",
          source: "cli",
          effect: "allow",
          reason: "CLI requested allow",
          matcher: { kind: "tool", toolName: "delete_path" },
        }),
      ],
    });

    const decision = engine.evaluate({
      action: toolAction({ toolName: "delete_path", risk: "destructive" }),
      context: context(),
    });

    expect(decision).toMatchObject({ effect: "deny", ruleId: "builtin.destructive.deny" });
    expect(decision.evaluatedRuleIds).toContain("cli.allow-delete");
    expect(engine.removeRule("builtin.destructive.deny")).toBe(false);
  });
});

describe("permission precedence lattice", () => {
  it("uses source precedence before specificity for intentional higher-layer overrides", () => {
    const engine = new PermissionPolicyEngine({
      clock,
      includeBuiltinDefaults: false,
      rules: [
        rule({
          id: "project.deny-exact-tool",
          source: "project",
          effect: "deny",
          reason: "Project denies this tool",
          matcher: { kind: "tool", toolName: "read_file" },
        }),
        rule({
          id: "cli.allow-reads",
          source: "cli",
          effect: "allow",
          reason: "CLI explicitly allows reads",
          matcher: { kind: "risk", risks: ["read-only"] },
        }),
      ],
    });

    expect(engine.evaluate({ action: toolAction(), context: context() })).toMatchObject({
      effect: "allow",
      ruleId: "cli.allow-reads",
    });
  });

  it("prefers specificity within one source and deny on an exact tie", () => {
    const engine = new PermissionPolicyEngine({
      clock,
      includeBuiltinDefaults: false,
      rules: [
        rule({
          id: "session.ask-any",
          source: "session",
          effect: "ask",
          reason: "Broad session rule",
          matcher: { kind: "any" },
        }),
        rule({
          id: "session.allow-tool",
          source: "session",
          effect: "allow",
          reason: "Specific tool rule",
          matcher: { kind: "tool", toolName: "read_file" },
        }),
        rule({
          id: "session.deny-tool",
          source: "session",
          effect: "deny",
          reason: "Safer equal-specificity rule",
          matcher: { kind: "tool", toolName: "read_file" },
        }),
      ],
    });

    expect(engine.evaluate({ action: toolAction(), context: context() })).toMatchObject({
      effect: "deny",
      ruleId: "session.deny-tool",
    });
  });

  it("publishes an immutable and complete source ordering", () => {
    expect(permissionSourcePrecedence).toEqual({
      builtin: 100,
      global: 200,
      project: 300,
      session: 400,
      cli: 500,
      interactive: 600,
    });
    expect(Object.isFrozen(permissionSourcePrecedence)).toBe(true);
  });
});

describe("scoped grants", () => {
  it.each([
    ["once", { kind: "once", callId: "call-1" }, context(), context({ callId: "call-other" })],
    [
      "session",
      { kind: "session", sessionId: "session-1" },
      context(),
      context({ sessionId: "session-other" }),
    ],
    [
      "workspace",
      { kind: "workspace", workspaceId: "workspace-1" },
      context(),
      context({ workspaceId: "workspace-other" }),
    ],
    [
      "application",
      { kind: "application", applicationId: "application-1" },
      context(),
      context({ applicationId: "application-other" }),
    ],
  ] as const)("contains a %s grant to its matching context", (_label, scope, matching, other) => {
    const engine = new PermissionPolicyEngine({
      clock,
      includeBuiltinDefaults: false,
      rules: [
        rule({
          id: `interactive.${scope.kind}`,
          source: "interactive",
          effect: "allow",
          reason: "Scoped user grant",
          matcher: { kind: "any" },
          scope,
        }),
      ],
    });

    expect(engine.evaluate({ action: toolAction(), context: matching }).effect).toBe("allow");
    expect(engine.evaluate({ action: toolAction(), context: other }).effect).toBe("ask");
  });

  it("contains tool and exact-action grants without leaking to other actions", () => {
    const read = toolAction();
    const write = toolAction({
      toolName: "apply_patch",
      risk: "workspace-write",
      input: { patch: "change" },
    });
    const engine = new PermissionPolicyEngine({
      clock,
      includeBuiltinDefaults: false,
      rules: [
        rule({
          id: "interactive.tool",
          source: "interactive",
          effect: "allow",
          reason: "Allow read_file",
          matcher: { kind: "any" },
          scope: { kind: "tool", toolName: "read_file" },
        }),
        rule({
          id: "interactive.exact-write",
          source: "interactive",
          effect: "allow",
          reason: "Allow this exact write",
          matcher: { kind: "any" },
          scope: { kind: "exact-action", fingerprint: fingerprintPermissionAction(write) },
        }),
      ],
    });

    expect(engine.evaluate({ action: read, context: context() })).toMatchObject({
      effect: "allow",
      ruleId: "interactive.tool",
    });
    expect(
      engine.evaluate({ action: write, context: context({ callId: "call-2" }) }),
    ).toMatchObject({
      effect: "allow",
      ruleId: "interactive.exact-write",
    });
    expect(
      engine.evaluate({
        action: toolAction({ ...write, input: { patch: "different" } }),
        context: context({ callId: "call-3" }),
      }).effect,
    ).toBe("ask");
  });

  it("matches required permission capabilities", () => {
    const engine = new PermissionPolicyEngine({
      clock,
      includeBuiltinDefaults: false,
      rules: [
        rule({
          id: "project.workspace-read",
          source: "project",
          effect: "allow",
          reason: "Workspace reads are allowed",
          matcher: { kind: "permission", permission: "workspace.read" },
        }),
      ],
    });

    expect(engine.evaluate({ action: toolAction(), context: context() }).effect).toBe("allow");
    expect(
      engine.evaluate({
        action: toolAction({ requiredPermissions: ["network"] }),
        context: context({ callId: "call-2" }),
      }).effect,
    ).toBe("ask");
  });
});

describe("structured action fingerprints and audit", () => {
  it("canonicalizes command fields and changes for any exact structured argument", () => {
    expect(fingerprintPermissionAction(toolAction())).toBe(
      "sha256:ab8dc165d776f797d6456d0a526d88cecf8998ffe05f72c9983d1a4990654389",
    );
    const first = PermissionActionSchema.parse({
      kind: "command",
      executable: "pnpm",
      args: ["test", "--filter", "core"],
      cwd: "workspace/packages/core",
      environment: { B: "two", A: "one" },
      risk: "read-only",
      requiredPermissions: ["process.execute"],
    });
    const reordered = PermissionActionSchema.parse({
      ...first,
      environment: { A: "one", B: "two" },
    });
    const changedArgument = PermissionActionSchema.parse({
      ...first,
      args: ["test", "--filter", "agent-runtime"],
    });

    expect(fingerprintPermissionAction(first)).toBe(fingerprintPermissionAction(reordered));
    expect(fingerprintPermissionAction(first)).not.toBe(
      fingerprintPermissionAction(changedArgument),
    );
  });

  it("records immutable ordered decisions without raw inputs or environment values", () => {
    const engine = new PermissionPolicyEngine({ clock });
    const secret = "DO_NOT_PERSIST_RAW_SECRET";
    const action = toolAction({ input: { path: "safe.txt", token: secret } });

    const first = engine.evaluate({ action, context: context() });
    engine.evaluate({ action: toolAction(), context: context({ callId: "call-2" }) });
    const audit = engine.auditEntries();

    expect(first.actionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(audit.map(({ sequence }) => sequence)).toEqual([1, 2]);
    expect(audit[0]).toMatchObject({
      occurredAt: "2026-07-22T01:00:00.000Z",
      context: { runId: "run-1", callId: "call-1" },
      action: { kind: "tool", risk: "read-only", name: "read_file" },
      decision: { effect: "allow" },
    });
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(Object.isFrozen(audit)).toBe(true);
    expect(Object.isFrozen(audit[0])).toBe(true);
    expect(Object.isFrozen(audit[0]?.decision)).toBe(true);
  });
});

describe("permission policy validation", () => {
  it("rejects duplicate identifiers and invalid hard allows", () => {
    const duplicate = rule({
      id: "project.rule",
      source: "project",
      effect: "ask",
      reason: "Project asks",
      matcher: { kind: "any" },
    });
    expect(() => new PermissionPolicyEngine({ clock, rules: [duplicate, duplicate] })).toThrowError(
      PermissionPolicyError,
    );
    expect(
      () =>
        new PermissionPolicyEngine({
          clock,
          includeBuiltinDefaults: false,
          rules: [
            {
              ...duplicate,
              id: "invalid.hard-allow",
              effect: "allow",
              hard: true,
            } as never,
          ],
        }),
    ).toThrowError(PermissionPolicyError);
  });

  it("supports dynamic rule installation/removal and defaults to ask with no match", () => {
    const engine = new PermissionPolicyEngine({ clock, includeBuiltinDefaults: false });
    const installed = engine.addRule(
      rule({
        id: "session.temporary",
        source: "session",
        effect: "allow",
        reason: "Temporary session grant",
        matcher: { kind: "tool", toolName: "read_file" },
      }),
    );

    expect(engine.evaluate({ action: toolAction(), context: context() }).effect).toBe("allow");
    expect(engine.removeRule(installed.id)).toBe(true);
    expect(
      engine.evaluate({ action: toolAction(), context: context({ callId: "call-2" }) }),
    ).toMatchObject({
      effect: "ask",
      reason: "No permission rule matched the requested action",
      evaluatedRuleIds: [],
    });
  });
});
