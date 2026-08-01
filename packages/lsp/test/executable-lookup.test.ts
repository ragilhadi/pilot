import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearExecutableCache,
  resolveExecutable,
  resolveInvocation,
} from "../src/executable-lookup.js";

const windows = process.platform === "win32";
const shimName = "pilot-lookup-fixture";

let directory: string;
let originalPath: string | undefined;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "pilot-lookup-"));
  originalPath = process.env.PATH;
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
  clearExecutableCache();
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  clearExecutableCache();
  await rm(directory, { recursive: true, force: true });
});

/** Writes a script that echoes its arguments back, one per line, and returns its path. */
async function writeEchoScript(): Promise<string> {
  const scriptPath = path.join(directory, `${shimName}${windows ? ".cmd" : ""}`);
  await writeFile(
    scriptPath,
    windows ? "@echo off\r\nfor %%a in (%*) do @echo %%~a\r\n" : '#!/bin/sh\nprintf "%s\\n" "$@"\n',
  );
  if (!windows) await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function runInvocation(command: string, args: readonly string[]): Promise<string> {
  const invocation = await resolveInvocation(command, args);
  const child = spawn(invocation.executable, [...invocation.args], {
    shell: false,
    windowsHide: true,
    ...(invocation.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  await new Promise((resolve) => child.once("close", resolve));
  return output;
}

describe("executable lookup", () => {
  it("resolves a command on PATH to its absolute path", async () => {
    const scriptPath = await writeEchoScript();

    // The extension comes from PATHEXT, which is upper case; Windows paths are case-insensitive.
    const resolved = await resolveExecutable(shimName);
    expect(resolved?.toLowerCase()).toBe(scriptPath.toLowerCase());
  });

  it("returns undefined for a command that is not on PATH", async () => {
    expect(await resolveExecutable("pilot-definitely-not-installed")).toBeUndefined();
  });

  it("leaves an unresolvable command alone so the caller still sees ENOENT", async () => {
    expect(await resolveInvocation("pilot-definitely-not-installed", ["--stdio"])).toEqual({
      executable: "pilot-definitely-not-installed",
      args: ["--stdio"],
    });
  });

  it("passes shell metacharacters through as literal arguments", async () => {
    await writeEchoScript();

    // Under the previous `shell: true` spawn these were concatenated into the command line
    // unescaped, so `a&whoami` ran whoami.
    expect(await runInvocation(shimName, ["a&whoami", "b|c", "with space"])).toContain("a&whoami");
    expect(await runInvocation(shimName, ["a&whoami", "b|c", "with space"])).toContain("b|c");
    expect(await runInvocation(shimName, ["a&whoami", "b|c", "with space"])).toContain(
      "with space",
    );
  });

  it.runIf(windows)("routes a .cmd shim through cmd.exe rather than a shell option", async () => {
    await writeEchoScript();

    const invocation = await resolveInvocation(shimName, ["--stdio"]);

    expect(path.basename(invocation.executable).toLowerCase()).toBe("cmd.exe");
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });
});
