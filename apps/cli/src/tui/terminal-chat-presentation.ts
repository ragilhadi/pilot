import path from "node:path";
import { Editor, Key, matchesKey, type Terminal, TUI } from "@earendil-works/pi-tui";
import type { ClarificationRequest, PermissionApprovalRequest } from "@pilotrun/core";
import type { ChatEvent } from "../chat-events.js";
import type { InteractiveChatPresentation } from "../presentation/chat-presentation.js";
import type { TerminalCapabilitySnapshot } from "../presentation/presentation-mode.js";
import { copyToClipboard } from "./clipboard.js";
import { type CodeBlock, extractCodeBlocks } from "./code-blocks.js";
import { DismissableDialog, overlayOptions, SelectionDialog } from "./components/dialogs.js";
import { PermissionDialog } from "./components/permission-dialog.js";
import { QuestionDialog } from "./components/question-dialog.js";
import { PilotFooter } from "./components/footer.js";
import {
  PilotScreen,
  type RepositoryDisplayState,
  summarizeToolCall,
} from "./components/screen.js";
import { formatDuration } from "./render-helpers.js";
import { WorkspaceFileAutocompleteProvider } from "./workspace-file-autocomplete.js";
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
} from "./terminal-ui-state.js";

export { PilotFooter } from "./components/footer.js";
export { PilotScreen } from "./components/screen.js";
export type { RepositoryDisplayState } from "./components/screen.js";

export interface TerminalChatPresentationOptions {
  readonly terminal: Terminal;
  readonly capabilities: TerminalCapabilitySnapshot;
  readonly workspacePath: string;
  readonly repository?: RepositoryDisplayState;
  readonly themeMode?: PilotThemeMode;
  readonly models?: readonly ModelDisplayState[];
  readonly sessions?: readonly SessionDisplayState[];
  /** Monotonic clock for the activity animation's elapsed time. Injectable for tests. */
  readonly now?: () => number;
  /** Frame interval for the activity animation, in milliseconds. */
  readonly activityIntervalMs?: number;
}

