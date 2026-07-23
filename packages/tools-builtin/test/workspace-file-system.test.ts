import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkspaceBoundary, WorkspacePath } from "@pilotrun/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeWorkspaceBoundary, NodeWorkspaceFileSystem } from "../src/index.js";

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(tmpdir(), "pilot-atomic-write-test-"));
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

describe("NodeWorkspaceFileSystem", () => {
  it("reads BOM-preserving UTF-8 and atomically replaces an existing file", async () => {
    const filePath = path.join(workspacePath, "file.txt");
    const original = "\uFEFFone\r\ntwo\r\n";
    await writeFile(filePath, original, "utf8");
    if (process.platform !== "win32") await chmod(filePath, 0o640);
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const fileSystem = new NodeWorkspaceFileSystem(boundary, { temporaryId: () => "fixed" });

    const snapshot = await fileSystem.readUtf8("file.txt", signal());
    expect(snapshot).toMatchObject({
      path: "file.txt",
      content: original,
      sha256: sha256(original),
      sizeBytes: Buffer.byteLength(original),
    });
    const replacement = "\uFEFFone\r\nsecond\r\n";
    await expect(
      fileSystem.replaceUtf8Atomic({
        path: "file.txt",
        expectedSha256: snapshot.sha256,
        content: replacement,
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      path: "file.txt",
      beforeSha256: sha256(original),
      afterSha256: sha256(replacement),
      sizeBytes: Buffer.byteLength(replacement),
    });
    expect(await readFile(filePath, "utf8")).toBe(replacement);
    expect((await readdir(workspacePath)).filter((name) => name.includes(".pilot-"))).toEqual([]);
    if (process.platform !== "win32") expect((await stat(filePath)).mode & 0o777).toBe(0o640);
  });

  it("rejects a stale base without changing the target or leaving a temp file", async () => {
    const filePath = path.join(workspacePath, "file.txt");
    await writeFile(filePath, "current\n");
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const fileSystem = new NodeWorkspaceFileSystem(boundary, { temporaryId: () => "stale" });

    await expect(
      fileSystem.replaceUtf8Atomic({
        path: "file.txt",
        expectedSha256: sha256("old\n"),
        content: "replacement\n",
        signal: signal(),
      }),
    ).rejects.toMatchObject({ code: "PILOT_PATCH_BASE_MISMATCH" });
    expect(await readFile(filePath, "utf8")).toBe("current\n");
    expect(await readdir(workspacePath)).toEqual(["file.txt"]);
  });

  it("detects a dirty-file race after writing the temporary file and cleans it up", async () => {
    const filePath = path.join(workspacePath, "file.txt");
    await writeFile(filePath, "base\n");
    const base = await NodeWorkspaceBoundary.create(workspacePath);
    let revalidations = 0;
    const racingBoundary: WorkspaceBoundary = {
      rootPath: base.rootPath,
      resolve: (requestedPath, access) => base.resolve(requestedPath, access),
      async revalidate(resolved: WorkspacePath) {
        revalidations += 1;
        if (revalidations === 2) await writeFile(filePath, "user edit\n");
        return base.revalidate(resolved);
      },
    };
    const fileSystem = new NodeWorkspaceFileSystem(racingBoundary, {
      temporaryId: () => "race",
    });

    await expect(
      fileSystem.replaceUtf8Atomic({
        path: "file.txt",
        expectedSha256: sha256("base\n"),
        content: "agent edit\n",
        signal: signal(),
      }),
    ).rejects.toMatchObject({ code: "PILOT_PATCH_BASE_MISMATCH" });
    expect(await readFile(filePath, "utf8")).toBe("user edit\n");
    expect(await readdir(workspacePath)).toEqual(["file.txt"]);
  });

  it("honors cancellation before creating a temporary file", async () => {
    await writeFile(path.join(workspacePath, "file.txt"), "base\n");
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const fileSystem = new NodeWorkspaceFileSystem(boundary);
    const controller = new AbortController();
    controller.abort("cancelled test");

    await expect(
      fileSystem.replaceUtf8Atomic({
        path: "file.txt",
        expectedSha256: sha256("base\n"),
        content: "changed\n",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "PILOT_CANCELLED" });
    expect(await readdir(workspacePath)).toEqual(["file.txt"]);
  });

  it("creates a new UTF-8 file with the given content", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const fileSystem = new NodeWorkspaceFileSystem(boundary);
    const content = "export const value = 1;\n";

    await expect(
      fileSystem.createUtf8({ path: "src/new.ts", content, signal: signal() }),
    ).rejects.toMatchObject({ code: "PILOT_WORKSPACE_WRITE_PARENT_INVALID" });

    const created = await fileSystem.createUtf8({ path: "new.ts", content, signal: signal() });
    expect(created).toMatchObject({
      path: "new.ts",
      sha256: sha256(content),
      sizeBytes: Buffer.byteLength(content),
    });
    expect(await readFile(path.join(workspacePath, "new.ts"), "utf8")).toBe(content);
  });

  it("refuses to overwrite an existing file", async () => {
    await writeFile(path.join(workspacePath, "file.txt"), "original\n");
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const fileSystem = new NodeWorkspaceFileSystem(boundary);

    await expect(
      fileSystem.createUtf8({ path: "file.txt", content: "replacement\n", signal: signal() }),
    ).rejects.toMatchObject({ code: "PILOT_WORKSPACE_FILE_EXISTS" });
    expect(await readFile(path.join(workspacePath, "file.txt"), "utf8")).toBe("original\n");
  });

  it("rejects paths that escape the workspace", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const fileSystem = new NodeWorkspaceFileSystem(boundary);

    await expect(
      fileSystem.createUtf8({ path: "../escape.txt", content: "x\n", signal: signal() }),
    ).rejects.toMatchObject({ code: "PILOT_WORKSPACE_PATH_ESCAPE" });
  });
});

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
