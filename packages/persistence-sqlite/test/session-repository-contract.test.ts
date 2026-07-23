import { sessionRepositoryContract } from "../../testkit/contracts/session-repository.contract.js";
import { SqliteDatabase, SqliteMigrationRunner, SqliteSessionRepository } from "../src/index.js";

sessionRepositoryContract("SQLite", () => {
  const database = new SqliteDatabase(":memory:");
  new SqliteMigrationRunner(database).migrate();
  return new SqliteSessionRepository(database);
});
