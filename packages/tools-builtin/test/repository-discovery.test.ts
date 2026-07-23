import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CancellationError } from "@pilot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GitCommandRunner,
  GitInspectionError,
  NodeWorkspaceBoundary,
  RepositoryDiscovery,
  RepositoryDiscoveryError,
  RepositoryIgnoreRules,
} from "../src/index.js";

let sandboxPath: string;
let workspacePath: string;
let outsidePath: string;

beforeEach(async () => {
  sandboxPath = await mkdtemp(path.join(tmpdir(), "pilot-discovery-test-"));
  workspacePath = path.join(sandboxPath, "workspace");
  outsidePath = path.join(sandboxPath, "outside");
  await mkdir(workspacePath);
  await mkdir(outsidePath);
});

afterEach(async () => {
  await rm(sandboxPath, { recursive: true, force: true });
});

async function directoryLink(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function gitRunner(root = workspacePath): GitCommandRunner {
  return {
    run: vi.fn(async (args: readonly string[]) => {
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") return { stdout: `${root}\n`, stderr: "" };
      if (command === "symbolic-ref --quiet --short HEAD") return { stdout: "main\n", stderr: "" };
      if (command === "rev-parse --verify HEAD")
        return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
      if (command === "status --porcelain=v1 -z --untracked-files=normal") {
        return {
          stdout: "M  staged.ts\0 M modified.ts\0?? new.ts\0UU conflict.ts\0",
          stderr: "",
        };
      }
      throw new Error(`Unexpected git command: ${command}`);
    }),
  };
}

async function createFixture(): Promise<void> {
  await mkdir(path.join(workspacePath, ".git"));
  await mkdir(path.join(workspacePath, "src"));
  await mkdir(path.join(workspacePath, "dist"));
  await mkdir(path.join(workspacePath, "node_modules"));
  await mkdir(path.join(workspacePath, "private"));
  await mkdir(path.join(workspacePath, "packages", "example"), { recursive: true });
  await writeFile(
    path.join(workspacePath, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@11.9.0",
      scripts: { build: "tsc -b", test: "vitest", lint: "biome lint .", typecheck: "tsc -b" },
    }),
  );
  await writeFile(path.join(workspacePath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(path.join(workspacePath, "tsconfig.json"), "{}\n");
  await writeFile(path.join(workspacePath, "AGENTS.md"), "Project instructions\n");
  await writeFile(path.join(workspacePath, ".gitignore"), "*.log\n!keep.log\ndist/\n");
  await writeFile(path.join(workspacePath, ".ignore"), "secret.env\n");
  await writeFile(path.join(workspacePath, ".pilotignore"), "private/\n");
  await writeFile(path.join(workspacePath, "src", "index.ts"), "export const value = 1;\n");
  await writeFile(path.join(workspacePath, "src", "binary.dat"), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(workspacePath, "src", "large.txt"), "x".repeat(512));
  await writeFile(path.join(workspacePath, "ignored.log"), "ignored\n");
  await writeFile(path.join(workspacePath, "keep.log"), "included\n");
  await writeFile(path.join(workspacePath, "secret.env"), "SECRET=value\n");
  await writeFile(path.join(workspacePath, "dist", "bundle.js"), "generated\n");
  await writeFile(path.join(workspacePath, "node_modules", "dependency.js"), "generated\n");
  await writeFile(path.join(workspacePath, "private", "notes.md"), "private\n");
  await writeFile(path.join(workspacePath, "packages", "example", "package.json"), "{}\n");
  await writeFile(path.join(outsidePath, "outside.txt"), "outside\n");
  await directoryLink(outsidePath, path.join(workspacePath, "outside-link"));
}

describe("RepositoryIgnoreRules", () => {
  it("supports ordering, negation, anchoring, globstar, and protected generated directories", () => {
    const rules = RepositoryIgnoreRules.parse([
      {
        source: ".gitignore",
        content: "*.log\n!important.log\n/docs/*.tmp\ncache/**/generated.txt\n!node_modules/\n",
      },
    ]);

    expect(rules.evaluate("server.log", false).ignored).toBe(true);
    expect(rules.evaluate("nested/server.log", false).ignored).toBe(true);
    expect(rules.evaluate("important.log", false).ignored).toBe(false);
    expect(rules.evaluate("docs/file.tmp", false).ignored).toBe(true);
    expect(rules.evaluate("nested/docs/file.tmp", false).ignored).toBe(false);
    expect(rules.evaluate("cache/a/b/generated.txt", false).ignored).toBe(true);
    expect(rules.evaluate("node_modules", true)).toMatchObject({
      ignored: true,
      source: "builtin",
    });
  });
});

describe("RepositoryDiscovery", () => {
  it("creates a deterministic bounded snapshot with ignores, classification, signals, and Git status", async () => {
    await createFixture();
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const discovery = new RepositoryDiscovery({
      boundary,
      gitRunner: gitRunner(boundary.rootPath),
    });

    const snapshot = await discovery.discover({ maxDepth: 3, maxFileSizeBytes: 256 });
    const paths = snapshot.entries.map((entry) => entry.path);

    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("keep.log");
    expect(paths).not.toContain("ignored.log");
    expect(paths).not.toContain("secret.env");
    expect(paths).not.toContain("dist");
    expect(paths).not.toContain("private");
    expect(paths).not.toContain("outside-link");
    expect(snapshot.unsafeLinksSkipped).toBe(1);
    expect(snapshot.ignoredEntries).toBeGreaterThanOrEqual(5);
    expect(snapshot.entries.find((entry) => entry.path === "src/binary.dat")).toMatchObject({
      classification: "binary",
    });
    expect(snapshot.entries.find((entry) => entry.path === "src/large.txt")).toMatchObject({
      classification: "too-large",
    });
    expect(snapshot.languages).toContainEqual({ name: "TypeScript", fileCount: 1 });
    expect(snapshot.packageManagers).toEqual(["pnpm"]);
    expect(snapshot.buildTools).toEqual(["package-script", "typescript"]);
    expect(snapshot.commandHints).toEqual({
      build: "pnpm build",
      test: "pnpm test",
      lint: "pnpm lint",
      typecheck: "pnpm typecheck",
    });
    expect(snapshot.importantDirectories).toEqual(["packages", "src"]);
    expect(snapshot.generatedDirectories).toEqual(["dist", "node_modules"]);
    expect(snapshot.packageDirectories).toEqual([".", "packages/example"]);
    expect(snapshot.instructionFiles).toEqual(["AGENTS.md"]);
    expect(snapshot.git).toEqual({
      available: true,
      rootPath: boundary.rootPath,
      branch: "main",
      headCommit: "a".repeat(40),
      dirty: true,
      status: { staged: 1, modified: 1, untracked: 1, conflicted: 1 },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
  });

  it("honors depth and entry limits without scanning blindly", async () => {
    await mkdir(path.join(workspacePath, "a", "b", "c"), { recursive: true });
    await writeFile(path.join(workspacePath, "a", "b", "c", "deep.ts"), "export {};\n");
    await writeFile(path.join(workspacePath, "one.txt"), "one\n");
    await writeFile(path.join(workspacePath, "two.txt"), "two\n");
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const discovery = new RepositoryDiscovery({ boundary });

    const depthLimited = await discovery.discover({ maxDepth: 1 });
    const entryLimited = await discovery.discover({ maxEntries: 2 });

    expect(depthLimited.entries.map(({ path: entryPath }) => entryPath)).toContain("a/b");
    expect(depthLimited.entries.map(({ path: entryPath }) => entryPath)).not.toContain(
      "a/b/c/deep.ts",
    );
    expect(entryLimited.entries).toHaveLength(2);
    expect(entryLimited.truncated).toBe(true);
  });

  it("rejects invalid limits and propagates cancellation", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const discovery = new RepositoryDiscovery({ boundary });
    const controller = new AbortController();
    controller.abort("cancel discovery");

    await expect(discovery.discover({ maxDepth: -1 })).rejects.toBeInstanceOf(
      RepositoryDiscoveryError,
    );
    await expect(discovery.discover({ signal: controller.signal })).rejects.toBeInstanceOf(
      CancellationError,
    );
  });

  it("reports a non-Git workspace without invoking Git", async () => {
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const runner = gitRunner(boundary.rootPath);
    const discovery = new RepositoryDiscovery({ boundary, gitRunner: runner });

    const snapshot = await discovery.discover();

    expect(snapshot.git).toEqual({ available: false, reason: "git-directory-missing" });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects Git roots outside the configured workspace", async () => {
    await mkdir(path.join(workspacePath, ".git"));
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const discovery = new RepositoryDiscovery({ boundary, gitRunner: gitRunner(outsidePath) });

    await expect(discovery.discover()).rejects.toBeInstanceOf(GitInspectionError);
  });

  it("does not invoke Git through an escaping .git junction", async () => {
    const externalGitDirectory = path.join(outsidePath, "external-git");
    await mkdir(externalGitDirectory);
    await directoryLink(externalGitDirectory, path.join(workspacePath, ".git"));
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const runner = gitRunner(boundary.rootPath);
    const discovery = new RepositoryDiscovery({ boundary, gitRunner: runner });

    const snapshot = await discovery.discover();

    expect(snapshot.git).toEqual({ available: false, reason: "git-entry-unsafe" });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("does not invoke Git when a .git worktree file points outside the workspace", async () => {
    await writeFile(path.join(workspacePath, ".git"), "gitdir: ../outside/external-git\n");
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const runner = gitRunner(boundary.rootPath);
    const discovery = new RepositoryDiscovery({ boundary, gitRunner: runner });

    const snapshot = await discovery.discover();

    expect(snapshot.git).toEqual({ available: false, reason: "git-entry-unsafe" });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects oversized ignore files before applying partial policy", async () => {
    await writeFile(path.join(workspacePath, ".gitignore"), "x".repeat(128));
    const boundary = await NodeWorkspaceBoundary.create(workspacePath);
    const discovery = new RepositoryDiscovery({ boundary });

    await expect(discovery.discover({ maxIgnoreFileBytes: 64 })).rejects.toMatchObject({
      code: "PILOT_REPOSITORY_DISCOVERY_INVALID",
    });
  });
});
