import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyUnifiedPatchToContent, parseUnifiedPatch, UnifiedPatchError } from "../src/index.js";

describe("parseUnifiedPatch", () => {
  it("parses bounded single-file hunks and produces a normalized preview", () => {
    const parsed = parseUnifiedPatch(
      "--- a/src/main.ts\r\n" +
        "+++ b/src/main.ts\r\n" +
        "@@ -1,3 +1,4 @@ function example\r\n" +
        " alpha\r\n" +
        "-beta\r\n" +
        "+bravo\r\n" +
        "+between\r\n" +
        " gamma\r\n",
    );

    expect(parsed).toMatchObject({
      path: "src/main.ts",
      oldPath: "src/main.ts",
      newPath: "src/main.ts",
      additions: 2,
      deletions: 1,
      hunks: [
        {
          oldStart: 1,
          oldCount: 3,
          newStart: 1,
          newCount: 4,
          section: "function example",
        },
      ],
    });
    expect(parsed.diff).not.toContain("\r");
    expect(parsed.diff.endsWith("\n")).toBe(true);
  });

  it.each([
    ["missing headers", "@@ -1 +1 @@\n-a\n+b\n", "PILOT_PATCH_INVALID"],
    [
      "count mismatch",
      "--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,1 @@\n-old\n+new\n",
      "PILOT_PATCH_INVALID",
    ],
    [
      "path traversal",
      "--- a/../secret.txt\n+++ b/../secret.txt\n@@ -1 +1 @@\n-old\n+new\n",
      "PILOT_PATCH_INVALID",
    ],
    [
      "rename",
      "--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-old\n+new\n",
      "PILOT_PATCH_UNSUPPORTED",
    ],
    ["creation", "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n", "PILOT_PATCH_UNSUPPORTED"],
    [
      "multiple files",
      "--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-a\n+b\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-c\n+d\n",
      "PILOT_PATCH_UNSUPPORTED",
    ],
    [
      "orphan no-newline marker",
      "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n\\ No newline at end of file\n",
      "PILOT_PATCH_INVALID",
    ],
    [
      "non-terminal no-newline marker",
      "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1,2 @@\n-old\n+new\n\\ No newline at end of file\n+later\n",
      "PILOT_PATCH_INVALID",
    ],
  ])("rejects %s", (_name, patch, code) => {
    expect(() => parseUnifiedPatch(patch)).toThrowError(expect.objectContaining({ code }));
  });
});

describe("applyUnifiedPatchToContent", () => {
  it("applies multiple exact hunks and returns hash-bound preview metadata", () => {
    const original = "one\ntwo\nthree\nfour\nfive\n";
    const patch =
      "--- a/file.txt\n" +
      "+++ b/file.txt\n" +
      "@@ -1,2 +1,2 @@\n" +
      " one\n" +
      "-two\n" +
      "+second\n" +
      "@@ -4,2 +4,3 @@\n" +
      " four\n" +
      "+four-and-half\n" +
      " five\n";

    const result = applyUnifiedPatchToContent({
      patch,
      originalContent: original,
      baseSha256: sha256(original),
    });

    expect(result.content).toBe("one\nsecond\nthree\nfour\nfour-and-half\nfive\n");
    expect(result).toMatchObject({
      originalSha256: sha256(original),
      resultingSha256: sha256(result.content),
      originalLineEnding: "lf",
      resultingLineEnding: "lf",
      lineEndingsPreserved: true,
      preview: { path: "file.txt", hunks: 2, additions: 2, deletions: 1 },
    });
  });

  it("preserves CRLF and a UTF-8 BOM while inserting lines", () => {
    const original = "\uFEFFalpha\r\nbeta\r\n";
    const result = applyUnifiedPatchToContent({
      patch: "--- a/windows.txt\n+++ b/windows.txt\n@@ -1,2 +1,3 @@\n alpha\n+between\n beta\n",
      originalContent: original,
      baseSha256: sha256(original),
    });

    expect(result.content).toBe("\uFEFFalpha\r\nbetween\r\nbeta\r\n");
    expect(result).toMatchObject({
      originalLineEnding: "crlf",
      resultingLineEnding: "crlf",
      lineEndingsPreserved: true,
    });
  });

  it("honors no-newline markers on replacement lines", () => {
    const original = "one\ntwo";
    const result = applyUnifiedPatchToContent({
      patch:
        "--- a/file.txt\n" +
        "+++ b/file.txt\n" +
        "@@ -1,2 +1,2 @@\n" +
        " one\n" +
        "-two\n" +
        "\\ No newline at end of file\n" +
        "+second\n" +
        "\\ No newline at end of file\n",
      originalContent: original,
      baseSha256: sha256(original),
    });

    expect(result.content).toBe("one\nsecond");
  });

  it("rejects stale base hashes before considering patch context", () => {
    const original = "current\n";
    expect(() =>
      applyUnifiedPatchToContent({
        patch: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n",
        originalContent: original,
        baseSha256: sha256("old\n"),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "PILOT_PATCH_BASE_MISMATCH",
        metadata: {
          expectedSha256: sha256("old\n"),
          actualSha256: sha256(original),
        },
      }),
    );
  });

  it("reports exact hunk coordinates without exposing file contents on conflict", () => {
    const original = "safe\ncurrent\n";
    let caught: unknown;
    try {
      applyUnifiedPatchToContent({
        patch: "--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n safe\n-stale\n+new\n",
        originalContent: original,
        baseSha256: sha256(original),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnifiedPatchError);
    expect(caught).toMatchObject({
      code: "PILOT_PATCH_HUNK_CONFLICT",
      metadata: { hunk: 1, hunkLine: 2, originalLine: 2 },
    });
    expect(JSON.stringify((caught as UnifiedPatchError).metadata)).not.toContain("current");
  });

  it("validates every generated single-line replacement deterministically", () => {
    for (let index = 1; index <= 50; index += 1) {
      const original = `line-${index}\n`;
      const replacement = `changed-${index}`;
      const result = applyUnifiedPatchToContent({
        patch: `--- a/generated.txt\n+++ b/generated.txt\n@@ -1 +1 @@\n-line-${index}\n+${replacement}\n`,
        originalContent: original,
        baseSha256: sha256(original),
      });
      expect(result.content).toBe(`${replacement}\n`);
    }
  });
});

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}
