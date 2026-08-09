import {
  type DocumentDirectoryReader,
  type DocumentDirectoryRequest,
  type DocumentListResult,
  type DocumentReadRequest,
  type DocumentReadResult,
  ModelRegistry,
  PromptTemplateDiscovery,
  SkillDiscovery,
  ToolRegistry,
} from "@pilotrun/agent-runtime";
import { defineTool, resolveConfiguration } from "@pilotrun/core";
import { FakeLanguageModel, textResponseScript, toolCallScript } from "@pilotrun/testkit";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { type LineReader, runCli, type TextWriter } from "../src/index.js";

const skillFiles: Readonly<Record<string, string>> = {
  ".pilot/skills/review-diff/SKILL.md": [
    "---",
    "name: review-diff",
    "description: Review a working diff before committing",
    "requiresTools: [probe_tool]",
    "deniesTools: probe_tool",
    "---",
    "",
    "Read the diff first, then report findings most severe first.",
  ].join("\n"),
  ".pilot/skills/needs-missing.md": [
    "---",
    "name: needs-missing",
    "description: Depends on a tool this session does not register",
    "requiresTools: [absent_tool]",
    "---",
    "",
    "Never usable here.",
  ].join("\n"),
  ".pilot/skills/broken.md": "this file has no frontmatter",
  ".pilot/prompts/fix-test.md": [
    "---",
    "name: fix-test",
    "description: Investigate a failing test",
    "parameters: [testPath]",
    "argumentHint: <test path>",
    "---",
    "Run {{testPath}} and fix whatever it reports.",
  ].join("\n"),
};

/** Serves the fixture files above through the same port the Node reader implements. */
class FixtureDocumentReader implements DocumentDirectoryReader {
  async list(request: DocumentDirectoryRequest): Promise<DocumentListResult> {
    const prefix = `${request.path}/`;
    const children = new Map<string, "file" | "directory">();
    for (const path of Object.keys(skillFiles)) {
      if (!path.startsWith(prefix)) continue;
      const remainder = path.slice(prefix.length);
      const separator = remainder.indexOf("/");
      if (separator < 0) children.set(remainder, "file");
      else children.set(remainder.slice(0, separator), "directory");
    }
    return children.size === 0
      ? { status: "missing" }
      : { status: "listed", entries: [...children].map(([name, kind]) => ({ name, kind })) };
  }

  async read(request: DocumentReadRequest): Promise<DocumentReadResult> {
    const content = skillFiles[request.path];
    if (content === undefined) return { status: "missing" };
    return {
      status: "found",
      displayPath: request.path,
      realPath: `/repo/${request.path}`,
      content,
      bytes: new TextEncoder().encode(content).byteLength,
    };
  }
}

const probeTool = defineTool({
  name: "probe_tool",
  description: "Probe a value without changing anything",
  inputSchema: z.object({ value: z.string() }).strict(),
  outputSchema: z.object({ probed: z.string() }).strict(),
  metadata: {
    risk: "read-only",
    concurrency: "parallel-safe",
    timeoutMs: 1_000,
    maxOutputBytes: 1_000,
    requiredPermissions: [],
  },
  execute: async ({ value }) => ({ output: { probed: value } }),
});

function memoryWriter(): TextWriter & { readonly text: () => string } {
  let content = "";
  return {
    write(text) {
      content += text;
    },
    text: () => content,
  };
}

function timedLines(
  entries: readonly { readonly line?: string; readonly delayMs?: number }[],
): LineReader {
  let index = 0;
  return {
    async readLine() {
      const entry = entries[index];
      index += 1;
      if ((entry?.delayMs ?? 0) > 0) {
        await new Promise((resolve) => setTimeout(resolve, entry?.delayMs));
      }
      return entry?.line;
    },
  };
}

function skillDependencies(registry: ModelRegistry, options: { readonly stdin?: LineReader } = {}) {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const reader = new FixtureDocumentReader();
  const identifiers = ["session-1", "run-1", "message-1"];
  let fallback = 0;
  return {
    stdout,
    stderr,
    dependencies: {
      registry,
      configuration: resolveConfiguration([]),
      clock: { now: () => new Date("2026-08-09T10:00:00.000Z") },
      ids: {
        next: () => {
          const configured = identifiers.shift();
          if (configured !== undefined) return configured;
          fallback += 1;
          return `generated-${fallback}`;
        },
      },
      stdout,
      stderr,
      signal: new AbortController().signal,
      monotonicNow: () => 0,
      skillDiscovery: new SkillDiscovery(reader),
      promptTemplateDiscovery: new PromptTemplateDiscovery(reader),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    },
  };
}

function emptyRegistry(): ModelRegistry {
  return new ModelRegistry([
    {
      model: new FakeLanguageModel({ providerId: "fake", modelId: "unused", scripts: [] }),
      displayName: "Unused",
    },
  ]);
}

