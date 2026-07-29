import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every package published to npm under the @pilotrun scope. Released in lockstep: one version
// number for the whole release, matching the git tag that triggers publication.
//
// package.json is the single source of truth. Each package used to carry a separate `version` file
// beside it, which only created a second place to be wrong: nothing but these scripts ever read it,
// npm ignored it, and keeping the two in step needed its own CI check.
export const publishablePackagePaths = [
  "packages/core",
  "packages/agent-runtime",
  "packages/provider-openai-compatible",
  "packages/tools-builtin",
  "packages/persistence-sqlite",
  "packages/lsp",
  "packages/testkit",
  "apps/cli",
];

export const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** Accepts a bare or `v`-prefixed semver and returns the bare form package.json requires. */
export function parseVersion(input) {
  const trimmed = String(input ?? "").trim();
  const bare = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  if (!semverPattern.test(bare)) {
    throw new Error(`"${trimmed}" is not a valid version (expected e.g. 1.2.3 or v1.2.3)`);
  }
  return bare;
}

function manifestPath(relativePath) {
  return path.join(repositoryRoot, relativePath, "package.json");
}

export async function readManifest(relativePath) {
  return JSON.parse(await readFile(manifestPath(relativePath), "utf8"));
}

export async function writeManifestVersion(relativePath, bareVersion) {
  const manifest = await readManifest(relativePath);
  manifest.version = bareVersion;
  await writeFile(manifestPath(relativePath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest.name;
}
