import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CancellationError } from "@pilotrun/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeWorkspaceBoundary, parseMentions, resolveContextMentions } from "../src/index.js";

let sandboxPath: string;
let workspacePath: string;

beforeEach(async () => {
  sandboxPath = await mkdtemp(path.join(tmpdir(), "pilot-context-mention-test-"));
  workspacePath = path.join(sandboxPath, "workspace");
  await mkdir(path.join(workspacePath, "src"), { recursive: true });
});

afterEach(async () => {
  await rm(sandboxPath, { recursive: true, force: true });
});

async function boundary() {
  return NodeWorkspaceBoundary.create(workspacePath);
}

describe("parseMentions", () => {
  it("extracts a plain mention at the start and after whitespace", () => {
    expect(parseMentions("@src/a.ts please review @README.md")).toEqual([
      { raw: "@src/a.ts", path: "src/a.ts" },
      { raw: "@README.md", path: "README.md" },
    ]);
  });

  it("supports quoted mentions containing spaces", () => {
    expect(parseMentions('open @"src/my file.ts" now')).toEqual([
      { raw: '@"src/my file.ts"', path: "src/my file.ts" },
    ]);
  });

  it("trims trailing sentence punctuation but keeps the extension", () => {
    expect(parseMentions("see @src/a.ts, and @b.ts.")).toEqual([
      { raw: "@src/a.ts", path: "src/a.ts" },
      { raw: "@b.ts.", path: "b.ts." },
    ]);
  });

  it("does not treat email addresses as mentions", () => {
    expect(parseMentions("mail me at name@example.com")).toEqual([]);
  });
});

