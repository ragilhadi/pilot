import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node-pty";
import { describe, expect, it } from "vitest";

const cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const enterAlternateScreen = "\u001b[?1049h";
const leaveAlternateScreen = "\u001b[?1049l";
const enableMouseReporting = "\u001b[?1000h";
const disableMouseReporting = "\u001b[?1000l";

/**
 * Drives a real `pilot chat` in a pseudo-terminal until it exits, and returns everything it wrote.
 * Typing `/exit` opens a confirmation, so the session ends only after answering it.
 */
async function runChatSession(
  ui: "tui" | "fullscreen",
  environment: Readonly<Record<string, string>> = {},
): Promise<{ readonly output: string; readonly exitCode: number }> {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "pilot-pty-"));
  let output = "";
  let exitSent = false;
  let exitConfirmed = false;
  try {
    const terminal = spawn(process.execPath, [cliEntry, "chat", "--ui", ui], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: path.dirname(path.dirname(path.dirname(cliEntry))),
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        PILOT_DATA_DIR: dataDirectory,
        NO_COLOR: "1",
        ...environment,
      },
    });
    terminal.onData((data) => {
      output += data;
      if (output.includes("ready") && !exitSent) {
        exitSent = true;
        terminal.write("/exit\r");
        return;
      }
      // Exiting is confirmed now, so the session ends only after answering the prompt.
      if (exitSent && !exitConfirmed && output.includes("Are you sure you want to exit?")) {
        exitConfirmed = true;
        terminal.write("y");
      }
    });
    const exit = await Promise.race([
      new Promise<{ exitCode: number }>((resolve) => terminal.onExit(resolve)),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          terminal.kill();
          reject(new Error(`PTY did not exit. Output: ${output.slice(-2_000)}`));
        }, 10_000),
      ),
    ]);
    return { output, exitCode: exit.exitCode };
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

describe("packaged terminal UI in a pseudo-terminal", () => {
  it("accepts input, exits cleanly, and restores the terminal", async () => {
    const { output, exitCode } = await runChatSession("tui");

    expect(exitCode).toBe(0);
    expect(output).toContain("PILOT");
    expect(output).toContain("ready");
    expect(output).toContain("\u001b[?2004l");
  }, 15_000);

  it("keeps the default inline layout off the alternate screen", async () => {
    const { output } = await runChatSession("tui");

    expect(output).not.toContain(enterAlternateScreen);
    expect(output).not.toContain(enableMouseReporting);
  }, 15_000);

  it("draws fullscreen on the alternate screen and hands the shell back on exit", async () => {
    const { output, exitCode } = await runChatSession("fullscreen");

    expect(exitCode).toBe(0);
    expect(output).toContain("ready");
    expect(output).toContain(enterAlternateScreen);
    expect(output).toContain(enableMouseReporting);
    // Order matters: mouse reporting and the alternate screen must both be undone, and the
    // alternate screen last, or the shell is left looking at a blank buffer.
    expect(output.lastIndexOf(disableMouseReporting)).toBeLessThan(
      output.lastIndexOf(leaveAlternateScreen),
    );
    expect(output.lastIndexOf(enterAlternateScreen)).toBeLessThan(
      output.lastIndexOf(leaveAlternateScreen),
    );
  }, 15_000);

  it("keeps text selection usable when mouse reporting is declined", async () => {
    const { output } = await runChatSession("fullscreen", { PILOT_TUI_MOUSE: "0" });

    expect(output).toContain(enterAlternateScreen);
    expect(output).not.toContain(enableMouseReporting);
  }, 15_000);
});
