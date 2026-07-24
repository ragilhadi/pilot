import type { Terminal } from "@earendil-works/pi-tui";
import { runId, sessionId } from "@pilotrun/core";
import { afterEach, describe, expect, it } from "vitest";
import { ChatEventFactory } from "../src/index.js";
import { TerminalChatPresentation } from "../src/tui/terminal-chat-presentation.js";

class FakeTerminal implements Terminal {
  columns = 100;
  rows = 30;
  readonly kittyProtocolActive = false;
  output = "";
  #onInput: ((data: string) => void) | undefined;

  start(onInput: (data: string) => void): void {
    this.#onInput = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  input(data: string): void {
    this.#onInput?.(data);
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

function streamAssistant(presentation: TerminalChatPresentation, text: string): void {
  const factory = new ChatEventFactory({ now: () => new Date("2026-07-25T12:00:00.000Z") });
  const id = sessionId("copy-session");
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
      runId: runId("run-copy"),
      payload: { event: { type: "response.started", sequence: 0, responseId: "response-copy" } },
    }),
  );
  presentation.render(
    factory.create({
      type: "model.stream",
      sessionId: id,
      runId: runId("run-copy"),
      payload: {
        event: {
          type: "text.delta",
          sequence: 1,
          responseId: "response-copy",
          contentIndex: 0,
          delta: text,
        },
      },
    }),
  );
}

describe("terminal code-block copy", () => {
  const presentations: TerminalChatPresentation[] = [];
  afterEach(async () => {
    await Promise.all(presentations.splice(0).map((presentation) => presentation.close()));
  });

  it("copies the only code block to the clipboard via OSC 52 on /copy", async () => {
    const terminal = new FakeTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    streamAssistant(presentation, "Here you go:\n\n```bash\ng++ main.cpp -o main\n```\n");

    for (const character of "/copy") terminal.input(character);
    terminal.input("\r");
    await new Promise((resolve) => setTimeout(resolve, 25));

    const base64 = Buffer.from("g++ main.cpp -o main", "utf8").toString("base64");
    expect(terminal.output).toContain(`]52;c;${base64}`);
    expect(terminal.output).toContain("Copied 1 line");
  });

  it("opens a picker when several code blocks are available", async () => {
    const terminal = new FakeTerminal();
    const presentation = new TerminalChatPresentation({
      terminal,
      capabilities,
      workspacePath: "C:/workspace/pilot",
    });
    presentations.push(presentation);
    streamAssistant(presentation, "```ts\nconst a = 1;\n```\n\n```sh\nls -la\n```\n");

    for (const character of "/copy") terminal.input(character);
    terminal.input("\r");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(terminal.output).toContain("Copy code block");
    // The most recent block is preselected; Enter copies it.
    terminal.input("\r");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const base64 = Buffer.from("ls -la", "utf8").toString("base64");
    expect(terminal.output).toContain(`]52;c;${base64}`);
  });
});
