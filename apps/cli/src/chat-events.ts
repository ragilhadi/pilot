import type {
  AgentMessage,
  Clock,
  JsonValue,
  ModelStreamEvent,
  PermissionApprovalRequest,
  RunId,
  SafeErrorSnapshot,
  SessionId,
} from "@pilot/core";
import type {
  PromptCompositionSnapshot,
  RunState,
  ToolExecutionLifecycleEvent,
} from "@pilot/agent-runtime";
import type { CommandOutputEvent } from "@pilot/tools-builtin";
import type { TextWriter } from "./cli.js";
import { sanitizeTerminalText } from "./presentation/sanitize-terminal-text.js";

export const chatEventSchemaVersion = 1 as const;

interface ChatEventBase<Type extends string, Payload> {
  readonly schemaVersion: typeof chatEventSchemaVersion;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: Type;
  readonly sessionId: SessionId;
  readonly runId?: RunId;
  readonly payload: Payload;
}

export type ChatEvent =
  | ChatEventBase<"chat.started", { readonly modelKey: string }>
  | ChatEventBase<"chat.model.changed", { readonly modelKey: string }>
  | ChatEventBase<"chat.help", { readonly commands: readonly string[] }>
  | ChatEventBase<"chat.context", { readonly snapshot?: PromptCompositionSnapshot }>
  | ChatEventBase<"chat.input.queued", { readonly messageId: string }>
  | ChatEventBase<"model.stream", { readonly event: ModelStreamEvent }>
  | ChatEventBase<
      "tool.execution",
      { readonly event: ToolExecutionLifecycleEvent; readonly durationMs?: number }
    >
  | ChatEventBase<"command.output", { readonly event: CommandOutputEvent }>
  | ChatEventBase<"permission.requested", { readonly request: PermissionApprovalRequest }>
  | ChatEventBase<"permission.response.invalid", { readonly requestId: string }>
  | ChatEventBase<
      "chat.turn.completed",
      {
        readonly runCount: number;
        readonly assistantMessage: AgentMessage;
        readonly durationMs?: number;
      }
    >
  | ChatEventBase<"chat.turn.aborted", { readonly state: RunState; readonly durationMs?: number }>
  | ChatEventBase<
      "chat.turn.failed",
      { readonly error: SafeErrorSnapshot; readonly durationMs?: number }
    >
  | ChatEventBase<"chat.ended", { readonly reason: "end-of-input" | "user-exit" }>;

export type ChatEventInput = ChatEvent extends infer Event
  ? Event extends ChatEvent
    ? Omit<Event, "occurredAt" | "schemaVersion" | "sequence">
    : never
  : never;

export class ChatEventFactory {
  readonly #clock: Clock;
  #sequence = 0;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  create(input: ChatEventInput): ChatEvent {
    this.#sequence += 1;
    return Object.freeze({
      schemaVersion: chatEventSchemaVersion,
      sequence: this.#sequence,
      occurredAt: this.#clock.now().toISOString(),
      ...input,
    }) as ChatEvent;
  }
}

export class ChatEventRenderer {
  readonly #json: boolean;
  readonly #stdout: TextWriter;
  readonly #stderr: TextWriter;

  constructor(options: {
    readonly json: boolean;
    readonly stdout: TextWriter;
    readonly stderr: TextWriter;
  }) {
    this.#json = options.json;
    this.#stdout = options.stdout;
    this.#stderr = options.stderr;
  }

