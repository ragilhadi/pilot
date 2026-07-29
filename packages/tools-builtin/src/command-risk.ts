import type { ToolRisk } from "@pilotrun/core";

export interface DirectCommandIntent {
  readonly mode: "direct";
  readonly executable: string;
  readonly args: readonly string[];
}

export interface ShellCommandIntent {
  readonly mode: "shell";
  readonly command: string;
}

export type CommandIntent = DirectCommandIntent | ShellCommandIntent;

export interface CommandRiskClassification {
  readonly risk: ToolRisk;
  readonly reasons: readonly string[];
}

const readOnlyExecutables = new Set([
  "cat",
  "echo",
  "find",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "tail",
  "type",
  "where",
  "which",
]);
const workspaceWriteExecutables = new Set(["cp", "mkdir", "mv", "sed", "touch"]);
const networkExecutables = new Set(["curl", "ftp", "scp", "ssh", "wget"]);
const systemExecutables = new Set([
  "chown",
  "doas",
  "reg",
  "regedit",
  "service",
  "sudo",
  "systemctl",
]);

/** Ordered least to most restrictive, so a chained command can be scored by its worst segment. */
const riskSeverity: Readonly<Record<ToolRisk, number>> = Object.freeze({
  "read-only": 0,
  unknown: 1,
  "workspace-write": 2,
  network: 3,
  "system-change": 4,
  destructive: 5,
});

/** Heuristic classification used as one policy layer; it is not a process sandbox. */
export function classifyCommandRisk(intent: CommandIntent): CommandRiskClassification {
  if (intent.mode === "direct") {
    const evaluated = classifySegment(normalizeExecutable(intent.executable), [...intent.args]);
    return classification(evaluated.risk, evaluated.reasons, intent);
  }

  // Some patterns are properties of the pipeline rather than of any single segment: piping a
  // download straight into an interpreter is the canonical example.
  if (isPipedToInterpreter(intent.command)) {
    return classification("destructive", ["remote script piped into an interpreter"], intent);
  }

  // A shell string can chain, pipe, and substitute any number of commands, so scoring only its
  // first word let `ls && rm -rf ~` read as an unremarkable `ls`. That downgraded the built-in
  // destructive deny — a hard, unbypassable boundary — to an ordinary approval prompt. Score every
  // segment and keep the worst.
  const segments = splitShellSegments(intent.command);
  let worst = classifySegment("", []);
  for (const segment of segments) {
    const [executable = "", ...args] = segment;
    const evaluated = classifySegment(normalizeExecutable(executable), args);
    if (riskSeverity[evaluated.risk] > riskSeverity[worst.risk]) worst = evaluated;
  }
  return classification(worst.risk, worst.reasons, intent);
}

interface SegmentClassification {
  readonly risk: ToolRisk;
  readonly reasons: readonly string[];
}

/**
 * Programs whose own arguments name another program to run. `xargs rm -f` is an `rm`, and scoring
 * it as an unrecognized `xargs` hid the deletion behind a generic approval prompt.
 */
const commandWrappers = new Set([
  "doas",
  "env",
  "nice",
  "nohup",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
  "watch",
  "xargs",
]);

function classifySegment(
  executable: string,
  rawArgs: readonly string[],
  depth = 0,
): SegmentClassification {
  const tokens = [executable, ...rawArgs].map((value) => value.toLowerCase());
  const joined = tokens.join(" ");

  // Score the wrapped command too and keep whichever reads worse; `sudo` stays system-change on
  // its own, but `sudo rm -rf /` is destructive.
  if (commandWrappers.has(executable) && depth < 3) {
    const wrappedIndex = rawArgs.findIndex((argument) => !argument.startsWith("-"));
    const wrapped = wrappedIndex === -1 ? undefined : rawArgs[wrappedIndex];
    if (wrapped !== undefined) {
      const inner = classifySegment(
        normalizeExecutable(wrapped),
        rawArgs.slice(wrappedIndex + 1),
        depth + 1,
      );
      const outer = classifyDirect(executable, tokens, joined);
      return riskSeverity[inner.risk] > riskSeverity[outer.risk] ? inner : outer;
    }
  }
  return classifyDirect(executable, tokens, joined);
}

function classifyDirect(
  executable: string,
  tokens: readonly string[],
  joined: string,
): SegmentClassification {
  if (isDestructive(executable, tokens, joined)) {
    return { risk: "destructive", reasons: ["destructive command pattern"] };
  }
  if (containsCredentialPath(tokens)) {
    return { risk: "system-change", reasons: ["credential or secret path reference"] };
  }
  if (systemExecutables.has(executable) || isSecurityControlChange(joined)) {
    return { risk: "system-change", reasons: ["system or security configuration command"] };
  }
  if (networkExecutables.has(executable) || isNetworkCommand(executable, tokens)) {
    return { risk: "network", reasons: ["network, publication, or deployment command"] };
  }
  if (isWorkspaceWrite(executable, tokens)) {
    return { risk: "workspace-write", reasons: ["command may modify workspace files"] };
  }
  if (isReadOnly(executable, tokens)) {
    return { risk: "read-only", reasons: ["recognized read-only command shape"] };
  }
  return { risk: "unknown", reasons: ["unrecognized command"] };
}

