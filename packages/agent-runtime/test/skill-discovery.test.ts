import { describe, expect, it } from "vitest";
import {
  type DocumentDirectoryReader,
  type DocumentDirectoryRequest,
  type DocumentListResult,
  type DocumentReadRequest,
  type DocumentReadResult,
  PromptTemplateDiscovery,
  SkillDiscovery,
  SkillDiscoveryError,
} from "../src/index.js";

/** An in-memory workspace: keys are the paths the discovery asks for, values the file contents. */
class FakeDocumentReader implements DocumentDirectoryReader {
  readonly reads: string[] = [];

  constructor(private readonly files: Readonly<Record<string, string>>) {}

  async list(request: DocumentDirectoryRequest): Promise<DocumentListResult> {
    const prefix = `${request.path}/`;
    const children = new Map<string, "file" | "directory">();
    for (const path of Object.keys(this.files)) {
      if (!path.startsWith(prefix)) continue;
      const remainder = path.slice(prefix.length);
      const separator = remainder.indexOf("/");
      if (separator < 0) children.set(remainder, "file");
      else children.set(remainder.slice(0, separator), "directory");
    }
    if (children.size === 0) return { status: "missing" };
    return {
      status: "listed",
      entries: [...children].map(([name, kind]) => ({ name, kind })),
    };
  }

  async read(request: DocumentReadRequest): Promise<DocumentReadResult> {
    this.reads.push(request.path);
    const content = this.files[request.path];
    if (content === undefined) return { status: "missing" };
    const bytes = new TextEncoder().encode(content).byteLength;
    if (bytes > request.maximumBytes) {
      return { status: "rejected", reason: "too-large", detail: "over the per-file limit" };
    }
    return {
      status: "found",
      displayPath: request.path,
      realPath: `/real/${request.path}`,
      content,
      bytes,
    };
  }
}

function skillFile(name: string, extra: readonly string[] = []): string {
  return [
    "---",
    `name: ${name}`,
    `description: The ${name} skill`,
    ...extra,
    "---",
    "Do the thing.",
  ].join("\n");
}

const limits = { maximumFileBytes: 4_096, maximumTotalBytes: 65_536, maximumDocuments: 10 };

