import {
  publishablePackagePaths,
  readManifest,
  readVersionFile,
  writeManifestVersion,
} from "./package-versions.mjs";

// Propagates each package's `version` file (the source of truth) into its package.json.
// With `--check`, reports drift and exits non-zero instead of writing — used in CI so a
// hand-edited `version` file that was never synced fails the build.
const check = process.argv.includes("--check");
let drift = false;

for (const relativePath of publishablePackagePaths) {
  const fileVersion = await readVersionFile(relativePath);
  const manifest = await readManifest(relativePath);
  if (check) {
    if (manifest.version !== fileVersion) {
      drift = true;
      process.stderr.write(
        `${manifest.name}: package.json ${manifest.version} != version file ${fileVersion}\n`,
      );
    }
  } else {
    const name = await writeManifestVersion(relativePath, fileVersion);
    process.stdout.write(`${name}@${fileVersion}\n`);
  }
}

if (check && drift) {
  process.stderr.write("Version files and package.json manifests are out of sync. ");
  process.stderr.write("Run 'pnpm sync:versions' and commit the result.\n");
  process.exitCode = 1;
}
