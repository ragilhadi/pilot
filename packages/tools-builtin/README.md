# @pilotrun/tools-builtin

Built-in workspace tools for [Pilot](https://github.com/ragilhadi/pilot), a terminal-first
coding-agent platform. This package implements the file, patch, search, shell, and Git tools the
agent uses to inspect and change a repository — each one boundary-checked, sandboxed to the
workspace, and permission-gated.

Included tools: `list_files`, `glob`, `grep`, `read_file`, `apply_patch`, `create_file`,
`run_command`, `git_status`, and `git_diff`. All reads and writes resolve through a workspace
boundary (real-path containment, symlink-escape prevention) before touching the filesystem.

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
