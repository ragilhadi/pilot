import type { Terminal } from "@earendil-works/pi-tui";
import { runId, sessionId } from "@pilotrun/core";
import { afterEach, describe, expect, it } from "vitest";
import { ChatEventFactory } from "../src/index.js";
import {
  permissionDialogBottomMargin,
  TerminalChatPresentation,
} from "../src/tui/terminal-chat-presentation.js";

class FakeTerminal implements Terminal {
  columns: number;
  rows: number;
  readonly kittyProtocolActive = false;
  output = "";
  writes = 0;
  started = false;
  stopped = false;
  title = "";
  progressActive = false;
  #onInput: ((data: string) => void) | undefined;
  #onResize: (() => void) | undefined;

  constructor(columns = 100, rows = 30) {
    this.columns = columns;
    this.rows = rows;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.started = true;
    this.#onInput = onInput;
    this.#onResize = onResize;
  }

  stop(): void {
    this.stopped = true;
  }

  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
    this.writes += 1;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(title: string): void {
    this.title = title;
  }
  setProgress(active: boolean): void {
    this.progressActive = active;
  }

  input(data: string): void {
    this.#onInput?.(data);
  }

  resize(columns = this.columns, rows = this.rows): void {
    this.columns = columns;
    this.rows = rows;
    this.#onResize?.();
  }
}

const capabilities = {
  interactiveInput: true,
  interactiveOutput: true,
  cursorAddressing: true,
  color: false,
  unicode: true,
  columns: 100,
  rows: 30,
} as const;

