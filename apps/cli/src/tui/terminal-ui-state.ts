import type { JsonValue, PermissionApprovalRequest, SafeErrorSnapshot } from "@pilotrun/core";
import type { PromptCompositionSnapshot, RunState } from "@pilotrun/agent-runtime";
import type { ChatEvent } from "../chat-events.js";

export type TerminalUiPhase =
  | "starting"
  | "ready"
  | "streaming"
  | "running-tool"
  | "awaiting-permission"
  | "aborted"
  | "failed"
  | "ended";

export interface UserTranscriptBlock {
  readonly kind: "user";
  readonly id: string;
  readonly text: string;
}

export interface AssistantTranscriptBlock {
  readonly kind: "assistant";
  readonly id: string;
  readonly responseId: string;
  readonly text: string;
  readonly status: "streaming" | "completed" | "failed" | "aborted";
}

export interface ToolTranscriptBlock {
  readonly kind: "tool";
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly output?: JsonValue;
  readonly commandOutput: string;
  readonly durationMs?: number;
  readonly truncated?: boolean;
  readonly status: "running" | "completed" | "failed" | "cancelled";
}

export interface ChangedFileSummary {
  readonly path: string;
  readonly additions?: number;
  readonly deletions?: number;
}

export interface CommandSummary {
  readonly command: string;
  readonly status: "completed" | "failed" | "timed-out" | "unknown";
  readonly exitCode?: number | null;
  readonly durationMs?: number;
  readonly truncated: boolean;
}

export interface TurnSummary {
  readonly outcome: "completed" | "failed" | "cancelled";
  readonly runCount: number;
  readonly toolCount: number;
  readonly failedToolCount: number;
  readonly changedFiles: readonly ChangedFileSummary[];
  readonly commands: readonly CommandSummary[];
  readonly tests: readonly CommandSummary[];
  readonly usage: TerminalUsageState;
  readonly elapsedMs?: number;
  readonly error?: string;
}

export interface TurnSummaryTranscriptBlock {
  readonly kind: "summary";
  readonly id: string;
  readonly summary: TurnSummary;
}

export interface NoticeTranscriptBlock {
  readonly kind: "notice";
  readonly id: string;
  readonly tone: "info" | "warning" | "danger" | "success";
  readonly text: string;
}

export type TranscriptBlock =
  | UserTranscriptBlock
  | AssistantTranscriptBlock
  | ToolTranscriptBlock
  | NoticeTranscriptBlock
  | TurnSummaryTranscriptBlock;

export interface TerminalUsageState {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedCostUsd?: number;
}

export interface TerminalUiState {
  readonly sessionId?: string;
  readonly modelKey?: string;
  readonly phase: TerminalUiPhase;
  readonly lastEventSequence: number;
  readonly blocks: readonly TranscriptBlock[];
  readonly usage: TerminalUsageState;
  readonly activeToolCount: number;
  readonly queuedInputCount: number;
  readonly pendingPermission: PermissionApprovalRequest | undefined;
  readonly showToolDetails: boolean;
  readonly currentTurnBlockStart: number | undefined;
  readonly lastTurnSummary: TurnSummary | undefined;
  readonly context?: PromptCompositionSnapshot;
  readonly error?: SafeErrorSnapshot;
}

export type TerminalUiAction =
  | { readonly type: "chat.event"; readonly event: ChatEvent }
  | { readonly type: "composer.submitted"; readonly id: string; readonly text: string }
  | { readonly type: "ui.toggle-tool-details" };

export const initialTerminalUiState: TerminalUiState = Object.freeze({
  phase: "starting",
  lastEventSequence: 0,
  blocks: Object.freeze([]),
  usage: Object.freeze({}),
  activeToolCount: 0,
  queuedInputCount: 0,
  pendingPermission: undefined,
  showToolDetails: false,
  currentTurnBlockStart: undefined,
  lastTurnSummary: undefined,
});

