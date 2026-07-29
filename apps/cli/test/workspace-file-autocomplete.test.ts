import type { RipgrepRunRequest, RipgrepRunResult, RipgrepRunner } from "@pilotrun/tools-builtin";
import { describe, expect, it } from "vitest";
import { WorkspaceFileAutocompleteProvider } from "../src/tui/workspace-file-autocomplete.js";

class FakeRipgrepRunner implements RipgrepRunner {
  lastRequest: RipgrepRunRequest | undefined;
  constructor(private readonly files: readonly string[]) {}

  run(request: RipgrepRunRequest): Promise<RipgrepRunResult> {
    this.lastRequest = request;
    for (const file of this.files) {
      if (!request.onLine(file)) break;
    }
    return Promise.resolve({ exitCode: 0, stderr: "" });
  }
}

function suggest(text: string) {
  return { lines: [text], cursorLine: 0, cursorCol: text.length };
}

const signal = new AbortController().signal;

describe("WorkspaceFileAutocompleteProvider", () => {
  it("suggests workspace files ranked for an @ prefix", async () => {
    const runner = new FakeRipgrepRunner([
      "src/context-mention.ts",
      "src/read-file-tool.ts",
      "README.md",
    ]);
    const provider = new WorkspaceFileAutocompleteProvider({ basePath: "/repo", runner });

    const { lines, cursorLine, cursorCol } = suggest("explain @context");
    const result = await provider.getSuggestions(lines, cursorLine, cursorCol, { signal });

    expect(result?.prefix).toBe("@context");
    expect(result?.items[0]).toMatchObject({
      value: "@src/context-mention.ts",
      label: "context-mention.ts",
      description: "src/context-mention.ts",
    });
  });

  it("lists files through ripgrep with ignore-respecting arguments", async () => {
    const runner = new FakeRipgrepRunner(["a.ts"]);
    const provider = new WorkspaceFileAutocompleteProvider({ basePath: "/repo", runner });

    const { lines, cursorLine, cursorCol } = suggest("@a");
    await provider.getSuggestions(lines, cursorLine, cursorCol, { signal });

    expect(runner.lastRequest?.args).toContain("--files");
    expect(runner.lastRequest?.args).toContain("--ignore-file");
    expect(runner.lastRequest?.args).toContain(".pilotignore");
  });

  it("returns no suggestions when nothing matches the query", async () => {
    const runner = new FakeRipgrepRunner(["src/a.ts"]);
    const provider = new WorkspaceFileAutocompleteProvider({ basePath: "/repo", runner });

    const { lines, cursorLine, cursorCol } = suggest("@zzzz");
    const result = await provider.getSuggestions(lines, cursorLine, cursorCol, { signal });

    expect(result).toBeNull();
  });

  it("handles quoted @ prefixes and quotes completion values", async () => {
    const runner = new FakeRipgrepRunner(["src/my file.ts"]);
    const provider = new WorkspaceFileAutocompleteProvider({ basePath: "/repo", runner });

    const text = '@"src/my';
    const result = await provider.getSuggestions([text], 0, text.length, { signal });

    expect(result?.items[0]?.value).toBe('@"src/my file.ts"');
  });

  it("applies an @ completion by replacing the token and adding a trailing space", async () => {
    const runner = new FakeRipgrepRunner([]);
    const provider = new WorkspaceFileAutocompleteProvider({ basePath: "/repo", runner });

    const applied = provider.applyCompletion(
      ["explain @ctx"],
      0,
      12,
      { value: "@src/context-mention.ts", label: "context-mention.ts" },
      "@ctx",
    );

    expect(applied.lines[0]).toBe("explain @src/context-mention.ts ");
    expect(applied.cursorCol).toBe("explain @src/context-mention.ts ".length);
  });

  it("offers folders derived from the file listing", async () => {
    const runner = new FakeRipgrepRunner(["src/tui/theme.ts", "src/tui/screen.ts"]);
    const provider = new WorkspaceFileAutocompleteProvider({ basePath: "/repo", runner });

    const result = await provider.getSuggestions(["@tui"], 0, 4, { signal });

    // `rg --files` never emits directories, so they are synthesised from the listed paths.
    expect(result?.items).toContainEqual({
      value: "@src/tui/",
      label: "tui/",
      description: "src/tui/  (folder)",
    });
  });

  it("leaves a folder mention open so the user can keep descending", async () => {
    const runner = new FakeRipgrepRunner([]);
    const provider = new WorkspaceFileAutocompleteProvider({ basePath: "/repo", runner });

    const applied = provider.applyCompletion(
      ["explain @sr"],
      0,
      11,
      { value: "@src/tui/", label: "tui/" },
      "@sr",
    );

    expect(applied.lines[0]).toBe("explain @src/tui/");
    expect(applied.cursorCol).toBe("explain @src/tui/".length);
  });

  it("caches the file listing within the TTL window", async () => {
    let time = 0;
    let runCount = 0;
    const runner: RipgrepRunner = {
      run(request) {
        runCount += 1;
        request.onLine("a.ts");
        return Promise.resolve({ exitCode: 0, stderr: "" });
      },
    };
    const provider = new WorkspaceFileAutocompleteProvider({
      basePath: "/repo",
      runner,
      now: () => time,
    });

    await provider.getSuggestions(["@a"], 0, 2, { signal });
    await provider.getSuggestions(["@a"], 0, 2, { signal });
    expect(runCount).toBe(1);

    time = 5_000;
    await provider.getSuggestions(["@a"], 0, 2, { signal });
    expect(runCount).toBe(2);
  });
});
