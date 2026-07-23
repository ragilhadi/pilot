import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeInstructionFileReader } from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("NodeInstructionFileReader", () => {
  it("reads bounded UTF-8 workspace files and rejects lexical escapes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "pilot-instructions-"));
    directories.push(workspace);
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "AGENTS.md"), "Use focused tests", "utf8");
    const reader = await NodeInstructionFileReader.create(workspace);

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
    const reader = await NodeInstructionFileReader.create(workspace);

    await expect(
      reader.read({ kind: "workspace", path: "AGENTS.md", maximumBytes: 100 }),
    ).resolves.toMatchObject({ status: "rejected", reason: "read-failed" });
  });
});
