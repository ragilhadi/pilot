import {
  CancellationError,
  type PermissionAction,
  PermissionApprovalRequestSchema,
  PermissionApprovalResponseSchema,
  type PermissionApprovalScopeKind,
  type PermissionDecision,
  type PermissionEvaluationContext,
  type PermissionRuleMatcher,
  type PermissionRuleSource,
  type PermissionScope,
  PilotError,
  type UserInteraction,
} from "@pilotrun/core";
import type { PermissionPolicyEngine } from "./permission-policy.js";

export type PermissionResolutionMode =
  | "interactive"
  | "non-interactive-deny"
  | "non-interactive-allow";

export interface PermissionCoordinatorOptions {
  readonly policy: PermissionPolicyEngine;
  readonly mode?: PermissionResolutionMode;
  readonly interaction?: UserInteraction;
}

export interface PermissionAuthorizationInput {
  readonly action: PermissionAction;
  readonly context: PermissionEvaluationContext;
  readonly signal: AbortSignal;
}

export class PermissionCoordinatorError extends PilotError {
  constructor(
    code: "PILOT_PERMISSION_INTERACTION_UNAVAILABLE" | "PILOT_PERMISSION_RESPONSE_INVALID",
    message: string,
    metadata: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super({
      code,
      message,
      safeMessage:
        code === "PILOT_PERMISSION_INTERACTION_UNAVAILABLE"
          ? "This action requires approval, but no user interaction is available"
          : "The permission response is invalid",
      metadata,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

/** Resolves policy prompts into scoped rules, then returns the policy's final decision. */
export class PermissionCoordinator {
  readonly #policy: PermissionPolicyEngine;
  readonly #mode: PermissionResolutionMode;
  readonly #interaction: UserInteraction | undefined;
  #sequence = 0;

  constructor(options: PermissionCoordinatorOptions) {
    this.#policy = options.policy;
    this.#mode = options.mode ?? "non-interactive-deny";
    this.#interaction = options.interaction;
  }

  async authorize(input: PermissionAuthorizationInput): Promise<PermissionDecision> {
    throwIfCancelled(input.signal);
    const initial = this.#policy.evaluate({ action: input.action, context: input.context });
    if (initial.effect !== "ask") return initial;

    const source: PermissionRuleSource = this.#mode === "interactive" ? "interactive" : "cli";
    const requestId = this.#nextRequestId(source);
    const availableScopes = availableScopesFor(input.action, input.context);
    const request = PermissionApprovalRequestSchema.parse({
      requestId,
      action: input.action,
      context: input.context,
      policyDecision: initial,
      availableScopes,
    });

    const rawResponse = await this.#resolve(request, input.signal);
    const parsed = PermissionApprovalResponseSchema.safeParse(rawResponse);
    if (!parsed.success || !availableScopes.includes(parsed.data.scope)) {
      throw new PermissionCoordinatorError(
        "PILOT_PERMISSION_RESPONSE_INVALID",
        "Permission response validation failed or selected an unavailable scope",
        { requestId, availableScopes },
        parsed.success ? undefined : parsed.error,
      );
    }
    throwIfCancelled(input.signal);

    const scope = scopeFor(parsed.data.scope, input.action, input.context, initial);
    this.#policy.addRule({
      id: `${source}.${requestId}`,
      source,
      effect: parsed.data.effect,
      reason:
        parsed.data.reason ??
        `${source === "interactive" ? "User" : "Non-interactive mode"} ${parsed.data.effect}ed the action`,
      matcher: matcherFor(parsed.data.scope, input.action, initial),
      scope,
      hard: false,
    });
    return this.#policy.evaluate({ action: input.action, context: input.context });
  }

  #nextRequestId(source: PermissionRuleSource): string {
    const existing = new Set(this.#policy.rules().map(({ id }) => id));
    do {
      this.#sequence += 1;
    } while (existing.has(`${source}.permission-${this.#sequence}`));
    return `permission-${this.#sequence}`;
  }

  async #resolve(
    request: Parameters<UserInteraction["requestPermission"]>[0],
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.#mode === "non-interactive-allow") {
      return { effect: "allow", scope: "once", reason: "Explicit non-interactive allow mode" };
    }
    if (this.#mode === "non-interactive-deny") {
      return { effect: "deny", scope: "once", reason: "No interactive approval is available" };
    }
    if (this.#interaction === undefined) {
      throw new PermissionCoordinatorError(
        "PILOT_PERMISSION_INTERACTION_UNAVAILABLE",
        "Interactive permission mode requires a UserInteraction implementation",
        { requestId: request.requestId },
      );
    }
    return await raceWithCancellation(this.#interaction.requestPermission(request, signal), signal);
  }
}

/**
 * What the user is offered: approve this call, or approve for the rest of the session.
 *
 * The list used to run to six. `exact-action`, `workspace`, and `application` all outlive the
 * session — some of them outlive the process — which is a durable grant to make from a prompt the
 * user is trying to get past, and three of the six differed only in wording. Two choices is the
 * whole decision: now, or until I stop working.
 *
 * The domain vocabulary still carries the wider kinds; nothing offers them.
 */
function availableScopesFor(
  _action: PermissionAction,
  context: PermissionEvaluationContext,
): readonly PermissionApprovalScopeKind[] {
  return Object.freeze([
    "once",
    ...(context.sessionId === undefined ? [] : (["session"] as const)),
  ]);
}

/**
 * Chooses what an approval covers, independently of how long it lasts.
 *
 * A scope answers "until when"; the matcher answers "which actions". Pairing a scope with an `any`
 * matcher once turned "allow for session" into a blanket approval of every later tool call in that
 * session, so approving one `npm run build` silently pre-authorized an unrelated `curl`. The fix
 * then was to bind every scope to the exact action the user reviewed, by fingerprint.
 *
 * That was too tight to be usable for a **tool**. A tool's fingerprint covers its input, so every
 * `write_file` to a different path — or the same path with different content — is a different
 * action, and "for the rest of this session" bought the user exactly one silent call. A session
 * approval of a tool therefore matches the tool by name: approving `write_file` approves
 * `write_file`, for this session, and nothing else. It is still not `any` — it does not reach
 * `edit`, `apply_patch`, or a command — and writes remain confined to the workspace boundary.
 *
 * **Commands** keep the fingerprint. `run_command` carries its whole command line in the action, so
 * matching anything looser than the exact action would turn one approved `npm test` into standing
 * approval for every command that followed it.
 */
function matcherFor(
  kind: PermissionApprovalScopeKind,
  action: PermissionAction,
  decision: PermissionDecision,
): PermissionRuleMatcher {
  if ((kind === "tool" || kind === "session") && action.kind === "tool") {
    return { kind: "tool", toolName: action.toolName };
  }
  return { kind: "exact-action", fingerprint: decision.actionFingerprint };
}

function scopeFor(
  kind: PermissionApprovalScopeKind,
  action: PermissionAction,
  context: PermissionEvaluationContext,
  decision: PermissionDecision,
): PermissionScope {
  switch (kind) {
    case "once":
      return { kind, callId: context.callId };
    case "exact-action":
      return { kind, fingerprint: decision.actionFingerprint };
    case "session":
      return requiredScopeValue(kind, "sessionId", context.sessionId);
    case "tool":
      if (action.kind !== "tool") return unavailableScope(kind);
      return { kind, toolName: action.toolName };
    case "workspace":
      return requiredScopeValue(kind, "workspaceId", context.workspaceId);
    case "application":
      return requiredScopeValue(kind, "applicationId", context.applicationId);
  }
}

function requiredScopeValue<
  Kind extends "application" | "session" | "workspace",
  Key extends "applicationId" | "sessionId" | "workspaceId",
>(kind: Kind, key: Key, value: string | undefined): PermissionScope {
  if (value === undefined) return unavailableScope(kind);
  return { kind, [key]: value } as PermissionScope;
}

function unavailableScope(kind: PermissionApprovalScopeKind): never {
  throw new PermissionCoordinatorError(
    "PILOT_PERMISSION_RESPONSE_INVALID",
    `Permission scope ${kind} is unavailable for this action`,
    { scope: kind },
  );
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancellationError(signal.reason);
}

function raceWithCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new CancellationError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new CancellationError(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
