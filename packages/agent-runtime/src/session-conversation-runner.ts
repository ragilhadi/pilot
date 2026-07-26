import {
  type AgentMessage,
  type Clock,
  type FinishReason,
  type IdSource,
  type JsonObject,
  messageId,
  type ModelRequest,
  parseAgentMessage,
  parseModelKey,
  parseModelRequest,
  runId,
  type RunId,
  SessionError,
  type SessionId,
  type SessionRepository,
  type SessionSnapshot,
  type TokenUsage,
} from "@pilotrun/core";
import type { ApplicationRunResult, ApplicationRunner } from "./application-runner.js";
import type { RunBudgetPolicy } from "./run-budget.js";
import { RunInterruptionQueue } from "./run-interruption-queue.js";
import type { RetryPolicy } from "@pilotrun/core";

export type ConversationModelRequest = Omit<ModelRequest, "messages">;

export interface SessionConversationRunnerDependencies {
  readonly runner: ApplicationRunner;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
  readonly messageIds: IdSource;
  readonly runIds: IdSource;
}

export interface ConversationTurnInput {
  readonly sessionId: SessionId;
  readonly text: string;
  readonly channel: "cli" | "ide" | "sdk" | "server";
  readonly modelKey: string;
  readonly request: ConversationModelRequest;
  readonly retryPolicy: RetryPolicy;
  readonly budgetPolicy: RunBudgetPolicy;
  readonly signal: AbortSignal;
  readonly interruptionQueue?: RunInterruptionQueue;
  readonly permissionContext?: {
    readonly workspaceId?: string;
    readonly applicationId?: string;
  };
}

export interface ConversationRunRecord {
  readonly runId: RunId;
  readonly result: ApplicationRunResult;
}

/**
 * Describes a terminal turn that finished without a clean `stop`. The turn is not an error — its
 * runs are preserved — but the assistant response is either absent or partial, and callers should
 * surface why (an output-token cutoff, a content filter, a model-side error, or an empty reply).
 */
export interface ConversationIncomplete {
  readonly reason: "truncated" | "content-filtered" | "model-error" | "empty";
  readonly finishReason: FinishReason;
  readonly runId: RunId;
  /** Whether a partial assistant message was still committed to history. */
  readonly hasPartialText: boolean;
}

export interface ConversationTurnResult {
  readonly session: SessionSnapshot;
  readonly runs: readonly ConversationRunRecord[];
  readonly assistantMessage?: AgentMessage;
  readonly incomplete?: ConversationIncomplete;
}

/**
 * Executes text-only turns over a linear session history. A queued follow-up cancels the active
 * response, is rebased onto the latest committed message, and immediately starts a fresh run.
 */
export class SessionConversationRunner {
  readonly #dependencies: SessionConversationRunnerDependencies;

  constructor(dependencies: SessionConversationRunnerDependencies) {
    this.#dependencies = dependencies;
  }

  async runTurn(input: ConversationTurnInput): Promise<ConversationTurnResult> {
    if (input.text.length === 0) {
      throw new SessionError(
        "PILOT_SESSION_INVALID_MESSAGE",
        "non-terminal-message",
        "A conversation turn must contain text",
        { sessionId: input.sessionId },
      );
    }

    const parsedModelKey = parseModelKey(input.modelKey);
    const queue = input.interruptionQueue ?? new RunInterruptionQueue();
    const runs: ConversationRunRecord[] = [];
    let session = await this.#requiredSession(input.sessionId);
    let currentRunId = this.#nextRunId();
    const firstUserMessage = parseAgentMessage({
      schemaVersion: 1,
      id: messageId(this.#dependencies.messageIds.next()),
      sessionId: input.sessionId,
      runId: currentRunId,
      ...(session.messages.at(-1) === undefined ? {} : { parentId: session.messages.at(-1)?.id }),
      role: "user",
      status: "complete",
      parts: [{ type: "text", text: input.text }],
      createdAt: this.#now(),
      provenance: { kind: "user", channel: input.channel },
    });
    session = await this.#dependencies.sessions.appendMessage(firstUserMessage);

    while (true) {
      const request = parseModelRequest({ ...input.request, messages: session.messages });
      const result = await this.#dependencies.runner.run({
        runId: currentRunId,
        modelKey: input.modelKey,
        request,
        retryPolicy: input.retryPolicy,
        budgetPolicy: input.budgetPolicy,
        signal: input.signal,
        interruptionQueue: queue,
        ...(input.permissionContext === undefined
          ? {}
          : { permissionContext: input.permissionContext }),
      });
      runs.push(Object.freeze({ runId: currentRunId, result }));
      for (const generatedMessage of result.generatedMessages) {
        session = await this.#dependencies.sessions.appendMessage(generatedMessage);
      }

      if (result.interruption?.type === "follow-up") {
        currentRunId = this.#nextRunId();
        const followUp = this.#rebaseFollowUp(
          result.interruption.message,
          input.sessionId,
          currentRunId,
          session.messages.at(-1)?.id,
        );
        session = await this.#dependencies.sessions.appendMessage(followUp);
        continue;
      }

