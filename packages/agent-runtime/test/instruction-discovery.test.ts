import { describe, expect, it } from "vitest";
import {
  InstructionDiscovery,
  InstructionDiscoveryError,
  type InstructionFileReader,
  type InstructionReadResult,
} from "../src/index.js";

function reader(
  files: Readonly<Record<string, string | InstructionReadResult>>,
): InstructionFileReader {
  return {
    async read(request) {
      const value = files[`${request.kind}:${request.path}`];
      if (value === undefined) return { status: "missing" };
      if (typeof value !== "string") return value;
      const bytes = new TextEncoder().encode(value).byteLength;
      if (bytes > request.maximumBytes) {
        return { status: "rejected", reason: "too-large", detail: "fixture exceeds limit" };
      }
      return {
        status: "found",
        displayPath: request.path,
        realPath: `/real/${request.path}`,
        content: value,
        bytes,
      };
    },
  };
}

describe("InstructionDiscovery", () => {
  it("loads only global and target ancestors with trust, hashes, scopes, and precedence", async () => {
    const discovery = new InstructionDiscovery(
      reader({
        "global:/user/AGENTS.md": "Global instructions",
        "workspace:AGENTS.md": "Root project instructions",
        "workspace:src/AGENTS.md": "Source instructions",
        "workspace:src/feature/AGENTS.md": "Feature instructions",
        "workspace:unrelated/AGENTS.md": "Must not be read",
      }),
    );
    const result = await discovery.discover({
      globalPath: "/user/AGENTS.md",
      targets: [
        { path: "src/feature/main.ts", kind: "file" },
        { path: "src/shared", kind: "directory" },
      ],
      maximumFileBytes: 1_000,
      maximumTotalBytes: 4_000,
    });

    expect(result.documents.map(({ displayPath }) => displayPath)).toEqual([
      "/user/AGENTS.md",
      "AGENTS.md",
      "src/AGENTS.md",
      "src/feature/AGENTS.md",
    ]);
    expect(result.documents).toMatchObject([
      { trust: "trusted-user", scope: "global", precedence: 0 },
      { trust: "untrusted-project", scope: ".", precedence: 1_000 },
      {
        scope: "src",
        appliesTo: ["src/feature/main.ts", "src/shared"],
        sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
      { scope: "src/feature", appliesTo: ["src/feature/main.ts"] },
    ]);
    expect(result.precedenceNotices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "src/feature/main.ts",
          relationship: "project-over-global",
          semanticConflictRequiresReview: true,
        }),
        expect.objectContaining({
          target: "src/feature/main.ts",
          relationship: "more-specific-scope",
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("unrelated");
    expect(Object.isFrozen(result.documents)).toBe(true);
  });

  it("surfaces rejected files without treating their content as instructions", async () => {
    const discovery = new InstructionDiscovery(
      reader({
        "workspace:AGENTS.md": {
          status: "rejected",
          reason: "outside-workspace",
          detail: "symlink escaped",
        },
      }),
    );
    const result = await discovery.discover({
      targets: [{ path: ".", kind: "directory" }],
      maximumFileBytes: 100,
      maximumTotalBytes: 100,
    });

    expect(result.documents).toEqual([]);
    expect(result.diagnostics).toEqual([
      { path: "AGENTS.md", reason: "outside-workspace", detail: "symlink escaped" },
    ]);
  });

  it("fails closed on traversal, depth, and aggregate byte limits", async () => {
    const discovery = new InstructionDiscovery(
      reader({
        "workspace:AGENTS.md": "root",
        "workspace:src/AGENTS.md": "source",
      }),
    );
    await expect(
      discovery.discover({
        targets: [{ path: "../outside.ts", kind: "file" }],
        maximumFileBytes: 100,
        maximumTotalBytes: 100,
      }),
    ).rejects.toThrowError(InstructionDiscoveryError);
    await expect(
      discovery.discover({
        targets: [{ path: "a/b/c/file.ts", kind: "file" }],
        maximumFileBytes: 100,
        maximumTotalBytes: 100,
        maximumScopeDepth: 2,
      }),
    ).rejects.toThrowError(InstructionDiscoveryError);
    await expect(
      discovery.discover({
        targets: [{ path: "src/file.ts", kind: "file" }],
        maximumFileBytes: 100,
        maximumTotalBytes: 5,
      }),
    ).rejects.toMatchObject({ code: "PILOT_INSTRUCTIONS_LIMIT" });
  });

  it("rejects empty targets and inconsistent reader byte metadata", async () => {
    const discovery = new InstructionDiscovery(
      reader({
        "workspace:AGENTS.md": {
          status: "found",
          displayPath: "AGENTS.md",
          realPath: "/real/AGENTS.md",
          content: "instructions",
          bytes: 0,
        },
      }),
    );

    await expect(
      discovery.discover({
        targets: [],
        maximumFileBytes: 100,
        maximumTotalBytes: 100,
      }),
    ).rejects.toMatchObject({ code: "PILOT_INSTRUCTIONS_INVALID" });
    await expect(
      discovery.discover({
        targets: [{ path: "./", kind: "directory" }],
        maximumFileBytes: 100,
        maximumTotalBytes: 100,
      }),
    ).rejects.toMatchObject({
      code: "PILOT_INSTRUCTIONS_INVALID",
      metadata: { path: "AGENTS.md", reportedBytes: 0, actualBytes: 12 },
    });
  });

  it("deduplicates repeated targets and reads each applicable file once", async () => {
    let reads = 0;
    const discovery = new InstructionDiscovery({
      async read() {
        reads += 1;
        return { status: "missing" };
      },
    });
    await discovery.discover({
      targets: [
        { path: "src/file.ts", kind: "file" },
        { path: "src/file.ts", kind: "file" },
      ],
      maximumFileBytes: 100,
      maximumTotalBytes: 100,
    });
    expect(reads).toBe(2);
  });
});
