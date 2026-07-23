# Pilot

Pilot is a terminal-first, provider-neutral coding-agent platform written in TypeScript. It
streams responses from interchangeable language models, exposes repository and process access
only through registered tools, asks for approval at risk boundaries, and persists sessions so
you can resume them later.

## Requirements

- Node.js 22.19 or newer
- ripgrep (`rg`) on `PATH` for the built-in repository search tool

## Install

```sh
npm install -g @pilot/cli
```

This installs the `pilot` command globally. It works from any folder on your machine:

```sh
cd ~/some/project
pilot doctor
pilot chat
```

### From source

```sh
git clone https://github.com/ragilhadi/pilot.git
cd pilot
pnpm install
pnpm build
pnpm link:global   # links the local build as the global `pilot` command
```

`pnpm unlink:global` removes it again.

## Usage

```sh
pilot doctor              # environment/health check
pilot models              # list configured models
pilot chat                # start an interactive session
pilot run "fix the bug"   # one-shot, non-interactive
pilot sessions list       # inspect stored sessions
```

Pilot's primary model is Ollama Cloud `glm-5.2:cloud`, served through a local Ollama daemon:

```sh
ollama signin
ollama pull glm-5.2:cloud
pilot chat
```

Override the local endpoint with `PILOT_OLLAMA_BASE_URL` if your daemon listens elsewhere.
Additional OpenAI-compatible models can be configured via `PILOT_OPENAI_COMPATIBLE_MODELS_JSON`
(a JSON array of `{ provider, modelId, displayName, capabilities }` entries; credentials must be
environment-variable references, never raw keys).

In an interactive terminal, `chat` uses a full-screen TUI automatically (multiline editor,
history, `/` and `@` completion, streaming Markdown, permission prompts). Force a mode
explicitly with `--ui tui`, `--ui plain`, `--screen-reader`, or `--json`. Sessions and tool
activity are stored in SQLite under `PILOT_DATA_DIR` (default `~/.pilot`).

Every tool call that isn't read-only asks for approval before it runs, showing the exact diff
or command. Approve with `allow`/`deny`, optionally scoped to `once`, `session`, `tool`,
`workspace`, or `application`.

## Configuration

Pilot loads JSONC configuration from `~/.pilot/config.jsonc` (or `PILOT_CONFIG`), then
`<workspace>/.pilot/config.jsonc`. Inspect the effective merged configuration and its source
with `pilot config --json`.

```jsonc
{
  "schemaVersion": 1,
  "model": { "default": "ollama/glm-5.2:cloud" },
  "context": { "maxInputTokens": 120000, "reservedOutputTokens": 4096 },
}
```

Project-level `AGENTS.md` files (discovered from the workspace root down to each requested
file's directory) provide project instructions; a trusted `~/.pilot/AGENTS.md` provides global
ones. Inspect what applies with `pilot instructions`.

## Development

```sh
pnpm install
pnpm check     # format, lint, typecheck
pnpm test      # unit + integration tests
pnpm eval      # deterministic evaluation gate
pnpm build
```

## Releasing

Packages are versioned in lockstep. To cut a release:

```sh
node scripts/set-version.mjs 0.2.0
git commit -am "release: v0.2.0"
git tag pilot-v0.2.0
git push --follow-tags
```

Then publish a GitHub Release from that tag (via the GitHub UI, or `gh release create pilot-v0.2.0
--generate-notes`). Publishing the release triggers `.github/workflows/release.yml`, which verifies
the tag matches the package version, re-runs the full check/test/build gate, and then publishes all
`@pilot/*` packages to npm. The workflow can also be run manually via `workflow_dispatch` for a
retry, in which case it publishes whatever version is currently in `apps/cli/package.json`.

## License

MIT — see [LICENSE](./LICENSE).
