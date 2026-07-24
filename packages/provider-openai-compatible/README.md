# @pilotrun/provider-openai-compatible

OpenAI-compatible language-model adapter for [Pilot](https://github.com/ragilhadi/pilot), a
terminal-first coding-agent platform. It implements the Pilot language-model port against any
Chat Completions-style endpoint — Ollama Cloud, OpenAI, OpenRouter, and similar — including
server-sent-event streaming and bearer-token resolution.

## Install

```sh
npm install @pilotrun/provider-openai-compatible @pilotrun/core
```

## Usage

```ts
import { OpenAICompatibleLanguageModel } from "@pilotrun/provider-openai-compatible";

const model = new OpenAICompatibleLanguageModel({
  configuration: {
    /* base URL, auth env var, and headers — a ProviderConfiguration from @pilotrun/core */
  },
  modelId: "gpt-4o-mini",
  capabilities: {
    /* ModelCapabilities from @pilotrun/core */
  },
});
```

The adapter conforms to the model port in `@pilotrun/core`, so it plugs directly into
`@pilotrun/agent-runtime`. `resolveBearerToken` and `processEnvironmentReader` are exported for
resolving credentials from the environment.

## License

MIT — see the [repository](https://github.com/ragilhadi/pilot) for details.
