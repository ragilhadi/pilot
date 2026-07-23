import {
  AgentMessageSchema,
  CancellationError,
  messageId,
  PilotError,
  type AgentMessage,
  type MessageId,
} from "@pilot/core";
import { Utf8HeuristicTokenEstimator, type ContextTokenEstimator } from "./context-engine.js";

export interface ConversationSummaryRequest {
  readonly messages: readonly AgentMessage[];
  readonly sourceMessageIds: readonly MessageId[];
  readonly sourceDigest: `sha256:${string}`;
  readonly maximumTokens: number;
  readonly signal: AbortSignal;
}

export interface ConversationSummaryDraft {
  readonly text: string;
  readonly sourceMessageIds: readonly MessageId[];
  readonly sourceDigest: `sha256:${string}`;
}

export interface ConversationSummarizer {
  summarize(request: ConversationSummaryRequest): Promise<ConversationSummaryDraft>;
}

export interface ConversationCompactorDependencies {
  readonly summarizer: ConversationSummarizer;
  readonly tokenEstimator?: ContextTokenEstimator;
}

export interface ConversationCompactionOptions {
  readonly history: readonly AgentMessage[];
  readonly maximumConversationTokens: number;
  readonly maximumSummaryTokens: number;
  readonly preserveRecentMessages: number;
  readonly summaryMessageId: MessageId;
  readonly signal: AbortSignal;
}

export interface ConversationCompactionResult {
  readonly compacted: boolean;
  readonly messages: readonly AgentMessage[];
  readonly originalTokens: number;
  readonly compactedTokens: number;
  readonly savedTokens: number;
  readonly summary?: AgentMessage;
  readonly sourceMessageIds: readonly MessageId[];
  readonly sourceDigest?: `sha256:${string}`;
}