function classification(
  risk: ToolRisk,
  reasons: readonly string[],
  intent: CommandIntent,
): CommandRiskClassification {
  const shell = intent.mode === "shell";
  return Object.freeze({
    // Shell syntax is never provably read-only: globs, redirection, and substitution can all reach
    // files the token scan never saw.
    risk: shell && risk === "read-only" ? "unknown" : risk,
    reasons: Object.freeze([
      ...(shell && risk === "read-only" ? ["shell syntax cannot be proven safe"] : reasons),
      ...(shell ? ["shell-string mode"] : []),
    ]),
  });
}

/**
 * Splits a shell string into the individual commands it would run.
 *
 * Operators (`&&`, `||`, `;`, `|`, `&`, newline) start a new command; so does entering a command
 * substitution (`$(…)`, backticks) or a redirection target. Quoting is respected so an operator
 * inside `"…"` or `'…'` stays part of its argument.
 */
function splitShellSegments(command: string): readonly (readonly string[])[] {
  const segments: string[][] = [];
  let current: string[] = [];
  let token = "";
  let quote: '"' | "'" | undefined;

  const endToken = () => {
    if (token.length > 0) current.push(token);
    token = "";
  };
  const endSegment = () => {
    endToken();
    if (current.length > 0) segments.push(current);
    current = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "\\") {
      token += command[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (character === "$" && command[index + 1] === "(") {
      endSegment();
      index += 1;
      continue;
    }
    if ("&|;`()\n\r".includes(character)) {
      endSegment();
      continue;
    }
    if (character === ">" || character === "<") {
      // A redirection target is a path, not a command; end the token but keep the segment so the
      // command that owns the redirection is still classified.
      endToken();
      continue;
    }
    if (character === " " || character === "\t") {
      endToken();
      continue;
    }
    token += character;
  }
  endSegment();
  return segments;
}

function isDestructive(executable: string, tokens: readonly string[], joined: string): boolean {
  if (["diskpart", "format", "mkfs", "shutdown"].includes(executable)) return true;
  if (["del", "erase", "rm", "rmdir"].includes(executable)) return true;
  if (executable === "git") {
    // Match the force flag itself, not any token containing the letter "f" — that read
    // `git clean --dry-run foo.txt` as destructive because of the filename.
    if (tokens[1] === "clean" && tokens.some((token) => isForceFlag(token))) return true;
    if (tokens[1] === "reset" && tokens.includes("--hard")) return true;
    if (
      tokens[1] === "push" &&
      tokens.some(
        (token) => token === "--force" || token === "-f" || token.startsWith("--force-with-lease"),
      )
    )
      return true;
  }
  // The curl-piped-to-shell shape spans segments, so isPipedToInterpreter owns it now.
  return joined.includes("remove-item");
}

function containsCredentialPath(tokens: readonly string[]): boolean {
  return tokens.some((token) =>
    /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.kube)([\\/]|$)|(^|[\\/])\.env(?:\.|$)/iu.test(token),
  );
}

function isSecurityControlChange(joined: string): boolean {
  return /disable.*(defender|firewall|security)|set-executionpolicy\s+unrestricted/iu.test(joined);
}

function isNetworkCommand(executable: string, tokens: readonly string[]): boolean {
  if (executable === "git") return ["clone", "fetch", "pull", "push"].includes(tokens[1] ?? "");
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    return ["add", "install", "publish", "deploy"].includes(tokens[1] ?? "");
  }
  return ["deploy", "publish"].some((token) => tokens.includes(token));
}

function isWorkspaceWrite(executable: string, tokens: readonly string[]): boolean {
  if (workspaceWriteExecutables.has(executable)) return true;
  if (executable === "git") {
    return ["add", "checkout", "commit", "merge", "rebase", "restore", "switch"].includes(
      tokens[1] ?? "",
    );
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    return ["build", "exec", "run", "test"].includes(tokens[1] ?? "");
  }
  return false;
}

function isReadOnly(executable: string, tokens: readonly string[]): boolean {
  if (readOnlyExecutables.has(executable)) return true;
  if (executable === "git") return ["diff", "log", "show", "status"].includes(tokens[1] ?? "");
  return false;
}

/** `curl … | sh`, `wget … | bash`: the fetch and the interpreter are separate segments. */
function isPipedToInterpreter(command: string): boolean {
  const lowered = command.toLowerCase();
  if (!lowered.includes("|")) return false;
  const [source = "", ...rest] = lowered.split("|");
  return (
    /\b(?:curl|wget|iwr|invoke-webrequest)\b/u.test(source) &&
    rest.some((stage) =>
      /(?:^|\s)(?:sh|bash|zsh|powershell|pwsh|python3?|node|ruby|perl)\b/u.test(stage),
    )
  );
}

/** `-f`, `-fd`, `--force`: a short flag cluster containing f, or the long form. */
function isForceFlag(token: string): boolean {
  return token === "--force" || /^-[a-z]*f[a-z]*$/u.test(token);
}

function normalizeExecutable(input: string): string {
  const basename = input.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  return basename.replace(/\.(?:bat|cmd|com|exe|ps1)$/u, "");
}
