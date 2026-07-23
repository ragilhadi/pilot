import { describe, expect, it } from "vitest";
import {
  detectTerminalCapabilities,
  resolvePresentationMode,
  type TerminalCapabilitySnapshot,
} from "../src/index.js";

const capableTerminal = {
  interactiveInput: true,
  interactiveOutput: true,
  cursorAddressing: true,
  color: true,
  unicode: true,
  columns: 120,
  rows: 40,
} as const satisfies TerminalCapabilitySnapshot;

describe("presentation mode selection", () => {
  it("selects TUI only for a capable interactive terminal", () => {
    expect(
      resolvePresentationMode({
        requested: "auto",
        json: false,
        screenReader: false,
        capabilities: capableTerminal,
      }),
    ).toBe("tui");
    expect(
      resolvePresentationMode({
        requested: "auto",
        json: false,
        screenReader: false,
        capabilities: { ...capableTerminal, interactiveOutput: false },
      }),
    ).toBe("plain");
  });

  it("gives JSON and screen-reader modes precedence over interactive layout", () => {
    expect(
      resolvePresentationMode({
        requested: "tui",
        json: true,
        screenReader: false,
        capabilities: capableTerminal,
      }),
    ).toBe("json");
    expect(
      resolvePresentationMode({
        requested: "tui",
        json: false,
        screenReader: true,
        capabilities: capableTerminal,
      }),
    ).toBe("plain");
  });

  it("fails an explicit unsupported TUI request with remediation", () => {
    expect(() =>
      resolvePresentationMode({
        requested: "tui",
        json: false,
        screenReader: false,
        capabilities: {
          ...capableTerminal,
          interactiveInput: false,
          reason: "stdin is not a TTY",
        },
      }),
    ).toThrow("Use --ui plain");
  });
});

describe("terminal capability detection", () => {
  it("honors dumb terminals, NO_COLOR, ASCII mode, and dimensions", () => {
    expect(
      detectTerminalCapabilities({
        stdinIsTTY: true,
        stdoutIsTTY: true,
        columns: 30,
        rows: 8,
        environment: { TERM: "dumb", NO_COLOR: "1", PILOT_ASCII: "1" },
      }),
    ).toEqual({
      interactiveInput: true,
      interactiveOutput: true,
      cursorAddressing: false,
      color: false,
      unicode: false,
      columns: 30,
      rows: 8,
      reason: "TERM=dumb does not support cursor addressing",
    });
  });
});
