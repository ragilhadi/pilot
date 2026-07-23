import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node-pty";
import { describe, expect, it } from "vitest";

const cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

describe("packaged terminal UI in a pseudo-terminal", () => {
  it("accepts input, exits cleanly, and restores the terminal", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "pilot-pty-"));
    let output = "";
    let exitSent = false;
    try {
      const terminal = spawn(process.execPath, [cliEntry, "chat", "--ui", "tui"], {
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
        },
      });
      terminal.onData((data) => {
        output += data;
        if (output.includes("ready") && !exitSent) {
          exitSent = true;
          terminal.write("/exit\r");
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

      expect(exit.exitCode).toBe(0);
      expect(output).toContain("PILOT");
      expect(output).toContain("ready");
      expect(output).toContain("\u001b[?2004l");
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 15_000);
});