export function reduceTerminalUi(
  state: TerminalUiState,
  action: TerminalUiAction,
): TerminalUiState {
  if (action.type === "ui.toggle-tool-details") {
    return { ...state, showToolDetails: !state.showToolDetails };
  }
  if (action.type === "composer.submitted") {
    return {
      ...state,
      currentTurnBlockStart: state.currentTurnBlockStart ?? state.blocks.length,
      blocks: [
        ...state.blocks,
        { kind: "user", id: action.id, text: action.text } satisfies UserTranscriptBlock,
      ],
    };
  }

  const event = action.event;
  if (event.sequence <= state.lastEventSequence) return state;
  const sequencedState: TerminalUiState = { ...state, lastEventSequence: event.sequence };
  switch (event.type) {
    case "chat.started":
      return {
        ...sequencedState,
        sessionId: event.sessionId,
        modelKey: event.payload.modelKey,
        phase: "ready",
      };
    case "chat.model.changed":
      return { ...sequencedState, modelKey: event.payload.modelKey };
    case "chat.help":
      return appendNotice(
        sequencedState,
        event,
        "info",
        `Commands: ${event.payload.commands.join("  ")}`,
      );
    case "chat.context":
      return {
        ...appendNotice(
          sequencedState,
          event,
          "info",
          event.payload.snapshot === undefined
            ? "Context is unavailable until the first turn."
            : contextSummary(event.payload.snapshot),
        ),
        ...(event.payload.snapshot === undefined ? {} : { context: event.payload.snapshot }),
      };
    case "chat.input.queued":
      return {
        ...appendNotice(sequencedState, event, "info", "Follow-up queued"),
        queuedInputCount: sequencedState.queuedInputCount + 1,
      };
    case "model.stream":
      return reduceModelEvent(sequencedState, event);
    case "tool.execution":
      return reduceToolEvent(sequencedState, event);
    case "command.output":
      return appendCommandOutput(sequencedState, event.payload.event.chunk);
    case "permission.requested":
      return {
        ...sequencedState,
        phase: "awaiting-permission",
        pendingPermission: event.payload.request,
      };
    case "permission.response.invalid":
      return appendNotice(sequencedState, event, "danger", "Invalid permission response");
    case "chat.turn.completed": {
      const summary = summarizeTurn(
        sequencedState.blocks.slice(sequencedState.currentTurnBlockStart ?? 0),
        event.payload.runCount,
        sequencedState.usage,
        {
          outcome: "completed",
          ...(event.payload.durationMs === undefined
            ? {}
            : { elapsedMs: event.payload.durationMs }),
        },
      );
      return {
        ...sequencedState,
        phase: "ready",
        queuedInputCount: 0,
        pendingPermission: undefined,
        currentTurnBlockStart: undefined,
        lastTurnSummary: summary,
        blocks: [
          ...sequencedState.blocks,
          {
            kind: "summary",
            id: `summary:${event.sequence}`,
            summary,
          } satisfies TurnSummaryTranscriptBlock,
        ],
      };
    }
    case "chat.turn.aborted":
      return abortedState(
        sequencedState,
        event.payload.state,
        event.sequence,
        event.payload.durationMs,
      );
    case "chat.turn.failed":
      return failedState(sequencedState, event);
    case "chat.ended":
      return {
        ...appendNotice(sequencedState, event, "info", `Chat ended: ${event.payload.reason}`),
        phase: "ended",
        pendingPermission: undefined,
      };
  }
}

function reduceModelEvent(
  state: TerminalUiState,
  chatEvent: Extract<ChatEvent, { type: "model.stream" }>,
): TerminalUiState {
  const event = chatEvent.payload.event;
  if (event.type === "response.started") {
    if (
      state.blocks.some(
        (block) => block.kind === "assistant" && block.responseId === event.responseId,
      )
    ) {
      return { ...state, phase: "streaming" };
    }
    const block: AssistantTranscriptBlock = {
      kind: "assistant",
      id: `assistant:${event.responseId}`,
      responseId: event.responseId,
      text: "",
      status: "streaming",
    };
    return { ...state, phase: "streaming", blocks: [...state.blocks, block] };
  }
  if (event.type === "text.delta") {
    return {
      ...state,
      phase: "streaming",
      blocks: updateAssistant(state.blocks, event.responseId, (block) => ({
        ...block,
        text: block.text + event.delta,
      })),
    };
  }
  if (event.type === "usage.updated") {
    return {
      ...state,
      usage: {
        ...state.usage,
        ...(event.usage.inputTokens === undefined ? {} : { inputTokens: event.usage.inputTokens }),
        ...(event.usage.outputTokens === undefined
          ? {}
          : { outputTokens: event.usage.outputTokens }),
        ...(event.usage.estimatedCostUsd === undefined
          ? {}
          : { estimatedCostUsd: event.usage.estimatedCostUsd }),
      },
    };
  }
  if (event.type === "response.completed") {
    return {
      ...state,
      phase: "ready",
      blocks: updateAssistant(state.blocks, event.responseId, (block) => ({
        ...block,
        status: "completed",
      })),
    };
  }
  if (event.type === "response.failed") {
    return {
      ...state,
      phase: "failed",
      blocks: updateAssistant(state.blocks, event.responseId, (block) => ({
        ...block,
        status: "failed",
      })),
    };
  }
  return state;
}

