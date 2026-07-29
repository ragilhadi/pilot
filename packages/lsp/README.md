# @pilotrun/lsp

Language-server diagnostics for the Pilot coding agent. Implements `WorkspaceDiagnosticsPort` from
`@pilotrun/core`, so the edit tools can report "your change does not compile" without depending on a
package that spawns subprocesses.

See [ADR 0009](../../docs/decisions/0009-language-server-diagnostics.md) for the reasoning.

## What it does

After every successful `edit`, `write_file`, or `apply_patch`, Pilot asks the language server about
the file as just written and attaches the answer to that tool's result:

```json
{
  "diagnostics": {
    "status": "ready",
    "items": [
      { "severity": "error", "line": 42, "column": 9,
        "message": "Property 'nmae' does not exist on type 'User'.", "source": "ts", "code": "2339" }
    ],
    "errorCount": 1,
    "warningCount": 0
  }
}
```

The model reads the error as part of the edit's own result and fixes it in the same turn, instead of
discovering it a tool call later — or not at all.

`status` is load-bearing. Only `ready` with an empty `items` means the file is clean:

| status        | meaning                                                    |
| ------------- | ---------------------------------------------------------- |
| `ready`       | The report is trustworthy.                                  |
| `unavailable` | No server could be started. `detail` says why and how to fix it. |
| `timeout`     | The server did not answer in the budget. State unknown.     |
| `unsupported` | No server is configured for this file type.                 |

## Servers

| Language              | Server                                                     |
| --------------------- | ---------------------------------------------------------- |
| TypeScript/JavaScript | the project's own TypeScript 7 native binary (`--lsp -stdio`), else `typescript-language-server --stdio` |
| Python                | `pyright-langserver --stdio`                                |

Both are optional. A missing server yields `status: "unavailable"` with the install command;
`pilot doctor` reports the same up front.

```sh
npm install -g typescript-language-server typescript   # TypeScript 5.x / 6.x projects
npm install -g pyright                                 # Python
```

A TypeScript 7 project needs nothing installed globally — Pilot runs the binary the project already
depends on.

## Configuration

```jsonc
{
  "diagnostics": {
    "enabled": true,    // false never spawns a server; the edit tools omit the field entirely
    "timeoutMs": 3000   // a timeout reports no diagnostics, never stale ones
  }
}
```

## Design notes

- **Freshness over coverage.** A diagnostic set is reported only when it describes the content just
  sent — matched by document version for push servers, guaranteed by the request for pull servers.
  Nothing arriving in time yields `timeout`, never the previous revision's errors.
- **One server per project root.** Roots are found by walking up to the nearest `tsconfig.json`,
  `pyproject.toml`, and so on, so a monorepo gets one correctly-scoped server per project.
- **Errors and warnings only.** Hints and information are editor affordances, not defects.
- **Nothing throws.** A missing binary, a crash, or a hang becomes a status the model can act on.
