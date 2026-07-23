import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pilot-package-smoke-"));
const deploymentPath = path.join(temporaryRoot, "pilot");

try {
  const pnpmScript = process.env.npm_execpath;
  assert(pnpmScript !== undefined, "pnpm must expose npm_execpath to the smoke script");
  await run(process.execPath, [
    pnpmScript,
    "--filter",
    "@pilotrun/cli",
    "deploy",
    deploymentPath,
    "--prod",
  ]);

  const manifest = JSON.parse(await readFile(path.join(deploymentPath, "package.json"), "utf8"));
  assertEqual(manifest.name, "@pilotrun/cli", "deployed package name");
  assertEqual(manifest.bin?.pilot, "./dist/index.js", "pilot executable mapping");
  assertEqual(manifest.engines?.node, ">=22.19.0", "Node.js engine declaration");

  const topLevelFiles = await readdir(deploymentPath);
  assert(topLevelFiles.includes("dist"), "deployment must contain compiled output");
  assert(topLevelFiles.includes("node_modules"), "deployment must contain production dependencies");
  assert(!topLevelFiles.includes("src"), "deployment must not contain TypeScript sources");
  assert(!topLevelFiles.includes("test"), "deployment must not contain tests");
  const installedPilotPackages = await readdir(
    path.join(deploymentPath, "node_modules", "@pilotrun"),
  );
  for (const dependency of [
    "agent-runtime",
    "core",
    "persistence-sqlite",
    "provider-openai-compatible",
    "testkit",
    "tools-builtin",
  ]) {
    assert(
      installedPilotPackages.includes(dependency),
      `deployment must materialize @pilotrun/${dependency}`,
    );
  }

  const cliPath = path.join(deploymentPath, "dist", "index.js");
  const models = JSON.parse((await run(process.execPath, [cliPath, "models", "--json"])).stdout);
  assertEqual(models[0]?.key, "ollama/glm-5.2:cloud", "first configured model");

  const fakeRun = await run(process.execPath, [
    cliPath,
    "run",
    "--model",
    "fake/test",
    "local package smoke",
  ]);
  assert(
    fakeRun.stdout.includes("Hello from Pilot's fake model."),
    "deployed CLI must complete the offline fake-model path",
  );

  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      package: manifest.name,
      version: manifest.version,
      node: process.version,
      platform: process.platform,
    })}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CI: "true",
        NO_COLOR: "1",
      },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) resolve({ stdout, stderr });
      else reject(new Error(`${executable} ${args.join(" ")} failed (${exitCode})\n${stderr}`));
    });
  });
}

function assertEqual(actual, expected, label) {
  assert(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(`Package smoke assertion failed: ${message}`);
}
