import type { AppEvent } from "@pilotrun/core";

export const runtimeVersion = "0.0.0";

/** The initial runtime seam; orchestration behavior is introduced in Phase 3. */
export type RuntimeEvent = AppEvent;

export { InMemoryEventBus, type Unsubscribe } from "./in-memory-event-bus.js";
export {
  ModelStreamAccumulator,
  ModelStreamProtocolError,
  type AccumulatedText,
  type CompletedToolCall,
  type ModelStreamOutcome,
  type StreamContentSnapshot,
  type StreamPhase,
  type StreamProgressSnapshot,
  type StreamProtocolViolation,
  type ToolCallSnapshot,
} from "./model-stream-accumulator.js";
export {
  calculateRetryDelay,
  classifyModelRetryError,
  RetryExecutor,
  type RetryAttemptContext,
  type RetryClassification,
  type RetryClassificationReason,
  type RetryClassifier,
  type RetryDelayDecision,
  type RetryExecutionOptions,
  type RetryExecutorDependencies,
  type RetryLifecycleEvent,
  type RetryObserver,
  type RetrySafety,
} from "./retry-executor.js";
export {
  assertModelSupportsRequest,
  inspectModelCapabilities,
  ModelCapabilityError,
  ModelNotFoundError,
  ModelRegistrationConflictError,
  ModelRegistry,
  type ModelCapabilityIssue,
  type ModelCapabilityName,
  type ModelRegistration,
  type RegisteredModelDescriptor,
  type ResolvedModel,
} from "./model-registry.js";
export {
  allowedRunActionTypes,
  createIdleRunState,
  isTerminalRunState,
  RunStateMachine,
  RunTransitionError,
  transitionRun,
  type AbortedRunState,
  type AwaitingPermissionRunState,
  type CompletedRunState,
  type ExecutingToolsRunState,
  type FailedRunState,
  type IdleRunState,
  type PreparingContextRunState,
  type ProcessingToolResultsRunState,
  type ReceivingModelStreamRunState,
  type RunAbortReason,
  type RunAction,
  type RunActionType,
  type RunState,
  type RunStateKind,
  type WaitingForModelRunState,
} from "./run-state-machine.js";
export {
  RunBudgetError,
  RunBudgetExceededError,
  RunBudgetPolicySchema,
  RunBudgetTracker,
  type ModelAttemptReservation,
  type MonotonicClock,
  type RunBudgetDecision,
  type RunBudgetExhaustion,
  type RunBudgetPolicy,
  type RunBudgetResource,
  type RunBudgetSnapshot,
} from "./run-budget.js";
export {
  RunInterruptionQueue,
  type RunInterruption,
  type RunInterruptionListener,
  type UnsubscribeRunInterruption,
} from "./run-interruption-queue.js";
export {
  ApplicationRunner,
  ApplicationRunnerError,
  runCheckpointSchemaVersion,
  type ApplicationRunInput,
  type ApplicationRunnerDependencies,
  type ApplicationRunResult,
  type ModelCallBudgetEstimate,
  type ModelCallBudgetEstimateInput,
  type ModelCallBudgetEstimator,
  type RunCheckpoint,
  type RunCheckpointReason,
  type RunCheckpointWriter,
} from "./application-runner.js";
export {
  RepositoryRunCheckpointWriter,
  RepositoryRunLifecycleCheckpointWriter,
  type ThrottledCheckpointPolicy,
  ThrottledRunCheckpointWriter,
  toPersistedCheckpoint,
} from "./checkpoint-persistence.js";
export {
  InstructionDiscovery,
  InstructionDiscoveryError,
  type InstructionDiscoveryOptions,
  type InstructionDiscoveryResult,
  type InstructionDiagnostic,
  type InstructionDocument,
  type InstructionFileReader,
  type InstructionPrecedenceNotice,
  type InstructionReadRequest,
  type InstructionReadResult,
  type InstructionTarget,
  type InstructionTrust,
} from "./instruction-discovery.js";
export {
  ContextEngine,
  ContextEngineError,
  resolveContextBudget,
  selectContext,
  Utf8HeuristicTokenEstimator,
  type CollectedContextCandidate,
  type ContextBudgetRequest,
  type ContextCandidate,
  type ContextCollectionContext,
  type ContextContent,
  type ContextEngineDependencies,
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
} from "./context-engine.js";
export {
  ToolResultContextError,
  ToolResultContextFormatter,
  type FormattedToolResultContext,
  type ToolResultContextFormatterPort,
  type ToolResultContextInput,
  type ToolResultContextPolicy,
  type ToolResultTruncationMetadata,
} from "./tool-result-context.js";
export {
  ConversationCompactionError,
  ConversationCompactor,
  rehydrateConversationView,
  rehydrateConversationSummary,
  type ConversationCompactionOptions,
  type ConversationCompactionResult,
  type ConversationCompactorDependencies,
  type ConversationSummarizer,
  type ConversationSummaryDraft,
  type ConversationSummaryRequest,
} from "./conversation-compaction.js";
export {
  ConversationModelRequestContextPreparer,
  PromptComposer,
  type ContextSnapshotEntry,
  type ContextSnapshotExclusion,
  type ConversationContextPreparerOptions,
  type ModelRequestContextPreparer,
  type ModelRequestContextPreparationInput,
  type PromptComposition,
  type PromptCompositionInput,
  type PromptCompositionSnapshot,
} from "./prompt-composition.js";
export {
  InMemorySessionRepository,
  sessionSchemaVersion,
  SessionError,
  type NewSession,
  type SessionErrorReason,
  type SessionRepository,
  type SessionSnapshot,
} from "./in-memory-session-repository.js";
export {
  SessionConversationRunner,
  type ConversationModelRequest,
  type ConversationRunRecord,
  type ConversationTurnInput,
  type ConversationTurnResult,
  type SessionConversationRunnerDependencies,
} from "./session-conversation-runner.js";
export {
  ToolNotFoundError,
  ToolRegistrationConflictError,
  ToolRegistry,
  type RegisteredTool,
} from "./tool-registry.js";
export {
  ToolCallScheduler,
  ToolCallSchedulingError,
  ToolExecutionInterruptedError,
  type PendingToolCall,
  type ScheduledToolResult,
  type ScheduleToolCallsInput,
  type ToolCallSchedulerDependencies,
  type ToolExecutionLifecycleEvent,
} from "./tool-call-scheduler.js";
export {
  builtinPermissionRules,
  fingerprintPermissionAction,
  PermissionAuditLog,
  PermissionPolicyEngine,
  PermissionPolicyError,
  permissionSourcePrecedence,
  type PermissionEvaluationInput,
  type PermissionPolicyEngineOptions,
} from "./permission-policy.js";
export {
  PermissionCoordinator,
  PermissionCoordinatorError,
  type PermissionAuthorizationInput,
  type PermissionCoordinatorOptions,
  type PermissionResolutionMode,
} from "./permission-coordinator.js";
export {
  interruptedToolRecovery,
  permissionDeniedRecovery,
  recoveryForToolError,
} from "./tool-recovery.js";
