import {
  PermissionActionSchema,
  type PermissionAction,
  type PermissionApprovalRequest,
  type PermissionEvaluationContext,
  type UserInteraction,
} from "@pilotrun/core";
import { describe, expect, it, vi } from "vitest";
import {
  PermissionCoordinator,
  PermissionCoordinatorError,
  PermissionPolicyEngine,
} from "../src/index.js";

const clock = { now: () => new Date("2026-07-22T02:00:00.000Z") };

function action(risk: "destructive" | "read-only" | "workspace-write" = "workspace-write") {
  return PermissionActionSchema.parse({
    kind: "tool",
    toolName: "write_file",
    risk,
    requiredPermissions: [risk === "read-only" ? "workspace.read" : "workspace.write"],
    input: { path: "notes.txt" },
  }) as Extract<PermissionAction, { kind: "tool" }>;
}

function context(callId = "call-1"): PermissionEvaluationContext {
  return {
    runId: "run-1",
    callId,
    sessionId: "session-1",
    workspaceId: "workspace-1",
    applicationId: "application-1",
  };
}

describe("PermissionCoordinator", () => {
  it("returns direct policy decisions without invoking interaction", async () => {
    const requestPermission = vi.fn<UserInteraction["requestPermission"]>();
    const coordinator = new PermissionCoordinator({
      policy: new PermissionPolicyEngine({ clock }),
      mode: "interactive",
      interaction: { requestPermission },
    });

    await expect(
      coordinator.authorize({ action: action("read-only"), context: context(), signal: signal() }),
    ).resolves.toMatchObject({ effect: "allow", ruleId: "builtin.read-only.allow" });
    await expect(
      coordinator.authorize({
        action: action("destructive"),
        context: context("call-2"),
        signal: signal(),
      }),
    ).resolves.toMatchObject({ effect: "deny", ruleId: "builtin.destructive.deny" });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("pauses for interactive approval and reuses a session-scoped decision", async () => {
    let resolveApproval: ((value: { effect: "allow"; scope: "session" }) => void) | undefined;
    const requestPermission = vi.fn(
      (_request: PermissionApprovalRequest) =>
        new Promise<{ effect: "allow"; scope: "session" }>((resolve) => {
          resolveApproval = resolve;
        }),
    );
    const policy = new PermissionPolicyEngine({ clock });
    const coordinator = new PermissionCoordinator({
      policy,
      mode: "interactive",
      interaction: { requestPermission },
    });

    const pending = coordinator.authorize({
      action: action(),
      context: context(),
      signal: signal(),
    });
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledOnce());
    expect(requestPermission.mock.calls[0]?.[0].availableScopes).toEqual([
      "once",
      "exact-action",
      "session",
      "tool",
      "workspace",
      "application",
    ]);
    resolveApproval?.({ effect: "allow", scope: "session" });

    await expect(pending).resolves.toMatchObject({
      effect: "allow",
      source: "interactive",
      scope: { kind: "session", sessionId: "session-1" },
    });
    await expect(
      coordinator.authorize({ action: action(), context: context("call-2"), signal: signal() }),
    ).resolves.toMatchObject({ effect: "allow", source: "interactive" });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(policy.auditEntries()).toHaveLength(3);
  });

  it("denies asks by default in non-interactive mode", async () => {
    const coordinator = new PermissionCoordinator({
      policy: new PermissionPolicyEngine({ clock }),
    });
    await expect(
      coordinator.authorize({ action: action(), context: context(), signal: signal() }),
    ).resolves.toMatchObject({ effect: "deny", source: "cli", scope: { kind: "once" } });
  });

  it("allows asks only when non-interactive allow mode is explicit", async () => {
    const coordinator = new PermissionCoordinator({
      policy: new PermissionPolicyEngine({ clock }),
      mode: "non-interactive-allow",
    });
    await expect(
      coordinator.authorize({ action: action(), context: context(), signal: signal() }),
    ).resolves.toMatchObject({ effect: "allow", source: "cli" });
    await expect(
      coordinator.authorize({
        action: action("destructive"),
        context: context("call-2"),
        signal: signal(),
      }),
    ).resolves.toMatchObject({ effect: "deny", ruleId: "builtin.destructive.deny" });
  });

  it("allocates unique scoped rule identifiers across coordinator instances", async () => {
    const policy = new PermissionPolicyEngine({ clock });
    for (const callId of ["call-1", "call-2"]) {
      const coordinator = new PermissionCoordinator({
        policy,
        mode: "non-interactive-allow",
      });
      await coordinator.authorize({ action: action(), context: context(callId), signal: signal() });
    }
    expect(policy.rules().map(({ id }) => id)).toEqual(
      expect.arrayContaining(["cli.permission-1", "cli.permission-2"]),
    );
  });

  it("rejects interactive mode without an interaction port", async () => {
    const coordinator = new PermissionCoordinator({
      policy: new PermissionPolicyEngine({ clock }),
      mode: "interactive",
    });
    await expect(
      coordinator.authorize({ action: action(), context: context(), signal: signal() }),
    ).rejects.toBeInstanceOf(PermissionCoordinatorError);
  });

  it("rejects an unavailable response scope", async () => {
    const coordinator = new PermissionCoordinator({
      policy: new PermissionPolicyEngine({ clock }),
      mode: "interactive",
      interaction: {
        requestPermission: async () => ({ effect: "allow", scope: "workspace" }),
      },
    });
    const limitedContext = { runId: "run-1", callId: "call-1" };
    await expect(
      coordinator.authorize({ action: action(), context: limitedContext, signal: signal() }),
    ).rejects.toMatchObject({ code: "PILOT_PERMISSION_RESPONSE_INVALID" });
  });

  it("cancels while awaiting an interaction response", async () => {
    const controller = new AbortController();
    const coordinator = new PermissionCoordinator({
      policy: new PermissionPolicyEngine({ clock }),
      mode: "interactive",
      interaction: { requestPermission: () => new Promise(() => undefined) },
    });
    const pending = coordinator.authorize({
      action: action(),
      context: context(),
      signal: controller.signal,
    });
    controller.abort("test cancellation");
    await expect(pending).rejects.toMatchObject({ code: "PILOT_CANCELLED" });
  });
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("PermissionCoordinator approval breadth", () => {
  function coordinatorAllowing(scope: string) {
    const policy = new PermissionPolicyEngine({ clock });
    const coordinator = new PermissionCoordinator({
      policy,
      mode: "interactive",
      interaction: { requestPermission: async () => ({ effect: "allow", scope }) },
    });
    return { policy, coordinator };
  }

  // A scope says how long an approval lasts, never what it covers. Pairing one with an `any`
  // matcher turned "allow for session" into a blanket approval of every later tool call, so
  // approving one npm build silently pre-authorized an unrelated network command.
  it.each(["session", "workspace", "application", "exact-action", "once"])(
    "keeps a %s approval bound to the reviewed action",
    async (scope) => {
      const { policy, coordinator } = coordinatorAllowing(scope);
      const approved = await coordinator.authorize({
        action: action(),
        context: context(),
        signal: new AbortController().signal,
      });
      expect(approved.effect).toBe("allow");

      const unrelated = policy.evaluate({
        action: PermissionActionSchema.parse({
          kind: "command",
          executable: "curl",
          args: ["https://example.test", "-o", "out"],
          cwd: ".",
          environment: {},
          risk: "network",
          requiredPermissions: ["process.execute", "network.access"],
        }),
        context: context("call-2"),
      });
      expect(unrelated.effect).toBe("ask");
    },
  );

  it("re-allows the identical action for the rest of the session", async () => {
    const { policy, coordinator } = coordinatorAllowing("session");
    await coordinator.authorize({
      action: action(),
      context: context(),
      signal: new AbortController().signal,
    });
    expect(policy.evaluate({ action: action(), context: context("call-2") }).effect).toBe("allow");
  });

  it("does not carry a session approval into a different session", async () => {
    const { policy, coordinator } = coordinatorAllowing("session");
    await coordinator.authorize({
      action: action(),
      context: context(),
      signal: new AbortController().signal,
    });
    const elsewhere = policy.evaluate({
      action: action(),
      context: { ...context("call-2"), sessionId: "session-2" },
    });
    expect(elsewhere.effect).toBe("ask");
  });

  it("still lets a tool-scoped approval cover the whole tool", async () => {
    const { policy, coordinator } = coordinatorAllowing("tool");
    await coordinator.authorize({
      action: action(),
      context: context(),
      signal: new AbortController().signal,
    });
    const otherInput = PermissionActionSchema.parse({
      kind: "tool",
      toolName: "write_file",
      risk: "workspace-write",
      requiredPermissions: ["workspace.write"],
      input: { path: "a-completely-different-file.txt" },
    });
    expect(policy.evaluate({ action: otherInput, context: context("call-2") }).effect).toBe(
      "allow",
    );
  });
});
