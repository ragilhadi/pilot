import path from "node:path";
import { PilotError } from "@pilotrun/core";

export class GlobPatternError extends PilotError {
  constructor(message: string, pattern: string) {
    super({
      code: "PILOT_FILE_TOOL_PATTERN_INVALID",
      message,
      safeMessage: "The glob pattern is invalid or escapes the workspace",
      metadata: { pattern },
    });
  }
}

export function compileGlobPattern(pattern: string): RegExp {
  validatePattern(pattern);
  return new RegExp(`^${compileFragment(pattern.replaceAll("\\", "/"))}$`, "u");
}

function validatePattern(pattern: string): void {
  if (pattern.length === 0 || pattern.length > 256 || pattern.includes("\0")) {
    throw new GlobPatternError("Glob patterns must contain between 1 and 256 characters", pattern);
  }
  if (path.isAbsolute(pattern) || path.win32.isAbsolute(pattern) || /^[a-z]:/iu.test(pattern)) {
    throw new GlobPatternError("Glob patterns must be workspace-relative", pattern);
  }
  const segments = pattern.replaceAll("\\", "/").split("/");
  if (segments.includes("..")) {
    throw new GlobPatternError("Glob patterns cannot traverse above the workspace", pattern);
  }
}

function compileFragment(pattern: string): string {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          output += "(?:.*/)?";
        } else {
          output += ".*";
        }
      } else {
        output += "[^/]*";
      }
    } else if (character === "?") {
      output += "[^/]";
    } else if (character === "[") {
      const closing = pattern.indexOf("]", index + 1);
      if (closing < 0) throw new GlobPatternError("Glob character class is not closed", pattern);
      let content = pattern.slice(index + 1, closing);
      if (content.startsWith("!")) content = `^${content.slice(1)}`;
      if (content.length === 0)
        throw new GlobPatternError("Glob character class is empty", pattern);
      output += `[${content.replaceAll("\\", "\\\\")}]`;
      index = closing;
    } else if (character === "{") {
      const closing = pattern.indexOf("}", index + 1);
      if (closing < 0) throw new GlobPatternError("Glob alternative is not closed", pattern);
      const alternatives = pattern.slice(index + 1, closing).split(",");
      if (alternatives.length < 2 || alternatives.some((value) => value.length === 0)) {
        throw new GlobPatternError(
          "Glob alternatives require two or more non-empty values",
          pattern,
        );
      }
      output += `(?:${alternatives.map(escapeRegex).join("|")})`;
      index = closing;
    } else {
      output += escapeRegex(character ?? "");
    }
  }
  return output;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.-]/gu, "\\$&");
}
