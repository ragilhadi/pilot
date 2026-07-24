import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every package published to npm under the @pilotrun scope. Released in lockstep: one version
// number for the whole release, matching the git tag that triggers publication. Each package
// carries its own `version` file (the source of truth) so a single package can also be bumped
// on its own if the release model ever loosens.
export const publishablePackagePaths = [
  "packages/core",
  "packages/agent-runtime",
  "packages/provider-openai-compatible",
  "packages/tools-builtin",
  "packages/persistence-sqlite",
  "packages/testkit",
  "apps/cli",
];

export const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

// The `version` file mirrors the convention in ragilhadi/mimic (`vars/version`): a single line,
// optionally `v`-prefixed. package.json requires a bare semver, so the `v` is stripped on read.
export function parseVersionFile(contents) {
  const trimmed = contents.trim();
  const bare = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  if (!semverPattern.test(bare)) {
    throw new Error(`"${trimmed}" is not a valid version (expected e.g. v1.2.3)`);
  }
  return bare;
}

function versionFilePath(relativePath) {
  return path.join(repositoryRoot, relativePath, "version");
}

function manifestPath(relativePath) {
  return path.join(repositoryRoot, relativePath, "package.json");
}

export async function readVersionFile(relativePath) {
  return parseVersionFile(await readFile(versionFilePath(relativePath), "utf8"));
}

export async function writeVersionFile(relativePath, bareVersion) {
  await writeFile(versionFilePath(relativePath), `v${bareVersion}\n`, "utf8");
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
