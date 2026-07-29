import {
  ApplicationRunner,
  ConversationModelRequestContextPreparer,
  ContextEngineError,
  createSystemPromptContextSource,
  InMemorySessionRepository,
  type InstructionDiscovery,
  type InstructionTarget,
  type ModelRegistry,
  type ContextSource,
  ModelStreamAccumulator,
  PermissionPolicyEngine,
  RepositoryRunLifecycleCheckpointWriter,
  RunInterruptionQueue,
  SessionConversationRunner,
  ThrottledRunCheckpointWriter,
  ToolResultContextFormatter,
  ToolRegistry,
  Utf8HeuristicTokenEstimator,
  type PromptCompositionSnapshot,
} from "@pilotrun/agent-runtime";
import {
  type AgentMessage,
  builtinConfiguration,
  type Clock,
  ConfigurationError,
  type IdSource,
  type JsonValue,
  type EffectiveConfiguration,
  type EnvironmentReference,
  messageId,
  parseAgentMessage,
  parseModelRequest,
  runId,
  type PersistenceRepositories,
  resolveEnvironmentReference,
  SessionError,
  sessionId,
  toSafeErrorSnapshot,
  type ToolRisk,
  type WorkspaceDiagnosticsPort,
  type WorkspaceBoundary,
} from "@pilotrun/core";
import {
  diagnoseSqliteDatabase,
  type SqliteDatabase,
  type SqliteSessionAdministration,
} from "@pilotrun/persistence-sqlite";
import { LspDiagnosticsService } from "@pilotrun/lsp";
import {
  createApplyPatchTool,
  createDiagnosticsTool,
  createQuestionTool,
  createTavilyWebSearchProvider,
  createBuiltinFileListTools,
  createEditFileTool,
  createGrepTool,
  createGitTools,
  createReadFileTool,
  createRunCommandTool,
  createTodoTools,
  createWebFetchTool,
  createWebSearchTool,
  createWriteFileTool,
  InMemoryChangeJournal,
  InMemoryTodoStore,
  NodeWorkspaceFileSystem,
  NodeWorkspaceBoundary,
  resolveContextMentions,
  type ContextMentionResolution,
  type GitCommandRunner,
} from "@pilotrun/tools-builtin";
import {
  ChatEventFactory,
  ChatEventRenderer,
  formatContextAttachmentSummary,
} from "./chat-events.js";
import { CliUserClarification } from "./cli-user-clarification.js";
import { CliUserInteraction } from "./cli-user-interaction.js";
import { type PilotDoctor, renderDoctorReport } from "./diagnostics.js";
import { builtinModelKeys, defaultCliModelKey } from "./model-catalog.js";
import {
  ModelStoreError,
  modelsStorePath,
  type PersistedModelInput,
  PersistedModelSchema,
  persistedModelKey,
  readPersistedModels,
  removePersistedModel,
  upsertPersistedModel,
  writePersistedModels,
} from "./model-store.js";
import type { ChatEventSink } from "./presentation/chat-presentation.js";
import { isPresentationMode, type PresentationMode } from "./presentation/presentation-mode.js";
import type { StructuredLogger } from "./structured-logger.js";

export interface TextWriter {
  write(text: string): void;
}

export interface LineReader {
  readLine(): Promise<string | undefined>;
}

export interface CliDependencies {
  readonly registry: ModelRegistry;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly stdout: TextWriter;
  readonly stderr: TextWriter;
  readonly signal: AbortSignal;
  readonly stdin?: LineReader;
  readonly monotonicNow?: () => number;
  readonly workspacePath?: string;
  readonly dataDirectory?: string;
  readonly tools?: ToolRegistry;
  readonly gitRunner?: GitCommandRunner;
  readonly persistence?: {
    readonly database: SqliteDatabase;
    readonly repositories: PersistenceRepositories;
    readonly administration: SqliteSessionAdministration;
  };
  readonly configuration?: EffectiveConfiguration;
  readonly instructionDiscovery?: InstructionDiscovery;
  readonly instructionGlobalPath?: string;
  readonly doctor?: PilotDoctor;
  readonly logger?: StructuredLogger;
  readonly chatRenderer?: ChatEventSink;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly diagnostics?: WorkspaceDiagnosticsPort;
}

interface ModelsCommand {
  readonly type: "models";
  readonly json: boolean;
  readonly action:
    | { readonly kind: "list" }
    | { readonly kind: "add"; readonly entry: PersistedModelInput }
    | { readonly kind: "remove"; readonly key: string };
}

interface ConfigCommand {
  readonly type: "config";
  readonly json: boolean;
}

interface InstructionsCommand {
  readonly type: "instructions";
  readonly json: boolean;
  readonly targets: readonly InstructionTarget[];
}

interface DoctorCommand {
  readonly type: "doctor";
  readonly json: boolean;
}

interface RunCommand {
  readonly type: "run";
  readonly json: boolean;
  readonly modelKey: string;
  readonly prompt: string;
}

interface ChatCommand {
  readonly type: "chat";
  readonly json: boolean;
  readonly modelKey: string;
  readonly ui: PresentationMode;
  readonly screenReader: boolean;
  readonly sessionId?: string;
}

interface SessionsCommand {
  readonly type: "sessions";
  readonly action:
    | { readonly kind: "archive"; readonly id: string }
    | { readonly kind: "backup"; readonly path: string }
    | { readonly kind: "delete"; readonly id: string }
    | { readonly kind: "doctor"; readonly json: boolean }
    | { readonly kind: "export"; readonly id: string; readonly redact: boolean }
    | {
        readonly kind: "fork";
        readonly sourceId: string;
        readonly id: string;
        readonly through?: string;
      }
    | { readonly kind: "list"; readonly json: boolean }
    | { readonly kind: "show"; readonly id: string; readonly json: boolean };
}

type CliCommand =
  | ChatCommand
  | ConfigCommand
  | DoctorCommand
  | InstructionsCommand
  | ModelsCommand
  | RunCommand
  | SessionsCommand;

class CliUsageError extends Error {}

