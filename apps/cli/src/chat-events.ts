import type {
  AgentMessage,
  ClarificationRequest,
  Clock,
  FinishReason,
  JsonValue,
  ModelStreamEvent,
  PermissionApprovalRequest,
  RunId,
  SafeErrorSnapshot,
  SessionId,
} from "@pilotrun/core";
import type {
  ConversationIncomplete,
  PromptCompositionSnapshot,
  RunState,
  ToolExecutionLifecycleEvent,
} from "@pilotrun/agent-runtime";
import type { CommandOutputEvent } from "@pilotrun/tools-builtin";
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
  | ChatEventBase<
      "chat.started",
      { readonly modelKey: string; readonly contextWindowTokens?: number }
    >
  | ChatEventBase<
      "chat.model.changed",
      { readonly modelKey: string; readonly contextWindowTokens?: number }
    >
  | ChatEventBase<"chat.help", { readonly commands: readonly string[] }>
  | ChatEventBase<"chat.context", { readonly snapshot?: PromptCompositionSnapshot }>
  | ChatEventBase<"chat.input.queued", { readonly messageId: string }>
  | ChatEventBase<
      "chat.context.attached",
      {
        readonly attached: readonly {
          readonly path: string;
          readonly bytes: number;
          readonly truncated: boolean;
        }[];
        readonly skipped: readonly {
          readonly path: string;
          readonly reason: string;
          readonly detail?: string;
        }[];
      }
    >
  | ChatEventBase<"model.stream", { readonly event: ModelStreamEvent }>
  | ChatEventBase<
      "tool.execution",
      { readonly event: ToolExecutionLifecycleEvent; readonly durationMs?: number }
    >
  | ChatEventBase<"command.output", { readonly event: CommandOutputEvent }>
  | ChatEventBase<"permission.requested", { readonly request: PermissionApprovalRequest }>
  | ChatEventBase<"permission.response.invalid", { readonly requestId: string }>
  | ChatEventBase<"question.requested", { readonly request: ClarificationRequest }>
  | ChatEventBase<"question.response.invalid", { readonly requestId: string }>
  | ChatEventBase<
      "question.answered",
      { readonly requestId: string; readonly answer: string; readonly unanswered?: boolean }
    >
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
  | ChatEventBase<
      "chat.turn.incomplete",
      {
        readonly reason: ConversationIncomplete["reason"];
        readonly finishReason: FinishReason;
        readonly hasPartialText: boolean;
        readonly durationMs?: number;
      }
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
      case "chat.context.attached": {
        const summary = formatContextAttachmentSummary(event.payload);
        if (summary !== undefined) {
          this.#stdout.write(`${summary}\n`);
        }
        break;
      }
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
      case "question.requested": {
        const request = event.payload.request;
        this.#stdout.write(`\n[question] ${sanitizeTerminalText(request.question)}\n`);
        request.options.forEach((option, index) => {
          const description =
            option.description === undefined
              ? ""
              : ` — ${sanitizeTerminalText(option.description)}`;
          const label = sanitizeTerminalText(option.label);
          this.#stdout.write(`  ${index + 1}. ${label}${description}\n`);
        });
        this.#stdout.write(
          request.options.length === 0
            ? "Type your answer to continue.\n"
            : `Answer with a number 1-${request.options.length}${
                request.allowsFreeformAnswer ? ", or type your own answer" : ""
              }.\n`,
        );
        break;
      }
      case "question.response.invalid":
        this.#stderr.write("Invalid answer. Choose one of the listed options by number.\n");
        break;
      case "question.answered":
        if (event.payload.unanswered) {
          this.#stderr.write("[question unanswered: input closed]\n");
        }
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
      case "chat.turn.incomplete":
        this.#stderr.write(`\n${formatIncompleteNotice(event.payload)}\n`);
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

/**
 * Renders a one-line summary of the files attached via `@` mentions and any
 * mentions that were skipped (including ignore-blocked files). Returns
 * `undefined` when there is nothing to report.
 */
export function formatContextAttachmentSummary(payload: {
  readonly attached: readonly { readonly path: string; readonly truncated: boolean }[];
  readonly skipped: readonly {
    readonly path: string;
    readonly reason: string;
    readonly detail?: string;
  }[];
}): string | undefined {
  if (payload.attached.length === 0 && payload.skipped.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  for (const file of payload.attached) {
    parts.push(`+${file.path}${file.truncated ? " (truncated)" : ""}`);
  }
  for (const file of payload.skipped) {
    parts.push(`-${file.path} (${describeSkipReason(file.reason, file.detail)})`);
  }
  return `[context: ${parts.join(", ")}]`;
}

/**
 * Renders the warning shown when a turn ends without a clean completion — a truncated,
 * content-filtered, errored, or empty response. The turn itself is not a failure, so this is a
 * notice on stderr rather than an error.
 */
export function formatIncompleteNotice(payload: {
  readonly reason: ConversationIncomplete["reason"];
  readonly finishReason: FinishReason;
  readonly hasPartialText: boolean;
}): string {
  const cause = describeIncompleteReason(payload.reason, payload.finishReason);
  const tail = payload.hasPartialText
    ? "the response above may be cut off"
    : "no response text was returned";
  return `[incomplete: ${cause} — ${tail}]`;
}

function describeIncompleteReason(
  reason: ConversationIncomplete["reason"],
  finishReason: FinishReason,
): string {
  switch (reason) {
    case "truncated":
      return "the model reached its output token limit";
    case "content-filtered":
      return "the response was stopped by a content filter";
    case "model-error":
      return `the model ended abnormally (${finishReason})`;
    default:
      return "the model returned an empty response";
  }
}

function describeSkipReason(reason: string, detail: string | undefined): string {
  switch (reason) {
    case "ignored":
      return detail === undefined ? "ignored" : `ignored by ${detail}`;
    case "not-found":
      return "not found";
    case "outside-workspace":
      return "outside workspace";
    case "not-a-file":
      return "not a file";
    case "budget-exceeded":
      return "context budget reached";
    case "unreadable":
      return "unreadable";
    default:
      return reason;
  }
}

function patchFromInput(input: JsonValue): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const patch = (input as Readonly<Record<string, JsonValue>>).patch;
  return typeof patch === "string" ? patch : undefined;
}
