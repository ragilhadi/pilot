import {
  publishablePackagePaths,
  semverPattern,
  writeManifestVersion,
  writeVersionFile,
} from "./package-versions.mjs";

// Writes one version across every publishable package: the `version` file (the source of truth)
// and the package.json manifest that npm publishes. Accepts a bare or `v`-prefixed semver.
const input = process.argv[2];
const version = input?.startsWith("v") ? input.slice(1) : input;

if (version === undefined || !semverPattern.test(version)) {
  process.stderr.write("Usage: node scripts/set-version.mjs <semver>\n");
  process.exitCode = 1;
} else {
  for (const relativePath of publishablePackagePaths) {
    await writeVersionFile(relativePath, version);
    const name = await writeManifestVersion(relativePath, version);
    process.stdout.write(`${name}@${version}\n`);
  }
}