const usage = `Usage:
  pilot doctor [--json]
  pilot models [--json]
  pilot models add MODEL_ID [--provider P] [--name NAME] [--base-url URL] [--no-tools] [--vision]
                            [--context-window N]
  pilot models remove MODEL_ID [--provider P]
  pilot config [--json]
  pilot instructions [--json] [FILE ...] [--directory DIR]
  pilot run [--model provider/model] [--json] "prompt"
  pilot chat [--model provider/model] [--ui auto|tui|plain] [--screen-reader] [--json]
  pilot chat --session SESSION_ID [--model provider/model] [--ui auto|tui|plain] [--json]
  pilot sessions list [--json]
  pilot sessions show SESSION_ID [--json]
  pilot sessions fork SESSION_ID NEW_SESSION_ID [--through MESSAGE_ID]
  pilot sessions export SESSION_ID [--unsafe-unredacted]
  pilot sessions archive SESSION_ID
  pilot sessions delete SESSION_ID --yes
  pilot sessions doctor [--json]
  pilot sessions backup PATH
`;

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const startedAt = dependencies.monotonicNow?.() ?? 0;
  let command: CliCommand;
  try {
    command = parseCommand(
      args,
      dependencies.configuration?.configuration.model.default ?? defaultCliModelKey,
    );
  } catch (error) {
    if (error instanceof CliUsageError) {
      dependencies.stderr.write(`pilot: ${error.message}\n${usage}`);
      return 2;
    }
    throw error;
  }

  dependencies.logger?.log("info", "cli.command.started", { command: command.type });
  let exitCode = 1;
  try {
    switch (command.type) {
      case "doctor":
        exitCode = await executeDoctor(command, dependencies);
        break;
      case "models":
        exitCode = await executeModels(command, dependencies);
        break;
      case "config":
        renderConfiguration(dependencies.configuration, command.json, dependencies.stdout);
        exitCode = 0;
        break;
      case "instructions":
        exitCode = await executeInstructions(command, dependencies);
        break;
      case "run":
        exitCode = await executeRun(command, dependencies);
        break;
      case "chat":
        exitCode = await executeChat(command, dependencies);
        break;
      case "sessions":
        exitCode = await executeSessions(command, dependencies);
        break;
    }
  } catch (error) {
    const snapshot = toSafeErrorSnapshot(error);
    dependencies.logger?.log("error", "cli.command.failed", {
      command: command.type,
      errorCode: snapshot.code,
    });
    dependencies.stderr.write(
      `${JSON.stringify({ ...snapshot, remediation: remediationForError(snapshot.code) })}\n`,
    );
    exitCode = 1;
  }
  dependencies.logger?.log("info", "cli.command.completed", {
    command: command.type,
    exitCode,
    durationMs: Math.max(0, (dependencies.monotonicNow?.() ?? startedAt) - startedAt),
  });
  return exitCode;
}

function parseCommand(args: readonly string[], defaultModelKey: string): CliCommand {
  const [name, ...rest] = args;
  if (name === "doctor") {
    if (rest.length === 0 || (rest.length === 1 && rest[0] === "--json")) {
      return { type: "doctor", json: rest[0] === "--json" };
    }
    throw new CliUsageError("doctor accepts only the optional --json flag");
  }
  if (name === "models") {
    return parseModelsCommand(rest);
  }
  if (name === "config") {
    if (rest.length === 0 || (rest.length === 1 && rest[0] === "--json")) {
      return { type: "config", json: rest[0] === "--json" };
    }
    throw new CliUsageError("config accepts only the optional --json flag");
  }
  if (name === "instructions") return parseInstructionsCommand(rest);
  if (name === "sessions") return parseSessionsCommand(rest);
  if (name !== "run" && name !== "chat") {
    throw new CliUsageError(
      name === undefined ? "a command is required" : `unknown command ${name}`,
    );
  }

  let modelKey = defaultModelKey;
  let modelSpecified = false;
  let json = false;
  let ui: PresentationMode = "auto";
  let uiSpecified = false;
  let screenReader = false;
  let selectedSessionId: string | undefined;
  const promptParts: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--screen-reader") {
      if (name !== "chat") throw new CliUsageError("--screen-reader is available only for chat");
      screenReader = true;
      continue;
    }
    if (argument === "--ui") {
      const value = rest[index + 1];
      if (name !== "chat") throw new CliUsageError("--ui is available only for chat");
      if (value === undefined || !isPresentationMode(value)) {
        throw new CliUsageError("--ui requires one of: auto, tui, plain");
      }
      if (uiSpecified) throw new CliUsageError("--ui may only be specified once");
      ui = value;
      uiSpecified = true;
      index += 1;
      continue;
    }
    if (argument === "--model") {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError("--model requires a provider/model value");
      }
      if (modelSpecified) {
        throw new CliUsageError("--model may only be specified once");
      }
      modelKey = value;
      modelSpecified = true;
      index += 1;
      continue;
    }
    if (argument === "--session") {
      const value = rest[index + 1];
      if (name !== "chat") throw new CliUsageError("--session is available only for chat");
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError("--session requires a session identifier");
      }
      if (selectedSessionId !== undefined) {
        throw new CliUsageError("--session may only be specified once");
      }
      selectedSessionId = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--")) {
      throw new CliUsageError(`unknown option ${argument}`);
    }
    if (argument !== undefined) {
      promptParts.push(argument);
    }
  }

  const prompt = promptParts.join(" ").trim();
  if (name === "run" && prompt.length === 0) {
    throw new CliUsageError("run requires a non-empty prompt");
  }
  if (name === "chat") {
    if (prompt.length > 0) {
      throw new CliUsageError("chat does not accept an initial prompt");
    }
    return Object.freeze({
      type: "chat",
      json,
      modelKey,
      ui,
      screenReader,
      ...(selectedSessionId === undefined ? {} : { sessionId: selectedSessionId }),
    });
  }
  return Object.freeze({ type: "run", json, modelKey, prompt });
}

async function executeDoctor(
  command: DoctorCommand,
  dependencies: CliDependencies,
): Promise<number> {
  if (dependencies.doctor === undefined) throw new Error("Application diagnostics are unavailable");
  const report = await dependencies.doctor.diagnose();
  dependencies.stdout.write(renderDoctorReport(report, command.json));
  return report.healthy ? 0 : 1;
}

export function remediationForError(code: string): string {
  if (code === "PILOT_MODEL_AUTHENTICATION") {
    return "Check the provider credential environment variable with pilot doctor; secret values are never displayed.";
  }
  if (code === "PILOT_MODEL_NOT_FOUND") {
    return "Run pilot models and select an available provider/model identifier.";
  }
  if (code.startsWith("PILOT_CONFIG")) {
    return "Run pilot config --json and correct the reported configuration layer.";
  }
  if (code.startsWith("PILOT_PERSISTENCE") || code.startsWith("PILOT_SESSION")) {
    return "Run pilot doctor and pilot sessions doctor --json, then verify PILOT_DATA_DIR access.";
  }
  if (code.startsWith("PILOT_WORKSPACE") || code.startsWith("PILOT_GIT")) {
    return "Run pilot doctor in the intended repository and verify workspace and Git access.";
  }
  return "Run pilot doctor --json for environment checks and retry after correcting failed checks.";
}

function parseModelsCommand(args: readonly string[]): ModelsCommand {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand === "--json") {
    if (rest.length > 0) throw new CliUsageError("models accepts only the optional --json flag");
    return Object.freeze({
      type: "models",
      json: subcommand === "--json",
      action: { kind: "list" as const },
    });
  }
  if (subcommand === "add") return parseModelsAddCommand(rest);
  if (subcommand === "remove") return parseModelsRemoveCommand(rest);
  if (subcommand.startsWith("--")) throw new CliUsageError(`unknown option ${subcommand}`);
  throw new CliUsageError(`unknown models subcommand ${subcommand}`);
}