  render(event: ChatEvent): void {
    if (this.#json) {
      this.#stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }

    switch (event.type) {
      case "chat.started":
        this.#stdout.write(
          `Pilot chat — ${event.payload.modelKey}\nType /help for commands, /abort to cancel, /exit to quit.\n`,
        );
        break;
      case "chat.model.changed":
        this.#stdout.write(`\n[model: ${event.payload.modelKey}]\n`);
        break;
      case "chat.help":
        this.#stdout.write(`${event.payload.commands.join("  ")}\n`);
        break;
      case "chat.context":
        this.#renderContext(event.payload.snapshot);
        break;
      case "chat.input.queued":
        this.#stdout.write("\n[follow-up queued]\n");
        break;
      case "model.stream":
        if (event.payload.event.type === "text.delta") {
          this.#stdout.write(event.payload.event.delta);
        }
        break;
      case "tool.execution":
        if (event.payload.event.type === "tool.started") {
          this.#stdout.write(`\n[tool: ${event.payload.event.toolName}]\n`);
        }
        break;
      case "command.output":
        (event.payload.event.stream === "stdout" ? this.#stdout : this.#stderr).write(
          event.payload.event.chunk,
        );
        break;
      case "permission.requested": {
        const action = event.payload.request.action;
        const name = sanitizeTerminalText(
          action.kind === "tool" ? action.toolName : action.executable,
        );
        const proposedPatch =
          action.kind === "tool" && action.toolName === "apply_patch"
            ? patchFromInput(action.input)
            : undefined;
        this.#stdout.write(
          `\n[approval required: ${name} (${action.risk})]\nRespond with allow or deny, optionally followed by: ${event.payload.request.availableScopes.join(
            ", ",
          )}\n`,
        );
        if (proposedPatch !== undefined) {
          this.#stdout.write(`[proposed diff]\n${sanitizeTerminalText(proposedPatch)}`);
          if (!proposedPatch.endsWith("\n")) this.#stdout.write("\n");
        }
        if (action.kind === "command") {
          this.#stdout.write(
            `[command] ${sanitizeTerminalText(action.executable)} ${sanitizeTerminalText(action.args.join(" "))}\n`,
          );
        }
        break;
      }
      case "permission.response.invalid":
        this.#stderr.write(
          "Invalid approval response. Use allow or deny followed by an available scope.\n",
        );
        break;
      case "chat.turn.completed":
        this.#stdout.write("\n");
        break;
      case "chat.turn.aborted":
        this.#stdout.write(
          `\n[aborted: ${event.payload.state.kind === "aborted" ? event.payload.state.reason : "unknown"}]\n`,
        );
        break;
      case "chat.turn.failed":
        this.#stderr.write(`[error: ${event.payload.error.message}]\n`);
        break;
      case "chat.ended":
        this.#stdout.write(`[chat ended: ${event.payload.reason}]\n`);
        break;
    }
  }

  #renderContext(snapshot: PromptCompositionSnapshot | undefined): void {
    if (snapshot === undefined) {
      this.#stdout.write("[context unavailable: run a turn first]\n");
      return;
    }
    this.#stdout.write(
      `[context cycle ${snapshot.cycle}: ${snapshot.selected.length} selected, ${snapshot.excluded.length} excluded; ${snapshot.composedTokens}/${snapshot.budget.availableCandidateTokens} composed tokens; ${snapshot.remainingModelTokens} remaining]\n`,
    );
    this.#stdout.write(`[fingerprint ${snapshot.fingerprint}]\n`);
    for (const entry of snapshot.selected) {
      this.#stdout.write(
        `+ ${sanitizeTerminalText(entry.id)} source=${sanitizeTerminalText(entry.sourceId)} tokens=${entry.estimatedTokens} priority=${entry.sourcePriority} mandatory=${entry.mandatory} trust=${entry.trust} ref=${sanitizeTerminalText(entry.reference)}\n`,
      );
    }
    for (const entry of snapshot.excluded) {
      this.#stdout.write(
        `- ${sanitizeTerminalText(entry.id)} reason=${entry.reason} source=${sanitizeTerminalText(entry.sourceId)} tokens=${entry.estimatedTokens} ref=${sanitizeTerminalText(entry.reference)}\n`,
      );
    }
  }
}

function patchFromInput(input: JsonValue): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const patch = (input as Readonly<Record<string, JsonValue>>).patch;
  return typeof patch === "string" ? patch : undefined;
}
