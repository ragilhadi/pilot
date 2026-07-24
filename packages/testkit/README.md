# @pilotrun/testkit

Deterministic test doubles for [Pilot](https://github.com/ragilhadi/pilot), a terminal-first
coding-agent platform. It provides a fake language model and a small scripting DSL for driving
model streams — text responses, tool calls, delays, and injected errors — so runtime and
extension behavior can be tested offline, without a real provider or network access.

## Install

```sh
npm install --save-dev @pilotrun/testkit @pilotrun/core
```

## Usage

```ts
import { FakeLanguageModel, textResponseScript, toolCallScript } from "@pilotrun/testkit";

const model = new FakeLanguageModel({
  scripts: [textResponseScript({ responseId: "r1", deltas: ["Hello from the fake model."] })],
});
```

`FakeLanguageModel` implements the same language-model port as the real providers, so it drops
into `@pilotrun/agent-runtime` in place of a live model.

## License

MIT — see the [repository](https://github.com/ragilhadi/pilot) for details.