function reduceToolEvent(
  state: TerminalUiState,
  chatEvent: Extract<ChatEvent, { type: "tool.execution" }>,
): TerminalUiState {
  const event = chatEvent.payload.event;
  if (event.type === "tool.started") {
    const block: ToolTranscriptBlock = {
      kind: "tool",
      id: `tool:${event.callId}`,
      callId: event.callId,
      name: event.toolName,
      input: event.input,
      commandOutput: "",
      status: "running",
    };
    return {
      ...state,
      phase: "running-tool",
      activeToolCount: state.activeToolCount + 1,
      blocks: [...state.blocks, block],
    };
  }
  return {
    ...state,
    phase: state.activeToolCount <= 1 ? "streaming" : state.phase,
    activeToolCount: Math.max(0, state.activeToolCount - 1),
    blocks: state.blocks.map((block) =>
      block.kind === "tool" && block.callId === event.callId
        ? {
            ...block,
            output: event.output,
            ...(chatEvent.payload.durationMs === undefined
              ? {}
              : { durationMs: chatEvent.payload.durationMs }),
            ...(toolOutputTruncated(event.output) ? { truncated: true } : {}),
            status: event.isError ? "failed" : "completed",
          }
        : block,
    ),
  };
}

function toolOutputTruncated(output: JsonValue): boolean {
  const record = objectValue(output);
  return (
    record?.truncated === true ||
    record?.stdoutTruncated === true ||
    record?.stderrTruncated === true
  );
}

function summarizeTurn(
  blocks: readonly TranscriptBlock[],
  runCount: number,
  usage: TerminalUsageState,
  details: {
    readonly outcome: TurnSummary["outcome"];
    readonly elapsedMs?: number;
    readonly error?: string;
  },
): TurnSummary {
  const tools = blocks.filter((block): block is ToolTranscriptBlock => block.kind === "tool");
  const commands = tools.flatMap(commandFromTool);
  return {
    outcome: details.outcome,
    runCount,
    toolCount: tools.length,
    failedToolCount: tools.filter(({ status }) => status === "failed").length,
    changedFiles: tools.flatMap(changedFileFromTool),
    commands,
    tests: commands.filter(({ command }) =>
      /(?:^|\s)(?:test|vitest|jest|pytest)(?:\s|$)|test[/\\]/iu.test(command),
    ),
    usage,
    ...(details.elapsedMs === undefined ? {} : { elapsedMs: details.elapsedMs }),
    ...(details.error === undefined ? {} : { error: details.error }),
  };
}

function changedFileFromTool(block: ToolTranscriptBlock): readonly ChangedFileSummary[] {
  if (block.name !== "apply_patch") return [];
  const output = objectValue(block.output);
  const preview = objectValue(output?.preview);
  const path = stringValue(output?.path) ?? stringValue(objectValue(block.input)?.path);
  if (path === undefined) return [];
  const additions = numberValue(preview?.additions);
  const deletions = numberValue(preview?.deletions);
  return [
    {
      path,
      ...(additions === undefined ? {} : { additions }),
      ...(deletions === undefined ? {} : { deletions }),
    },
  ];
}

function commandFromTool(block: ToolTranscriptBlock): readonly CommandSummary[] {
  if (block.name !== "run_command") return [];
  const input = objectValue(block.input);
  const commandInput = objectValue(input?.command);
  const output = objectValue(block.output);
  const mode = stringValue(commandInput?.mode);
  const command =
    mode === "shell"
      ? stringValue(commandInput?.command)
      : mode === "direct"
        ? [
            stringValue(commandInput?.executable),
            ...arrayValue(commandInput?.args).filter(
              (value): value is string => typeof value === "string",
            ),
          ]
            .filter((value): value is string => value !== undefined)
            .join(" ")
        : undefined;
  if (command === undefined || command.length === 0) return [];
  const statusValue = stringValue(output?.status);
  const status =
    statusValue === "completed" || statusValue === "failed" || statusValue === "timed-out"
      ? statusValue
      : "unknown";
  const exitCodeValue = output?.exitCode;
  const exitCode =
    exitCodeValue === null || typeof exitCodeValue === "number" ? exitCodeValue : undefined;
  return [
    {
      command,
      status,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(block.durationMs === undefined ? {} : { durationMs: block.durationMs }),
      truncated: output?.stdoutTruncated === true || output?.stderrTruncated === true,
    },
  ];
}