function parseModelsAddCommand(args: readonly string[]): ModelsCommand {
  let modelId: string | undefined;
  let provider = "ollama";
  let displayName: string | undefined;
  let baseUrl: string | undefined;
  let tools = true;
  let vision = false;
  let contextWindow: number | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    const optionValue = (label: string): string => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(`${label} requires a value`);
      }
      index += 1;
      return value;
    };
    switch (argument) {
      case "--provider":
        provider = optionValue("--provider");
        break;
      case "--name":
        displayName = optionValue("--name");
        break;
      case "--base-url":
        baseUrl = optionValue("--base-url");
        break;
      case "--no-tools":
        tools = false;
        break;
      case "--vision":
        vision = true;
        break;
      case "--context-window": {
        const raw = optionValue("--context-window");
        const parsed = Number(raw);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          throw new CliUsageError("--context-window requires a positive integer");
        }
        contextWindow = parsed;
        break;
      }
      case "--json":
        json = true;
        break;
      default:
        if (argument.startsWith("--")) throw new CliUsageError(`unknown option ${argument}`);
        if (modelId !== undefined) throw new CliUsageError("models add accepts a single model id");
        modelId = argument;
    }
  }
  if (modelId === undefined) {
    throw new CliUsageError('models add requires a model id, e.g. models add "llama3.1:8b"');
  }
  return Object.freeze({
    type: "models",
    json,
    action: {
      kind: "add" as const,
      entry: {
        provider,
        modelId,
        tools,
        vision,
        ...(displayName === undefined ? {} : { displayName }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
      },
    },
  });
}

function parseModelsRemoveCommand(args: readonly string[]): ModelsCommand {
  let target: string | undefined;
  let provider = "ollama";
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--provider") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError("--provider requires a value");
      }
      provider = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--")) throw new CliUsageError(`unknown option ${argument}`);
    if (argument !== undefined) {
      if (target !== undefined) throw new CliUsageError("models remove accepts a single model");
      target = argument;
    }
  }
  if (target === undefined) {
    throw new CliUsageError("models remove requires a model id or provider/model key");
  }
  const key = target.includes("/") ? target : `${provider}/${target}`;
  return Object.freeze({ type: "models", json, action: { kind: "remove" as const, key } });
}

function parseInstructionsCommand(args: readonly string[]): InstructionsCommand {
  let json = false;
  const targets: InstructionTarget[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--directory") {
      const directory = args[index + 1];
      if (directory === undefined || directory.startsWith("--")) {
        throw new CliUsageError("--directory requires a workspace-relative path");
      }
      targets.push({ path: directory, kind: "directory" });
      index += 1;
      continue;
    }
    if (argument?.startsWith("--")) throw new CliUsageError(`unknown option ${argument}`);
    if (argument !== undefined) targets.push({ path: argument, kind: "file" });
  }
  return Object.freeze({
    type: "instructions",
    json,
    targets: Object.freeze(
      targets.length === 0 ? [{ path: ".", kind: "directory" as const }] : targets,
    ),
  });
}

