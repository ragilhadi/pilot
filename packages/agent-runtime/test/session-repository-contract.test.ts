import { sessionRepositoryContract } from "../../testkit/contracts/session-repository.contract.js";
import { InMemorySessionRepository } from "../src/index.js";

sessionRepositoryContract("in-memory", () => new InMemorySessionRepository());
