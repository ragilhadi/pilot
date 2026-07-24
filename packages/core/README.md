# @pilotrun/core

Provider-neutral domain types and ports for [Pilot](https://github.com/ragilhadi/pilot), a
terminal-first coding-agent platform. This package is the shared vocabulary every other
`@pilotrun/*` package depends on: branded identifiers, event and message shapes, tool and
permission contracts, and the Zod schemas that validate them — with no runtime side effects.

## Install

```sh
npm install @pilotrun/core
```

## Usage

```ts
import { sessionId, ToolRecoverySchema, builtinConfiguration } from "@pilotrun/core";

const id = sessionId("01J..."); // branded, validated identifier
```

Everything is exported from the package root. Types and ports live here; concrete
implementations live in the sibling packages (`@pilotrun/agent-runtime`,
`@pilotrun/tools-builtin`, `@pilotrun/persistence-sqlite`, and others).

## License

MIT — see the [repository](https://github.com/ragilhadi/pilot) for details.
