import type { AppEvent } from "@pilotrun/core";

export const runtimeVersion = "0.0.0";

/** The initial runtime seam; orchestration behavior is introduced in Phase 3. */
export type RuntimeEvent = AppEvent;

export {
  type ApplicationRunInput,
  ApplicationRunner,
  type ApplicationRunnerDependencies,
  ApplicationRunnerError,
  type ApplicationRunResult,
  type ModelCallBudgetEstimate,
  type ModelCallBudgetEstimateInput,
  type ModelCallBudgetEstimator,
  type RunCheckpoint,
  type RunCheckpointReason,
  type RunCheckpointWriter,
  runCheckpointSchemaVersion,
} from "./application-runner.js";
export {
  RepositoryRunCheckpointWriter,
  RepositoryRunLifecycleCheckpointWriter,
  type ThrottledCheckpointPolicy,
  ThrottledRunCheckpointWriter,
  toPersistedCheckpoint,
} from "./checkpoint-persistence.js";
export {
  type CollectedContextCandidate,
  type ContextBudgetRequest,
  type ContextCandidate,
  type ContextCollectionContext,
  type ContextContent,
  ContextEngine,
  type ContextEngineDependencies,
  ContextEngineError,
  type ContextExclusionReason,
  type ContextFreshness,
  type ContextFreshnessVerification,
  type ContextFreshnessVerifier,
  type ContextPreparationOptions,
  type ContextProvenance,
  type ContextProvenanceKind,
  type ContextSelection,
  type ContextSource,
  type ContextTokenEstimate,
  type ContextTokenEstimator,
  type ContextTrust,
  type ExcludedContextCandidate,
  type ResolvedContextBudget,
  resolveContextBudget,
  selectContext,
  Utf8HeuristicTokenEstimator,
} from "./context-engine.js";
export {
  ConversationCompactionError,
  type ConversationCompactionOptions,
  type ConversationCompactionResult,
  ConversationCompactor,
  type ConversationCompactorDependencies,
  type ConversationSummarizer,
  type ConversationSummaryDraft,
  type ConversationSummaryRequest,
  rehydrateConversationSummary,
  rehydrateConversationView,
} from "./conversation-compaction.js";
export { InMemoryEventBus, type Unsubscribe } from "./in-memory-event-bus.js";
export {
  InMemorySessionRepository,
  type NewSession,
  SessionError,
  type SessionErrorReason,
  type SessionRepository,
  type SessionSnapshot,
  sessionSchemaVersion,
} from "./in-memory-session-repository.js";
export {
  type InstructionDiagnostic,
  InstructionDiscovery,
  InstructionDiscoveryError,
  type InstructionDiscoveryOptions,
  type InstructionDiscoveryResult,
  type InstructionDocument,
  type InstructionFileReader,
  type InstructionPrecedenceNotice,
  type InstructionReadRequest,
  type InstructionReadResult,
  type InstructionTarget,
  type InstructionTrust,
} from "./instruction-discovery.js";
export {
  assertModelSupportsRequest,
  inspectModelCapabilities,
  ModelCapabilityError,
  type ModelCapabilityIssue,
  type ModelCapabilityName,
  ModelNotFoundError,
  type ModelRegistration,
  ModelRegistrationConflictError,
  ModelRegistry,
  type RegisteredModelDescriptor,
  type ResolvedModel,
} from "./model-registry.js";
export {
  type AccumulatedText,
  type CompletedToolCall,
  ModelStreamAccumulator,
  type ModelStreamOutcome,
  ModelStreamProtocolError,
  type StreamContentSnapshot,
  type StreamPhase,
  type StreamProgressSnapshot,
  type StreamProtocolViolation,
  type ToolCallSnapshot,
} from "./model-stream-accumulator.js";
export {
  type PermissionAuthorizationInput,
  PermissionCoordinator,
  PermissionCoordinatorError,
  type PermissionCoordinatorOptions,
  type PermissionResolutionMode,
} from "./permission-coordinator.js";
export {
  builtinPermissionRules,
  fingerprintPermissionAction,
  PermissionAuditLog,
  type PermissionEvaluationInput,
  PermissionPolicyEngine,
  type PermissionPolicyEngineOptions,
  PermissionPolicyError,
  permissionSourcePrecedence,
} from "./permission-policy.js";
export {
  type ContextSnapshotEntry,
  type ContextSnapshotExclusion,
  type ConversationContextPreparerOptions,
  ConversationModelRequestContextPreparer,
  type ModelRequestContextPreparationInput,
  type ModelRequestContextPreparer,
  PromptComposer,
  type PromptComposition,
  type PromptCompositionInput,
  type PromptCompositionSnapshot,
} from "./prompt-composition.js";
export {
  calculateRetryDelay,
  classifyModelRetryError,
  type RetryAttemptContext,
  type RetryClassification,
  type RetryClassificationReason,
  type RetryClassifier,
  type RetryDelayDecision,
  type RetryExecutionOptions,
  RetryExecutor,
  type RetryExecutorDependencies,
  type RetryLifecycleEvent,
  type RetryObserver,
  type RetrySafety,
} from "./retry-executor.js";
export {
  type ModelAttemptReservation,
  type MonotonicClock,
  type RunBudgetDecision,
  RunBudgetError,
  RunBudgetExceededError,
  type RunBudgetExhaustion,
  type RunBudgetPolicy,
  RunBudgetPolicySchema,
  type RunBudgetResource,
  type RunBudgetSnapshot,
  RunBudgetTracker,
} from "./run-budget.js";
export {
  type RunInterruption,
  type RunInterruptionListener,
  RunInterruptionQueue,
  type UnsubscribeRunInterruption,
} from "./run-interruption-queue.js";
export {
  type AbortedRunState,
  type AwaitingPermissionRunState,
  allowedRunActionTypes,
  type CompletedRunState,
  createIdleRunState,
  type ExecutingToolsRunState,
  type FailedRunState,
  type IdleRunState,
  isTerminalRunState,
  type PreparingContextRunState,
  type ProcessingToolResultsRunState,
  type ReceivingModelStreamRunState,
  type RunAbortReason,
  type RunAction,
  type RunActionType,
  type RunState,
  type RunStateKind,
  RunStateMachine,
  RunTransitionError,
  transitionRun,
  type WaitingForModelRunState,
} from "./run-state-machine.js";
export {
  type ConversationIncomplete,
  type ConversationModelRequest,
  type ConversationRunRecord,
  type ConversationTurnInput,
  type ConversationTurnResult,
  SessionConversationRunner,
  type SessionConversationRunnerDependencies,
} from "./session-conversation-runner.js";
export {
  composeSystemPrompt,
  createSystemPromptContextSource,
  type SystemPromptInput,
} from "./system-prompt.js";
export {
  type ContextOccupancy,
  describeGenericRequestPayload,
  RequestTokenAccountant,
  ScriptAwareHeuristicCounter,
  TokenCounterContextEstimator,
} from "./token-accounting.js";
export {
  type PendingToolCall,
  type ScheduledToolResult,
  type ScheduleToolCallsInput,
  ToolCallScheduler,
  type ToolCallSchedulerDependencies,
  ToolCallSchedulingError,
  ToolExecutionInterruptedError,
  type ToolExecutionLifecycleEvent,
} from "./tool-call-scheduler.js";
export {
  interruptedToolRecovery,
  permissionDeniedRecovery,
  recoveryForToolError,
} from "./tool-recovery.js";
export {
  type RegisteredTool,
  ToolNotFoundError,
  ToolRegistrationConflictError,
  ToolRegistry,
} from "./tool-registry.js";
export {
  type FormattedToolResultContext,
  ToolResultContextError,
  ToolResultContextFormatter,
  type ToolResultContextFormatterPort,
  type ToolResultContextInput,
  type ToolResultContextPolicy,
  type ToolResultFieldContentTruncation,
  type ToolResultHeadTailTruncation,
  type ToolResultPreservedErrorTruncation,
  type ToolResultTruncationMetadata,
} from "./tool-result-context.js";
