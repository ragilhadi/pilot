import {
  parseVersion,
  publishablePackagePaths,
  writeManifestVersion,
} from "./package-versions.mjs";

// Writes one version into every publishable package's package.json — the single source of truth
// npm publishes. Accepts a bare or `v`-prefixed semver.
let version;
try {
  version = parseVersion(process.argv[2]);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write("Usage: node scripts/set-version.mjs <semver>\n");
  process.exitCode = 1;
}

if (version !== undefined) {
  for (const relativePath of publishablePackagePaths) {
    const name = await writeManifestVersion(relativePath, version);
    process.stdout.write(`${name}@${version}\n`);
  }
}
