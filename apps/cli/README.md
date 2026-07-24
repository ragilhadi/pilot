# @pilotrun/cli

`pilot` — a terminal-first, provider-neutral coding agent. It streams responses from
interchangeable language models, exposes repository and process access only through registered,
permission-gated tools, and persists sessions so you can resume them later. This package is the
CLI entry point of the [Pilot](https://github.com/ragilhadi/pilot) platform.

## Requirements

- Node.js 22.19 or newer
- ripgrep (`rg`) on `PATH` for the built-in repository search tool

## Install

```sh
npm install -g @pilotrun/cli
```

This installs the `pilot` command globally.

## Usage

```sh
pilot doctor              # environment/health check
pilot models              # list configured models
pilot chat                # start an interactive session
pilot run "fix the bug"   # one-shot, non-interactive
pilot sessions list       # inspect stored sessions
```

Pilot's primary model is Ollama Cloud `glm-5.2:cloud`, served through a local Ollama daemon; an
offline `fake/test` model backs deterministic runs, and any OpenAI-compatible endpoint works via
`@pilotrun/provider-openai-compatible`.

See the [project README](https://github.com/ragilhadi/pilot#readme) for configuration, model
setup, and the full command reference.

## License

MIT — see the [repository](https://github.com/ragilhadi/pilot) for details.