export class ConversationCompactionError extends PilotError {
  constructor(message: string, metadata: Readonly<Record<string, unknown>> = {}, cause?: unknown) {
    super({
      code: "PILOT_CONTEXT_COMPACTION",
      message,
      safeMessage: "Conversation context could not be compacted safely",
      metadata,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

const summaryPrefix =
  "Compacted conversation summary (semantically unverified; rehydrate source messages for exact details):\n";

/** Produces a reversible context-only summary while leaving canonical session history untouched. */
export class ConversationCompactor {
  readonly #summarizer: ConversationSummarizer;
  readonly #tokenEstimator: ContextTokenEstimator;

  constructor(dependencies: ConversationCompactorDependencies) {
    if (typeof dependencies.summarizer?.summarize !== "function") {
      throw new ConversationCompactionError("Conversation summarizer is invalid");
    }
    this.#summarizer = dependencies.summarizer;
    this.#tokenEstimator = dependencies.tokenEstimator ?? new Utf8HeuristicTokenEstimator();
  }

  async compact(options: ConversationCompactionOptions): Promise<ConversationCompactionResult> {
    validatePositiveInteger(options.maximumConversationTokens, "maximumConversationTokens");
    validatePositiveInteger(options.maximumSummaryTokens, "maximumSummaryTokens");
    if (
      !Number.isSafeInteger(options.preserveRecentMessages) ||
      options.preserveRecentMessages < 1
    ) {
      throw new ConversationCompactionError("preserveRecentMessages must be a positive integer");
    }
    throwIfCancelled(options.signal);
    const history = validateCanonicalHistory(options.history);
    if (history.some(({ provenance }) => provenance.kind === "compaction")) {
      throw new ConversationCompactionError(
        "Canonical history cannot contain compaction summaries; rehydrate original messages first",
      );
    }
    const originalTokens = estimateMessages(history, this.#tokenEstimator);
    if (originalTokens <= options.maximumConversationTokens) {
      return Object.freeze({
        compacted: false,
        messages: history,
        originalTokens,
        compactedTokens: originalTokens,
        savedTokens: 0,
        sourceMessageIds: Object.freeze([]),
      });
    }

    const maximumBoundary = history.length - options.preserveRecentMessages;
    const boundary = safeCompactionBoundary(history, maximumBoundary);
    if (boundary < 2) {
      throw new ConversationCompactionError(
        "Conversation has no safe compactable prefix while preserving recent messages",
        { historyLength: history.length, preserveRecentMessages: options.preserveRecentMessages },
      );
    }
    const sourceMessages = Object.freeze(history.slice(0, boundary));
    const retainedMessages = Object.freeze(history.slice(boundary));
    const sourceMessageIds = Object.freeze(sourceMessages.map(({ id }) => id));
    const sourceDigest = await digestMessages(sourceMessages);
    throwIfCancelled(options.signal);
    const draft = await this.#summarizer.summarize(
      Object.freeze({
        messages: sourceMessages,
        sourceMessageIds,
        sourceDigest,
        maximumTokens: options.maximumSummaryTokens,
        signal: options.signal,
      }),
    );
    throwIfCancelled(options.signal);
    validateDraft(draft, sourceMessageIds, sourceDigest);

    const text = `${summaryPrefix}${draft.text}`;
    const summaryEstimate = estimateContent(text, this.#tokenEstimator, "summary");
    if (summaryEstimate > options.maximumSummaryTokens) {
      throw new ConversationCompactionError("Conversation summary exceeds its token limit", {
        maximumTokens: options.maximumSummaryTokens,
        observedTokens: summaryEstimate,
      });
    }
    const sourceTail = sourceMessages.at(-1);
    if (sourceTail === undefined) {
      throw new ConversationCompactionError("Conversation summary has no source tail");
    }
    const summary = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: messageId(options.summaryMessageId),
      sessionId: sourceTail.sessionId,
      ...(sourceTail.runId === undefined ? {} : { runId: sourceTail.runId }),
      role: "system",
      status: "complete",
      parts: [{ type: "text", text }],
      createdAt: sourceTail.createdAt,
      provenance: { kind: "compaction", sourceMessageIds },
      metadata: {
        compaction: {
          schemaVersion: 1,
          sourceDigest,
          sourceCount: sourceMessages.length,
          firstSourceMessageId: sourceMessageIds[0],
          lastSourceMessageId: sourceMessageIds.at(-1),
          semanticVerification: "unverified",
          rehydrationRequiredForExactDetails: true,
        },
      },
    });
    const messages = Object.freeze([summary, ...retainedMessages]);
    const compactedTokens = estimateMessages(messages, this.#tokenEstimator);
    if (compactedTokens > options.maximumConversationTokens) {
      throw new ConversationCompactionError(
        "Compacted conversation still exceeds the target token limit",
        {
          maximumTokens: options.maximumConversationTokens,
          observedTokens: compactedTokens,
          preservedMessages: retainedMessages.length,
        },
      );
    }
    if (compactedTokens >= originalTokens) {
      throw new ConversationCompactionError("Conversation summary did not reduce context size", {
        originalTokens,
        compactedTokens,
      });
    }
    return Object.freeze({
      compacted: true,
      messages,
      originalTokens,
      compactedTokens,
      savedTokens: originalTokens - compactedTokens,
      summary,
      sourceMessageIds,
      sourceDigest,
    });
  }
}

/** Restores exact source messages and rejects missing, reordered, or modified canonical history. */
export async function rehydrateConversationSummary(
  summaryInput: AgentMessage,
  canonicalHistoryInput: readonly AgentMessage[],
): Promise<readonly AgentMessage[]> {
  const summary = AgentMessageSchema.parse(summaryInput);
  if (summary.provenance.kind !== "compaction") {
    throw new ConversationCompactionError("Only a compaction message can be rehydrated", {
      messageId: summary.id,
    });
  }
  const history = validateCanonicalHistory(canonicalHistoryInput);
  const compaction = readCompactionMetadata(summary);
  const identifiers = summary.provenance.sourceMessageIds;
  if (compaction.sourceCount !== identifiers.length) {
    throw new ConversationCompactionError("Compaction source count does not match provenance", {
      messageId: summary.id,
    });
  }
  const indexById = new Map(history.map((message, index) => [message.id, index] as const));
  const sourceMessages = identifiers.map((id) => {
    const index = indexById.get(id);
    if (index === undefined) {
      throw new ConversationCompactionError("A compaction source message is unavailable", {
        messageId: summary.id,
        sourceMessageId: id,
      });
    }
    return { index, message: history[index] as AgentMessage };
  });
  for (const [position, source] of sourceMessages.entries()) {
    if (source.index !== (sourceMessages[0]?.index ?? 0) + position) {
      throw new ConversationCompactionError("Compaction source messages are no longer contiguous", {
        messageId: summary.id,
      });
    }
    if (source.message.provenance.kind === "compaction") {
      throw new ConversationCompactionError("Nested compaction provenance cannot be rehydrated");
    }
  }
  const messages = Object.freeze(sourceMessages.map(({ message }) => message));
  const actualDigest = await digestMessages(messages);
  if (actualDigest !== compaction.sourceDigest) {
    throw new ConversationCompactionError("Compaction source history has drifted", {
      messageId: summary.id,
      expectedDigest: compaction.sourceDigest,
      actualDigest,
    });
  }
  if (
    identifiers[0] !== compaction.firstSourceMessageId ||
    identifiers.at(-1) !== compaction.lastSourceMessageId
  ) {
    throw new ConversationCompactionError(
      "Compaction boundary metadata does not match provenance",
      {
        messageId: summary.id,
      },
    );
  }
  return messages;
}

/** Replaces summaries in a compacted view and proves the result equals the complete canonical chain. */
export async function rehydrateConversationView(
  compactedViewInput: readonly AgentMessage[],
  canonicalHistoryInput: readonly AgentMessage[],
): Promise<readonly AgentMessage[]> {
  if (!Array.isArray(compactedViewInput) || compactedViewInput.length === 0) {
    throw new ConversationCompactionError("Compacted conversation view is invalid");
  }
  const canonicalHistory = validateCanonicalHistory(canonicalHistoryInput);
  const expanded: AgentMessage[] = [];
  for (const input of compactedViewInput) {
    const message = AgentMessageSchema.parse(input);
    if (message.provenance.kind === "compaction") {
      expanded.push(...(await rehydrateConversationSummary(message, canonicalHistory)));
    } else {
      expanded.push(message);
    }
  }
  const hydrated = validateCanonicalHistory(expanded);
  const [hydratedDigest, canonicalDigest] = await Promise.all([
    digestMessages(hydrated),
    digestMessages(canonicalHistory),
  ]);
  if (hydratedDigest !== canonicalDigest) {
    throw new ConversationCompactionError(
      "Rehydrated conversation view does not match canonical history",
      { hydratedDigest, canonicalDigest },
    );
  }
  return canonicalHistory;
}

interface CompactionMetadata {
  readonly sourceDigest: `sha256:${string}`;
  readonly sourceCount: number;
  readonly firstSourceMessageId: string;
  readonly lastSourceMessageId: string;
}

function readCompactionMetadata(summary: AgentMessage): CompactionMetadata {
  const value = summary.metadata?.compaction;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConversationCompactionError("Compaction message lacks provenance metadata", {
      messageId: summary.id,
    });
  }
  const metadata = value as Readonly<Record<string, unknown>>;
  if (
    metadata.schemaVersion !== 1 ||
    typeof metadata.sourceDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(metadata.sourceDigest) ||
    !Number.isSafeInteger(metadata.sourceCount) ||
    typeof metadata.sourceCount !== "number" ||
    metadata.sourceCount < 1 ||
    typeof metadata.firstSourceMessageId !== "string" ||
    typeof metadata.lastSourceMessageId !== "string" ||
    metadata.semanticVerification !== "unverified" ||
    metadata.rehydrationRequiredForExactDetails !== true
  ) {
    throw new ConversationCompactionError("Compaction provenance metadata is invalid", {
      messageId: summary.id,
    });
  }
  return {
    sourceDigest: metadata.sourceDigest as `sha256:${string}`,
    sourceCount: metadata.sourceCount,
    firstSourceMessageId: metadata.firstSourceMessageId,
    lastSourceMessageId: metadata.lastSourceMessageId,
  };
}

function validateCanonicalHistory(input: readonly AgentMessage[]): readonly AgentMessage[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100_000) {
    throw new ConversationCompactionError("Canonical conversation history size is invalid");
  }
  const messages = input.map((message) => AgentMessageSchema.parse(message));
  const identifiers = new Set<MessageId>();
  const toolCallIds = new Set<string>();
  const outstandingToolCalls = new Set<string>();
  const sessionId = messages[0]?.sessionId;
  for (const [index, message] of messages.entries()) {
    if (message.sessionId !== sessionId) {
      throw new ConversationCompactionError("Conversation history mixes sessions", {
        messageId: message.id,
      });
    }
    if (identifiers.has(message.id)) {
      throw new ConversationCompactionError("Conversation history contains duplicate message IDs", {
        messageId: message.id,
      });
    }
    identifiers.add(message.id);
    const previous = messages[index - 1];
    if (message.parentId !== previous?.id) {
      throw new ConversationCompactionError(
        "Conversation history is not a linear canonical chain",
        {
          messageId: message.id,
        },
      );
    }
    if (previous !== undefined && Date.parse(message.createdAt) < Date.parse(previous.createdAt)) {
      throw new ConversationCompactionError("Conversation history timestamps regress", {
        messageId: message.id,
      });
    }
    for (const part of message.parts) {
      if (part.type === "tool-call") {
        const correlationKey = `${message.runId ?? "no-run"}\u0000${part.callId}`;
        if (toolCallIds.has(correlationKey)) {
          throw new ConversationCompactionError(
            "Conversation history reuses a tool-call identifier",
            { messageId: message.id, callId: part.callId },
          );
        }
        toolCallIds.add(correlationKey);
        outstandingToolCalls.add(correlationKey);
      }
      if (part.type === "tool-result") {
        const correlationKey = `${message.runId ?? "no-run"}\u0000${part.callId}`;
        if (!outstandingToolCalls.delete(correlationKey)) {
          throw new ConversationCompactionError(
            "Conversation history contains an uncorrelated tool result",
            { messageId: message.id, callId: part.callId },
          );
        }
      }
    }
  }
  return Object.freeze(messages);
}

function safeCompactionBoundary(history: readonly AgentMessage[], maximumBoundary: number): number {
  for (let boundary = Math.min(maximumBoundary, history.length - 1); boundary >= 2; boundary -= 1) {
    const sourceTail = history[boundary - 1];
    if (sourceTail?.role !== "user" && hasCompleteToolExchanges(history.slice(0, boundary))) {
      return boundary;
    }
  }
  return 0;
}

function hasCompleteToolExchanges(messages: readonly AgentMessage[]): boolean {
  const outstanding = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool-call") outstanding.add(part.callId);
      if (part.type === "tool-result") outstanding.delete(part.callId);
    }
  }
  return outstanding.size === 0;
}