async function executeInstructions(
  command: InstructionsCommand,
  dependencies: CliDependencies,
): Promise<number> {
  if (dependencies.instructionDiscovery === undefined || dependencies.configuration === undefined) {
    throw new Error("Instruction discovery is unavailable");
  }
  const context = dependencies.configuration.configuration.context;
  const result = await dependencies.instructionDiscovery.discover({
    targets: command.targets,
    ...(dependencies.instructionGlobalPath === undefined
      ? {}
      : { globalPath: dependencies.instructionGlobalPath }),
    maximumFileBytes: context.maxInstructionBytes,
    maximumTotalBytes: context.maxInstructionTotalBytes,
  });
  if (command.json) {
    dependencies.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  for (const document of result.documents) {
    dependencies.stdout.write(
      `--- ${document.displayPath} [${document.trust}; scope=${document.scope}; ${document.sha256}] ---\n${document.content}\n`,
    );
  }
  for (const notice of result.precedenceNotices) {
    dependencies.stdout.write(
      `[precedence: ${notice.target}: ${notice.higherDocumentId} overrides ${notice.lowerDocumentId}; semantic conflicts require review]\n`,
    );
  }
  for (const diagnostic of result.diagnostics) {
    dependencies.stderr.write(
      `[instruction rejected: ${diagnostic.path}: ${diagnostic.reason}: ${diagnostic.detail}]\n`,
    );
  }
  return 0;
}

function renderConfiguration(
  effective: EffectiveConfiguration | undefined,
  json: boolean,
  writer: TextWriter,
): void {
  if (effective === undefined) throw new Error("Effective configuration is unavailable");
  if (json) {
    writer.write(`${JSON.stringify(effective)}\n`);
    return;
  }
  writer.write("PATH\tVALUE\tSOURCE\tLOCATION\n");
  for (const [path, provenance] of Object.entries(effective.provenance).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    writer.write(
      `${path}\t${JSON.stringify(readConfigurationPath(effective.configuration, path))}\t${provenance.source}\t${provenance.location}\n`,
    );
  }
}

function readConfigurationPath(configuration: unknown, path: string): unknown {
  let value = configuration;
  for (const segment of path.split(".")) {
    if (value === null || typeof value !== "object" || !(segment in value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function parseSessionsCommand(args: readonly string[]): SessionsCommand {
  const [action, ...rest] = args;
  if (action === "list" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--json"))) {
    return { type: "sessions", action: { kind: "list", json: rest[0] === "--json" } };
  }
  if (action === "show" && (rest.length === 1 || (rest.length === 2 && rest[1] === "--json"))) {
    const id = rest[0];
    if (id !== undefined)
      return { type: "sessions", action: { kind: "show", id, json: rest[1] === "--json" } };
  }
  if (
    action === "export" &&
    (rest.length === 1 || (rest.length === 2 && rest[1] === "--unsafe-unredacted"))
  ) {
    const id = rest[0];
    if (id !== undefined)
      return {
        type: "sessions",
        action: { kind: "export", id, redact: rest[1] !== "--unsafe-unredacted" },
      };
  }
  if (action === "archive" && rest.length === 1 && rest[0] !== undefined) {
    return { type: "sessions", action: { kind: "archive", id: rest[0] } };
  }
  if (action === "delete" && rest.length === 2 && rest[0] !== undefined && rest[1] === "--yes") {
    return { type: "sessions", action: { kind: "delete", id: rest[0] } };
  }
  if (action === "doctor" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--json"))) {
    return { type: "sessions", action: { kind: "doctor", json: rest[0] === "--json" } };
  }
  if (action === "backup" && rest.length === 1 && rest[0] !== undefined) {
    return { type: "sessions", action: { kind: "backup", path: rest[0] } };
  }
  if (action === "fork" && (rest.length === 2 || (rest.length === 4 && rest[2] === "--through"))) {
    const [sourceId, id, , through] = rest;
    if (sourceId !== undefined && id !== undefined) {
      return {
        type: "sessions",
        action: { kind: "fork", sourceId, id, ...(through === undefined ? {} : { through }) },
      };
    }
  }
  throw new CliUsageError("invalid sessions command or missing required confirmation");
}

async function executeSessions(
  command: SessionsCommand,
  dependencies: CliDependencies,
): Promise<number> {
  const persistence = dependencies.persistence;
  if (persistence === undefined) throw new Error("Session persistence is unavailable");
  const { action } = command;
  switch (action.kind) {
    case "list": {
      const sessions = persistence.administration.list();
      if (action.json) dependencies.stdout.write(`${JSON.stringify(sessions)}\n`);
      else {
        dependencies.stdout.write("SESSION\tSTATUS\tMESSAGES\tUPDATED\n");
        for (const session of sessions) {
          dependencies.stdout.write(
            `${session.id}\t${session.status}\t${session.messageCount}\t${session.updatedAt}\n`,
          );
        }
      }
      return 0;
    }
    case "show": {
      const snapshot = await persistence.administration.resume(sessionId(action.id));
      if (snapshot === undefined) throw missingSession(action.id);
      dependencies.stdout.write(
        action.json ? `${JSON.stringify(snapshot)}\n` : renderSession(snapshot),
      );
      return 0;
    }
    case "fork": {
      const snapshot = await persistence.administration.fork({
        sourceId: sessionId(action.sourceId),
        id: sessionId(action.id),
        createdAt: dependencies.clock.now().toISOString(),
        nextMessageId: () => messageId(dependencies.ids.next()),
        ...(action.through === undefined ? {} : { throughMessageId: messageId(action.through) }),
      });
      dependencies.stdout.write(
        `${JSON.stringify({ id: snapshot.id, revision: snapshot.revision })}\n`,
      );
      return 0;
    }
    case "export": {
      const exported = await persistence.administration.export(sessionId(action.id), {
        exportedAt: dependencies.clock.now().toISOString(),
        redact: action.redact,
      });
      if (exported === undefined) throw missingSession(action.id);
      dependencies.stdout.write(`${JSON.stringify(exported, null, 2)}\n`);
      return 0;
    }
    case "archive": {
      if (
        !persistence.administration.archive(
          sessionId(action.id),
          dependencies.clock.now().toISOString(),
        )
      )
        throw missingSession(action.id);
      dependencies.stdout.write(`${JSON.stringify({ archived: action.id })}\n`);
      return 0;
    }
    case "delete": {
      const result = persistence.administration.delete(sessionId(action.id));
      if (!result.deleted) throw missingSession(action.id);
      dependencies.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    case "doctor": {
      const report = diagnoseSqliteDatabase(persistence.database);
      if (action.json) dependencies.stdout.write(`${JSON.stringify(report)}\n`);
      else
        dependencies.stdout.write(
          `database: ${report.healthy ? "healthy" : "unhealthy"}\nschema: ${report.schemaVersion}\nforeign-key violations: ${report.foreignKeyViolationCount}\n`,
        );
      return report.healthy ? 0 : 1;
    }
    case "backup":
      await persistence.database.backupTo(action.path);
      dependencies.stdout.write(`${JSON.stringify({ backup: action.path })}\n`);
      return 0;
  }
}

function missingSession(id: string): SessionError {
  return new SessionError(
    "PILOT_SESSION_NOT_FOUND",
    "session-not-found",
    `Session ${id} does not exist`,
    { sessionId: id },
  );
}

function requireConfiguredSecret(
  reference: EnvironmentReference,
  environment: Readonly<Record<string, string | undefined>>,
  configurationPath: string,
): string {
  const value = resolveEnvironmentReference(reference, environment);
  if (value !== undefined && value.length > 0) return value;
  throw new ConfigurationError(`Configuration ${configurationPath} resolved to an empty secret`, {
    path: configurationPath,
    variable: reference.variable,
  });
}

function renderSession(snapshot: {
  readonly id: string;
  readonly revision: number;
  readonly messages: readonly AgentMessage[];
}): string {
  return `Session ${snapshot.id} (revision ${snapshot.revision})\n${snapshot.messages
    .map(
      (message) =>
        `${message.role}: ${message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")}`,
    )
    .join("\n")}\n`;
}

async function executeModels(
  command: ModelsCommand,
  dependencies: CliDependencies,
): Promise<number> {
  if (command.action.kind === "list") {
    renderModels(dependencies.registry, command.json, dependencies.stdout);
    return 0;
  }
  if (dependencies.dataDirectory === undefined) {
    dependencies.stderr.write("Cannot modify models: no data directory is available.\n");
    return 1;
  }
  const storePath = modelsStorePath(dependencies.dataDirectory);
  try {
    const existing = await readPersistedModels(storePath);
    if (command.action.kind === "add") {
      return await addModel(command, command.action.entry, existing, storePath, dependencies);
    }
    return await removeModel(command, command.action.key, existing, storePath, dependencies);
  } catch (error) {
    if (error instanceof ModelStoreError) {
      dependencies.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

async function addModel(
  command: ModelsCommand,
  input: PersistedModelInput,
  existing: Awaited<ReturnType<typeof readPersistedModels>>,
  storePath: string,
  dependencies: CliDependencies,
): Promise<number> {
  const entry = PersistedModelSchema.parse(input);
  const key = persistedModelKey(entry);
  if ((builtinModelKeys as readonly string[]).includes(key)) {
    dependencies.stderr.write(`${key} is a built-in model and cannot be overridden.\n`);
    return 1;
  }
  const { models, replaced } = upsertPersistedModel(existing, entry);
  await writePersistedModels(storePath, models);
  if (command.json) {
    dependencies.stdout.write(
      `${JSON.stringify({ action: replaced ? "updated" : "added", key, model: entry })}\n`,
    );
    return 0;
  }
  dependencies.stdout.write(
    `${replaced ? "Updated" : "Added"} ${key}${entry.tools ? "" : " (tools disabled)"}.\n` +
      `Use it now:  pilot chat --model ${key}\n`,
  );
  return 0;
}

async function removeModel(
  command: ModelsCommand,
  key: string,
  existing: Awaited<ReturnType<typeof readPersistedModels>>,
  storePath: string,
  dependencies: CliDependencies,
): Promise<number> {
  if ((builtinModelKeys as readonly string[]).includes(key)) {
    dependencies.stderr.write(`${key} is a built-in model and cannot be removed.\n`);
    return 1;
  }
  const { models, removed } = removePersistedModel(existing, key);
  if (!removed) {
    dependencies.stderr.write(
      `${key} is not a saved model. Run pilot models to list saved models.\n`,
    );
    return 1;
  }
  await writePersistedModels(storePath, models);
  if (command.json) {
    dependencies.stdout.write(`${JSON.stringify({ action: "removed", key })}\n`);
    return 0;
  }
  dependencies.stdout.write(`Removed ${key}.\n`);
  return 0;
}

function renderModels(registry: ModelRegistry, json: boolean, writer: TextWriter): void {
  const descriptors = [...registry.list()].sort((left, right) => {
    const priorityDifference = modelPriority(left.metadata) - modelPriority(right.metadata);
    return priorityDifference === 0 ? left.key.localeCompare(right.key) : priorityDifference;
  });
  if (json) {
    writer.write(`${JSON.stringify(descriptors)}\n`);
    return;
  }

  writer.write("MODEL\tDISPLAY NAME\tSTREAMING\tTOOLS\tVISION\n");
  for (const descriptor of descriptors) {
    writer.write(
      `${descriptor.key}\t${descriptor.displayName}\t${yesNo(descriptor.capabilities.streaming)}\t${yesNo(descriptor.capabilities.nativeToolCalling)}\t${yesNo(descriptor.capabilities.vision)}\n`,
    );
  }
}

function modelPriority(metadata: Readonly<Record<string, unknown>> | undefined): number {
  const priority = metadata?.priority;
  return typeof priority === "number" && Number.isFinite(priority) ? priority : 1_000;
}

/**
 * Expands `@` mentions in a submitted line into attached file context. Ignore
 * rules are enforced inside {@link resolveContextMentions}, so gitignored files
 * are reported as skipped rather than read. Any unexpected failure degrades
 * gracefully to the original text so a turn is never blocked by mention
 * resolution.
 */
async function resolveMentionContext(
  text: string,
  boundary: WorkspaceBoundary,
  signal: AbortSignal | undefined,
): Promise<ContextMentionResolution> {
  try {
    return await resolveContextMentions({
      text,
      boundary,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return { augmentedText: text, attachments: [], skipped: [] };
  }
}

async function executeRun(command: RunCommand, dependencies: CliDependencies): Promise<number> {
  const sessionIdentifier = dependencies.ids.next();
  const runIdentifier = runId(dependencies.ids.next());
  const messageIdentifier = dependencies.ids.next();
  const boundary = await NodeWorkspaceBoundary.create(dependencies.workspacePath ?? process.cwd());
  const mentionContext = await resolveMentionContext(command.prompt, boundary, dependencies.signal);
  const mentionSummary = formatContextAttachmentSummary({
    attached: mentionContext.attachments,
    skipped: mentionContext.skipped,
  });
  if (mentionSummary !== undefined) {
    dependencies.stderr.write(`${mentionSummary}\n`);
  }
  const request = parseModelRequest({
    messages: [
      parseAgentMessage({
        schemaVersion: 1,
        id: messageIdentifier,
        sessionId: sessionIdentifier,
        runId: runIdentifier,
        role: "user",
        status: "complete",
        parts: [{ type: "text", text: mentionContext.augmentedText }],
        createdAt: dependencies.clock.now().toISOString(),
        provenance: { kind: "user", channel: "cli" },
      }),
    ],
    tools: [],
  });
  const resolvedModel = dependencies.registry.resolve(command.modelKey, request);
  const { model } = resolvedModel;
  const accumulator = new ModelStreamAccumulator();
  const modelStartedAt = dependencies.monotonicNow?.() ?? 0;
  let firstTokenLogged = false;

  for await (const event of model.stream(request, {
    runId: runIdentifier,
    attempt: 1,
    idempotencyKey: `${runIdentifier}:model:1`,
    signal: dependencies.signal,
  })) {
    accumulator.consume(event);
    if (event.type === "text.delta" && !firstTokenLogged) {
      firstTokenLogged = true;
      dependencies.logger?.log("info", "model.first_token", {
        sessionId: sessionIdentifier,
        runId: runIdentifier,
        agentId: "main",
        provider: model.providerId,
        model: model.modelId,
        retryCount: 0,
        durationMs: Math.max(0, (dependencies.monotonicNow?.() ?? modelStartedAt) - modelStartedAt),
      });
    }
    if (event.type === "usage.updated") {
      dependencies.logger?.log("info", "model.usage", {
        sessionId: sessionIdentifier,
        runId: runIdentifier,
        agentId: "main",
        provider: model.providerId,
        model: model.modelId,
        ...(event.usage.inputTokens === undefined ? {} : { inputTokens: event.usage.inputTokens }),
        ...(event.usage.outputTokens === undefined
          ? {}
          : { outputTokens: event.usage.outputTokens }),
        ...(event.usage.estimatedCostUsd === undefined
          ? {}
          : { costUsd: event.usage.estimatedCostUsd }),
      });
    }
    if (command.json) {
      dependencies.stdout.write(`${JSON.stringify(event)}\n`);
    } else if (event.type === "text.delta") {
      dependencies.stdout.write(event.delta);
    }
  }

  const outcome = accumulator.finalize();
  if (!command.json) {
    dependencies.stdout.write("\n");
  }
  if (outcome.status !== "completed") {
    dependencies.stderr.write(`${JSON.stringify(outcome)}\n`);
    return 1;
  }
  return 0;
}

async function executeChat(command: ChatCommand, dependencies: CliDependencies): Promise<number> {
  if (dependencies.stdin === undefined) {
    throw new CliUsageError("chat requires an interactive input stream");
  }

  const id = sessionId(command.sessionId ?? dependencies.ids.next());
  const sessions =
    dependencies.persistence?.repositories.sessions ?? new InMemorySessionRepository();
  if (command.sessionId === undefined) {
    await sessions.create({ id, createdAt: dependencies.clock.now().toISOString() });
  } else if ((await sessions.load(id)) === undefined) {
    throw missingSession(command.sessionId);
  }
  const eventFactory = new ChatEventFactory(dependencies.clock);
  if (
    command.ui === "tui" &&
    !command.json &&
    !command.screenReader &&
    dependencies.chatRenderer === undefined
  ) {
    dependencies.stderr.write(
      "pilot: TUI mode is unavailable in this terminal. Use --ui plain or an interactive terminal.\n",
    );
    return 2;
  }
  const renderer =
    dependencies.chatRenderer ??
    new ChatEventRenderer({
      json: command.json,
      stdout: dependencies.stdout,
      stderr: dependencies.stderr,
    });
  const emit = (input: Parameters<ChatEventFactory["create"]>[0]) => {
    renderer.render(eventFactory.create(input));
  };
  const boundary = await NodeWorkspaceBoundary.create(dependencies.workspacePath ?? process.cwd());
  const fileTools = createBuiltinFileListTools(boundary);
  const gitTools = createGitTools(
    boundary,
    ...(dependencies.gitRunner === undefined ? [] : [dependencies.gitRunner]),
  );
  const changeJournal = new InMemoryChangeJournal(dependencies.clock);
  const workspaceFileSystem = new NodeWorkspaceFileSystem(boundary);
  const todoStore = new InMemoryTodoStore();
  const todoTools = createTodoTools(todoStore);
  const environment = dependencies.environment ?? process.env;
  const webSearchConfiguration = dependencies.configuration?.configuration.webSearch;
  const webSearchTool =
    webSearchConfiguration === undefined
      ? undefined
      : createWebSearchTool(
          createTavilyWebSearchProvider({
            apiKey: requireConfiguredSecret(
              webSearchConfiguration.apiKey,
              environment,
              "webSearch.apiKey",
            ),
          }),
        );
  const clarification = new CliUserClarification((request) => {
    emit({ type: "question.requested", sessionId: id, payload: { request } });
  });
  // Language-server diagnostics. Servers start lazily on the first file that needs one, so a
  // session that never edits TypeScript or Python never spawns anything.
  const diagnosticsConfiguration = dependencies.configuration?.configuration.diagnostics;
  const diagnosticsService =
    dependencies.diagnostics ??
    (diagnosticsConfiguration?.enabled === false
      ? undefined
      : new LspDiagnosticsService({
          workspacePath: boundary.rootPath,
          ...(diagnosticsConfiguration?.timeoutMs === undefined
            ? {}
            : { timeoutMs: diagnosticsConfiguration.timeoutMs }),
          onUnavailable: (server, detail) => {
            dependencies.logger?.log("info", "lsp.unavailable", { server: server.id, detail });
          },
        }));
  const diagnosticsOptions = diagnosticsService === undefined ? {} : { port: diagnosticsService };
  const tools =
    dependencies.tools ??
    new ToolRegistry([
      fileTools.listFiles,
      fileTools.glob,
      gitTools.gitDiff,
      gitTools.gitStatus,
      createGrepTool(boundary),
      createReadFileTool(boundary),
      createApplyPatchTool(workspaceFileSystem, changeJournal, diagnosticsOptions),
      createEditFileTool(workspaceFileSystem, changeJournal, diagnosticsOptions),
      createWriteFileTool(workspaceFileSystem, changeJournal, diagnosticsOptions),
      ...(diagnosticsService === undefined
        ? []
        : [createDiagnosticsTool(workspaceFileSystem, diagnosticsService)]),
      todoTools.todoWrite,
      todoTools.todoRead,
      createQuestionTool(clarification),
      createWebFetchTool(),
      ...(webSearchTool === undefined ? [] : [webSearchTool]),
      createRunCommandTool(boundary, {
        environment,
        onOutput: (event, context) => {
          emit({
            type: "command.output",
            sessionId: id,
            runId: context.runId,
            payload: { event },
          });
        },
      }),
    ]);
  const interaction = new CliUserInteraction((request) => {
    emit({
      type: "permission.requested",
      sessionId: id,
      runId: runId(request.context.runId),
      payload: { request },
    });
  });
  const permissions = new PermissionPolicyEngine({
    clock: dependencies.clock,
    ...(dependencies.configuration === undefined
      ? {}
      : { rules: dependencies.configuration.configuration.permissions.rules }),
  });
  const persistedCalls = new Map<
    string,
    { readonly sequence: number; readonly startedAt: string; readonly input: JsonValue }
  >();
  const nextToolSequence = new Map<string, number>();
  const modelStartedAt = new Map<string, number>();
  const toolStartedAt = new Map<string, number>();
  let latestContextSnapshot: PromptCompositionSnapshot | undefined;
  const configuredContext = dependencies.configuration?.configuration.context;
  const sharedTokenEstimator = new Utf8HeuristicTokenEstimator();
  /** Once a provider reports real usage, stop publishing Pilot's own estimate. */
  let providerUsageSeen = false;
  const systemPromptContextSource: ContextSource | undefined =
    dependencies.configuration?.configuration.prompt.systemPrompt === "none"
      ? undefined
      : createSystemPromptContextSource({
          workspacePath: boundary.rootPath,
          platform: process.platform,
          toolNames: tools.list().map(({ definition }) => definition.name),
        });
  const instructionContextSource: ContextSource | undefined =
    dependencies.instructionDiscovery === undefined
      ? undefined
      : {
          id: "instructions",
          priority: 2_000,
          collect: async () => {
            const discovered = await dependencies.instructionDiscovery?.discover({
              ...(dependencies.instructionGlobalPath === undefined
                ? {}
                : { globalPath: dependencies.instructionGlobalPath }),
              targets: [{ path: ".", kind: "directory" }],
              maximumFileBytes: configuredContext?.maxInstructionBytes ?? 131_072,
              maximumTotalBytes: configuredContext?.maxInstructionTotalBytes ?? 524_288,
            });
            if (discovered === undefined) return [];
            if (discovered.diagnostics.length > 0) {
              throw new ContextEngineError(
                "PILOT_CONTEXT_INVALID",
                "Applicable instruction discovery returned rejected files",
                { rejectedFiles: discovered.diagnostics.length },
              );
            }
            return discovered.documents.map((document) => ({
              id: `instruction:${String(document.precedence).padStart(6, "0")}:${document.id}`,
              content: document.content,
              relevance: Math.min(1, document.precedence / 10_000),
              mandatory: true,
              provenance: {
                kind: "instructions" as const,
                trust:
                  document.trust === "trusted-user" ? ("trusted" as const) : ("untrusted" as const),
                reference: document.displayPath,
                sha256: document.sha256 as `sha256:${string}`,
              },
              deduplicationKey: document.sha256,
            }));
          },
        };
  const applicationRunner = new ApplicationRunner({
    registry: dependencies.registry,
    clock: dependencies.clock,
    monotonicClock: { nowMilliseconds: dependencies.monotonicNow ?? (() => Date.now()) },
    checkpointWriter:
      dependencies.persistence === undefined
        ? { write: async () => undefined }
        : new ThrottledRunCheckpointWriter(
            new RepositoryRunLifecycleCheckpointWriter(dependencies.persistence.repositories, id),
            { nowMilliseconds: dependencies.monotonicNow ?? (() => Date.now()) },
            {
              streamIntervalMs:
                dependencies.configuration?.configuration.persistence.checkpointIntervalMs ?? 250,
            },
          ),
    // One estimator for the whole app. This used to be a third, independent heuristic
    // (chars / 4 over the serialized messages) that disagreed with both the context engine and
    // the provider's reported usage.
    estimateModelCall: ({ request }) => ({
      inputTokens: Math.max(
        1,
        request.messages.reduce(
          (total, message) => total + sharedTokenEstimator.estimate(message).tokens,
          0,
        ),
      ),
      outputTokens: request.maxOutputTokens ?? 4_096,
    }),
    retry: { random: Math.random, sleep: abortableDelay },
    tools,
    permissions,
    permissionMode: "interactive",
    userInteraction: interaction,
    contextPreparer: new ConversationModelRequestContextPreparer({
      configuredContextTokens: configuredContext?.maxInputTokens ?? 120_000,
      reservedOutputTokens: configuredContext?.reservedOutputTokens ?? 4_096,
      tokenEstimator: sharedTokenEstimator,
      now: () => dependencies.clock.now().toISOString(),
      ...(() => {
        const sources = [systemPromptContextSource, instructionContextSource].filter(
          (source): source is ContextSource => source !== undefined,
        );
        return sources.length === 0 ? {} : { additionalSources: sources, targetPaths: ["."] };
      })(),
    }),
    onContextPrepared: (snapshot) => {
      latestContextSnapshot = snapshot;
      // Some OpenAI-compatible servers never report usage. Rather than leaving the footer blank,
      // publish the composed estimate — marked as an estimate — so there is always a figure.
      if (!providerUsageSeen) {
        emit({
          type: "model.stream",
          sessionId: id,
          runId: runId(snapshot.runId),
          payload: {
            event: {
              type: "usage.updated",
              sequence: 0,
              responseId: `context:${snapshot.cycle}`,
              usage: { inputTokens: snapshot.composedTokens, source: "estimated" },
            },
          },
        });
      }
    },
    toolResultContextFormatter: new ToolResultContextFormatter({
      maximumBytes: dependencies.configuration?.configuration.context.maxToolResultBytes ?? 32_768,
    }),
    onModelEvent: (event, context) => {
      const now = dependencies.monotonicNow?.() ?? 0;
      if (event.type === "usage.updated" && event.usage.source === "provider") {
        providerUsageSeen = true;
      }
      if (event.type === "response.started") modelStartedAt.set(context.runId, now);
      if (event.type === "text.delta") {
        const startedAt = modelStartedAt.get(context.runId);
        if (startedAt !== undefined) {
          modelStartedAt.delete(context.runId);
          dependencies.logger?.log("info", "model.first_token", {
            sessionId: id,
            runId: context.runId,
            agentId: "main",
            provider: command.modelKey.split("/")[0],
            model: command.modelKey.split("/").slice(1).join("/"),
            retryCount: 0,
            durationMs: Math.max(0, now - startedAt),
          });
        }
      }
      if (event.type === "usage.updated") {
        dependencies.logger?.log("info", "model.usage", {
          sessionId: id,
          runId: context.runId,
          agentId: "main",
          provider: command.modelKey.split("/")[0],
          model: command.modelKey.split("/").slice(1).join("/"),
          ...(event.usage.inputTokens === undefined
            ? {}
            : { inputTokens: event.usage.inputTokens }),
          ...(event.usage.outputTokens === undefined
            ? {}
            : { outputTokens: event.usage.outputTokens }),
          ...(event.usage.estimatedCostUsd === undefined
            ? {}
            : { costUsd: event.usage.estimatedCostUsd }),
        });
      }
      emit({
        type: "model.stream",
        sessionId: id,
        runId: context.runId,
        payload: { event },
      });
    },
    onToolEvent: async (event) => {
      const measurementKey = `${event.runId}\0${event.callId}`;
      const now = dependencies.monotonicNow?.() ?? 0;
      let durationMs: number | undefined;
      if (event.type === "tool.started") toolStartedAt.set(measurementKey, now);
      else {
        const startedAt = toolStartedAt.get(measurementKey);
        toolStartedAt.delete(measurementKey);
        durationMs = startedAt === undefined ? undefined : Math.max(0, now - startedAt);
        dependencies.logger?.log("info", "tool.completed", {
          sessionId: id,
          runId: event.runId,
          agentId: "main",
          tool: event.toolName,
          error: event.isError,
          ...(durationMs === undefined ? {} : { durationMs }),
        });
      }
      emit({
        type: "tool.execution",
        sessionId: id,
        runId: event.runId,
        payload: { event, ...(durationMs === undefined ? {} : { durationMs }) },
      });
      if (dependencies.persistence !== undefined) {
        const databaseStartedAt = dependencies.monotonicNow?.() ?? 0;
        const key = `${event.runId}\u0000${event.callId}`;
        if (event.type === "tool.started") {
          const sequence = (nextToolSequence.get(event.runId) ?? 0) + 1;
          nextToolSequence.set(event.runId, sequence);
          const startedAt = dependencies.clock.now().toISOString();
          persistedCalls.set(key, { sequence, startedAt, input: event.input });
          const risk = riskOfTool(tools, event.toolName);
          await dependencies.persistence.repositories.toolActivity.saveCall({
            runId: event.runId,
            callId: event.callId,
            sequence,
            toolName: event.toolName,
            risk,
            replaySafety: replaySafetyForRisk(risk),
            status: "running",
            input: event.input,
            startedAt,
          });
        } else {
          // A tool.started record is normally present, but it is not worth failing a finished tool
          // call over: fall back to a fresh sequence so the completion is still recorded.
          const started = persistedCalls.get(key) ?? {
            sequence: (nextToolSequence.get(event.runId) ?? 0) + 1,
            startedAt: dependencies.clock.now().toISOString(),
            input: event.output,
          };
          nextToolSequence.set(
            event.runId,
            Math.max(nextToolSequence.get(event.runId) ?? 0, started.sequence),
          );
          const completedAt = dependencies.clock.now().toISOString();
          const risk = riskOfTool(tools, event.toolName);
          await dependencies.persistence.repositories.toolActivity.saveCall({
            runId: event.runId,
            callId: event.callId,
            sequence: started.sequence,
            toolName: event.toolName,
            risk,
            replaySafety: replaySafetyForRisk(risk),
            status: event.isError ? "failed" : "completed",
            input: started.input,
            startedAt: started.startedAt,
            completedAt,
          });
          await dependencies.persistence.repositories.toolActivity.saveResult({
            runId: event.runId,
            callId: event.callId,
            output: event.output,
            isError: event.isError,
            createdAt: completedAt,
          });
          persistedCalls.delete(key);
        }
        dependencies.logger?.log("debug", "database.tool_activity.write", {
          sessionId: id,
          runId: event.runId,
          tool: event.toolName,
          durationMs: Math.max(
            0,
            (dependencies.monotonicNow?.() ?? databaseStartedAt) - databaseStartedAt,
          ),
        });
      }
    },
  });
  const conversation = new SessionConversationRunner({
    runner: applicationRunner,
    sessions,
    clock: dependencies.clock,
    messageIds: dependencies.ids,
    runIds: dependencies.ids,
  });

  let activeModelKey = command.modelKey;
  /** The model's declared context window, so the footer can show usage as a fraction of it. */
  const contextWindowFor = (key: string): number | undefined =>
    dependencies.registry.list().find((descriptor) => descriptor.key === key)?.capabilities
      .maxContextTokens;
  const modelPayload = (key: string) => {
    const contextWindowTokens = contextWindowFor(key);
    return {
      modelKey: key,
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    };
  };
  emit({ type: "chat.started", sessionId: id, payload: modelPayload(activeModelKey) });

  let pendingLine: Promise<string | undefined> | undefined;
  let inputClosed = false;
  const readLine = (): Promise<string | undefined> => {
    pendingLine ??= dependencies.stdin?.readLine() ?? Promise.resolve(undefined);
    return pendingLine;
  };

  try {
    while (!inputClosed) {
      const line = await readLine();
      pendingLine = undefined;
      if (line === undefined) {
        emit({ type: "chat.ended", sessionId: id, payload: { reason: "end-of-input" } });
        return 0;
      }
      const text = line.trim();
      if (text.length === 0) {
        continue;
      }
      if (text === "/exit") {
        emit({ type: "chat.ended", sessionId: id, payload: { reason: "user-exit" } });
        return 0;
      }
      if (text === "/help") {
        emit({
          type: "chat.help",
          sessionId: id,
          payload: {
            commands: ["/help", "/context", "/model <provider/model>", "/abort", "/exit"],
          },
        });
        continue;
      }
      if (text === "/context") {
        emit({
          type: "chat.context",
          sessionId: id,
          payload: {
            ...(latestContextSnapshot === undefined ? {} : { snapshot: latestContextSnapshot }),
          },
        });
        continue;
      }
      if (text === "/model" || text.startsWith("/model ")) {
        const requestedModelKey = text.slice("/model".length).trim();
        if (requestedModelKey.length === 0) {
          dependencies.stderr.write(
            `Usage: /model provider/model. Active model is ${activeModelKey}.\n`,
          );
          continue;
        }
        if (!dependencies.registry.has(requestedModelKey)) {
          dependencies.stderr.write(
            `Unknown model ${requestedModelKey}. Run pilot models to list available models.\n`,
          );
          continue;
        }
        activeModelKey = requestedModelKey;
        emit({
          type: "chat.model.changed",
          sessionId: id,
          payload: modelPayload(activeModelKey),
        });
        continue;
      }
      if (text === "/abort") {
        continue;
      }

      const mentionContext = await resolveMentionContext(text, boundary, dependencies.signal);
      if (mentionContext.attachments.length > 0 || mentionContext.skipped.length > 0) {
        emit({
          type: "chat.context.attached",
          sessionId: id,
          payload: {
            attached: mentionContext.attachments.map(({ path, bytes, truncated }) => ({
              path,
              bytes,
              truncated,
            })),
            skipped: mentionContext.skipped.map(({ path, reason, detail }) => ({
              path,
              reason,
              ...(detail === undefined ? {} : { detail }),
            })),
          },
        });
      }

      const queue = new RunInterruptionQueue();
      const turnStartedAt = dependencies.monotonicNow?.() ?? performance.now();
      // Resolve the per-response output-token cap: an explicit config override wins, otherwise the
      // active model's declared capability, otherwise omit it entirely so the model uses its own
      // default. A hardcoded cap previously starved reasoning models, which spend that budget on
      // hidden thinking and can emit no text before hitting the limit.
      const activeCapabilities = dependencies.registry.has(activeModelKey)
        ? dependencies.registry.resolve(activeModelKey).descriptor.capabilities
        : undefined;
      const maxOutputTokens =
        dependencies.configuration?.configuration.model.maxOutputTokens ??
        activeCapabilities?.maxOutputTokens;
      const turn = conversation.runTurn({
        sessionId: id,
        text: mentionContext.augmentedText,
        channel: "cli",
        modelKey: activeModelKey,
        request: {
          tools: tools.modelDefinitions(),
          ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        },
        retryPolicy: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2_000, jitterRatio: 0.2 },
        // The run budget bounds a single turn's agent loop. Cycle/attempt/tool
        // counts are generous backstops against runaway iteration; wall-clock
        // elapsed time is the meaningful limit. Per-request context size is
        // bounded by context.maxInputTokens, so no cumulative token cap is set
        // unless the user opts into one. All fields are tunable in config.jsonc.
        budgetPolicy:
          dependencies.configuration?.configuration.runBudget ?? builtinConfiguration.runBudget,
        signal: dependencies.signal,
        interruptionQueue: queue,
        permissionContext: {
          workspaceId: boundary.rootPath,
          applicationId: "pilot-cli",
        },
      });
      let exitRequested = false;
      let turnResult: Awaited<typeof turn> | undefined;

      while (turnResult === undefined) {
        if (inputClosed) {
          turnResult = await turn;
          break;
        }
        const raced = await Promise.race([
          turn.then((result) => ({ type: "turn" as const, result })),
          readLine().then((nextLine) => ({ type: "line" as const, line: nextLine })),
        ]);
        if (raced.type === "turn") {
          turnResult = raced.result;
          break;
        }

        pendingLine = undefined;
        if (raced.line === undefined) {
          inputClosed = true;
          if (interaction.pendingRequest !== undefined) {
            queue.enqueue({ type: "cancel", reason: "user-cancelled" });
          }
          // A question nobody can answer fails only that tool call, so the turn still finishes:
          // the model continues on its own assumption rather than losing the work done so far.
          const unansweredId = clarification.pendingRequest?.requestId;
          clarification.close();
          if (unansweredId !== undefined) {
            emit({
              type: "question.answered",
              sessionId: id,
              payload: { requestId: unansweredId, answer: "", unanswered: true },
            });
          }
          continue;
        }
        const followUpText = raced.line.trim();
        if (followUpText.length === 0 || followUpText === "/help" || followUpText === "/context") {
          if (followUpText === "/help") {
            emit({
              type: "chat.help",
              sessionId: id,
              payload: {
                commands: ["/help", "/context", "/model <provider/model>", "/abort", "/exit"],
              },
            });
          }
          if (followUpText === "/context") {
            emit({
              type: "chat.context",
              sessionId: id,
              payload: {
                ...(latestContextSnapshot === undefined ? {} : { snapshot: latestContextSnapshot }),
              },
            });
          }
          continue;
        }
        if (followUpText === "/abort" || followUpText === "/exit") {
          queue.enqueue({ type: "cancel", reason: "user-cancelled" });
          exitRequested = followUpText === "/exit";
          continue;
        }

        const permissionInput = interaction.respond(followUpText);
        if (permissionInput === "accepted") continue;
        if (permissionInput === "invalid") {
          const request = interaction.pendingRequest;
          if (request !== undefined) {
            emit({
              type: "permission.response.invalid",
              sessionId: id,
              runId: runId(request.context.runId),
              payload: { requestId: request.requestId },
            });
          }
          continue;
        }

        // A pending question owns the next line: it is an answer, not a follow-up prompt.
        const pendingQuestion = clarification.pendingRequest;
        const questionInput = clarification.respond(followUpText);
        if (questionInput === "accepted") {
          if (pendingQuestion !== undefined) {
            emit({
              type: "question.answered",
              sessionId: id,
              payload: { requestId: pendingQuestion.requestId, answer: followUpText },
            });
          }
          continue;
        }
        if (questionInput === "invalid") {
          if (pendingQuestion !== undefined) {
            emit({
              type: "question.response.invalid",
              sessionId: id,
              payload: { requestId: pendingQuestion.requestId },
            });
          }
          continue;
        }

        const queuedMessage = parseAgentMessage({
          schemaVersion: 1,
          id: messageId(dependencies.ids.next()),
          sessionId: id,
          runId: runId("queued-follow-up"),
          role: "user",
          status: "complete",
          parts: [{ type: "text", text: followUpText }],
          createdAt: dependencies.clock.now().toISOString(),
          provenance: { kind: "user", channel: "cli" },
        });
        queue.enqueue({ type: "follow-up", message: queuedMessage });
        emit({
          type: "chat.input.queued",
          sessionId: id,
          payload: { messageId: queuedMessage.id },
        });
      }

      const lastRun = turnResult.runs.at(-1);
      const turnDurationMs = Math.max(
        0,
        (dependencies.monotonicNow?.() ?? performance.now()) - turnStartedAt,
      );
      if (turnResult.assistantMessage !== undefined) {
        emit({
          type: "chat.turn.completed",
          sessionId: id,
          ...(lastRun === undefined ? {} : { runId: lastRun.runId }),
          payload: {
            runCount: turnResult.runs.length,
            assistantMessage: turnResult.assistantMessage,
            durationMs: turnDurationMs,
          },
        });
      } else if (lastRun?.result.state.kind === "aborted") {
        emit({
          type: "chat.turn.aborted",
          sessionId: id,
          runId: lastRun.runId,
          payload: { state: lastRun.result.state, durationMs: turnDurationMs },
        });
      } else if (lastRun?.result.state.kind === "failed") {
        emit({
          type: "chat.turn.failed",
          sessionId: id,
          runId: lastRun.runId,
          payload: { error: lastRun.result.state.error, durationMs: turnDurationMs },
        });
      }

      if (turnResult.incomplete !== undefined) {
        emit({
          type: "chat.turn.incomplete",
          sessionId: id,
          runId: turnResult.incomplete.runId,
          payload: {
            reason: turnResult.incomplete.reason,
            finishReason: turnResult.incomplete.finishReason,
            hasPartialText: turnResult.incomplete.hasPartialText,
            durationMs: turnDurationMs,
          },
        });
      }

      if (exitRequested || inputClosed) {
        emit({
          type: "chat.ended",
          sessionId: id,
          payload: { reason: exitRequested ? "user-exit" : "end-of-input" },
        });
        return 0;
      }
    }

    return 0;
  } finally {
    // Language servers are long-lived subprocesses holding memory proportional to project size.
    // They outlive the chat loop unless the session tears them down on every exit path.
    if (diagnosticsService instanceof LspDiagnosticsService) {
      await diagnosticsService.shutdown();
    }
  }
}

/**
 * Risk of a tool that may not be registered.
 *
 * The scheduler emits `tool.started` before it resolves the tool, so a name the model invented
 * reaches this observer. Resolving it unconditionally threw `ToolNotFoundError` out of the observer,
 * which the scheduler awaits outside its own try block — turning a recoverable "no such tool" result
 * into a failed run that discarded the whole turn.
 */
function riskOfTool(registry: ToolRegistry, toolName: string): ToolRisk {
  return registry.has(toolName) ? registry.resolve(toolName).definition.metadata.risk : "unknown";
}

function replaySafetyForRisk(risk: ToolRisk): "safe" | "unknown" | "unsafe" {
  if (risk === "read-only") return "safe";
  return risk === "network" || risk === "unknown" ? "unknown" : "unsafe";
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function yesNo(value: boolean): "no" | "yes" {
  return value ? "yes" : "no";
}