/** Rows reserved below the permission dialog: the footer's two lines plus one composer line. */
export const permissionDialogBottomMargin = 3;

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
  #questionOverlay: { readonly requestId: string; readonly hide: () => void } | undefined;
  #lastIdleInterruptAt = Number.NEGATIVE_INFINITY;
  #themeMode: PilotThemeMode;
  #noticeSequence = 0;
  readonly #now: () => number;
  readonly #activityIntervalMs: number;
  #activityTimer: ReturnType<typeof setInterval> | undefined;
  #activityFrame = 0;
  #activityStartedAt = 0;

  constructor(options: TerminalChatPresentationOptions) {
    this.#terminal = options.terminal;
    this.#capabilities = options.capabilities;
    this.#themeMode = options.themeMode ?? "system";
    this.#theme = createPilotTheme(options.capabilities, this.#themeMode);
    this.#models = options.models ?? [];
    this.#sessions = options.sessions ?? [];
    this.#workspacePath = options.workspacePath;
    this.#now = options.now ?? (() => performance.now());
    this.#activityIntervalMs = options.activityIntervalMs ?? 120;
    this.#tui = new TUI(options.terminal);
    this.#screen = new PilotScreen(
      () => this.#state,
      this.#theme,
      options.capabilities,
      this.#workspacePath,
      options.repository,
      () => this.#activitySnapshot(),
    );
    this.#editor = new Editor(this.#tui, this.#theme.editor, {
      paddingX: options.capabilities.columns >= 80 ? 1 : 0,
      autocompleteMaxVisible: 7,
    });
    this.#editor.setAutocompleteProvider(
      new WorkspaceFileAutocompleteProvider({
        commands: [
          { name: "help", description: "Show commands and shortcuts" },
          { name: "context", description: "Inspect selected model context" },
          { name: "models", description: "Select the model for the next turn" },
          { name: "sessions", description: "Inspect resumable sessions" },
          { name: "tools", description: "Inspect tool calls and their input/output" },
          { name: "copy", description: "Copy a code block to the clipboard" },
          { name: "theme", description: "Switch terminal color theme" },
          { name: "abort", description: "Cancel the active turn" },
          { name: "exit", description: "End the chat session" },
        ],
        basePath: this.#workspacePath,
      }),
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
    if (event.type === "question.requested") {
      this.#showQuestionOverlay(event.payload.request);
    }
    if (
      event.type === "question.answered" ||
      event.type === "chat.turn.completed" ||
      event.type === "chat.turn.aborted" ||
      event.type === "chat.turn.failed"
    ) {
      this.#hideQuestionOverlay();
    }
    if (event.type === "chat.context" && event.payload.snapshot !== undefined) {
      this.#showContextOverlay(event.payload.snapshot);
    }
    this.#syncActivity();
    this.#tui.requestRender();
  }

  /**
   * Runs a lightweight frame timer while the model is streaming or a tool is running so the activity
   * indicator animates even when no output events arrive (e.g. long hidden reasoning). The timer is
   * torn down as soon as the UI goes idle, and never keeps the process alive.
   */
  #syncActivity(): void {
    const busy = this.#state.phase === "streaming" || this.#state.phase === "running-tool";
    if (busy && this.#activityTimer === undefined) {
      this.#activityFrame = 0;
      this.#activityStartedAt = this.#now();
      this.#activityTimer = setInterval(() => {
        this.#activityFrame += 1;
        this.#tui.requestRender();
      }, this.#activityIntervalMs);
      this.#activityTimer.unref?.();
    } else if (!busy && this.#activityTimer !== undefined) {
      clearInterval(this.#activityTimer);
      this.#activityTimer = undefined;
    }
  }

  #activitySnapshot(): { readonly frame: number; readonly elapsedMs: number } | undefined {
    if (this.#activityTimer === undefined) return undefined;
    return {
      frame: this.#activityFrame,
      elapsedMs: Math.max(0, this.#now() - this.#activityStartedAt),
    };
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
    if (this.#activityTimer !== undefined) {
      clearInterval(this.#activityTimer);
      this.#activityTimer = undefined;
    }
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
    if (text === "/copy") {
      this.#showCopyOverlay();
      return;
    }
    if (text === "/tools") {
      this.#showToolsOverlay();
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
    if (matchesKey(data, Key.ctrl("t"))) {
      this.#state = reduceTerminalUi(this.#state, { type: "ui.toggle-thinking" });
      this.#tui.requestRender(true);
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      this.#showHistoryOverlay();
      return { consume: true };
    }
    // Ctrl+Y copies a code block, but only when the composer is empty so the
    // editor's emacs-style yank stays available while typing.
    if (
      matchesKey(data, Key.ctrl("y")) &&
      this.#editor.getText().length === 0 &&
      this.#collectCodeBlocks().length > 0
    ) {
      this.#showCopyOverlay();
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
        "@path        Attach a file as context (ignored files are skipped)",
        "Esc          Close dialog or cancel active turn",
        "Ctrl+O       Toggle detailed tool output",
        "Ctrl+T       Toggle model thinking (reasoning)",
        "Ctrl+Y       Copy a code block (empty composer)",
        "Ctrl+L       Redraw terminal",
        "Ctrl+C       Cancel, clear, then exit on second idle press",
        "Ctrl+D       Exit when the ready composer is empty",
        "",
        "/context     Inspect model-facing context",
        "/models      Select the model used by the next turn",
        "/sessions    Inspect sessions and resume commands",
        "/tools       Inspect tool calls and their input/output",
        "/copy        Copy a code block to the clipboard",
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

  /** Every code block across the transcript, most recent first. */
  #collectCodeBlocks(): readonly CodeBlock[] {
    const blocks: CodeBlock[] = [];
    for (const block of this.#state.blocks) {
      if (block.kind === "assistant") blocks.push(...extractCodeBlocks(block.text));
    }
    return blocks.reverse();
  }

  #notify(tone: "info" | "warning" | "danger" | "success", text: string): void {
    this.#noticeSequence += 1;
    this.#state = reduceTerminalUi(this.#state, {
      type: "ui.notice",
      id: `local-notice:${this.#noticeSequence}`,
      tone,
      text,
    });
    this.#tui.requestRender();
  }

  #copyCodeBlock(block: CodeBlock): void {
    const copied = copyToClipboard(this.#terminal, block.code);
    const lineCount = block.code.split("\n").length;
    if (copied) {
      this.#notify(
        "success",
        `Copied ${lineCount} line${lineCount === 1 ? "" : "s"}${block.lang === undefined ? "" : ` of ${block.lang}`} to the clipboard`,
      );
    } else {
      this.#notify("warning", "Code block is too large to copy through the terminal clipboard");
    }
  }

  #showCopyOverlay(): void {
    const blocks = this.#collectCodeBlocks();
    if (blocks.length === 1 && blocks[0] !== undefined) {
      this.#copyCodeBlock(blocks[0]);
      return;
    }
    const items = blocks.map((block, index) => {
      const preview =
        block.code
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? "(empty)";
      const lineCount = block.code.split("\n").length;
      return {
        value: String(index),
        label: `${block.lang ?? "text"}  ${preview}`,
        description: `${lineCount} line${lineCount === 1 ? "" : "s"}, copy to clipboard`,
      };
    });
    const dialog = new SelectionDialog("Copy code block", items, this.#theme);
    const handle = this.#tui.showOverlay(dialog, overlayOptions(48));
    dialog.onSelect = (value) => {
      handle.hide();
      const block = blocks[Number(value)];
      if (block !== undefined) this.#copyCodeBlock(block);
    };
    dialog.onClose = () => handle.hide();
  }

  /** Lists every tool call in the session; selecting one opens its full input/output. */
  #showToolsOverlay(): void {
    const tools = this.#state.blocks.filter(
      (block): block is ToolTranscriptBlock => block.kind === "tool",
    );
    if (tools.length === 0) {
      this.#notify("info", "No tool calls in this session yet");
      return;
    }
    const items = tools.map((block, index) => ({
      value: String(index),
      label: `${block.name}  ${summarizeToolCall(block)}`,
      description: `${block.status}${block.durationMs === undefined ? "" : `, ${formatDuration(block.durationMs)}`}`,
    }));
    const dialog = new SelectionDialog("Tool calls", items, this.#theme);
    const handle = this.#tui.showOverlay(dialog, overlayOptions(60));
    dialog.onSelect = (value) => {
      handle.hide();
      const block = tools[Number(value)];
      if (block !== undefined) this.#showToolDetailOverlay(block);
    };
    dialog.onClose = () => handle.hide();
  }

  #showToolDetailOverlay(block: ToolTranscriptBlock): void {
    const heading = `${block.name}  ${block.status}${block.durationMs === undefined ? "" : `  ${formatDuration(block.durationMs)}`}`;
    const lines = [heading, "", "input", ...jsonLines(block.input)];
    if (block.output !== undefined) {
      lines.push("", "output", ...jsonLines(block.output));
    }
    const commandOutput = block.commandOutput.trim();
    if (commandOutput.length > 0) {
      lines.push("", "command output", ...commandOutput.split(/\r?\n/u));
    }
    const dialog = new DismissableDialog(`Tool: ${block.name}`, lines, this.#theme);
    const handle = this.#tui.showOverlay(dialog, {
      width: "100%",
      minWidth: 40,
      maxHeight: "80%",
      anchor: "center",
      margin: 0,
    });
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
    const dialog = new PermissionDialog(request, this.#theme, this.#capabilities);
    const handle = this.#tui.showOverlay(dialog, {
      width: "100%",
      minWidth: 36,
      maxHeight: "70%",
      // Unlike the other overlays, this one is a response to what the user is doing right now, so
      // it belongs next to the composer. Centering it put a tall dialog a few rows from the top of
      // the screen with a gap between it and the input the user is looking at.
      anchor: "bottom-center",
      margin: { bottom: permissionDialogBottomMargin },
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

  #showQuestionOverlay(request: ClarificationRequest): void {
    // A question with no options is answered by typing, so an overlay would only steal the
    // composer's focus; the transcript notice already carries the question.
    if (request.options.length === 0) return;
    if (this.#questionOverlay?.requestId === request.requestId) return;
    this.#hideQuestionOverlay();
    const dialog = new QuestionDialog(request, this.#theme);
    const handle = this.#tui.showOverlay(dialog, {
      width: "100%",
      minWidth: 36,
      maxHeight: "70%",
      anchor: "bottom-center",
      margin: { bottom: permissionDialogBottomMargin },
    });
    this.#questionOverlay = { requestId: request.requestId, hide: () => handle.hide() };
    dialog.onResponse = (line) => {
      this.#hideQuestionOverlay();
      this.#enqueue(line);
      this.#tui.requestRender();
    };
    // Dismissing does not answer: the question stays pending and the user can type a reply.
    dialog.onDismiss = () => {
      this.#hideQuestionOverlay();
      this.#tui.requestRender();
    };
  }

  #hideQuestionOverlay(): void {
    const overlay = this.#questionOverlay;
    if (overlay === undefined) return;
    this.#questionOverlay = undefined;
    overlay.hide();
  }
}

function jsonLines(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\r?\n/u);
  try {
    return JSON.stringify(value, null, 2).split("\n");
  } catch {
    return [String(value)];
  }
}