function validateDraft(
  draft: ConversationSummaryDraft,
  sourceMessageIds: readonly MessageId[],
  sourceDigest: `sha256:${string}`,
): void {
  if (typeof draft !== "object" || draft === null) {
    throw new ConversationCompactionError("Conversation summarizer returned an invalid result");
  }
  if (
    typeof draft.text !== "string" ||
    draft.text.trim().length === 0 ||
    draft.text.length > 1_000_000
  ) {
    throw new ConversationCompactionError("Conversation summarizer returned invalid text");
  }
  if (
    !Array.isArray(draft.sourceMessageIds) ||
    draft.sourceMessageIds.length !== sourceMessageIds.length ||
    draft.sourceMessageIds.some((id, index) => id !== sourceMessageIds[index])
  ) {
    throw new ConversationCompactionError("Conversation summary source lineage does not match");
  }
  if (draft.sourceDigest !== sourceDigest) {
    throw new ConversationCompactionError("Conversation summary source digest does not match");
  }
}

function estimateMessages(
  messages: readonly AgentMessage[],
  estimator: ContextTokenEstimator,
): number {
  return messages.reduce(
    (total, message) => safeSum(total, estimateContent(message, estimator, message.id)),
    0,
  );
}

function estimateContent(
  content: AgentMessage | string,
  estimator: ContextTokenEstimator,
  label: string,
): number {
  const estimate = estimator.estimate(content);
  if (
    typeof estimate !== "object" ||
    estimate === null ||
    !Number.isSafeInteger(estimate.tokens) ||
    estimate.tokens < 1 ||
    typeof estimate.method !== "string" ||
    estimate.method.length === 0
  ) {
    throw new ConversationCompactionError("Token estimator returned an invalid result", { label });
  }
  return estimate.tokens;
}

async function digestMessages(messages: readonly AgentMessage[]): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(JSON.stringify(messages));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

function safeSum(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new ConversationCompactionError("Conversation token accounting overflowed");
  }
  return sum;
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConversationCompactionError(`${label} must be a positive integer`);
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancellationError(signal.reason);
}
