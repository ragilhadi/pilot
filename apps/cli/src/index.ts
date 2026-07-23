#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { InstructionDiscovery, runtimeVersion } from "@pilot/agent-runtime";
import {
  createSqliteRepositories,
  SqliteCrashRecovery,
  SqliteDatabase,
  SqliteMigrationRunner,
  SqliteSessionAdministration,
} from "@pilot/persistence-sqlite";
import {
  type AppStartedEvent,
  type Clock,
  correlationId,
  eventId,
  eventSchemaVersion,
  type IdSource,
  toSafeErrorSnapshot,
} from "@pilot/core";
import { remediationForError, runCli } from "./cli.js";
import { defaultConfigurationPaths, loadCliConfiguration } from "./configuration.js";
import { NodeInstructionFileReader } from "./node-instruction-reader.js";
import { PilotDoctor } from "./diagnostics.js";
import { createModelCatalog, inspectProviderCredentials } from "./model-catalog.js";
import type { InteractiveChatPresentation } from "./presentation/chat-presentation.js";
import { detectTerminalCapabilities } from "./presentation/terminal-capabilities.js";
import {
  isPresentationMode,
  resolvePresentationMode,
  type PresentationMode,
} from "./presentation/presentation-mode.js";
import { type LogLevel, StructuredLogger } from "./structured-logger.js";

const execFileAsync = promisify(execFile);

export {
  ChatEventFactory,
  ChatEventRenderer,
  chatEventSchemaVersion,
  type ChatEvent,
  type ChatEventInput,
} from "./chat-events.js";
export { CliUserInteraction, type PermissionInputResult } from "./cli-user-interaction.js";
export type {
  ChatEventSink,
  InteractiveChatPresentation,
} from "./presentation/chat-presentation.js";
export {
  isPresentationMode,
  presentationModes,
  resolvePresentationMode,
  type PresentationMode,
  type PresentationSelection,
  type ResolvedPresentationMode,
  type TerminalCapabilitySnapshot,
} from "./presentation/presentation-mode.js";
export {
  detectTerminalCapabilities,
  type TerminalEnvironment,
} from "./presentation/terminal-capabilities.js";
export { sanitizeTerminalText } from "./presentation/sanitize-terminal-text.js";
export {
  initialTerminalUiState,
  reduceTerminalUi,
  type TerminalUiAction,
  type TerminalUiPhase,
  type TerminalUiState,
  type TranscriptBlock,
} from "./tui/terminal-ui-state.js";
export {
  remediationForError,
  runCli,
  type CliDependencies,
  type LineReader,
  type TextWriter,
} from "./cli.js";
export {
  type CliConfigurationPaths,
  defaultConfigurationPaths,
  type LoadCliConfigurationOptions,
  loadCliConfiguration,
  pilotConfigEnvironmentVariable,
} from "./configuration.js";
export { NodeInstructionFileReader } from "./node-instruction-reader.js";
export {
  type DiagnosticCheck,
  type DiagnosticStatus,
  type DoctorDependencies,
  type DoctorReport,
  PilotDoctor,
  type ProviderCredentialDiagnostic,
  renderDoctorReport,
} from "./diagnostics.js";
export {
  compatibleModelsEnvironmentVariable,
  createModelCatalog,
  defaultCliModelKey,
  defaultOllamaBaseUrl,
  ollamaBaseUrlEnvironmentVariable,
  type CliEnvironment,
  type ModelCatalogDependencies,
  inspectProviderCredentials,
  type ProviderCredentialStatus,
} from "./model-catalog.js";
export {
  type LogLevel,
  redactStructuredValue,
  type StructuredLoggerOptions,
  StructuredLogger,
} from "./structured-logger.js";

export const applicationVersion = "0.0.0";
export const pilotDataDirectoryEnvironmentVariable = "PILOT_DATA_DIR";
export const pilotLogLevelEnvironmentVariable = "PILOT_LOG_LEVEL";

export interface StartupEventDependencies {
  readonly clock: Clock;
  readonly ids: IdSource;
}

