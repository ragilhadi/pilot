# @pilotrun/tools-builtin

Built-in workspace tools for [Pilot](https://github.com/ragilhadi/pilot), a terminal-first
coding-agent platform. This package implements the file, patch, search, shell, and Git tools the
agent uses to inspect and change a repository — each one boundary-checked, sandboxed to the
workspace, and permission-gated.

Included tools: `list_files`, `glob`, `grep`, `read_file`, `apply_patch`, `edit`, `create_file`,
`run_command`, `git_status`, and `git_diff`. All reads and writes resolve through a workspace
boundary (real-path containment, symlink-escape prevention) before touching the filesystem.

The write surface offers three complementary primitives, all SHA-256-guarded and journal-backed:
`create_file` (create a new file, or overwrite an existing one when its `baseSha256` is supplied),
`edit` (replace an exact, unique string), and `apply_patch` (apply a unified diff).

`grep` uses ripgrep, bundled via [`@vscode/ripgrep`](https://www.npmjs.com/package/@vscode/ripgrep),
so search works with no external setup on Windows, macOS, and Linux (falling back to `rg` on the
`PATH` only if the bundled binary cannot be located).

## Install

```sh
npm install @pilotrun/tools-builtin @pilotrun/core
```

## Usage

```ts
import {
  NodeWorkspaceBoundary,
  loadRepositoryIgnoreRules,
  compileGlobPattern,
} from "@pilotrun/tools-builtin";
```

The tool definitions conform to the tool port in `@pilotrun/core` and are registered with
`@pilotrun/agent-runtime`.

## License

MIT — see the [repository](https://github.com/ragilhadi/pilot) for details.
