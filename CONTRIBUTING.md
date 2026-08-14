# Contributing

Pilot is a TypeScript pnpm workspace: a provider-neutral core, adapters around it, and the `pilot`
CLI on top.

## From source

```sh
git clone https://github.com/ragilhadi/pilot.git
cd pilot
pnpm install
pnpm build
pnpm link:global   # links the local build as the global `pilot` command
```

`pnpm unlink:global` removes it again.

## Checks

```sh
pnpm check     # format, lint, typecheck, version lockstep, docs links
pnpm test      # unit + integration tests
pnpm eval      # deterministic evaluation gate
pnpm build
```

`pnpm check` and `pnpm test` are what CI runs; both should be clean before a pull request.

## Releasing

Packages are versioned in lockstep, with each package's `package.json` as the single source of
truth. `pnpm release:version` writes one version across all of them, and `pnpm check` fails if they
ever disagree. To cut a release:

```sh
pnpm release:version 0.2.0   # writes the version into every publishable package.json
git commit -am "release: v0.2.0"
git tag pilot-v0.2.0
git push --follow-tags
```

Then publish a GitHub Release from that tag (via the GitHub UI, or `gh release create pilot-v0.2.0
--generate-notes`). Publishing the release triggers `.github/workflows/release.yml`, which verifies
the tag matches the package version, re-runs the full check/test/build gate, and then publishes all
`@pilotrun/*` packages to npm. The workflow can also be run manually via `workflow_dispatch` for a
retry, in which case it publishes whatever version is currently in `apps/cli/package.json`.
