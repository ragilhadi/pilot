# Pilot

A coding agent that lives in your terminal. Pilot reads and edits your repository, runs your
build and tests, and asks before doing anything risky — with whichever language model you point
it at.

## Install

```sh
npm install -g @pilotrun/cli
```

You need **Node.js 22.19+** and **[ripgrep](https://github.com/BurntSushi/ripgrep)** (`rg`) on your
`PATH`. Run `pilot doctor` at any time to check your setup.

## Quick start

Pilot uses Ollama Cloud's `glm-5.2:cloud` through a local Ollama daemon by default:

```sh
ollama signin
ollama pull glm-5.2:cloud

cd ~/your/project
pilot chat
```

Then say what you want in plain language — *"the login test is failing, find out why and fix it"* —
and approve the changes Pilot proposes.

## Commands

| Command | What it does |
| --- | --- |
| `pilot chat` | Start an interactive session. The main way to use Pilot. |
| `pilot chat --session <id>` | Pick up an earlier session where you left off. |
| `pilot run "…"` | One shot, no interaction. Good for scripts and CI. |
| `pilot doctor` | Check Node, Git, the workspace, the session database, and language servers. |
| `pilot models` | List available models (`add` / `remove` to manage them). |
| `pilot sessions list` | Browse past sessions (`show`, `export`, `fork`, `archive`, `delete`). |
| `pilot config --json` | Print the effective configuration and where each value came from. |
| `pilot skills` / `pilot prompts` | List the skills and prompt templates Pilot found. |
| `pilot instructions [path]` | Show which `AGENTS.md` files apply, and in what order. |

## In a chat session

**Attach files with `@`.** Type `@src/index.ts` and a picker completes workspace paths as you go
(`@"a file with spaces.ts"` for awkward names). Mention a folder — `@src` — to attach everything
inside it, recursively. Pilot reads each file on send, in `chat` and in `pilot run "…"` alike.

Files hidden by `.gitignore`, `.ignore`, `.pilotignore`, or the protected built-ins (a `.env`,
anything under `node_modules`) are never read and are reported as skipped, so secrets can't be
pulled into a prompt by accident. A folder that exceeds the per-turn budget (20 files, 256 KiB)
attaches what fits and tells you what it left out.

**Slash commands.** `/help` lists them all. The ones you'll reach for:

| | |
| --- | --- |
| `/context` | What's in the context window right now |
| `/skills`, `/skill <name>`, `/skill off <name>` | List and switch skills on or off |
| `/prompts`, `/prompt <name> [arguments]` | List and expand prompt templates |
| `/model <provider/model>` | Switch model mid-session |
| `/abort`, `/exit` | Stop the current turn, or end the session |

**Approvals.** Every tool call that isn't read-only asks first, showing the exact diff or command
line, and you answer **allow once** or **allow for this session**. Nothing granted outlives the
session, an approved tool doesn't cover the others, an approved command doesn't cover the next one,
and destructive actions are refused outright.

**Scrolling.** `PgUp`/`PgDn` by a screenful, `Shift+↑`/`Shift+↓` by a line, the wheel by three,
`Home`/`End` for the start or the newest output. The wheel scrolls the transcript, so selecting
text needs `Shift` held — or set `PILOT_TUI_MOUSE=0` to keep selection and scroll by keyboard.

**Display modes.** The default full-screen view leaves your shell's scrollback untouched, so the
transcript ends with the session. `--ui inline` does the opposite and writes finished output to
your terminal's scrollback, where the wheel and tmux copy-mode can reach it later. `--ui plain`,
`--screen-reader`, and `--json` are there too.

## Choosing a model

Pull a model in Ollama, then register it with Pilot so it sticks around:

```sh
ollama pull deepseek-v4-flash:cloud
pilot models add deepseek-v4-flash:cloud --context-window 128000
pilot chat --model ollama/deepseek-v4-flash:cloud
```

Setting `--context-window` to the model's real window matters: without it Pilot falls back to a
global default that over-fills a small model and under-uses a large one. It's also the denominator
behind the `ctx 38k/128k (30%)` figure in the status line.

Other flags: `--provider` (default `ollama`), `--name`, `--base-url`, `--no-tools` for models
without tool-calling, and `--vision`. Remove one with `pilot models remove <model-id>`. If your
daemon isn't at the usual address, set `PILOT_OLLAMA_BASE_URL`.

Any OpenAI-compatible endpoint works too: point `--base-url` at it, or set
`PILOT_OPENAI_COMPATIBLE_MODELS_JSON` to a JSON array of
`{ provider, modelId, displayName, capabilities }` entries for a whole fleet at once. Credentials
there are environment-variable references, never raw keys.

## Configuration

Pilot reads JSONC from `~/.pilot/config.jsonc` (or `PILOT_CONFIG`), then `.pilot/config.jsonc` in
your workspace, with the workspace file layered on top. `pilot config --json` shows the result and
the origin of every value.

```jsonc
{
  "schemaVersion": 1,
  "model": { "default": "ollama/glm-5.2:cloud" },
  "context": { "maxInputTokens": 120000, "reservedOutputTokens": 4096 },
  "runBudget": { "maxElapsedMs": 1800000 },
}
```

### Project instructions

Drop an `AGENTS.md` in your repository and Pilot reads it — from the workspace root down to the
directory of each file it touches, so a subdirectory can add its own rules. `~/.pilot/AGENTS.md`
holds instructions that follow you across every project. `pilot instructions` shows what applies.

Pilot also sends a short baseline prompt of its own ahead of yours, mainly so smaller models behave
predictably. Set `"prompt": { "systemPrompt": "none" }` to send nothing but your own instructions.

### Skills and prompt templates

A **skill** is a Markdown file of instructions for one kind of work that you switch on when you
want it. Put skills in `.pilot/skills` in a repository, or `~/.pilot/skills` for your own. A skill
is either `NAME.md` or `NAME/SKILL.md`, and the declared `name` has to match:

```markdown
---
name: review-diff
description: Review a working diff before it is committed
requiresTools: [grep, read_file]
deniesTools: run_command
confirmsRisks: [workspace-write]
---

Read the whole diff before commenting. Report findings most severe first.
```

Skills are discovered automatically but **never activate on their own**. `pilot skills` lists what
was found and what it restricts, `pilot skills show NAME` prints one in full, and nothing reaches
the model until you run `/skill NAME` (`/skill off NAME` to undo).

The three permission fields only make a session *stricter*: `requiresTools` refuses activation if a
tool is missing, `deniesTools` denies those tools for the rest of the session, and `confirmsRisks`
forces confirmation for a risk class. No field grants anything, and a skill that came with a
repository is labelled untrusted in context, the same as an `AGENTS.md`. Your own skill wins a name
clash with a project one. `"skills": { "enabled": false }` turns discovery off entirely.

A **prompt template** is a reusable prompt with placeholders, kept in `.pilot/prompts` (or
`~/.pilot/prompts`):

```markdown
---
name: fix-test
description: Investigate and fix a failing test
parameters: [testPath, note]
argumentHint: <test path> <what you saw>
---

Run {{testPath}} and fix what it reports. What I saw: {{note}}
```

`/prompt fix-test test/foo.test.ts fails only on CI` sends the expanded text as your message.
Arguments fill positionally and the last one absorbs the rest of the line; `{{arguments}}` gives
you the whole string. List templates with `pilot prompts` or `/prompts`.

### Command environment

Commands start from a deliberately small environment — `PATH`, `PATHEXT`, `SystemRoot`, `COMSPEC`,
`TEMP`, `TMP` — and the model may set only `CI` and `NO_COLOR` on an individual command. When your
toolchain needs more (a pinned runtime, a corporate proxy, a locale, a fixture database), name the
extra variables:

```jsonc
{
  "commands": {
    "inheritEnvironment": ["JAVA_HOME", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"],
    "allowEnvironmentOverrides": ["TEST_DATABASE_URL"],
  },
}
```

Both lists **extend** the defaults rather than replace them, so nothing can strip `PATH` out from
under a command. You name variables, never their values: the value is read from Pilot's own
environment when the command runs, and one whose name looks like a credential is redacted from the
output. `inheritEnvironment` is taken from your global config only — what every subprocess inherits
isn't a decision a config that arrived with a clone gets to make — while
`allowEnvironmentOverrides` carries no value of yours with it and may be set per repository.

### Web search

Add a Tavily key to your **global** config to give the model a `web_search` tool. Pilot resolves
the key at runtime and never places it in the effective configuration, tool arguments, or results —
which is why it takes the name of an environment variable rather than the key itself:

```jsonc
{
  "webSearch": {
    "provider": "tavily",
    "apiKey": { "variable": "TAVILY_API_KEY" },
  },
}
```

Without this section the tool isn't offered at all. A repository config can't select the credential.

### Run budget

Each turn is bounded, with wall-clock time as the real limit and the counts as backstops against
runaway iteration. When a limit is hit the turn ends cleanly with a reason rather than erroring.

| Field | Default | Meaning |
| --- | --- | --- |
| `maxElapsedMs` | `1800000` (30 min) | Wall-clock limit for a single turn |
| `maxCycles` | `200` | Model round-trips per turn |
| `maxModelAttempts` | `600` | Model calls including retries |
| `maxToolCalls` | `2000` | Tool calls per turn |
| `maxInputTokens` | _unset_ | Optional cumulative input-token ceiling |
| `maxOutputTokens` | _unset_ | Optional cumulative output-token ceiling |
| `maxEstimatedCostUsd` | _unset_ | Optional cost ceiling (needs provider cost data) |

Raise `maxElapsedMs` for long autonomous tasks; set `maxEstimatedCostUsd` to cap spend.

### Type errors after every edit

If a language server is available, Pilot checks each file it just wrote and hands the errors back
to the model in the same turn, so a broken edit gets fixed immediately instead of at the next test
run. TypeScript 7 projects need nothing — Pilot uses the compiler the project already depends on.
Otherwise:

```sh
npm install -g typescript-language-server typescript   # TypeScript 5.x / 6.x
npm install -g pyright                                 # Python
```

`pilot doctor` reports what's missing. Turn it off with `"diagnostics": { "enabled": false }`.

## Where your data lives

Sessions and tool activity are stored in SQLite under `~/.pilot` (override with `PILOT_DATA_DIR`),
alongside `config.jsonc`, `models.json`, and your personal `skills`, `prompts`, and `AGENTS.md`.
Nothing leaves your machine except what you send to the model you configured.

## Contributing

Building from source, the test suites, and the release process are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