describe("resolveContextMentions", () => {
  it("returns the original text unchanged when there are no mentions", async () => {
    const result = await resolveContextMentions({
      text: "just a normal question",
      boundary: await boundary(),
    });
    expect(result.augmentedText).toBe("just a normal question");
    expect(result.attachments).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("attaches the contents of a referenced file", async () => {
    await writeFile(path.join(workspacePath, "src", "a.ts"), "export const answer = 42;");
    const result = await resolveContextMentions({
      text: "explain @src/a.ts",
      boundary: await boundary(),
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({ path: "src/a.ts", truncated: false });
    expect(result.augmentedText).toContain('<context path="src/a.ts">');
    expect(result.augmentedText).toContain("export const answer = 42;");
    expect(result.skipped).toEqual([]);
  });

  it("refuses to read a gitignored file and never leaks its contents", async () => {
    await writeFile(path.join(workspacePath, ".gitignore"), ".env\n");
    await writeFile(path.join(workspacePath, ".env"), "SECRET_TOKEN=super-secret-value");
    const result = await resolveContextMentions({
      text: "use @.env for config",
      boundary: await boundary(),
    });
    expect(result.attachments).toEqual([]);
    expect(result.skipped).toEqual([
      { raw: "@.env", path: ".env", reason: "ignored", detail: ".gitignore" },
    ]);
    expect(result.augmentedText).not.toContain("super-secret-value");
  });

  it("respects .pilotignore in addition to .gitignore", async () => {
    await writeFile(path.join(workspacePath, ".pilotignore"), "notes/\n");
    await mkdir(path.join(workspacePath, "notes"), { recursive: true });
    await writeFile(path.join(workspacePath, "notes", "private.md"), "internal only");
    const result = await resolveContextMentions({
      text: "look at @notes/private.md",
      boundary: await boundary(),
    });
    expect(result.attachments).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: "ignored", detail: ".pilotignore" });
    expect(result.augmentedText).not.toContain("internal only");
  });

  it("skips paths that escape the workspace boundary", async () => {
    await writeFile(path.join(sandboxPath, "outside.txt"), "outside content");
    const result = await resolveContextMentions({
      text: "read @../outside.txt",
      boundary: await boundary(),
    });
    expect(result.attachments).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: "outside-workspace" });
    expect(result.augmentedText).not.toContain("outside content");
  });

  it("reports missing files without failing the turn", async () => {
    const result = await resolveContextMentions({
      text: "check @src/missing.ts",
      boundary: await boundary(),
    });
    expect(result.skipped[0]).toMatchObject({ path: "src/missing.ts", reason: "not-found" });
  });

  it("attaches every eligible file inside a mentioned folder, recursively", async () => {
    await writeFile(path.join(workspacePath, "src", "a.ts"), "alpha");
    await mkdir(path.join(workspacePath, "src", "nested"), { recursive: true });
    await writeFile(path.join(workspacePath, "src", "nested", "b.ts"), "beta");

    const result = await resolveContextMentions({
      text: "explore @src",
      boundary: await boundary(),
    });

    expect(result.attachments.map(({ path: value }) => value)).toEqual([
      "src/a.ts",
      "src/nested/b.ts",
    ]);
    expect(result.augmentedText).toContain('<context path="src/nested/b.ts">');
    expect(result.skipped).toEqual([]);
  });

  it("never reads an ignored file inside a mentioned folder", async () => {
    await writeFile(path.join(workspacePath, ".gitignore"), "secret.txt\n");
    await writeFile(path.join(workspacePath, "src", "kept.ts"), "kept");
    await writeFile(path.join(workspacePath, "src", "secret.txt"), "SHOULD NOT APPEAR");

    const result = await resolveContextMentions({
      text: "explore @src",
      boundary: await boundary(),
    });

    expect(result.attachments.map(({ path: value }) => value)).toEqual(["src/kept.ts"]);
    expect(result.augmentedText).not.toContain("SHOULD NOT APPEAR");
  });

  it("skips binary files rather than pasting mojibake into the prompt", async () => {
    await writeFile(path.join(workspacePath, "src", "ok.ts"), "text");
    await writeFile(path.join(workspacePath, "src", "logo.png"), Buffer.from([0x89, 0x50, 0x4e]));
    await writeFile(path.join(workspacePath, "src", "blob.dat"), Buffer.from([0x61, 0x00, 0x62]));

    const result = await resolveContextMentions({
      text: "explore @src",
      boundary: await boundary(),
    });

    expect(result.attachments.map(({ path: value }) => value)).toEqual(["src/ok.ts"]);
    expect(result.skipped.map(({ path: value, reason }) => [value, reason])).toEqual([
      ["src/blob.dat", "binary"],
      ["src/logo.png", "binary"],
    ]);
  });

  it("reports how many files a folder could not fit in the budget", async () => {
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      await writeFile(path.join(workspacePath, "src", name), name);
    }

    const result = await resolveContextMentions({
      text: "explore @src",
      boundary: await boundary(),
      maxFiles: 2,
    });

    expect(result.attachments).toHaveLength(2);
    expect(result.skipped[0]).toMatchObject({
      path: "src",
      reason: "budget-exceeded",
      detail: "1 of 3 files not attached",
    });
  });

  it("reports an empty folder without failing the turn", async () => {
    await mkdir(path.join(workspacePath, "empty"), { recursive: true });

    const result = await resolveContextMentions({
      text: "explore @empty",
      boundary: await boundary(),
    });

    expect(result.attachments).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ path: "empty", reason: "folder-empty" });
  });

  it("deduplicates a file referenced more than once", async () => {
    await writeFile(path.join(workspacePath, "src", "a.ts"), "content");
    const result = await resolveContextMentions({
      text: "compare @src/a.ts with @src/a.ts",
      boundary: await boundary(),
    });
    expect(result.attachments).toHaveLength(1);
  });

  it("truncates files that exceed the per-file byte budget", async () => {
    await writeFile(path.join(workspacePath, "src", "big.ts"), "x".repeat(1_000));
    const result = await resolveContextMentions({
      text: "@src/big.ts",
      boundary: await boundary(),
      maxFileBytes: 100,
    });
    expect(result.attachments[0]).toMatchObject({ truncated: true, bytes: 100 });
    expect(result.attachments[0]?.content).toHaveLength(100);
    expect(result.augmentedText).toContain('truncated="true"');
  });

  it("stops attaching once the file count budget is reached", async () => {
    await writeFile(path.join(workspacePath, "src", "a.ts"), "a");
    await writeFile(path.join(workspacePath, "src", "b.ts"), "b");
    const result = await resolveContextMentions({
      text: "@src/a.ts @src/b.ts",
      boundary: await boundary(),
      maxFiles: 1,
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ path: "src/b.ts", reason: "budget-exceeded" });
  });

  it("throws when the abort signal is already aborted", async () => {
    await writeFile(path.join(workspacePath, "src", "a.ts"), "content");
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolveContextMentions({
        text: "@src/a.ts",
        boundary: await boundary(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CancellationError);
  });
});
