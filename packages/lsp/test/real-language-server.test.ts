import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LspDiagnosticsService } from "../src/index.js";

/**
 * Exercises the client against a real TypeScript language server.
 *
 * The other tests here drive an in-memory server, which proves the framing and the freshness logic
 * but cannot prove the handshake is one a real server accepts. Every interesting bug in this
 * package was found here and nowhere else: `typescript` being unresolvable from a nested package
 * in a pnpm workspace, TypeScript 7 shipping a native binary instead of `tsserver.js`, that binary
 * needing an explicit `-stdio`, and it serving diagnostics by pull rather than push.
 *
 * This repository, because a language server needs a real project — content is supplied in memory,
 * so nothing here writes to the working tree. Skipped when no server can be started.
 */
const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
const subject = "packages/core/src/shared/brand.ts";
const original = await readFile(path.join(workspaceRoot, subject), "utf8");

async function check(content: string) {
  const service = new LspDiagnosticsService({ workspacePath: workspaceRoot, timeoutMs: 60_000 });
  try {
    return await service.check({ path: subject, content, signal: new AbortController().signal });
  } finally {
    await service.shutdown();
  }
}

const probe = await check(original);
const available = probe.status === "ready";
if (!available) {
  console.warn(`[lsp] skipping real-server tests: ${probe.detail ?? probe.status}`);
}

describe.skipIf(!available)("against a real TypeScript language server", () => {
  it("reports the unmodified file as clean", () => {
    expect(probe).toMatchObject({ status: "ready", errorCount: 0, items: [] });
  });

  it("reports a type error in the content it was handed", async () => {
    const report = await check(
      `${original}\nconst broken: number = "definitely not a number";\nexport { broken };\n`,
    );
    expect(report.status).toBe("ready");
    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.items.map(({ message }) => message).join("\n")).toMatch(/not assignable/iu);
    // Positions are one-based, matching read_file's gutter.
    expect(report.items[0]?.line).toBeGreaterThan(original.split("\n").length);
  }, 120_000);

  // Without a freshness guarantee the second check would replay the first revision's error and
  // send the model chasing something it already fixed.
  it("stops reporting an error once the next revision fixes it", async () => {
    const service = new LspDiagnosticsService({ workspacePath: workspaceRoot, timeoutMs: 60_000 });
    try {
      const broken = await service.check({
        path: subject,
        content: `${original}\nconst broken: number = "oops";\nexport { broken };\n`,
        signal: new AbortController().signal,
      });
      expect(broken.errorCount).toBeGreaterThan(0);

      const fixed = await service.check({
        path: subject,
        content: `${original}\nconst broken: number = 7;\nexport { broken };\n`,
        signal: new AbortController().signal,
      });
      expect(fixed).toMatchObject({ status: "ready", errorCount: 0 });
    } finally {
      await service.shutdown();
    }
  }, 120_000);
});
