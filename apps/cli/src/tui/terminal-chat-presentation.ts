import path from "node:path";
import {
  CombinedAutocompleteProvider,
  type Component,
  Editor,
  Key,
  Markdown,
  matchesKey,
  SelectList,
  type SelectItem,
  type Terminal,
  truncateToWidth,
  TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { PermissionApprovalRequest } from "@pilotrun/core";
import type { ChatEvent } from "../chat-events.js";
import type { InteractiveChatPresentation } from "../presentation/chat-presentation.js";
import type { TerminalCapabilitySnapshot } from "../presentation/presentation-mode.js";
import { sanitizeTerminalText } from "../presentation/sanitize-terminal-text.js";
import {
  applyPilotTheme,
  createPilotTheme,
  pilotThemeModes,
  type PilotTheme,
  type PilotThemeMode,
} from "./theme.js";
import {
  initialTerminalUiState,
  reduceTerminalUi,
  type TerminalUiState,
  type ToolTranscriptBlock,
  type TranscriptBlock,
} from "./terminal-ui-state.js";

export interface TerminalChatPresentationOptions {
  readonly terminal: Terminal;
  readonly capabilities: TerminalCapabilitySnapshot;
  readonly workspacePath: string;
  readonly repository?: RepositoryDisplayState;
  readonly themeMode?: PilotThemeMode;
  readonly models?: readonly ModelDisplayState[];
  readonly sessions?: readonly SessionDisplayState[];
}

export interface ModelDisplayState {
  readonly key: string;
  readonly displayName: string;
}

export interface SessionDisplayState {
  readonly id: string;
  readonly status: "active" | "archived";
  readonly messageCount: number;
  readonly updatedAt: string;
}

export interface RepositoryDisplayState {
  readonly branch: string;
  readonly dirty: boolean;
}

export class TerminalChatPresentation implements InteractiveChatPresentation {
  readonly #terminal: Terminal;
  readonly #tui: TUI;
  readonly #editor: Editor;
  readonly #screen: PilotScreen;
  readonly #footer: PilotFooter;
  readonly #theme: PilotTheme;
  readonly #workspacePath: string;
  readonly #capabilities: TerminalCapabilitySnapshot;
  readonly #models: readonly ModelDisplayState[];
  readonly #sessions: readonly SessionDisplayState[];
  readonly #pendingLines: string[] = [];
  readonly #promptHistory: string[] = [];
  readonly #readers: Array<(line: string | undefined) => void> = [];
  #state = initialTerminalUiState;
  #closed = false;
  #submissionSequence = 0;
  #permissionOverlayRequestId: string | undefined;
  #lastIdleInterruptAt = Number.NEGATIVE_INFINITY;
  #themeMode: PilotThemeMode;

  constructor(options: TerminalChatPresentationOptions) {
    this.#terminal = options.terminal;
    this.#capabilities = options.capabilities;
    this.#themeMode = options.themeMode ?? "system";
    this.#theme = createPilotTheme(options.capabilities, this.#themeMode);
    this.#models = options.models ?? [];
    this.#sessions = options.sessions ?? [];
    this.#workspacePath = options.workspacePath;
    this.#tui = new TUI(options.terminal);
    this.#screen = new PilotScreen(
      () => this.#state,
      this.#theme,
      options.capabilities,
      this.#workspacePath,
      options.repository,
    );
    this.#editor = new Editor(this.#tui, this.#theme.editor, {
      paddingX: options.capabilities.columns >= 80 ? 1 : 0,
      autocompleteMaxVisible: 7,
    });
    this.#editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        [
          { name: "help", description: "Show commands and shortcuts" },
          { name: "context", description: "Inspect selected model context" },
          { name: "models", description: "Select the model for the next turn" },
          { name: "sessions", description: "Inspect resumable sessions" },
          { name: "theme", description: "Switch terminal color theme" },
          { name: "abort", description: "Cancel the active turn" },
          { name: "exit", description: "End the chat session" },
        ],
        this.#workspacePath,
      ),
    );
    this.#footer = new PilotFooter(() => this.#state, this.#theme, options.capabilities);
    this.#editor.onSubmit = (text) => this.#submit(text);
    this.#tui.addChild(this.#screen);
    this.#tui.addChild(this.#editor);
    this.#tui.addChild(this.#footer);
    this.#tui.setFocus(this.#editor);
    this.#tui.addInputListener((data) => this.#handleGlobalInput(data));
    this.#terminal.setTitle(`Pilot — ${path.basename(this.#workspacePath)}`);
    this.#tui.start();
  }

  render(event: ChatEvent): void {
    if (this.#closed) return;
    this.#state = reduceTerminalUi(this.#state, { type: "chat.event", event });
    if (event.type === "permission.requested") {
      this.#showPermissionOverlay(event.payload.request);
    }
    if (event.type === "chat.context" && event.payload.snapshot !== undefined) {
      this.#showContextOverlay(event.payload.snapshot);
    }
    this.#tui.requestRender();
  }

  get themeMode(): PilotThemeMode {
    return this.#themeMode;
  }

  readLine(): Promise<string | undefined> {
    const pending = this.#pendingLines.shift();
    if (pending !== undefined) return Promise.resolve(pending);
    if (this.#closed) return Promise.resolve(undefined);
    return new Promise((resolve) => this.#readers.push(resolve));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#terminal.setProgress(false);
    this.#terminal.setTitle("");
    this.#tui.stop();
    for (const resolve of this.#readers.splice(0)) resolve(undefined);
  }

  #submit(rawText: string): void {
    const text = rawText.trim();
    if (text.length === 0) return;
    this.#editor.addToHistory(rawText);
    this.#promptHistory.push(rawText);
    this.#editor.setText("");
    if (text === "/theme") {
      this.#showThemeOverlay();
      return;
    }
    if (text === "/models") {
      this.#showModelOverlay();
      return;
    }
    if (text === "/sessions") {
      this.#showSessionOverlay();
      return;
    }
    this.#submissionSequence += 1;
    this.#state = reduceTerminalUi(this.#state, {
      type: "composer.submitted",
      id: `local:${this.#submissionSequence}`,
      text: rawText,
    });
    this.#enqueue(text);
    this.#tui.requestRender();
  }

  #enqueue(line: string): void {
    const reader = this.#readers.shift();
    if (reader === undefined) this.#pendingLines.push(line);
    else reader(line);
  }

  #handleGlobalInput(data: string): { readonly consume?: boolean } | undefined {
    if (this.#tui.hasOverlay()) return undefined;
    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.#state.phase !== "ready" && this.#state.phase !== "starting") {
        this.#enqueue("/abort");
      } else if (this.#editor.getText().length > 0) {
        this.#editor.setText("");
      } else {
        const now = Date.now();
        if (now - this.#lastIdleInterruptAt <= 1_000) this.#enqueue("/exit");
        this.#lastIdleInterruptAt = now;
      }
      this.#tui.requestRender();
      return { consume: true };
    }
    if (
      matchesKey(data, Key.ctrl("d")) &&
      this.#state.phase === "ready" &&
      this.#editor.getText().length === 0
    ) {
      this.#enqueue("/exit");
      return { consume: true };
    }
    if (matchesKey(data, Key.escape) && this.#state.phase !== "ready") {
      this.#enqueue("/abort");
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("l"))) {
      this.#tui.requestRender(true);
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      this.#state = reduceTerminalUi(this.#state, { type: "ui.toggle-tool-details" });
      this.#tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      this.#showHistoryOverlay();
      return { consume: true };
    }
    if (data === "?" && this.#editor.getText().length === 0) {
      this.#showHelpOverlay();
      return { consume: true };
    }
    return undefined;
  }

  #showHelpOverlay(): void {
    const dialog = new DismissableDialog(
      "Pilot shortcuts",
      [
        "Enter        Send prompt / confirm selection",
        "Ctrl+J       Insert newline",
        "Tab          Accept command or file completion",
        "Esc          Close dialog or cancel active turn",
        "Ctrl+O       Toggle detailed tool output",
        "Ctrl+L       Redraw terminal",
        "Ctrl+C       Cancel, clear, then exit on second idle press",
        "Ctrl+D       Exit when the ready composer is empty",
        "",
        "/context     Inspect model-facing context",
        "/models      Select the model used by the next turn",
        "/sessions    Inspect sessions and resume commands",
        "/theme       Switch system/dark/light/high-contrast theme",
        "/abort       Cancel the active turn",
        "/exit        End the session",
      ],
      this.#theme,
    );
    const handle = this.#tui.showOverlay(dialog, {
      width: "100%",
      minWidth: 38,
      maxHeight: "80%",
      anchor: "center",
      margin: 0,
    });
    dialog.onClose = () => handle.hide();
  }

  #showThemeOverlay(): void {
    const dialog = new SelectionDialog(
      "Theme",
      pilotThemeModes.map((mode) => ({
        value: mode,
        label: mode === this.#themeMode ? `${mode} (current)` : mode,
        description: mode === "system" ? "Use conservative terminal colors" : `${mode} palette`,
      })),
      this.#theme,
    );
    const handle = this.#tui.showOverlay(dialog, overlayOptions(32));
    dialog.onSelect = (mode) => {
      this.#themeMode = mode as PilotThemeMode;
      applyPilotTheme(this.#theme, createPilotTheme(this.#capabilities, this.#themeMode));
      this.#screen.invalidate();
      handle.hide();
      this.#tui.requestRender(true);
    };
    dialog.onClose = () => handle.hide();
  }

  #showHistoryOverlay(): void {
    const items = [...this.#promptHistory].reverse().map((text, index) => ({
      value: String(index),
      label: text.replace(/\s+/gu, " "),
      description: "Restore to composer",
    }));
    const dialog = new SelectionDialog("Prompt history", items, this.#theme);
    const handle = this.#tui.showOverlay(dialog, overlayOptions(44));
    dialog.onSelect = (value) => {
      const text = [...this.#promptHistory].reverse()[Number(value)];
      if (text !== undefined) this.#editor.setText(text);
      handle.hide();
      this.#tui.requestRender();
    };
    dialog.onClose = () => handle.hide();
  }

  #showModelOverlay(): void {
    const items = this.#models.map((model) => ({
      value: model.key,
      label:
        model.key === this.#state.modelKey ? `${model.displayName} (current)` : model.displayName,
      description: model.key,
    }));
    const dialog = new SelectionDialog("Model selector", items, this.#theme);
    const handle = this.#tui.showOverlay(dialog, overlayOptions(42));
    dialog.onSelect = (key) => {
      handle.hide();
      this.#enqueue(`/model ${key}`);
    };
    dialog.onClose = () => handle.hide();
  }

  #showSessionOverlay(): void {
    const items = this.#sessions.map((session) => ({
      value: session.id,
      label: session.id,
      description: `${session.status}, ${session.messageCount} messages, ${session.updatedAt}`,
    }));
    const dialog = new SelectionDialog("Session inspector", items, this.#theme);
    const handle = this.#tui.showOverlay(dialog, overlayOptions(50));
    dialog.onSelect = (id) => {
      handle.hide();
      this.#showSessionResumeOverlay(id);
    };
    dialog.onClose = () => handle.hide();
  }

  #showSessionResumeOverlay(id: string): void {
    const dialog = new DismissableDialog(
      "Resume session",
      [id, "", `Start a new Pilot process with:`, `pilot chat --session ${id}`],
      this.#theme,
    );
    const handle = this.#tui.showOverlay(dialog, overlayOptions(48));
    dialog.onClose = () => handle.hide();
  }

  #showContextOverlay(snapshot: NonNullable<TerminalUiState["context"]>): void {
    const lines = [
      `Cycle ${snapshot.cycle}`,
      `${snapshot.composedTokens}/${snapshot.budget.availableCandidateTokens} composed tokens`,
      `${snapshot.remainingModelTokens} model tokens remaining`,
      `Fingerprint ${snapshot.fingerprint}`,
      "",
      ...snapshot.selected.map(
        (entry) =>
          `+ ${entry.reference}  ${entry.estimatedTokens} tokens  ${entry.trust}${entry.mandatory ? "  required" : ""}`,
      ),
      ...snapshot.excluded.map(
        (entry) => `- ${entry.reference}  ${entry.estimatedTokens} tokens  ${entry.reason}`,
      ),
    ];
    const dialog = new DismissableDialog("Context inspector", lines, this.#theme);
    const handle = this.#tui.showOverlay(dialog, {
      width: "100%",
      minWidth: 40,
      maxHeight: "80%",
      anchor: "center",
      margin: 0,
    });
    dialog.onClose = () => handle.hide();
  }

  #showPermissionOverlay(request: PermissionApprovalRequest): void {
    if (this.#permissionOverlayRequestId === request.requestId) return;
    this.#permissionOverlayRequestId = request.requestId;
    const dialog = new PermissionDialog(request, this.#theme);
    const handle = this.#tui.showOverlay(dialog, {
      width: "100%",
      minWidth: 36,
      maxHeight: "75%",
      anchor: "center",
      margin: 0,
    });
    const finish = (response: string) => {
      handle.hide();
      this.#permissionOverlayRequestId = undefined;
      this.#enqueue(response);
      this.#tui.requestRender();
    };
    dialog.onResponse = finish;
    dialog.onCancel = () => finish("deny once");
  }
}

