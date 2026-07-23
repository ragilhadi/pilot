import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every package published to npm under the @pilot scope. Kept in lockstep: one version
// number for the whole release, matching the git tag that triggers publication.
const publishablePackagePaths = [
  "packages/core",
  "packages/agent-runtime",
  "packages/provider-openai-compatible",
  "packages/tools-builtin",
  "packages/persistence-sqlite",
  "packages/testkit",
  "apps/cli",
];

const version = process.argv[2];
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
if (version === undefined || !semverPattern.test(version)) {
  process.stderr.write("Usage: node scripts/set-version.mjs <semver>\n");
  process.exitCode = 1;
} else {
  for (const relativePath of publishablePackagePaths) {
    const manifestPath = path.join(repositoryRoot, relativePath, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = version;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(`${manifest.name}@${version}\n`);
  }
}