describe("SkillDiscovery", () => {
  it("reads both single-file and directory skills with provenance and a content digest", async () => {
    const reader = new FakeDocumentReader({
      ".pilot/skills/review-diff/SKILL.md": skillFile("review-diff", [
        "requiresTools: [grep]",
        "deniesTools: run_command",
      ]),
      ".pilot/skills/write-notes.md": skillFile("write-notes"),
    });

    const catalog = await new SkillDiscovery(reader).discover({
      workspaceDirectory: ".pilot/skills",
      ...limits,
    });

    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.skills.map(({ name }) => name)).toEqual(["review-diff", "write-notes"]);
    const [reviewDiff] = catalog.skills;
    expect(reviewDiff).toMatchObject({
      name: "review-diff",
      origin: "workspace",
      trust: "untrusted-project",
      displayPath: ".pilot/skills/review-diff/SKILL.md",
      realPath: "/real/.pilot/skills/review-diff/SKILL.md",
    });
    expect(reviewDiff?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(reviewDiff?.manifest.requiresTools).toEqual(["grep"]);
    expect(reviewDiff?.body).toBe("Do the thing.");
    expect(catalog.totalBytes).toBeGreaterThan(0);
  });

  it("marks a user's global skill as trusted and never lets a project skill take its name", async () => {
    const reader = new FakeDocumentReader({
      "/home/.pilot/skills/deploy.md": skillFile("deploy"),
      ".pilot/skills/deploy.md": skillFile("deploy"),
    });

    const catalog = await new SkillDiscovery(reader).discover({
      globalDirectory: "/home/.pilot/skills",
      workspaceDirectory: ".pilot/skills",
      ...limits,
    });

    expect(catalog.skills).toHaveLength(1);
    expect(catalog.skills[0]).toMatchObject({ trust: "trusted-user", origin: "global" });
    expect(catalog.diagnostics).toEqual([
      {
        path: ".pilot/skills/deploy.md",
        reason: "shadowed",
        detail: "skill deploy is already defined by a higher-trust directory",
      },
    ]);
  });

  it("reports a malformed skill as a diagnostic and keeps reading the rest", async () => {
    const reader = new FakeDocumentReader({
      ".pilot/skills/broken.md": "no frontmatter here",
      ".pilot/skills/misnamed.md": skillFile("other-name"),
      ".pilot/skills/notes.txt": "ignored",
      ".pilot/skills/Bad_Name.md": skillFile("bad-name"),
      ".pilot/skills/works.md": skillFile("works"),
    });

    const catalog = await new SkillDiscovery(reader).discover({
      workspaceDirectory: ".pilot/skills",
      ...limits,
    });

    expect(catalog.skills.map(({ name }) => name)).toEqual(["works"]);
    expect(catalog.diagnostics.map(({ path, reason }) => `${path}:${reason}`).sort()).toEqual([
      ".pilot/skills/Bad_Name.md:invalid-name",
      ".pilot/skills/broken.md:invalid-manifest",
      ".pilot/skills/misnamed.md:name-mismatch",
      ".pilot/skills/notes.txt:unsupported-entry",
    ]);
  });

  it("stops at the document and byte ceilings instead of loading an unbounded catalogue", async () => {
    const reader = new FakeDocumentReader({
      ".pilot/skills/a.md": skillFile("a"),
      ".pilot/skills/b.md": skillFile("b"),
      ".pilot/skills/c.md": skillFile("c"),
    });

    const capped = await new SkillDiscovery(reader).discover({
      workspaceDirectory: ".pilot/skills",
      ...limits,
      maximumDocuments: 2,
    });
    expect(capped.skills.map(({ name }) => name)).toEqual(["a", "b"]);
    expect(capped.diagnostics).toEqual([
      {
        path: ".pilot/skills/c.md",
        reason: "limit-exceeded",
        detail: "more than 2 skills were found",
      },
    ]);

    const byteCapped = await new SkillDiscovery(reader).discover({
      workspaceDirectory: ".pilot/skills",
      maximumFileBytes: 60,
      maximumTotalBytes: 100,
      maximumDocuments: 10,
    });
    expect(byteCapped.skills).toHaveLength(1);
    expect(byteCapped.diagnostics[0]?.reason).toBe("limit-exceeded");
  });

  it("surfaces a rejected directory without reading anything from it", async () => {
    const reader: DocumentDirectoryReader = {
      list: async () => ({
        status: "rejected",
        reason: "outside-workspace",
        detail: "the symlink resolves outside the workspace",
      }),
      read: async () => {
        throw new Error("read must not be attempted");
      },
    };

    const catalog = await new SkillDiscovery(reader).discover({
      workspaceDirectory: ".pilot/skills",
      ...limits,
    });

    expect(catalog.skills).toEqual([]);
    expect(catalog.diagnostics[0]?.reason).toBe("outside-workspace");
  });

  it("rejects nonsensical limits rather than silently reinterpreting them", async () => {
    const discovery = new SkillDiscovery(new FakeDocumentReader({}));

    await expect(discovery.discover({ ...limits, maximumDocuments: 0 })).rejects.toBeInstanceOf(
      SkillDiscoveryError,
    );
    await expect(
      discovery.discover({ ...limits, maximumFileBytes: 100, maximumTotalBytes: 50 }),
    ).rejects.toBeInstanceOf(SkillDiscoveryError);
  });
});

describe("PromptTemplateDiscovery", () => {
  it("reads single-file templates and rejects a directory", async () => {
    const reader = new FakeDocumentReader({
      ".pilot/prompts/fix-test.md": [
        "---",
        "name: fix-test",
        "description: Fix a failing test",
        "parameters: [testPath]",
        "---",
        "Fix {{testPath}}.",
      ].join("\n"),
      ".pilot/prompts/nested/inner.md": "---\nname: inner\ndescription: d\n---\nbody",
    });

    const catalog = await new PromptTemplateDiscovery(reader).discover({
      workspaceDirectory: ".pilot/prompts",
      ...limits,
    });

    expect(catalog.templates.map(({ name }) => name)).toEqual(["fix-test"]);
    expect(catalog.templates[0]?.template.placeholders).toEqual(["testPath"]);
    expect(catalog.diagnostics).toEqual([
      {
        path: ".pilot/prompts/nested",
        reason: "unsupported-entry",
        detail: "prompt templates must be single .md files",
      },
    ]);
  });
});