function objectValue(
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function arrayValue(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function appendCommandOutput(state: TerminalUiState, chunk: string): TerminalUiState {
  const index = findLastIndex(state.blocks, (block) => block.kind === "tool");
  if (index < 0) return state;
  return {
    ...state,
    blocks: state.blocks.map((block, blockIndex) =>
      blockIndex === index && block.kind === "tool"
        ? { ...block, commandOutput: block.commandOutput + chunk }
        : block,
    ),
  };
}

function updateAssistant(
  blocks: readonly TranscriptBlock[],
  responseId: string,
  update: (block: AssistantTranscriptBlock) => AssistantTranscriptBlock,
): readonly TranscriptBlock[] {
  const existing = blocks.some(
    (block) => block.kind === "assistant" && block.responseId === responseId,
  );
  if (!existing) {
    return [
      ...blocks,
      update({
        kind: "assistant",
        id: `assistant:${responseId}`,
        responseId,
        text: "",
        status: "streaming",
      }),
    ];
  }
  return blocks.map((block) =>
    block.kind === "assistant" && block.responseId === responseId ? update(block) : block,
  );
}

function appendNotice(
  state: TerminalUiState,
  event: ChatEvent,
  tone: NoticeTranscriptBlock["tone"],
  text: string,
): TerminalUiState {
  return {
    ...state,
    blocks: [
      ...state.blocks,
      { kind: "notice", id: `event:${event.sequence}`, tone, text } satisfies NoticeTranscriptBlock,
    ],
  };
}

function abortedState(
  state: TerminalUiState,
  runState: RunState,
  sequence: number,
  durationMs: number | undefined,
): TerminalUiState {
  const reason = runState.kind === "aborted" ? runState.reason : "unknown";
  const updatedBlocks = state.blocks.map((block) =>
    block.kind === "assistant" && block.status === "streaming"
      ? ({ ...block, status: "aborted" } satisfies AssistantTranscriptBlock)
      : block.kind === "tool" && block.status === "running"
        ? ({ ...block, status: "cancelled" } satisfies ToolTranscriptBlock)
        : block,
  );
  const summary = summarizeTurn(
    updatedBlocks.slice(state.currentTurnBlockStart ?? 0),
    0,
    state.usage,
    {
      outcome: "cancelled",
      ...(durationMs === undefined ? {} : { elapsedMs: durationMs }),
      error: reason,
    },
  );
  return {
    ...state,
    phase: "aborted",
    pendingPermission: undefined,
    currentTurnBlockStart: undefined,
    activeToolCount: 0,
    lastTurnSummary: summary,
    blocks: [
      ...updatedBlocks,
      {
        kind: "notice",
        id: `event:${sequence}`,
        tone: "warning",
        text: `Turn aborted: ${reason}`,
      },
      { kind: "summary", id: `summary:${sequence}`, summary },
    ],
  };
}

function failedState(
  state: TerminalUiState,
  event: Extract<ChatEvent, { type: "chat.turn.failed" }>,
): TerminalUiState {
  const summary = summarizeTurn(
    state.blocks.slice(state.currentTurnBlockStart ?? 0),
    0,
    state.usage,
    {
      outcome: "failed",
      ...(event.payload.durationMs === undefined ? {} : { elapsedMs: event.payload.durationMs }),
      error: event.payload.error.message,
    },
  );
  const noticed = appendNotice(state, event, "danger", event.payload.error.message);
  return {
    ...noticed,
    phase: "failed",
    error: event.payload.error,
    pendingPermission: undefined,
    currentTurnBlockStart: undefined,
    lastTurnSummary: summary,
    blocks: [...noticed.blocks, { kind: "summary", id: `summary:${event.sequence}`, summary }],
  };
}

function contextSummary(snapshot: PromptCompositionSnapshot): string {
  return `Context cycle ${snapshot.cycle}: ${snapshot.selected.length} selected, ${snapshot.excluded.length} excluded, ${snapshot.composedTokens}/${snapshot.budget.availableCandidateTokens} tokens`;
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) return index;
  }
  return -1;
}
