import {
  CancellationError,
  type PermissionApprovalRequest,
  type PermissionApprovalResponse,
  type PermissionApprovalScopeKind,
  type UserInteraction,
} from "@pilot/core";

export type PermissionInputResult = "accepted" | "invalid" | "none";

interface PendingApproval {
  readonly request: PermissionApprovalRequest;
  readonly resolve: (response: PermissionApprovalResponse) => void;
  readonly reject: (error: unknown) => void;
  readonly abort: () => void;
  readonly signal: AbortSignal;
}

/** Bridges the chat loop's sole stdin reader to an awaiting permission request. */
export class CliUserInteraction implements UserInteraction {
  readonly #onRequest: (request: PermissionApprovalRequest) => void;
  #pending: PendingApproval | undefined;

  constructor(onRequest: (request: PermissionApprovalRequest) => void) {
    this.#onRequest = onRequest;
  }

  get pendingRequest(): PermissionApprovalRequest | undefined {
    return this.#pending?.request;
  }

  requestPermission(
    request: PermissionApprovalRequest,
    signal: AbortSignal,
  ): Promise<PermissionApprovalResponse> {
    if (this.#pending !== undefined) {
      return Promise.reject(new Error("A permission request is already pending"));
    }
    if (signal.aborted) return Promise.reject(new CancellationError(signal.reason));

    return new Promise((resolve, reject) => {
      const abort = () => {
        if (this.#pending?.request.requestId !== request.requestId) return;
        this.#pending = undefined;
        reject(new CancellationError(signal.reason));
      };
      this.#pending = { request, resolve, reject, abort, signal };
      signal.addEventListener("abort", abort, { once: true });
      this.#onRequest(request);
    });
  }

  respond(line: string): PermissionInputResult {
    const pending = this.#pending;
    if (pending === undefined) return "none";
    const response = parseResponse(line, pending.request.availableScopes);
    if (response === undefined) return "invalid";

    this.#pending = undefined;
    pending.signal.removeEventListener("abort", pending.abort);
    pending.resolve(response);
    return "accepted";
  }
}

function parseResponse(
  input: string,
  availableScopes: readonly PermissionApprovalScopeKind[],
): PermissionApprovalResponse | undefined {
  const normalized = input.trim().toLowerCase();
  if (normalized === "y" || normalized === "yes") {
    return { effect: "allow", scope: "once" };
  }
  if (normalized === "n" || normalized === "no") {
    return { effect: "deny", scope: "once" };
  }
  const [effect, scope = "once", ...extra] = normalized.split(/\s+/u);
  if ((effect !== "allow" && effect !== "deny") || extra.length > 0) return undefined;
  if (!isScope(scope) || !availableScopes.includes(scope)) return undefined;
  return { effect, scope };
}

function isScope(value: string): value is PermissionApprovalScopeKind {
  return ["once", "session", "exact-action", "tool", "workspace", "application"].includes(value);
}
