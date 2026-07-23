import type { ToolRisk } from "@pilot/core";

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

/** Heuristic classification used as one policy layer; it is not a process sandbox. */
export function classifyCommandRisk(intent: CommandIntent): CommandRiskClassification {
  const executable =
    intent.mode === "direct"
      ? normalizeExecutable(intent.executable)
      : shellExecutable(intent.command);
  const args = intent.mode === "direct" ? [...intent.args] : tokenizeShell(intent.command).slice(1);
  const tokens = [executable, ...args].map((value) => value.toLowerCase());
  const joined = tokens.join(" ");
  const reasons: string[] = [];

  if (isDestructive(executable, tokens, joined)) {
    reasons.push("destructive command pattern");
    return classification("destructive", reasons, intent);
  }
  if (containsCredentialPath(tokens)) {
    reasons.push("credential or secret path reference");
    return classification("system-change", reasons, intent);
  }
  if (systemExecutables.has(executable) || isSecurityControlChange(joined)) {
    reasons.push("system or security configuration command");
    return classification("system-change", reasons, intent);
  }
  if (networkExecutables.has(executable) || isNetworkCommand(executable, tokens)) {
    reasons.push("network, publication, or deployment command");
    return classification("network", reasons, intent);
  }
  if (isWorkspaceWrite(executable, tokens)) {
    reasons.push("command may modify workspace files");
    return classification("workspace-write", reasons, intent);
  }
  if (isReadOnly(executable, tokens)) {
    reasons.push("recognized read-only command shape");
    return classification("read-only", reasons, intent);
  }
  reasons.push(
    intent.mode === "shell" ? "shell syntax cannot be proven safe" : "unrecognized command",
  );
  return classification("unknown", reasons, intent);
}

function classification(
  risk: ToolRisk,
  reasons: readonly string[],
  intent: CommandIntent,
): CommandRiskClassification {
  return Object.freeze({
    risk: intent.mode === "shell" && risk === "read-only" ? "unknown" : risk,
    reasons: Object.freeze([...reasons, ...(intent.mode === "shell" ? ["shell-string mode"] : [])]),
  });
}

function isDestructive(executable: string, tokens: readonly string[], joined: string): boolean {
  if (["diskpart", "format", "mkfs", "shutdown"].includes(executable)) return true;
  if (["del", "erase", "rm", "rmdir"].includes(executable)) return true;
  if (executable === "git") {
    if (tokens[1] === "clean" && tokens.some((token) => token.includes("f"))) return true;
    if (tokens[1] === "reset" && tokens.includes("--hard")) return true;
    if (
      tokens[1] === "push" &&
      tokens.some(
        (token) => token === "--force" || token === "-f" || token.startsWith("--force-with-lease"),
      )
    )
      return true;
  }
  return (
    joined.includes("remove-item") ||
    (joined.includes("curl") &&
      joined.includes("|") &&
      /\b(sh|bash|powershell|pwsh)\b/u.test(joined))
  );
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

function shellExecutable(command: string): string {
  return normalizeExecutable(tokenizeShell(command)[0] ?? "");
}

function tokenizeShell(command: string): string[] {
  return (
    command
      .match(/[^\s"']+|"[^"]*"|'[^']*'/gu)
      ?.map((token) => token.replace(/^["']|["']$/gu, "")) ?? []
  );
}

function normalizeExecutable(input: string): string {
  const basename = input.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  return basename.replace(/\.(?:cmd|com|exe)$/u, "");
}
