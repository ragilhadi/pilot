import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeWorkspaceBoundary, WorkspacePathError } from "../src/index.js";

let sandboxPath: string;
let workspacePath: string;
let outsidePath: string;

beforeEach(async () => {
  sandboxPath = await mkdtemp(path.join(tmpdir(), "pilot-boundary-test-"));
  workspacePath = path.join(sandboxPath, "workspace");
  outsidePath = path.join(sandboxPath, "outside");
  await mkdir(path.join(workspacePath, "src"), { recursive: true });
  await mkdir(outsidePath, { recursive: true });
  await writeFile(path.join(workspacePath, "src", "index.ts"), "export {};\n", "utf8");
  await writeFile(path.join(outsidePath, "secret.txt"), "secret\n", "utf8");
});

afterEach(async () => {
  await rm(sandboxPath, { recursive: true, force: true });
});

async function directoryLink(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

describe("NodeWorkspaceBoundary", () => {
  it("returns immutable canonical snapshots for in-workspace paths", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);

    const file = await boundary.resolve(path.join("src", "index.ts"), "read");
    const root = await boundary.resolve(".", "read");

    expect(file).toMatchObject({
      access: "read",
      rootPath: await realpath(workspacePath),
      relativePath: "src/index.ts",
      exists: true,
    });
    expect(file.realPath).toBe(path.join(boundary.rootPath, "src", "index.ts"));
    expect(root.relativePath).toBe("");
    expect(Object.isFrozen(file)).toBe(true);
  });

  it.each([
    "../outside/secret.txt",
    "..\\outside\\secret.txt",
    "/etc/passwd",
    "C:\\Windows\\System32\\drivers\\etc\\hosts",
    "C:relative.txt",
    "\\\\server\\share\\file.txt",
    "\\\\?\\C:\\Windows\\file.txt",
  ])("rejects lexical, absolute, and Windows-qualified path %s", async (requestedPath) => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);

    await expect(boundary.resolve(requestedPath, "read")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
  });

  it("distinguishes missing reads from safe writes and unresolved write parents", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);

    await expect(boundary.resolve("src/missing.ts", "read")).rejects.toMatchObject({
      code: "PILOT_WORKSPACE_PATH_NOT_FOUND",
      reason: "not-found",
    });
    await expect(boundary.resolve("src/new.ts", "write")).resolves.toMatchObject({
      relativePath: "src/new.ts",
      exists: false,
      access: "write",
    });
    await expect(boundary.resolve("missing/new.ts", "write")).rejects.toMatchObject({
      code: "PILOT_WORKSPACE_WRITE_PARENT_INVALID",
      reason: "unresolved-write-parent",
    });
  });

  it("denies reads and writes through a symlink or junction that escapes the workspace", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    await directoryLink(outsidePath, path.join(workspacePath, "escape"));

    await expect(boundary.resolve("escape/secret.txt", "read")).rejects.toMatchObject({
      code: "PILOT_WORKSPACE_PATH_ESCAPE",
      reason: "outside-real-root",
    });
    await expect(boundary.resolve("escape/new.txt", "write")).rejects.toMatchObject({
      code: "PILOT_WORKSPACE_PATH_ESCAPE",
      reason: "outside-real-root",
    });
  });

  it("allows an internal symlink while retaining the user-facing relative path", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    await directoryLink(path.join(workspacePath, "src"), path.join(workspacePath, "source-link"));

    const resolved = await boundary.resolve("source-link/index.ts", "read");

    expect(resolved.relativePath).toBe("source-link/index.ts");
    expect(resolved.realPath).toBe(path.join(boundary.rootPath, "src", "index.ts"));
  });

  it("revalidates immediately before access and detects a swapped directory link", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const switchPath = path.join(workspacePath, "switch");
    await mkdir(switchPath);
    await writeFile(path.join(switchPath, "target.txt"), "inside\n", "utf8");
    const resolved = await boundary.resolve("switch/target.txt", "read");

    await rm(switchPath, { recursive: true });
    await directoryLink(outsidePath, switchPath);

    await expect(boundary.revalidate(resolved)).rejects.toMatchObject({
      code: "PILOT_WORKSPACE_PATH_ESCAPE",
      reason: "outside-real-root",
    });
  });

  it("rejects paths resolved by another workspace boundary", async () => {
    const workspaceBoundary = await NodeWorkspaceBoundary.create(workspacePath);
    const outsideBoundary = await NodeWorkspaceBoundary.create(outsidePath);
    const outside = await outsideBoundary.resolve("secret.txt", "read");

    await expect(workspaceBoundary.revalidate(outside)).rejects.toMatchObject({
      code: "PILOT_WORKSPACE_PATH_INVALID",
    });
  });

  it("requires an existing directory as the workspace root", async () => {
    const filePath = path.join(sandboxPath, "root-file.txt");
    await writeFile(filePath, "not a directory\n", "utf8");

    await expect(NodeWorkspaceBoundary.create(filePath)).rejects.toMatchObject({
      code: "PILOT_WORKSPACE_PATH_INVALID",
      reason: "root-not-directory",
    });
    await expect(
      NodeWorkspaceBoundary.create(path.join(sandboxPath, "missing")),
    ).rejects.toMatchObject({
      code: "PILOT_WORKSPACE_PATH_NOT_FOUND",
      reason: "root-not-found",
    });
  });
});
