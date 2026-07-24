# @pilotrun/persistence-sqlite

SQLite-backed persistence for [Pilot](https://github.com/ragilhadi/pilot), a terminal-first
coding-agent platform. It stores sessions, runs, model calls, and checkpoints so conversations
survive process restarts and can be resumed, and it provides crash recovery and schema
migrations.

## Install

```sh
npm install @pilotrun/persistence-sqlite @pilotrun/core
```

## Usage

```ts
import {
  SqliteDatabase,
  SqliteMigrationRunner,
  pilotMigrations,
  createSqliteRepositories,
} from "@pilotrun/persistence-sqlite";
```

The repositories implement the persistence ports in `@pilotrun/core`, so the agent runtime and
CLI persist through this package without depending on SQLite directly.

## License

MIT — see the [repository](https://github.com/ragilhadi/pilot) for details.