      if (result.state.kind !== "completed" || result.outcome?.status !== "completed") {
        return Object.freeze({ session, runs: Object.freeze(runs) });
      }

      const { finishReason } = result.outcome;
      const parts = result.outcome.text
        .filter(({ text }) => text.length > 0)
        .map(({ text }) => Object.freeze({ type: "text" as const, text }));
      if (parts.length === 0) {
        // A terminal response carried no committable text. This is recoverable, not fatal: the
        // model hit its output-token budget (finishReason "length"), was content-filtered, errored
        // mid-stream, or simply produced nothing. Preserve the turn's runs and report why instead
        // of throwing a non-retryable SessionError that discards all of the turn's work.
        return Object.freeze({
          session,
          runs: Object.freeze(runs),
          incomplete: incompleteFor(finishReason, currentRunId, false),
        });
      }

      const metadata: JsonObject = Object.freeze({
        finishReason: result.outcome.finishReason,
        ...(result.outcome.usage === undefined
          ? {}
          : { usage: usageMetadata(result.outcome.usage) }),
        ...(result.outcome.providerMetadata === undefined
          ? {}
          : { providerMetadata: result.outcome.providerMetadata }),
      });
      const assistantMessage = parseAgentMessage({
        schemaVersion: 1,
        id: messageId(this.#dependencies.messageIds.next()),
        sessionId: input.sessionId,
        runId: currentRunId,
        parentId: session.messages.at(-1)?.id,
        role: "assistant",
        status: "complete",
        parts,
        createdAt: this.#now(),
        provenance: {
          kind: "model",
          providerId: parsedModelKey.providerId,
          modelId: parsedModelKey.modelId,
          responseId: result.outcome.responseId,
        },
        metadata,
      });
      session = await this.#dependencies.sessions.appendMessage(assistantMessage);
      return Object.freeze({
        session,
        runs: Object.freeze(runs),
        assistantMessage,
        // A non-"stop" finish reason means the committed text is partial — the model was cut off
        // (typically at the output-token limit) mid-answer. Commit what it produced, but flag it.
        ...(finishReason === "stop"
          ? {}
          : { incomplete: incompleteFor(finishReason, currentRunId, true) }),
      });
    }
  }

  async #requiredSession(id: SessionId): Promise<SessionSnapshot> {
    const session = await this.#dependencies.sessions.load(id);
    if (session === undefined) {
      throw new SessionError(
        "PILOT_SESSION_NOT_FOUND",
        "session-not-found",
        `Session ${id} does not exist`,
        { sessionId: id },
      );
    }
    return session;
  }

  #rebaseFollowUp(
    input: AgentMessage,
    sessionId: SessionId,
    nextRunId: RunId,
    parentId: AgentMessage["parentId"],
  ): AgentMessage {
    const message = parseAgentMessage(input);
    if (message.role !== "user" || message.status !== "complete") {
      throw new SessionError(
        "PILOT_SESSION_INVALID_MESSAGE",
        "non-terminal-message",
        "A queued follow-up must be a complete user message",
        { messageId: message.id, sessionId },
      );
    }
    return parseAgentMessage({
      ...message,
      sessionId,
      runId: nextRunId,
      ...(parentId === undefined ? {} : { parentId }),
      createdAt: this.#now(),
    });
  }

  #nextRunId(): RunId {
    return runId(this.#dependencies.runIds.next());
  }

  #now(): string {
    return this.#dependencies.clock.now().toISOString();
  }
}

function incompleteFor(
  finishReason: FinishReason,
  currentRunId: RunId,
  hasPartialText: boolean,
): ConversationIncomplete {
  return Object.freeze({
    reason: incompleteReasonFor(finishReason),
    finishReason,
    runId: currentRunId,
    hasPartialText,
  });
}

function incompleteReasonFor(finishReason: FinishReason): ConversationIncomplete["reason"] {
  switch (finishReason) {
    case "length":
      return "truncated";
    case "content-filter":
      return "content-filtered";
    case "error":
    case "unknown":
      return "model-error";
    default:
      return "empty";
  }
}

function usageMetadata(usage: TokenUsage): JsonObject {
  return Object.freeze({
    source: usage.source,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(usage.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: usage.estimatedCostUsd }),
  });
}
