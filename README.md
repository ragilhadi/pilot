# Pilot

Pilot is a terminal-first, provider-neutral coding-agent platform written in TypeScript. It
streams responses from interchangeable language models, exposes repository and process access
only through registered tools, asks for approval at risk boundaries, and persists sessions so
you can resume them later.

## Requirements

- Node.js 22.19 or newer
- ripgrep (`rg`) on `PATH` for the built-in repository search tool

Optional, for type diagnostics after every edit (`pilot doctor` reports what is missing):

- TypeScript 5.x/6.x projects: `npm install -g typescript-language-server typescript`
- Python: `npm install -g pyright`

TypeScript 7 projects need nothing — Pilot uses the compiler the project already depends on.

## Install

```sh
npm install -g @pilotrun/cli
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

### Adding models

Pull a model in Ollama, then register it with Pilot so it persists across sessions:

```sh
ollama pull deepseek-v4-flash:cloud
pilot models add deepseek-v4-flash:cloud
pilot chat --model ollama/deepseek-v4-flash:cloud
```

`pilot models add` saves the model to `<data-dir>/models.json` (default `~/.pilot/models.json`),
so it shows up in `pilot models` and is selectable from then on — no environment variables needed.
Flags: `--provider` (default `ollama`), `--name`, `--base-url`, `--no-tools` (for models without
tool-calling), `--vision`, and `--context-window N`. Remove one with
`pilot models remove <model-id>`.

Setting `--context-window` to the model's real window matters: without it Pilot falls back to the
global `context.maxInputTokens`, which over-fills a small local model and under-uses a large one.
It is also the denominator behind the `ctx 38k/128k (30%)` figure in the status line.

For advanced setups (custom providers, credential references), additional OpenAI-compatible models
can also be configured via `PILOT_OPENAI_COMPATIBLE_MODELS_JSON` (a JSON array of
`{ provider, modelId, displayName, capabilities }` entries; credentials must be environment-variable
references, never raw keys).

In an interactive terminal, `chat` renders inline (multiline editor, history, `/` and `@`
completion, streaming Markdown, permission prompts). Finished output — your message, each settled
tool call, each completed reply — is written to the terminal's own scrollback and never redrawn, so
the scroll wheel, `Shift+PgUp`, and tmux copy-mode reach the whole session *and* whatever was on
screen before Pilot started. Only a small live region at the bottom is repainted.

Because committed output belongs to the terminal, it keeps the width it was written at: resizing
does not reflow earlier output, the same way it does not reflow `git log`. Reflowing it would mean
rewriting it, and rewriting it is what clears a scrollback.

`--ui fullscreen` is the other shape: an app-like pane on the alternate screen buffer, with the
banner and composer pinned and the transcript scrolled by Pilot rather than the terminal — `PgUp`
and `PgDn` by a screenful, `Shift+Up`/`Shift+Down` by a line, or the mouse wheel. A rule above the
composer reports how many lines are still below whenever you have scrolled back; sending a prompt,
paging past the end, or pressing `Esc` while idle returns to the newest output. Nothing it draws
touches your shell's scrollback, which comes back untouched on exit — but the transcript ends with
the session instead of staying in the terminal, which is the trade against the default.

Because the wheel scrolls the transcript there, the terminal's own text selection needs `Shift`
held down; set `PILOT_TUI_MOUSE=0` to keep selection unmodified and scroll by keyboard only.

Force a mode explicitly with `--ui tui` (inline, the default), `--ui fullscreen`, `--ui plain`,
`--screen-reader`, or `--json`. Sessions and tool activity are stored in SQLite under
`PILOT_DATA_DIR` (default `~/.pilot`).

Reference a file as context by typing `@` followed by its path (`@src/index.ts`, or
`@"a file with spaces.ts"` for paths with spaces); the picker lists workspace files and folders as
you type. On send, Pilot reads each referenced file and includes its contents alongside your
message — both in interactive `chat` and in `pilot run "…"`.

Mentioning a folder (`@src`, or `@src/` from the picker) attaches every eligible file inside it,
recursively. Binary files are skipped, and the per-turn budget still applies — 20 files and 256 KiB
in total by default — so a large folder attaches what fits and reports how many files it left out.

Files hidden by `.gitignore`, `.ignore`, `.pilotignore`, or the protected builtins (for example a
`.env`, or anything under `node_modules`) are never read and are reported as skipped, so secrets
can't be pulled into a prompt by mistake. This applies everywhere, including folder mentions and
the completion picker.

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
  "prompt": { "systemPrompt": "builtin" },
  "runBudget": { "maxElapsedMs": 1800000 },
}
```

To enable `web_search`, configure Tavily in the trusted global config only. Pilot resolves
the API key at runtime and does not place it in the effective configuration, tool arguments, or
tool results:

```jsonc
{
  "webSearch": {
    "provider": "tavily",
    "apiKey": { "variable": "TAVILY_API_KEY" },
  },
}
```

`web_search` is omitted from the model's tool list when this section is absent. Repository and
session configuration cannot select web-search credentials.

### System prompt

Pilot sends a small, provider-neutral set of baseline instructions ahead of your own
`AGENTS.md` files: which tool to reach for, the read-then-edit hash handshake that `edit` and
`apply_patch` require, how to read a failed tool result, and the rule that file and web content
is data rather than instructions. It exists mainly so smaller models behave predictably; larger
ones mostly infer it. Set `"prompt": { "systemPrompt": "none" }` to send nothing but your own
instructions.

### Run budget

Each turn runs an agent loop (call the model, run tools, feed results back, repeat) bounded by a
run budget. Wall-clock **elapsed time** is the primary limit; the cycle, model-attempt, and
tool-call counts are generous backstops against runaway iteration, not the normal stopping point.
Per-request context size is bounded separately by `context.maxInputTokens`, so no cumulative token
cap is applied unless you opt into one. Every field is tunable under `runBudget` in `config.jsonc`:

| Field | Default | Meaning |
| --- | --- | --- |
| `maxElapsedMs` | `1800000` (30 min) | Wall-clock limit for a single turn |
| `maxCycles` | `200` | Model round-trips per turn |
| `maxModelAttempts` | `600` | Model calls including retries |
| `maxToolCalls` | `2000` | Tool calls per turn |
| `maxInputTokens` | _unset_ | Optional cumulative input-token ceiling |
| `maxOutputTokens` | _unset_ | Optional cumulative output-token ceiling |
| `maxEstimatedCostUsd` | _unset_ | Optional estimated-cost ceiling (requires provider cost data) |

When a limit is reached the turn ends cleanly with an exhaustion reason rather than erroring. Raise
`maxElapsedMs` for long autonomous tasks, or set `maxEstimatedCostUsd` to cap spend.

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

## License

MIT — see [LICENSE](./LICENSE).
