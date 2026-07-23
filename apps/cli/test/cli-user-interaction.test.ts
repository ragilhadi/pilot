import { CancellationError, type PermissionApprovalRequest } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import { CliUserInteraction } from "../src/cli-user-interaction.js";

function request(overrides: Partial<PermissionApprovalRequest> = {}): PermissionApprovalRequest {
  return {
    requestId: "permission-1",
    action: {
      kind: "tool",
      toolName: "apply_patch",
      risk: "workspace-write",
      requiredPermissions: ["workspace.write"],
      input: { patch: "*** Begin Patch" },
    },
    context: {
      runId: "run-1",
      callId: "call-1",
      sessionId: "session-1",
      workspaceId: "/workspace",
      applicationId: "pilot-cli",
    },
    policyDecision: {
      effect: "ask",
      reason: "Workspace writes require approval",
      actionFingerprint: `sha256:${"a".repeat(64)}`,
      evaluatedRuleIds: ["builtin.workspace-write.ask"],
    },
    availableScopes: ["once", "session"],
    ...overrides,
  };
}

describe("CliUserInteraction", () => {
  it("resolves a pending request once respond() parses a valid line", async () => {
    let notified: PermissionApprovalRequest | undefined;
    const interaction = new CliUserInteraction((requested) => {
      notified = requested;
    });

    const pending = interaction.requestPermission(request(), new AbortController().signal);
    expect(notified?.requestId).toBe("permission-1");
    expect(interaction.respond("allow session")).toBe("accepted");

    await expect(pending).resolves.toEqual({ effect: "allow", scope: "session" });
    expect(interaction.pendingRequest).toBeUndefined();
  });

  it("reports invalid lines without resolving or clearing the pending request", async () => {
    const interaction = new CliUserInteraction(() => {});
    const pending = interaction.requestPermission(request(), new AbortController().signal);

    expect(interaction.respond("allow workspace")).toBe("invalid");
    expect(interaction.pendingRequest?.requestId).toBe("permission-1");

    expect(interaction.respond("allow session")).toBe("accepted");
    await expect(pending).resolves.toEqual({ effect: "allow", scope: "session" });
  });

  it("reports 'none' when no request is pending", () => {
    const interaction = new CliUserInteraction(() => {});
    expect(interaction.respond("allow once")).toBe("none");
  });

  it("rejects a second concurrent permission request while one is already pending", async () => {
    const interaction = new CliUserInteraction(() => {});
    const first = interaction.requestPermission(request(), new AbortController().signal);

    await expect(
      interaction.requestPermission(
        request({ requestId: "permission-2" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("A permission request is already pending");

    expect(interaction.respond("allow once")).toBe("accepted");
    await expect(first).resolves.toEqual({ effect: "allow", scope: "once" });
  });

  it("cancels the pending request when its signal aborts", async () => {
    const interaction = new CliUserInteraction(() => {});
    const controller = new AbortController();
    const pending = interaction.requestPermission(request(), controller.signal);

    controller.abort("user cancelled");

    await expect(pending).rejects.toBeInstanceOf(CancellationError);
    expect(interaction.pendingRequest).toBeUndefined();
    expect(interaction.respond("allow once")).toBe("none");
  });
});