class SelectionDialog implements Component {
  readonly #list: SelectList;
  readonly #title: string;
  readonly #theme: PilotTheme;
  onSelect?: (value: string) => void;
  onClose?: () => void;

  constructor(title: string, items: readonly SelectItem[], theme: PilotTheme) {
    this.#title = title;
    this.#theme = theme;
    this.#list = new SelectList(
      items.length > 0
        ? [...items]
        : [{ value: "", label: "None available", description: "No entries were found" }],
      12,
      theme.select,
    );
    this.#list.onSelect = (item) => {
      if (item.value.length > 0) this.onSelect?.(item.value);
    };
    this.#list.onCancel = () => this.onClose?.();
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  handleInput(data: string): void {
    this.#list.handleInput(data);
  }

  render(width: number): string[] {
    return frameOverlay(
      [
        this.#theme.strong(this.#title),
        "",
        ...this.#list.render(Math.max(1, width - 4)),
        "",
        this.#theme.muted("Up/Down select  Enter confirm  Esc close"),
      ],
      width,
    );
  }
}

function overlayOptions(minWidth: number) {
  return {
    width: "100%" as const,
    minWidth,
    maxHeight: "80%" as const,
    anchor: "center" as const,
    margin: 0,
  };
}

export class PilotScreen implements Component {
  readonly #state: () => TerminalUiState;
  readonly #theme: PilotTheme;
  readonly #capabilities: TerminalCapabilitySnapshot;
  readonly #workspacePath: string;
  readonly #repository: RepositoryDisplayState | undefined;
  readonly #blockCache = new Map<
    string,
    { readonly block: TranscriptBlock; readonly lines: readonly string[] }
  >();

