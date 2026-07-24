# @pilotrun/agent-runtime

Deterministic agent orchestration runtime for [Pilot](https://github.com/ragilhadi/pilot), a
terminal-first coding-agent platform. It drives the bounded single-agent loop: model streaming
and accumulation, retries with backoff, token/turn budgets, context preparation, permission
gating, and typed runtime events.

## Install

```sh
npm install @pilotrun/agent-runtime @pilotrun/core
```

`@pilotrun/core` is a peer of the domain types this runtime operates on.

## Usage

```ts
import {
  InMemoryEventBus,
  ModelStreamAccumulator,
  RetryExecutor,
  inspectModelCapabilities,
} from "@pilotrun/agent-runtime";

const bus = new InMemoryEventBus();
```

The runtime is transport- and UI-agnostic: it emits typed events and reads model responses
through the ports defined in `@pilotrun/core`, so the same loop backs the CLI and any future
client.

## License

MIT — see the [repository](https://github.com/ragilhadi/pilot) for details.