export function createAppStartedEvent(dependencies: StartupEventDependencies): AppStartedEvent {
  return {
    schemaVersion: eventSchemaVersion,
    id: eventId(dependencies.ids.next()),
    sequence: 1,
    type: "app.started",
    occurredAt: dependencies.clock.now().toISOString(),
    correlationId: correlationId(dependencies.ids.next()),
    payload: {
      application: "pilot",
      version: applicationVersion,
      runtimeVersion,
    },
  };
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (args.length > 0) {
    const processStartedAt = performance.now();
    const controller = new AbortController();
    const capabilities = detectTerminalCapabilities({
      stdinIsTTY: process.stdin.isTTY,
      stdoutIsTTY: process.stdout.isTTY,
      columns: process.stdout.columns,
      rows: process.stdout.rows,
      platform: process.platform,
      environment: process.env,
    });
    const requestedPresentation = presentationFromArguments(args);
    const useTui = shouldUseTui(args, requestedPresentation, capabilities);
    const lines =
      args[0] === "chat" && !useTui
        ? createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
        : undefined;
    const iterator = lines?.[Symbol.asyncIterator]();
    let sessionDatabase: SqliteDatabase | undefined;
    let chatPresentation: InteractiveChatPresentation | undefined;
    let receivedSignal: "SIGHUP" | "SIGINT" | "SIGTERM" | undefined;
    const cancelForSignal = (signal: "SIGHUP" | "SIGINT" | "SIGTERM") => {
      receivedSignal ??= signal;
      controller.abort(signal);
      lines?.close();
      void chatPresentation?.close();
    };
    const cancelForHangup = () => cancelForSignal("SIGHUP");
    const cancelForInterrupt = () => cancelForSignal("SIGINT");
    const cancelForTermination = () => cancelForSignal("SIGTERM");
    process.once("SIGHUP", cancelForHangup);
    process.once("SIGINT", cancelForInterrupt);
    process.once("SIGTERM", cancelForTermination);
    try {
      try {
        const defaultDataDirectory =
          process.env[pilotDataDirectoryEnvironmentVariable] ?? path.join(homedir(), ".pilot");
        const configuration = await loadCliConfiguration({
          paths: defaultConfigurationPaths({
            dataDirectory: defaultDataDirectory,
            workspaceDirectory: process.cwd(),
            environment: process.env,
          }),
        });
        const usesPersistence =
          args[0] === "chat" || args[0] === "sessions" || args[0] === "doctor";
        const usesInstructions = args[0] === "instructions" || args[0] === "chat";
        let persistence: Parameters<typeof runCli>[1]["persistence"];
        if (usesPersistence) {
          const configuredDirectory = configuration.configuration.persistence.dataDirectory;
          const dataDirectory =
            configuredDirectory === undefined
              ? defaultDataDirectory
              : path.resolve(process.cwd(), configuredDirectory);
          mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
          sessionDatabase = new SqliteDatabase(path.join(dataDirectory, "sessions.db"));
          new SqliteMigrationRunner(sessionDatabase).migrate();
          new SqliteCrashRecovery(sessionDatabase).recover(new Date().toISOString());
          const repositories = createSqliteRepositories(sessionDatabase);
          persistence = {
            database: sessionDatabase,
            repositories,
            administration: new SqliteSessionAdministration(sessionDatabase, repositories),
          };
        }
        const instructionDiscovery = usesInstructions
          ? new InstructionDiscovery(await NodeInstructionFileReader.create(process.cwd()))
          : undefined;
        const configuredDataDirectory = configuration.configuration.persistence.dataDirectory;
        const instructionDataDirectory =
          configuredDataDirectory === undefined
            ? defaultDataDirectory
            : path.resolve(process.cwd(), configuredDataDirectory);
        const registry = createModelCatalog({ environment: process.env });
        const logger = new StructuredLogger({
          writer: process.stderr,
          level: parseLogLevel(process.env[pilotLogLevelEnvironmentVariable]),
          secrets: configuredSecretValues(process.env),
        });
        const doctor = new PilotDoctor({
          now: () => new Date(),
          monotonicNow: () => performance.now(),
          startedAtMs: processStartedAt,
          nodeVersion: process.version,
          memoryRssBytes: () => process.memoryUsage().rss,
          workspacePath: process.cwd(),
          ...(persistence?.database === undefined ? {} : { database: persistence.database }),
          providerCredentials: inspectProviderCredentials(process.env),
          probeCommand,
        });
        if (useTui) {
          const [{ ProcessTerminal }, { TerminalChatPresentation }] = await Promise.all([
            import("@earendil-works/pi-tui"),
            import("./tui/terminal-chat-presentation.js"),
          ]);
          chatPresentation = new TerminalChatPresentation({
            terminal: new ProcessTerminal(),
            capabilities,
            workspacePath: process.cwd(),
            models: registry.list().map(({ key, displayName }) => ({ key, displayName })),
            ...(persistence === undefined
              ? {}
              : {
                  sessions: persistence.administration.list({ limit: 50 }).map((session) => ({
                    id: String(session.id),
                    status: session.status,
                    messageCount: session.messageCount,
                    updatedAt: session.updatedAt,
                  })),
                }),
            ...(await inspectRepositoryDisplay(process.cwd())),
          });
        }
        const commandExitCode = await runCli(args, {
          registry,
          configuration,
          clock: { now: () => new Date() },
          ids: { next: randomUUID },
          stdout: process.stdout,
          stderr: process.stderr,
          signal: controller.signal,
          ...(chatPresentation !== undefined
            ? { stdin: chatPresentation, chatRenderer: chatPresentation }
            : iterator === undefined
              ? {}
              : {
                  stdin: {
                    readLine: async () => {
                      const next = await iterator.next();
                      return next.done ? undefined : next.value;
                    },
                  },
                }),
          monotonicNow: () => performance.now(),
          doctor,
          logger,
          ...(persistence === undefined ? {} : { persistence }),
          ...(instructionDiscovery === undefined
            ? {}
            : {
                instructionDiscovery,
                instructionGlobalPath: path.join(instructionDataDirectory, "AGENTS.md"),
              }),
        });
        const exitCode =
          receivedSignal === "SIGHUP"
            ? 129
            : receivedSignal === "SIGINT"
              ? 130
              : receivedSignal === "SIGTERM"
                ? 143
                : commandExitCode;
        logger.log("info", "app.startup.completed", {
          durationMs: Math.max(0, performance.now() - processStartedAt),
          memoryRssBytes: process.memoryUsage().rss,
          command: args[0],
        });
        return exitCode;
      } catch (error) {
        const snapshot = toSafeErrorSnapshot(error);
        process.stderr.write(
          `${JSON.stringify({ ...snapshot, remediation: remediationForError(snapshot.code) })}\n`,
        );
        return 1;
      }
    } finally {
      lines?.close();
      await chatPresentation?.close();
      sessionDatabase?.close();
      process.removeListener("SIGHUP", cancelForHangup);
      process.removeListener("SIGINT", cancelForInterrupt);
      process.removeListener("SIGTERM", cancelForTermination);
    }
  }

  const event = createAppStartedEvent({
    clock: { now: () => new Date() },
    ids: { next: randomUUID },
  });

  process.stdout.write(`${JSON.stringify(event)}\n`);
  return 0;
}

