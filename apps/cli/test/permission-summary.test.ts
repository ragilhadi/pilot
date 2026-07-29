import { PermissionActionSchema, type PermissionAction } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import {
  permissionPreview,
  summarizePermissionAction,
} from "../src/tui/components/permission-summary.js";

function toolAction(toolName: string, input: Record<string, unknown>): PermissionAction {
  return PermissionActionSchema.parse({
    kind: "tool",
    toolName,
    risk: "workspace-write",
    requiredPermissions: ["workspace.write"],
    input,
  });
}

function flatten(action: PermissionAction): string {
  return summarizePermissionAction(action)
    .map(({ label, value }) => `${label}: ${value}`)
    .join("\n");
}

describe("summarizePermissionAction", () => {
  // The prompt used to render the whole input as JSON, so writing a real file pushed the question,
  // the risk line, and the choices off the screen behind the payload.
  it("describes a large write_file by shape instead of printing its content", () => {
    const content = "const value = 1;\n".repeat(400);
    const summary = flatten(toolAction("write_file", { path: "src/generated.ts", content }));

    expect(summary).toContain("src/generated.ts");
    expect(summary).toContain("400 lines");
    expect(summary).not.toContain("const value = 1;");
    expect(summary.split("\n")).toHaveLength(2);
  });

  it("distinguishes creating a file from overwriting one", () => {
    expect(flatten(toolAction("write_file", { path: "a.txt", content: "hi" }))).toContain("Creates");
    expect(
      flatten(toolAction("write_file", { path: "a.txt", content: "hi", baseSha256: "a".repeat(64) })),
    ).toContain("Overwrites");
  });

  it("keeps a short single-line value readable rather than reducing it to a byte count", () => {
    expect(flatten(toolAction("write_file", { path: "a.txt", content: "port = 8080" }))).toContain(
      '"port = 8080"',
    );
  });

  it("summarizes an edit by file, size, and scope", () => {
    const summary = flatten(
      toolAction("edit", {
        path: "src/config.ts",
        oldString: "  port: 3000,",
        newString: "  port: 8080,",
        replaceAll: true,
      }),
    );
    expect(summary).toContain("src/config.ts");
    expect(summary).toContain("every occurrence");
  });

  it("summarizes a patch by hunk and line counts", () => {
    const patch = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "@@ -9,2 +9,3 @@",
      " keep",
      "+added",
    ].join("\n");
    const summary = flatten(toolAction("apply_patch", { path: "x.ts", patch }));
    expect(summary).toContain("2 hunks");
    expect(summary).toContain("+2");
    expect(summary).toContain("-1");
  });

  it("shows a command with its directory and never its environment values", () => {
    const summary = flatten(
      PermissionActionSchema.parse({
        kind: "command",
        executable: "npm",
        args: ["run", "build"],
        cwd: "packages/core",
        environment: { CI: "1", NO_COLOR: "1" },
        risk: "workspace-write",
        requiredPermissions: ["process.execute", "workspace.write"],
      }),
    );
    expect(summary).toContain("npm run build");
    expect(summary).toContain("packages/core");
    expect(summary).toContain("CI, NO_COLOR");
    expect(summary).not.toMatch(/CI: 1|NO_COLOR: 1/u);
  });

  it("falls back to scalar fields for an unrecognized tool, still bounding long ones", () => {
    const summary = flatten(
      toolAction("some_future_tool", { target: "a.txt", count: 3, blob: "x".repeat(5_000) }),
    );
    expect(summary).toContain("target: a.txt");
    expect(summary).toContain("count: 3");
    expect(summary).toContain("1 line");
    expect(summary).not.toContain("xxxxxxxxxx");
  });

  it("keeps every row on one line so the dialog cannot be pushed off screen", () => {
    const action = toolAction("write_file", {
      path: "a.txt",
      content: "line\n".repeat(1_000),
    });
    for (const { value } of summarizePermissionAction(action)) {
      expect(value).not.toContain("\n");
      expect(value.length).toBeLessThanOrEqual(160);
    }
  });
});

describe("permissionPreview", () => {
  it("offers the full content behind the preview key", () => {
    const preview = permissionPreview(
      toolAction("write_file", { path: "a.txt", content: "alpha\nbeta" }),
    );
    expect(preview).toMatchObject({ text: "alpha\nbeta", diff: false });
    expect(preview?.title).toContain("a.txt");
  });

  it("renders an edit as a diff of the replaced text", () => {
    const preview = permissionPreview(
      toolAction("edit", { path: "a.txt", oldString: "old", newString: "new" }),
    );
    expect(preview).toMatchObject({ diff: true, text: "-old\n+new" });
  });

  it("keeps the patch preview for apply_patch", () => {
    const preview = permissionPreview(
      toolAction("apply_patch", { path: "a.txt", patch: "--- a/a.txt\n+++ b/a.txt\n" }),
    );
    expect(preview).toMatchObject({ diff: true, title: "Proposed diff" });
  });

  it("offers nothing to preview for a command", () => {
    expect(
      permissionPreview(
        PermissionActionSchema.parse({
          kind: "command",
          executable: "ls",
          args: [],
          cwd: ".",
          environment: {},
          risk: "read-only",
          requiredPermissions: ["process.execute"],
        }),
      ),
    ).toBeUndefined();
  });
});
