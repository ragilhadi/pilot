import { parseVersion, publishablePackagePaths, readManifest } from "./package-versions.mjs";

// Asserts every publishable package carries the same, valid version.
//
// This replaces the old version-file drift check. With package.json as the only source of truth
// there is nothing left to sync, but the lockstep release invariant is still worth enforcing: the
// release workflow verifies the git tag against apps/cli alone, so a half-applied bump would
// otherwise publish a set of packages that disagree with each other.
const manifests = await Promise.all(
  publishablePackagePaths.map(async (relativePath) => ({
    relativePath,
    manifest: await readManifest(relativePath),
  })),
);

const problems = [];
for (const { relativePath, manifest } of manifests) {
  try {
    parseVersion(manifest.version);
  } catch (error) {
    problems.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const versions = new Set(manifests.map(({ manifest }) => manifest.version));
if (versions.size > 1) {
  problems.push(
    `publishable packages disagree on their version: ${manifests
      .map(({ manifest }) => `${manifest.name}@${manifest.version}`)
      .join(", ")}`,
  );
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.stderr.write("Run 'pnpm release:version <semver>' and commit the result.\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`All ${manifests.length} publishable packages at ${[...versions][0]}\n`);
}