describe("pilot skills", () => {
  it("lists discovered skills with trust, requirements, and restrictions", async () => {
    const { dependencies, stdout, stderr } = skillDependencies(emptyRegistry());

    expect(await runCli(["skills"], dependencies)).toBe(0);

    const lines = stdout.text().trimEnd().split("\n");
    expect(lines[0]).toBe("NAME\tTRUST\tLOCATION\tREQUIRES\tRESTRICTS\tDESCRIPTION");
    expect(lines[1]).toBe(
      "needs-missing\tuntrusted-project\t.pilot/skills/needs-missing.md\tabsent_tool\t-\tDepends on a tool this session does not register",
    );
    expect(lines[2]).toBe(
      "review-diff\tuntrusted-project\t.pilot/skills/review-diff/SKILL.md\tprobe_tool\tdeny:probe_tool\tReview a working diff before committing",
    );
    expect(stderr.text()).toContain("[skill rejected: .pilot/skills/broken.md: invalid-manifest");
  });

  it("emits the catalogue with provenance digests as JSON", async () => {
    const { dependencies, stdout } = skillDependencies(emptyRegistry());

    expect(await runCli(["skills", "--json"], dependencies)).toBe(0);

    const payload = JSON.parse(stdout.text()) as {
      readonly enabled: boolean;
      readonly skills: readonly {
        readonly name: string;
        readonly sha256: string;
        readonly trust: string;
      }[];
      readonly diagnostics: readonly unknown[];
    };
    expect(payload.enabled).toBe(true);
    expect(payload.skills.map(({ name }) => name)).toEqual(["needs-missing", "review-diff"]);
    expect(payload.skills[1]?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(payload.diagnostics).toHaveLength(1);
  });

  it("shows one skill's instructions and reports an unknown name", async () => {
    const shown = skillDependencies(emptyRegistry());
    expect(await runCli(["skills", "show", "review-diff"], shown.dependencies)).toBe(0);
    expect(shown.stdout.text()).toContain(
      "--- review-diff [untrusted-project; .pilot/skills/review-diff/SKILL.md; sha256:",
    );
    expect(shown.stdout.text()).toContain("denies tools: probe_tool");
    expect(shown.stdout.text()).toContain("a skill can never grant one");
    expect(shown.stdout.text()).toContain("Read the diff first");

    const missing = skillDependencies(emptyRegistry());
    expect(await runCli(["skills", "show", "absent"], missing.dependencies)).toBe(1);
    expect(missing.stderr.text()).toContain("Unknown skill absent");
  });

  it("lists prompt templates with their argument hints", async () => {
    const { dependencies, stdout } = skillDependencies(emptyRegistry());

    expect(await runCli(["prompts"], dependencies)).toBe(0);

    expect(stdout.text()).toContain(
      "fix-test\tuntrusted-project\t.pilot/prompts/fix-test.md\t<test path>\tInvestigate a failing test",
    );
  });

  it("reports nothing but the disabled notice when skills are switched off", async () => {
    const { dependencies, stdout } = skillDependencies(emptyRegistry());

    expect(
      await runCli(["skills"], {
        ...dependencies,
        configuration: resolveConfiguration([
          { source: "project", location: "config.jsonc", value: { skills: { enabled: false } } },
        ]),
      }),
    ).toBe(0);
    expect(stdout.text()).toBe("[skills and prompt templates are disabled by configuration]\n");
  });
});

describe("chat skill activation", () => {
  it("activates a skill on request and puts its instructions in the model prompt", async () => {
    const model = new FakeLanguageModel({
      providerId: "fake",
      modelId: "skill-chat",
      scripts: [textResponseScript({ responseId: "response-1", deltas: ["Reviewed"] })],
    });
    const { dependencies, stdout } = skillDependencies(
      new ModelRegistry([{ model, displayName: "Skill Chat Fake" }]),
      {
        stdin: timedLines([
          { line: "/skills" },
          { line: "/skill review-diff", delayMs: 20 },
          { line: "Review my diff", delayMs: 20 },
          { line: "/context", delayMs: 300 },
          {},
        ]),
      },
    );

    expect(
      await runCli(["chat", "--model", "fake/skill-chat"], {
        ...dependencies,
        tools: new ToolRegistry([probeTool]),
      }),
    ).toBe(0);

    // Listing is read-only: the catalogue is shown, nothing is activated by it.
    expect(stdout.text()).toContain("review-diff\tuntrusted-project");
    expect(stdout.text()).toContain(
      "[skill activated: review-diff (untrusted-project; .pilot/skills/review-diff/SKILL.md; sha256:",
    );
    expect(stdout.text()).toContain("deny: The active skill review-diff forbids probe_tool");

    const texts = (model.calls[0]?.request.messages ?? []).flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    );
    expect(texts.some((text) => text.includes("report findings most severe first"))).toBe(true);
    // Skill instructions are project-supplied content, so they are framed as untrusted data.
    expect(
      texts.some((text) => text.includes('"kind":"skill"') && text.includes('"trust":"untrusted"')),
    ).toBe(true);
    expect(stdout.text()).toContain("source=skills");
  });

  it("refuses activation when a required tool is not registered", async () => {
    const model = new FakeLanguageModel({
      providerId: "fake",
      modelId: "skill-missing",
      scripts: [],
    });
    const { dependencies, stderr } = skillDependencies(
      new ModelRegistry([{ model, displayName: "Skill Missing Fake" }]),
      { stdin: timedLines([{ line: "/skill needs-missing" }, { line: "/exit", delayMs: 20 }]) },
    );

    expect(
      await runCli(["chat", "--model", "fake/skill-missing"], {
        ...dependencies,
        tools: new ToolRegistry([probeTool]),
      }),
    ).toBe(0);

    expect(stderr.text()).toContain(
      "[skill not activated: needs-missing: Skill needs-missing requires unavailable tools: absent_tool]",
    );
  });

  it("denies a tool the active skill forbids, even though it is otherwise allowed", async () => {
    const scripts = [
      toolCallScript({
        responseId: "response-probe",
        callId: "call-1",
        toolName: "probe_tool",
        argumentDeltas: ['{"value":"x"}'],
        completedInput: { value: "x" },
      }),
      textResponseScript({ responseId: "response-final", deltas: ["Stopped"] }),
    ];
    const allowed = new FakeLanguageModel({
      providerId: "fake",
      modelId: "probe-allowed",
      scripts,
    });
    const withoutSkill = skillDependencies(
      new ModelRegistry([{ model: allowed, displayName: "Probe Allowed" }]),
      { stdin: timedLines([{ line: "Probe it" }, { line: "/exit", delayMs: 300 }]) },
    );
    expect(
      await runCli(["chat", "--model", "fake/probe-allowed"], {
        ...withoutSkill.dependencies,
        tools: new ToolRegistry([probeTool]),
      }),
    ).toBe(0);
    expect(withoutSkill.stdout.text()).toContain("[tool: probe_tool]");
    expect(withoutSkill.stderr.text()).not.toContain("denied");

    const denied = new FakeLanguageModel({
      providerId: "fake",
      modelId: "probe-denied",
      scripts,
    });
    const withSkill = skillDependencies(
      new ModelRegistry([{ model: denied, displayName: "Probe Denied" }]),
      {
        stdin: timedLines([
          { line: "/skill review-diff" },
          { line: "Probe it", delayMs: 20 },
          { line: "/exit", delayMs: 300 },
        ]),
      },
    );

    expect(
      await runCli(["chat", "--model", "fake/probe-denied"], {
        ...withSkill.dependencies,
        tools: new ToolRegistry([probeTool]),
      }),
    ).toBe(0);

    const results = (denied.calls[1]?.request.messages ?? []).flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "tool-result" ? [part] : [])),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);
    expect(JSON.stringify(results[0]?.output)).toContain("forbids probe_tool");
  });

  it("expands a prompt template into the turn with a deterministic fingerprint", async () => {
    const model = new FakeLanguageModel({
      providerId: "fake",
      modelId: "prompt-chat",
      scripts: [textResponseScript({ responseId: "response-1", deltas: ["Fixed"] })],
    });
    const { dependencies, stdout, stderr } = skillDependencies(
      new ModelRegistry([{ model, displayName: "Prompt Chat Fake" }]),
      {
        stdin: timedLines([
          { line: "/prompts" },
          { line: "/prompt unknown-template", delayMs: 20 },
          { line: "/prompt fix-test test/foo.test.ts", delayMs: 20 },
          { line: "/exit", delayMs: 300 },
        ]),
      },
    );

    expect(await runCli(["chat", "--model", "fake/prompt-chat"], dependencies)).toBe(0);

    expect(stdout.text()).toContain("/prompt fix-test <test path>");
    expect(stderr.text()).toContain("Unknown prompt template unknown-template");
    expect(stdout.text()).toMatch(
      /\[prompt fix-test expanded: \d+ characters; sha256:[0-9a-f]{64}\]/u,
    );
    const userTexts = (model.calls[0]?.request.messages ?? [])
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      );
    expect(userTexts).toEqual(["Run test/foo.test.ts and fix whatever it reports."]);
  });

  it("reports a template's missing argument without starting a turn", async () => {
    const model = new FakeLanguageModel({
      providerId: "fake",
      modelId: "prompt-invalid",
      scripts: [],
    });
    const { dependencies, stderr } = skillDependencies(
      new ModelRegistry([{ model, displayName: "Prompt Invalid Fake" }]),
      { stdin: timedLines([{ line: "/prompt fix-test" }, { line: "/exit", delayMs: 20 }]) },
    );

    expect(await runCli(["chat", "--model", "fake/prompt-invalid"], dependencies)).toBe(0);

    expect(stderr.text()).toContain("Prompt template fix-test requires testPath");
    expect(model.calls).toHaveLength(0);
  });
});
