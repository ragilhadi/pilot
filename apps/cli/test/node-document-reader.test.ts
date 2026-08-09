import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeWorkspaceDocumentReader } from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("NodeWorkspaceDocumentReader", () => {
  it("reads bounded UTF-8 workspace files and rejects lexical escapes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "pilot-instructions-"));
    directories.push(workspace);
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "AGENTS.md"), "Use focused tests", "utf8");
    const reader = await NodeWorkspaceDocumentReader.create(workspace);

    await expect(
      reader.read({ kind: "workspace", path: "src/AGENTS.md", maximumBytes: 100 }),
    ).resolves.toMatchObject({
      status: "found",
      displayPath: "src/AGENTS.md",
      content: "Use focused tests",
    });
    await expect(
      reader.read({ kind: "workspace", path: "../AGENTS.md", maximumBytes: 100 }),
    ).resolves.toMatchObject({ status: "rejected", reason: "outside-workspace" });
    await expect(
      reader.read({ kind: "workspace", path: "src/AGENTS.md", maximumBytes: 2 }),
    ).resolves.toMatchObject({ status: "rejected", reason: "too-large" });
  });

  it("rejects invalid UTF-8 instead of injecting replacement characters", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "pilot-instructions-"));
    directories.push(workspace);
    await writeFile(path.join(workspace, "AGENTS.md"), Buffer.from([0xff, 0xfe]));
    const reader = await NodeWorkspaceDocumentReader.create(workspace);

    await expect(
      reader.read({ kind: "workspace", path: "AGENTS.md", maximumBytes: 100 }),
    ).resolves.toMatchObject({ status: "rejected", reason: "read-failed" });
  });

  it("lists directory entries by kind and reports a missing directory as missing", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "pilot-documents-"));
    directories.push(workspace);
    await mkdir(path.join(workspace, ".pilot", "skills", "review-diff"), { recursive: true });
    await writeFile(path.join(workspace, ".pilot", "skills", "notes.md"), "notes", "utf8");
    const reader = await NodeWorkspaceDocumentReader.create(workspace);

    const listed = await reader.list({ kind: "workspace", path: ".pilot/skills" });
    expect(listed.status).toBe("listed");
    expect(
      listed.status === "listed"
        ? [...listed.entries].sort((left, right) => left.name.localeCompare(right.name))
        : [],
    ).toEqual([
      { kind: "file", name: "notes.md" },
      { kind: "directory", name: "review-diff" },
    ]);

    await expect(reader.list({ kind: "workspace", path: ".pilot/prompts" })).resolves.toEqual({
      status: "missing",
    });
    await expect(reader.list({ kind: "workspace", path: "../escape" })).resolves.toMatchObject({
      status: "rejected",
      reason: "outside-workspace",
    });
  });
});