describe("terminal chat presentation", () => {
  const presentations: TerminalChatPresentation[] = [];
  afterEach(async () => {
    await Promise.all(presentations.splice(0).map((presentation) => presentation.close()));
  });

  it("accepts multiline-editor input and restores terminal lifecycle", async () => {
    const terminal = new FakeTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    const line = presentation.readLine();

    terminal.input("h");
    terminal.input("i");
    terminal.input("\r");

    await expect(line).resolves.toBe("hi");
    expect(terminal.started).toBe(true);
    expect(terminal.title).toContain("Pilot");
    await presentation.close();
    expect(terminal.stopped).toBe(true);
    expect(terminal.title).toBe("");
  });

  it("offers to exit on Ctrl+D only when the ready composer is empty", async () => {
    const terminal = new FakeTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    const factory = new ChatEventFactory({ now: () => new Date("2026-07-22T12:00:00.000Z") });
    presentation.render(
      factory.create({
        type: "chat.started",
        sessionId: sessionId("session-ctrl-d"),
        payload: { modelKey: "fake/test" },
      }),
    );
    const line = presentation.readLine();

    // Ctrl+D now opens the exit confirmation rather than ending the session outright.
    terminal.input("\u0004");
    await new Promise((resolve) => setTimeout(resolve, 25));
    terminal.input("y");

    await expect(line).resolves.toBe("/exit");
  });

  it("supports multiline input and resolves pending readers during cleanup", async () => {
    const terminal = new FakeTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    const submitted = presentation.readLine();

    for (const character of "first") terminal.input(character);
    terminal.input("\n");
    for (const character of "second") terminal.input(character);
    terminal.input("\r");

    await expect(submitted).resolves.toBe("first\nsecond");
    const pending = presentation.readLine();
    await presentation.close();
    await expect(pending).resolves.toBeUndefined();
  });

  it("renders streaming state and maps the safest permission choice to text interaction", async () => {
    const terminal = new FakeTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    const factory = new ChatEventFactory({ now: () => new Date("2026-07-22T12:00:00.000Z") });
    const id = sessionId("session-ui");
    presentation.render(
      factory.create({
        type: "chat.started",
        sessionId: id,
        payload: { modelKey: "ollama/glm-5.2:cloud" },
      }),
    );
    presentation.render(
      factory.create({
        type: "model.stream",
        sessionId: id,
        runId: runId("run-ui"),
        payload: {
          event: { type: "response.started", sequence: 0, responseId: "response-ui" },
        },
      }),
    );
    presentation.render(
      factory.create({
        type: "model.stream",
        sessionId: id,
        runId: runId("run-ui"),
        payload: {
          event: {
            type: "text.delta",
            sequence: 1,
            responseId: "response-ui",
            contentIndex: 0,
            delta: "Safe output",
          },
        },
      }),
    );
    const response = presentation.readLine();
    presentation.render(
      factory.create({
        type: "permission.requested",
        sessionId: id,
        runId: runId("run-ui"),
        payload: {
          request: {
            requestId: "permission-ui",
            action: {
              kind: "tool",
              toolName: "apply_patch",
              risk: "workspace-write",
              requiredPermissions: ["workspace.write"],
              input: { patch: "*** Begin Patch" },
            },
            context: {
              runId: "run-ui",
              callId: "call-ui",
              sessionId: "session-ui",
              workspaceId: "C:/workspace/pilot",
              applicationId: "pilot-cli",
            },
            policyDecision: {
              effect: "ask",
              reason: "Workspace writes require approval",
              actionFingerprint: `sha256:${"a".repeat(64)}`,
              evaluatedRuleIds: ["builtin.workspace-write.ask"],
            },
            availableScopes: ["once", "session"],
          },
        },
      }),
    );

    terminal.input("\r");
    await expect(response).resolves.toBe("allow once");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(terminal.output).toContain("PILOT");
    expect(terminal.output).toContain("Safe output");
  });

  it("animates the activity indicator while streaming and stops it when the turn ends", async () => {
    const terminal = new FakeTerminal();
    let clock = 0;
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
      now: () => clock,
      activityIntervalMs: 5,
    });
    presentations.push(presentation);
    const factory = new ChatEventFactory({ now: () => new Date("2026-07-22T12:00:00.000Z") });
    const id = sessionId("session-activity");
    const run = runId("run-activity");
    presentation.render(
      factory.create({ type: "chat.started", sessionId: id, payload: { modelKey: "fake/test" } }),
    );
    clock = 2_000;
    presentation.render(
      factory.create({
        type: "model.stream",
        sessionId: id,
        runId: run,
        payload: { event: { type: "response.started", sequence: 0, responseId: "response-a" } },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(terminal.output).toContain("Thinking");

    terminal.output = "";
    presentation.render(
      factory.create({
        type: "model.stream",
        sessionId: id,
        runId: run,
        payload: {
          event: {
            type: "response.completed",
            sequence: 1,
            responseId: "response-a",
            finishReason: "stop",
          },
        },
      }),
    );

    // Once idle the timer is torn down, so no further frames are written.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const afterIdle = terminal.output;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(terminal.output).toBe(afterIdle);
  });

  it("opens a /tools overlay listing tool calls with compact summaries", async () => {
    const terminal = new FakeTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    const factory = new ChatEventFactory({ now: () => new Date("2026-07-22T12:00:00.000Z") });
    const id = sessionId("session-tools");
    const run = runId("run-tools");
    presentation.render(
      factory.create({ type: "chat.started", sessionId: id, payload: { modelKey: "fake/test" } }),
    );
    presentation.render(
      factory.create({
        type: "tool.execution",
        sessionId: id,
        runId: run,
        payload: {
          event: {
            type: "tool.started",
            runId: "run-tools",
            callId: "call-1",
            toolName: "list_files",
            input: { path: "apps/api/gen" },
          },
        },
      }),
    );
    presentation.render(
      factory.create({
        type: "tool.execution",
        sessionId: id,
        runId: run,
        payload: {
          event: {
            type: "tool.completed",
            runId: "run-tools",
            callId: "call-1",
            toolName: "list_files",
            output: { scannedEntries: 5 },
            isError: false,
          },
        },
      }),
    );

    // Typing the /tools command opens the overlay locally without sending a prompt.
    for (const character of "/tools") terminal.input(character);
    terminal.input("\r");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(terminal.output).toContain("Tool calls");
    expect(terminal.output).toContain("list_files");
    expect(terminal.output).toContain("5 entries");
  });

  it("denies once when a permission dialog is cancelled", async () => {
    const terminal = new FakeTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    const factory = new ChatEventFactory({ now: () => new Date("2026-07-22T12:00:00.000Z") });
    const response = presentation.readLine();
    presentation.render(permissionEvent(factory));

    terminal.input("\u001b");

    await expect(response).resolves.toBe("deny once");
  });

  it("hides broader permission scopes behind More options", async () => {
    const terminal = new FakeTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    const factory = new ChatEventFactory({ now: () => new Date("2026-07-22T12:00:00.000Z") });
    const response = presentation.readLine();
    presentation.render(permissionEvent(factory));

    terminal.input("\u001b[B");
    terminal.input("\u001b[B");
    terminal.input("\r");
    terminal.input("\r");

    await expect(response).resolves.toBe("allow session");
  });

  it("opens and scrolls the complete syntax-aware permission diff before returning safely", async () => {
    const terminal = new FakeTerminal(80, 24);
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities: { ...capabilities, columns: 80, rows: 24 },
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    const factory = new ChatEventFactory({ now: () => new Date("2026-07-22T12:00:00.000Z") });
    const response = presentation.readLine();
    const patch = [
      "--- a/src/file.ts",
      "+++ b/src/file.ts",
      "@@ -1,20 +1,20 @@",
      ...Array.from({ length: 30 }, (_, index) =>
        index % 2 === 0 ? `-old line ${index}` : `+new line ${index}`,
      ),
    ].join("\n");
    presentation.render(permissionEvent(factory, patch));

    terminal.input("d");
    await new Promise((resolve) => setTimeout(resolve, 25));
    // The viewport is sized from the terminal's rows, so on an 80x24 screen it fits inside the
    // overlay's height budget and the key hints below it are not sliced off.
    expect(terminal.output).toContain("Lines 1-8 of 33");
    expect(terminal.output).toContain("d/Esc back");
    terminal.input("\u001b[6~");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(terminal.output).toContain("Lines 11-18 of 33");
    terminal.input("\u001b");
    terminal.input("\u001b");

    await expect(response).resolves.toBe("deny once");
  });

  it("anchors the permission dialog just above the composer, not mid-screen", async () => {
    const terminal = new FakeTerminal(80, 24);
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities: { ...capabilities, columns: 80, rows: 24 },
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    const factory = new ChatEventFactory({ now: () => new Date("2026-07-22T12:00:00.000Z") });
    presentation.render(
      factory.create({
        type: "chat.started",
        sessionId: sessionId("session-anchor"),
        payload: { modelKey: "ollama/glm-5.2:cloud" },
      }),
    );
    presentation.render(permissionEvent(factory));
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The last frame written to the terminal, split into rows.
    const frame = terminal.output.split("\u001b[?2026h").at(-1) ?? "";
    const lines = frame.split("\n");
    const lastBorder = lines.findLastIndex((line) => line.includes("+---"));
    const firstBorder = lines.findIndex((line) => line.includes("+---"));

    expect(firstBorder).toBeGreaterThan(0);
    // Centering placed a tall dialog a few rows from the top of the screen, leaving a gap between
    // it and the input. Bottom-anchoring puts its lower edge exactly the reserved margin above the
    // bottom of the terminal, whatever the dialog's height.
    expect(24 - 1 - lastBorder).toBe(permissionDialogBottomMargin);
  });

  it.each([
    [40, 10],
    [60, 16],
    [100, 30],
    [160, 50],
  ])("renders and resizes safely at %ix%i", async (columns, rows) => {
    const terminal = new FakeTerminal(columns, rows);
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities: { ...capabilities, columns, rows },
      workspacePath: "C:/a/very-long-workspace-name-that-needs-responsive-truncation/pilot",
      repository: {
        branch: "feature/a-very-long-branch-name-that-must-not-overflow",
        dirty: true,
      },
    });
    presentations.push(presentation);
    const factory = new ChatEventFactory({ now: () => new Date("2026-07-22T12:00:00.000Z") });
    presentation.render(
      factory.create({
        type: "chat.started",
        sessionId: sessionId("responsive-session"),
        payload: { modelKey: "ollama/glm-5.2:cloud" },
      }),
    );
    presentation.render(permissionEvent(factory));

    terminal.resize(160, 50);
    terminal.resize(60, 16);
    terminal.resize(columns, rows);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(terminal.output).toContain("Permission required");
    // On a 10-row terminal the dialog plus footer fill the screen, so the transcript header is
    // legitimately scrolled out; anywhere with room, it stays visible alongside the dialog.
    if (rows >= 16) expect(terminal.output).toContain("PILOT");
  });

  it("uses ASCII and no-color semantics without losing state labels", async () => {
    const terminal = new FakeTerminal(60, 16);
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities: { ...capabilities, color: false, unicode: false, columns: 60, rows: 16 },
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    const factory = new ChatEventFactory({ now: () => new Date("2026-07-22T12:00:00.000Z") });
    presentation.render(
      factory.create({
        type: "chat.started",
        sessionId: sessionId("ascii-session"),
        payload: { modelKey: "fake/test" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(terminal.output).toContain("PILOT");
    expect(terminal.output).toContain("* ready");
    expect(terminal.output).not.toContain("\u001b[36m");
  });

  it("coalesces a high-rate stream instead of writing once per delta", async () => {
    const terminal = new FakeTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    const factory = new ChatEventFactory({ now: () => new Date("2026-07-22T12:00:00.000Z") });
    const id = sessionId("stream-session");
    const run = runId("stream-run");
    presentation.render(
      factory.create({
        type: "chat.started",
        sessionId: id,
        payload: { modelKey: "fake/test" },
      }),
    );
    presentation.render(
      factory.create({
        type: "model.stream",
        sessionId: id,
        runId: run,
        payload: {
          event: { type: "response.started", sequence: 0, responseId: "response-stream" },
        },
      }),
    );
    const writesBeforeStream = terminal.writes;
    for (let index = 0; index < 1_000; index += 1) {
      presentation.render(
        factory.create({
          type: "model.stream",
          sessionId: id,
          runId: run,
          payload: {
            event: {
              type: "text.delta",
              sequence: index + 1,
              responseId: "response-stream",
              contentIndex: 0,
              delta: "x",
            },
          },
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(terminal.writes - writesBeforeStream).toBeLessThan(50);
    expect(terminal.output).toContain("xxxxxxxxxx");
  });

  it("switches theme locally without submitting a chat message", async () => {
    const terminal = new FakeTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities: { ...capabilities, color: true },
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);

    for (const character of "/theme") terminal.input(character);
    terminal.input("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(terminal.output).toContain("Theme");
    terminal.input("\u001b[B");
    terminal.input("\u001b[B");
    terminal.input("\r");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(presentation.themeMode).toBe("light");
  });

  it("selects a model through the existing chat command channel", async () => {
    const terminal = new FakeTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
      models: [
        { key: "ollama/glm-5.2:cloud", displayName: "GLM 5.2 Cloud" },
        { key: "fake/test", displayName: "Test model" },
      ],
    });
    presentations.push(presentation);
    const selected = presentation.readLine();

    for (const character of "/models") terminal.input(character);
    terminal.input("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(terminal.output).toContain("Model selector");
    terminal.input("\r");

    await expect(selected).resolves.toBe("/model ollama/glm-5.2:cloud");
  });

  it("inspects sessions without writing overlay state into chat history", async () => {
    const terminal = new FakeTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
      sessions: [
        {
          id: "session-previous",
          status: "active",
          messageCount: 8,
          updatedAt: "2026-07-22T12:00:00.000Z",
        },
      ],
    });
    presentations.push(presentation);

    for (const character of "/sessions") terminal.input(character);
    terminal.input("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    terminal.input("\r");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(terminal.output).toContain("pilot chat --session session-previous");
  });

  it("handles bracketed multiline paste without accidental submission", async () => {
    const terminal = new FakeTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    let resolved = false;
    const submitted = presentation.readLine().then((line) => {
      resolved = true;
      return line;
    });

    terminal.input("\u001b[200~first\nsecond\u001b[201~");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);
    terminal.input("\r");

    await expect(submitted).resolves.toBe("first\nsecond");
  });

  it("restores a prior multiline prompt through reverse history search", async () => {
    const terminal = new FakeTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    const first = presentation.readLine();
    for (const character of "remember this") terminal.input(character);
    terminal.input("\r");
    await expect(first).resolves.toBe("remember this");

    terminal.input("\u0012");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(terminal.output).toContain("Prompt history");
    terminal.input("\r");
    const restored = presentation.readLine();
    terminal.input("\r");
    await expect(restored).resolves.toBe("remember this");
  });
});

function permissionEvent(factory: ChatEventFactory, patch = "*** Begin Patch") {
  return factory.create({
    type: "permission.requested",
    sessionId: sessionId("session-ui"),
    runId: runId("run-ui"),
    payload: {
      request: {
        requestId: "permission-ui",
        action: {
          kind: "tool",
          toolName: "apply_patch",
          risk: "workspace-write",
          requiredPermissions: ["workspace.write"],
          input: { patch },
        },
        context: {
          runId: "run-ui",
          callId: "call-ui",
          sessionId: "session-ui",
          workspaceId: "C:/workspace/pilot",
          applicationId: "pilot-cli",
        },
        policyDecision: {
          effect: "ask",
          reason: "Workspace writes require approval",
          actionFingerprint: `sha256:${"a".repeat(64)}`,
          evaluatedRuleIds: ["builtin.workspace-write.ask"],
        },
        availableScopes: ["once", "session"],
      },
    },
  });
}

describe("exit confirmation", () => {
  const presentations: TerminalChatPresentation[] = [];
  afterEach(async () => {
    await Promise.all(presentations.splice(0).map((presentation) => presentation.close()));
  });

  const painted = () => new Promise((resolve) => setTimeout(resolve, 25));

  function started(terminal: FakeTerminal) {
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    // One factory per presentation: its event sequence has to keep increasing or the reducer
    // discards the later events as stale.
    const factory = new ChatEventFactory({ now: () => new Date("2026-07-29T12:00:00.000Z") });
    presentation.render(
      factory.create({
        type: "chat.started",
        sessionId: sessionId("session-exit"),
        payload: { modelKey: "fake/test" },
      }),
    );
    return { presentation, factory };
  }

  /** Resolves to the next line, or "pending" when none arrives. */
  async function settled(line: Promise<string | undefined>) {
    return Promise.race([line, painted().then(() => "pending" as const)]);
  }

  it("asks before exiting on Ctrl+X and stays put when cancelled", async () => {
    const terminal = new FakeTerminal();
    const { presentation } = started(terminal);
    const line = presentation.readLine();

    terminal.input("\u0018");
    await painted();
    expect(terminal.output).toContain("Are you sure you want to exit?");
    await expect(settled(line)).resolves.toBe("pending");

    terminal.input("n");
    await expect(settled(line)).resolves.toBe("pending");
  });

  it("exits once the confirmation is accepted", async () => {
    const terminal = new FakeTerminal();
    const { presentation } = started(terminal);
    const line = presentation.readLine();

    terminal.input("\u0018");
    await painted();
    terminal.input("y");

    await expect(line).resolves.toBe("/exit");
  });

  it("offers the resume command for the active session", async () => {
    const terminal = new FakeTerminal();
    const { presentation: _unused } = started(terminal);
    terminal.input("\u0018");
    await painted();
    expect(terminal.output).toContain("pilot chat --session session-exit");
  });

  it("routes Ctrl+D through the same confirmation", async () => {
    const terminal = new FakeTerminal();
    const { presentation } = started(terminal);
    const line = presentation.readLine();

    terminal.input("\u0004");
    await painted();
    expect(terminal.output).toContain("Are you sure you want to exit?");
    await expect(settled(line)).resolves.toBe("pending");

    terminal.input("y");
    await expect(line).resolves.toBe("/exit");
  });

  it("routes a typed /exit through the same confirmation", async () => {
    const terminal = new FakeTerminal();
    const { presentation } = started(terminal);
    const line = presentation.readLine();

    for (const character of "/exit") terminal.input(character);
    terminal.input("\r");
    await painted();
    expect(terminal.output).toContain("Are you sure you want to exit?");
    await expect(settled(line)).resolves.toBe("pending");

    terminal.input("y");
    await expect(line).resolves.toBe("/exit");
  });

  it("escape cancels the confirmation and a later Ctrl+X reopens it", async () => {
    const terminal = new FakeTerminal();
    const { presentation } = started(terminal);
    const line = presentation.readLine();

    terminal.input("\u0018");
    await painted();
    terminal.input("\u001b");
    await expect(settled(line)).resolves.toBe("pending");

    terminal.input("\u0018");
    await painted();
    terminal.input("y");
    await expect(line).resolves.toBe("/exit");
  });

  it("warns that a running turn will be cancelled", async () => {
    const terminal = new FakeTerminal();
    const { presentation, factory } = started(terminal);
    presentation.render(
      factory.create({
        type: "model.stream",
        sessionId: sessionId("session-exit"),
        runId: runId("run-exit"),
        payload: {
          event: { type: "response.started", sequence: 0, responseId: "response-exit" },
        },
      }),
    );

    terminal.input("\u0018");
    await painted();
    expect(terminal.output).toContain("A turn is still running");
  });

  it("keeps the second idle Ctrl+C immediate", async () => {
    const terminal = new FakeTerminal();
    const { presentation } = started(terminal);
    const line = presentation.readLine();

    terminal.input("\u0003");
    terminal.input("\u0003");

    await expect(line).resolves.toBe("/exit");
  });
});