function presentationFromArguments(args: readonly string[]): PresentationMode {
  const index = args.indexOf("--ui");
  const value = index < 0 ? undefined : args[index + 1];
  return value !== undefined && isPresentationMode(value) ? value : "auto";
}

function shouldUseTui(
  args: readonly string[],
  requested: PresentationMode,
  capabilities: ReturnType<typeof detectTerminalCapabilities>,
): boolean {
  if (args[0] !== "chat") return false;
  try {
    return (
      resolvePresentationMode({
        requested,
        json: args.includes("--json"),
        screenReader: args.includes("--screen-reader"),
        capabilities,
      }) === "tui"
    );
  } catch {
    // Command parsing and execution report an explicit --ui tui incompatibility
    // through the normal CLI error boundary, after stdin has a plain fallback.
    return false;
  }
}

function parseLogLevel(value: string | undefined): LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : "warn";
}

function configuredSecretValues(environment: NodeJS.ProcessEnv): readonly string[] {
  return Object.entries(environment)
    .filter(
      ([name, value]) =>
        value !== undefined && /(?:api[_-]?key|credential|password|secret|token)/iu.test(name),
    )
    .flatMap(([, value]) => (value === undefined ? [] : [value]));
}

async function probeCommand(kind: "git" | "shell"): Promise<boolean> {
  const executable =
    kind === "git"
      ? "git"
      : process.platform === "win32"
        ? (process.env.ComSpec ?? "cmd.exe")
        : (process.env.SHELL ?? "/bin/sh");
  const args =
    kind === "git"
      ? ["--version"]
      : process.platform === "win32"
        ? ["/d", "/c", "exit 0"]
        : ["-c", "true"];
  try {
    await execFileAsync(executable, args, { timeout: 3_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function inspectRepositoryDisplay(
  workspacePath: string,
): Promise<{ readonly repository?: { readonly branch: string; readonly dirty: boolean } }> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], {
      cwd: workspacePath,
      timeout: 3_000,
      windowsHide: true,
    });
    const lines = stdout.trimEnd().split(/\r?\n/u);
    const branchLine = lines[0];
    if (branchLine === undefined || !branchLine.startsWith("## ")) return {};
    const branch = branchLine.slice(3).split("...")[0]?.trim() || "detached";
    return { repository: { branch, dirty: lines.length > 1 } };
  } catch {
    return {};
  }
}

const entryPath = process.argv[1];
const resolvedEntryPath = entryPath === undefined ? undefined : realpathSync(entryPath);

if (resolvedEntryPath !== undefined && pathToFileURL(resolvedEntryPath).href === import.meta.url) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
