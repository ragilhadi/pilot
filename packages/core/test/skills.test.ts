import { describe, expect, it } from "vitest";
import {
  expandPromptTemplate,
  parseFrontmatterDocument,
  parsePromptTemplate,
  parseSkillDocument,
  SkillError,
} from "../src/index.js";

const skill = [
  "---",
  "name: review-diff",
  "description: Review a working diff before it is committed",
  "requiresTools: [grep, read_file]",
  "deniesTools: run_command",
  "confirmsRisks:",
  "  - workspace-write",
  "argumentHint: <optional path>",
  "---",
  "",
  "Read the diff, then report findings most severe first.",
].join("\n");

describe("frontmatter parsing", () => {
  it("reads the supported scalar, inline, and block forms", () => {
    const document = parseFrontmatterDocument(
      [
        "---",
        "# a full-line comment",
        "name: review-diff",
        'description: "Review: a diff"',
        "enabled: true",
        "maxFiles: 20",
        "requiresTools: [grep, read_file]",
        "keywords:",
        "  - review",
        "  - diff",
        "---",
        "",
        "Body text.",
        "",
      ].join("\n"),
      "skill.md",
    );

    expect(document.fields).toEqual({
      name: "review-diff",
      description: "Review: a diff",
      enabled: true,
      maxFiles: 20,
      requiresTools: ["grep", "read_file"],
      keywords: ["review", "diff"],
    });
    expect(document.body).toBe("Body text.");
  });

  it("accepts CRLF line endings and a byte-order mark", () => {
    const document = parseFrontmatterDocument(
      "﻿---\r\nname: review-diff\r\n---\r\n\r\nBody.\r\n",
      "skill.md",
    );

    expect(document.fields).toEqual({ name: "review-diff" });
    expect(document.body).toBe("Body.");
  });

  it("rejects everything outside the supported subset by line number", () => {
    const rejections: readonly [string, string][] = [
      ["no delimiter\n", "line 1"],
      ["---\nname: a\n", "line 3"],
      ["---\nname: a\nname: b\n---\n", "line 3"],
      ["---\nnested:\n  key: value\n---\n", "line 3"],
      ["---\n\tname: a\n---\n", "line 2"],
      ["---\nname: 'unclosed\n---\n", "line 2"],
      ["---\nname: [a, b\n---\n", "line 2"],
      ["---\n  - orphan\n---\n", "line 2"],
      ["---\nnot a mapping\n---\n", "line 2"],
    ];

    for (const [text, expected] of rejections) {
      const error = (() => {
        try {
          parseFrontmatterDocument(text, "skill.md");
          return undefined;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error, `expected ${JSON.stringify(text)} to be rejected`).toBeInstanceOf(SkillError);
      expect((error as SkillError).message).toContain(expected);
      expect((error as SkillError).code).toBe("PILOT_SKILL_DOCUMENT_INVALID");
    }
  });
});

describe("skill documents", () => {
  it("parses a manifest with its requirements and restrictions", () => {
    const document = parseSkillDocument(skill, ".pilot/skills/review-diff/SKILL.md");

    expect(document.manifest).toEqual({
      name: "review-diff",
      description: "Review a working diff before it is committed",
      requiresTools: ["grep", "read_file"],
      deniesTools: ["run_command"],
      confirmsRisks: ["workspace-write"],
      argumentHint: "<optional path>",
    });
    expect(document.body).toBe("Read the diff, then report findings most severe first.");
  });

  it("names the offending frontmatter key when the manifest is invalid", () => {
    expect(() =>
      parseSkillDocument(
        ["---", "name: Review-Diff", "description: x", "---", "body"].join("\n"),
        "skill.md",
      ),
    ).toThrow(/name: Skill names must use lowercase kebab-case/u);
    expect(() =>
      parseSkillDocument(
        ["---", "name: review", "description: x", "unknownKey: y", "---", "body"].join("\n"),
        "skill.md",
      ),
    ).toThrow(SkillError);
  });

  it("refuses a skill with no instructions", () => {
    expect(() =>
      parseSkillDocument(["---", "name: review", "description: x", "---", ""].join("\n"), "s.md"),
    ).toThrow(/no instructions/u);
  });
});

describe("prompt templates", () => {
  const template = parsePromptTemplate(
    [
      "---",
      "name: fix-test",
      "description: Investigate a failing test",
      "parameters: [testPath, note]",
      "---",
      "Run {{testPath}}, then fix it. Context: {{note}}",
    ].join("\n"),
    ".pilot/prompts/fix-test.md",
  );

  it("validates placeholders against the declared parameters at parse time", () => {
    expect(template.placeholders).toEqual(["note", "testPath"]);
    expect(() =>
      parsePromptTemplate(
        ["---", "name: t", "description: d", "---", "Use {{unknown}}"].join("\n"),
        "t.md",
      ),
    ).toThrow(/not a declared parameter/u);
    expect(() =>
      parsePromptTemplate(
        ["---", "name: t", "description: d", "parameters: [unused]", "---", "No use"].join("\n"),
        "t.md",
      ),
    ).toThrow(/declared but never referenced/u);
  });

  it("binds parameters positionally, with the last one absorbing the rest of the line", async () => {
    const expansion = await expandPromptTemplate(template, "  test/foo.test.ts it fails on CI  ");

    expect(expansion.text).toBe("Run test/foo.test.ts, then fix it. Context: it fails on CI");
    expect(expansion.parameters).toEqual({ testPath: "test/foo.test.ts", note: "it fails on CI" });
  });

  it("keeps quoted tokens together and reports missing arguments", async () => {
    const quoted = await expandPromptTemplate(template, '"a b.test.ts" note here');
    expect(quoted.parameters.testPath).toBe("a b.test.ts");

    await expect(expandPromptTemplate(template, "only-one")).rejects.toThrow(/requires note/u);
  });

  it("fingerprints identical expansions identically and different ones differently", async () => {
    const first = await expandPromptTemplate(template, "a.test.ts note");
    const second = await expandPromptTemplate(template, "a.test.ts note");
    const third = await expandPromptTemplate(template, "b.test.ts note");

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).not.toBe(third.fingerprint);
    expect(first.templateSha256).toBe(third.templateSha256);
    expect(first.fingerprint.startsWith("sha256:")).toBe(true);
  });

  it("substitutes in one pass, so argument text is never re-scanned as a placeholder", async () => {
    const whole = parsePromptTemplate(
      ["---", "name: echo", "description: d", "---", "Task: {{arguments}}"].join("\n"),
      "echo.md",
    );

    const expansion = await expandPromptTemplate(whole, "{{arguments}} and {{testPath}}");

    expect(expansion.text).toBe("Task: {{arguments}} and {{testPath}}");
  });

  it("refuses arguments for a template that declares none", async () => {
    const fixed = parsePromptTemplate(
      ["---", "name: fixed", "description: d", "---", "Always the same request."].join("\n"),
      "fixed.md",
    );

    expect((await expandPromptTemplate(fixed, "")).text).toBe("Always the same request.");
    await expect(expandPromptTemplate(fixed, "extra")).rejects.toThrow(/takes no arguments/u);
  });
});