  constructor(
    state: () => TerminalUiState,
    theme: PilotTheme,
    capabilities: TerminalCapabilitySnapshot,
    workspacePath: string,
    repository?: RepositoryDisplayState,
  ) {
    this.#state = state;
    this.#theme = theme;
    this.#capabilities = capabilities;
    this.#workspacePath = workspacePath;
    this.#repository = repository;
  }

  invalidate(): void {
    this.#blockCache.clear();
  }

  render(width: number): string[] {
    const state = this.#state();
    const workspace = path.basename(this.#workspacePath) || this.#workspacePath;
    const brand = this.#theme.strong(this.#capabilities.unicode ? "◆ PILOT" : "PILOT");
    const model = state.modelKey ?? "starting";
    const session =
      width >= 120 && state.sessionId !== undefined ? `  ${state.sessionId.slice(0, 12)}` : "";
    const branch =
      this.#repository === undefined
        ? ""
        : `  ${this.#repository.branch}${this.#repository.dirty ? "*" : ""}`;
    const header = truncateToWidth(
      `${brand}${session}  ${workspace}${branch}  ${this.#theme.muted(model)}  ${this.#theme.warning("Manual")}`,
      width,
    );
    const lines = [header, this.#theme.muted("─".repeat(Math.max(1, width))), ""];
    for (const block of state.blocks) {
      lines.push(...this.#renderBlockCached(block, width, state.showToolDetails), "");
    }
    if (this.#blockCache.size > state.blocks.length * 3 + 30) {
      const activeIds = new Set(state.blocks.map(({ id }) => id));
      for (const key of this.#blockCache.keys()) {
        if (!activeIds.has(key.split("\0", 1)[0] ?? "")) this.#blockCache.delete(key);
      }
    }
    if (state.blocks.length === 0) {
      lines.push(
        this.#theme.muted("Ask Pilot to inspect, explain, or change this repository."),
        "",
      );
    }
    return lines;
  }

  #renderBlockCached(
    block: TranscriptBlock,
    width: number,
    showToolDetails: boolean,
  ): readonly string[] {
    const key = `${block.id}\0${width}\0${showToolDetails ? "details" : "compact"}`;
    const cached = this.#blockCache.get(key);
    if (cached?.block === block) return cached.lines;
    const lines = this.#renderBlock(block, width);
    this.#blockCache.set(key, { block, lines });
    return lines;
  }

  #renderBlock(block: TranscriptBlock, width: number): string[] {
    if (block.kind === "user") {
      return [this.#theme.accent("You"), ...wrapPlain(block.text, width, 2)];
    }
    if (block.kind === "assistant") {
      const status = block.status === "streaming" ? this.#theme.muted("  working") : "";
      const markdown = new Markdown(sanitizeTerminalText(block.text), 1, 0, this.#theme.markdown);
      return [`${this.#theme.strong("Pilot")}${status}`, ...markdown.render(width)];
    }
    if (block.kind === "tool") {
      return renderTool(
        block,
        width,
        this.#theme,
        this.#capabilities,
        this.#state().showToolDetails,
      );
    }
    if (block.kind === "summary") {
      const summary = block.summary;
      const lines = [
        this.#theme.strong("Turn summary"),
        this.#theme.muted(
          `${summary.outcome}${summary.elapsedMs === undefined ? "" : `  ${formatDuration(summary.elapsedMs)}`}  ${summary.runCount} run${summary.runCount === 1 ? "" : "s"}  ${summary.toolCount} tool${summary.toolCount === 1 ? "" : "s"}${summary.failedToolCount > 0 ? `  ${summary.failedToolCount} failed` : ""}`,
        ),
      ];
      for (const file of summary.changedFiles) {
        const changes =
          file.additions === undefined && file.deletions === undefined
            ? ""
            : `  +${file.additions ?? 0} -${file.deletions ?? 0}`;
        lines.push(this.#theme.success(`  changed ${file.path}${changes}`));
      }
      for (const command of summary.commands) {
        const details = [
          command.status,
          command.exitCode === undefined ? undefined : `exit ${command.exitCode ?? "signal"}`,
          command.durationMs === undefined ? undefined : formatDuration(command.durationMs),
          command.truncated ? "truncated" : undefined,
        ]
          .filter((value): value is string => value !== undefined)
          .join(", ");
        const decorate = command.status === "completed" ? this.#theme.success : this.#theme.danger;
        lines.push(...wrapPlain(decorate(`  command ${command.command}  ${details}`), width, 0));
      }
      if (summary.tests.length > 0) {
        const failedTests = summary.tests.filter(({ status }) => status !== "completed").length;
        lines.push(
          (failedTests === 0 ? this.#theme.success : this.#theme.danger)(
            `  tests ${failedTests === 0 ? "passed" : `${failedTests} failed`} (${summary.tests.length} command${summary.tests.length === 1 ? "" : "s"})`,
          ),
        );
      }
      if (summary.error !== undefined) lines.push(this.#theme.warning(`  ${summary.error}`));
      const usage = summary.usage;
      if (
        usage.inputTokens !== undefined ||
        usage.outputTokens !== undefined ||
        usage.estimatedCostUsd !== undefined
      ) {
        lines.push(
          this.#theme.muted(
            `  usage ${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out${usage.estimatedCostUsd === undefined ? "" : ` / $${usage.estimatedCostUsd.toFixed(4)}`}`,
          ),
        );
      }
      return lines;
    }
    const decorate =
      block.tone === "danger"
        ? this.#theme.danger
        : block.tone === "warning"
          ? this.#theme.warning
          : block.tone === "success"
            ? this.#theme.success
            : this.#theme.info;
    return wrapPlain(decorate(block.text), width, 0);
  }
}

export class PilotFooter implements Component {
  readonly #state: () => TerminalUiState;
  readonly #theme: PilotTheme;
  readonly #capabilities: TerminalCapabilitySnapshot;

  constructor(
    state: () => TerminalUiState,
    theme: PilotTheme,
    capabilities: TerminalCapabilitySnapshot,
  ) {
    this.#state = state;
    this.#theme = theme;
    this.#capabilities = capabilities;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.#state();
    const usage = state.usage;
    const parts = [phaseLabel(state.phase, this.#capabilities.unicode)];
    if (state.activeToolCount > 0) parts.push(`${state.activeToolCount} tool`);
    if (state.queuedInputCount > 0) parts.push(`${state.queuedInputCount} queued`);
    if (usage.inputTokens !== undefined) parts.push(`${compactNumber(usage.inputTokens)} in`);
    if (usage.outputTokens !== undefined) parts.push(`${compactNumber(usage.outputTokens)} out`);
    if (usage.estimatedCostUsd !== undefined) parts.push(`$${usage.estimatedCostUsd.toFixed(4)}`);
    const summary = state.lastTurnSummary;
    if (summary !== undefined && summary.changedFiles.length > 0) {
      parts.push(`${summary.changedFiles.length} changed`);
    }
    if (summary !== undefined && summary.commands.length > 0) {
      const failed = summary.commands.filter(({ status }) => status !== "completed").length;
      parts.push(
        failed === 0 ? `${summary.commands.length} command ok` : `${failed} command failed`,
      );
    }
    const hints =
      width >= 80
        ? "Enter send  Ctrl+J newline  Esc cancel  Ctrl+C twice exit"
        : "Enter send  Esc cancel";
    return [
      this.#theme.muted("─".repeat(Math.max(1, width))),
      truncateToWidth(`${parts.join("  ")}  ${this.#theme.muted(hints)}`, width),
    ];
  }
}

class PermissionDialog implements Component {
  readonly #request: PermissionApprovalRequest;
  readonly #theme: PilotTheme;
  readonly #patch: string | undefined;
  #list: SelectList;
  #mode: "decision" | "diff" | "more" = "decision";
  #diffOffset = 0;
  onResponse?: (response: string) => void;
  onCancel?: () => void;

  constructor(request: PermissionApprovalRequest, theme: PilotTheme) {
    this.#request = request;
    this.#theme = theme;
    this.#patch =
      request.action.kind === "tool" && request.action.toolName === "apply_patch"
        ? patchFromInput(request.action.input)
        : undefined;
    this.#list = new SelectList([], 8, theme.select);
    this.#showDecisionList();
  }

  #showDecisionList(): void {
    this.#mode = "decision";
    const items: SelectItem[] = [
      { value: "allow once", label: "Allow once", description: "Approve only this action" },
      { value: "deny once", label: "Deny", description: "Do not run this action" },
      ...(this.#request.availableScopes.some((scope) => scope !== "once")
        ? [
            {
              value: "more",
              label: "More options...",
              description: "Review broader policy-supported scopes",
            },
          ]
        : []),
    ];
    this.#list = new SelectList(items, 8, this.#theme.select);
    this.#list.onSelect = (item) => {
      if (item.value === "more") this.#showMoreList();
      else this.onResponse?.(item.value);
    };
    this.#list.onCancel = () => this.onCancel?.();
  }

  #showMoreList(): void {
    this.#mode = "more";
    const items: SelectItem[] = [
      ...this.#request.availableScopes
        .filter((scope) => scope !== "once")
        .map((scope) => ({
          value: `allow ${scope}`,
          label: `Allow for ${scope}`,
          description: "Broader approval permitted by policy",
        })),
      { value: "back", label: "Back", description: "Return without approving" },
    ];
    this.#list = new SelectList(items, 8, this.#theme.select);
    this.#list.onSelect = (item) => {
      if (item.value === "back") this.#showDecisionList();
      else this.onResponse?.(item.value);
    };
    this.#list.onCancel = () => this.#showDecisionList();
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  handleInput(data: string): void {
    if (this.#mode === "diff") {
      if (matchesKey(data, Key.up)) this.#diffOffset = Math.max(0, this.#diffOffset - 1);
      else if (matchesKey(data, Key.down)) this.#diffOffset += 1;
      else if (matchesKey(data, Key.pageUp)) this.#diffOffset = Math.max(0, this.#diffOffset - 10);
      else if (matchesKey(data, Key.pageDown)) this.#diffOffset += 10;
      else if (matchesKey(data, Key.home)) this.#diffOffset = 0;
      else if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.enter) ||
        data === "q" ||
        data === "d"
      ) {
        this.#showDecisionList();
      }
      return;
    }
    if (data === "d" && this.#patch !== undefined) {
      this.#mode = "diff";
      return;
    }
    this.#list.handleInput(data);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    if (this.#mode === "diff" && this.#patch !== undefined) {
      return this.#renderDiff(width, innerWidth);
    }
    const action = this.#request.action;
    const target =
      action.kind === "command"
        ? `${action.executable} ${action.args.join(" ")}`.trim()
        : `${action.toolName} ${safeJson(action.input)}`;
    return frameOverlay(
      [
        this.#theme.danger("Permission required"),
        ...wrapPlain(this.#request.policyDecision.reason, innerWidth, 0),
        this.#theme.warning(`Risk: ${action.risk}`),
        ...wrapPlain(sanitizeTerminalText(target), innerWidth, 0),
        ...(this.#patch === undefined
          ? []
          : [
              "",
              this.#theme.strong("Proposed diff"),
              ...previewLines(this.#patch, innerWidth, 5),
              this.#theme.muted("Press d to inspect and scroll the complete diff"),
            ]),
        "",
        ...(this.#mode === "more"
          ? [this.#theme.warning("Broader scopes persist beyond this action")]
          : []),
        ...this.#list.render(innerWidth),
        "",
        this.#theme.muted(
          this.#mode === "more" ? "Enter confirm  Esc back" : "Enter confirm  Esc deny",
        ),
      ],
      width,
    );
  }

  #renderDiff(width: number, innerWidth: number): string[] {
    const allLines = sanitizeTerminalText(this.#patch ?? "").split(/\r?\n/u);
    const viewportLines = 14;
    const maximumOffset = Math.max(0, allLines.length - viewportLines);
    this.#diffOffset = Math.min(this.#diffOffset, maximumOffset);
    const visible = allLines.slice(this.#diffOffset, this.#diffOffset + viewportLines);
    return frameOverlay(
      [
        this.#theme.strong("Proposed diff"),
        this.#theme.muted(
          `Lines ${this.#diffOffset + 1}-${Math.min(allLines.length, this.#diffOffset + viewportLines)} of ${allLines.length}`,
        ),
        "",
        ...visible.flatMap((line) => wrapPlain(styleDiffLine(line, this.#theme), innerWidth, 0)),
        "",
        this.#theme.muted("Up/Down scroll  PgUp/PgDn page  Home top  d/Esc back"),
      ],
      width,
    );
  }
}

class DismissableDialog implements Component {
  readonly #title: string;
  readonly #lines: readonly string[];
  readonly #theme: PilotTheme;
  onClose?: () => void;

  constructor(title: string, lines: readonly string[], theme: PilotTheme) {
    this.#title = title;
    this.#lines = lines;
    this.#theme = theme;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.ctrl("c")) ||
      data === "q"
    ) {
      this.onClose?.();
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    return frameOverlay(
      [
        this.#theme.strong(this.#title),
        "",
        ...this.#lines.flatMap((line) => wrapPlain(line, innerWidth, 0)),
        "",
        this.#theme.muted("Esc close"),
      ],
      width,
    );
  }
}

function renderTool(
  block: ToolTranscriptBlock,
  width: number,
  theme: PilotTheme,
  capabilities: TerminalCapabilitySnapshot,
  expanded: boolean,
): string[] {
  const symbol =
    block.status === "running"
      ? capabilities.unicode
        ? "●"
        : "*"
      : block.status === "failed" || block.status === "cancelled"
        ? capabilities.unicode
          ? "✗"
          : "x"
        : capabilities.unicode
          ? "✓"
          : "+";
  const decorate =
    block.status === "failed"
      ? theme.danger
      : block.status === "cancelled"
        ? theme.warning
        : block.status === "completed"
          ? theme.success
          : theme.info;
  const duration = block.durationMs === undefined ? "" : `  ${formatDuration(block.durationMs)}`;
  const truncated = block.truncated ? "  truncated" : "";
  const lines = [
    truncateToWidth(
      decorate(`${symbol} ${block.name}  ${block.status}${duration}${truncated}`),
      width,
    ),
  ];
  if (block.status === "failed" || block.status === "cancelled" || expanded) {
    lines.push(...wrapPlain(theme.muted(`input ${safeJson(block.input)}`), width, 2));
    if (block.output !== undefined) {
      lines.push(...wrapPlain(theme.muted(`output ${safeJson(block.output)}`), width, 2));
    }
    if (block.commandOutput.length > 0) {
      lines.push(...previewLines(block.commandOutput, width - 2, 12).map((line) => `  ${line}`));
    }
  } else if (block.commandOutput.length > 0) {
    const summary = block.commandOutput.trim().split(/\r?\n/u).at(-1) ?? "";
    if (summary.length > 0) lines.push(...wrapPlain(theme.muted(summary), width, 2));
  }
  return lines;
}

function patchFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const patch = (input as Readonly<Record<string, unknown>>).patch;
  return typeof patch === "string" ? patch : undefined;
}

function previewLines(text: string, width: number, maximumLines: number): string[] {
  const lines = sanitizeTerminalText(text)
    .split(/\r?\n/u)
    .flatMap((line) => wrapPlain(line, width, 0));
  if (lines.length <= maximumLines) return lines;
  return [...lines.slice(0, maximumLines), `… ${lines.length - maximumLines} more lines`];
}

function styleDiffLine(line: string, theme: PilotTheme): string {
  if (line.startsWith("@@")) return theme.accent(line);
  if (line.startsWith("+++") || line.startsWith("---")) return theme.info(line);
  if (line.startsWith("+")) return theme.success(line);
  if (line.startsWith("-")) return theme.danger(line);
  return theme.muted(line);
}

function frameOverlay(lines: readonly string[], width: number): string[] {
  const frameWidth = Math.max(8, width);
  const innerWidth = frameWidth - 4;
  const border = `+${"-".repeat(frameWidth - 2)}+`;
  return [
    border,
    ...lines.map((line) => {
      const content = truncateToWidth(line, innerWidth, "");
      return `| ${content}${" ".repeat(Math.max(0, innerWidth - visibleWidth(content)))} |`;
    }),
    border,
  ];
}

function phaseLabel(phase: TerminalUiState["phase"], unicode: boolean): string {
  const marker = unicode ? "●" : "*";
  return `${marker} ${phase.replace("-", " ")}`;
}

function compactNumber(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

function formatDuration(durationMs: number): string {
  return durationMs >= 1_000
    ? `${(durationMs / 1_000).toFixed(1)}s`
    : `${Math.round(durationMs)}ms`;
}

function wrapPlain(text: string, width: number, padding: number): string[] {
  const available = Math.max(1, width - padding);
  const prefix = " ".repeat(padding);
  return sanitizeTerminalText(text)
    .split("\n")
    .flatMap((line) => wrapTextWithAnsi(line, available).map((wrapped) => prefix + wrapped));
}

function safeJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable value]";
  }
}
