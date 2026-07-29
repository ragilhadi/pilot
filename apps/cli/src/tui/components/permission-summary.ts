import type { JsonValue, PermissionAction } from "@pilotrun/core";

/**
 * What a permission prompt should say about the action it is gating.
 *
 * The dialog used to render `toolName safeJson(input)`, which for `write_file` meant the entire
 * file being written. On anything but a trivial file that pushed the question, the risk line, and
 * the choices off the screen — the user could not see what they were approving, only the payload.
 *
 * A prompt needs the few facts that change the answer: which file, how big, which command, which
 * URL. Everything else belongs behind the preview key, not in the prompt.
 */
export interface PermissionSummaryRow {
  readonly label: string;
  readonly value: string;
}

export interface PermissionPreview {
  readonly title: string;
  readonly text: string;
  /** Rendered with diff colouring when the body is a unified diff. */
  readonly diff: boolean;
}

/** Longest single value rendered inline; anything longer is elided rather than wrapped forever. */
const maximumInlineValue = 160;

export function summarizePermissionAction(
  action: PermissionAction,
): readonly PermissionSummaryRow[] {
  if (action.kind === "command") {
    const commandLine = [action.executable, ...action.args].join(" ").trim();
    return rows([
      ["Command", commandLine],
      ["Directory", action.cwd],
      ...environmentRows(action.environment),
    ]);
  }
  const input = objectValue(action.input);
  const specific = toolRows(action.toolName, input);
  return rows(specific.length > 0 ? specific : genericRows(input));
}

/** The full payload, shown only when the user asks for it. */
export function permissionPreview(action: PermissionAction): PermissionPreview | undefined {
  if (action.kind !== "tool") return undefined;
  const input = objectValue(action.input);
  const patch = stringField(input, "patch");
  if (patch !== undefined) {
    return { title: "Proposed diff", text: patch, diff: true };
  }
  const content = stringField(input, "content");
  if (content !== undefined) {
    return {
      title: `Content for ${stringField(input, "path") ?? action.toolName}`,
      text: content,
      diff: false,
    };
  }
  const oldString = stringField(input, "oldString");
  const newString = stringField(input, "newString");
  if (oldString !== undefined && newString !== undefined) {
    return {
      title: `Replacement in ${stringField(input, "path") ?? action.toolName}`,
      diff: true,
      text: [
        ...oldString.split(/\r?\n/u).map((line) => `-${line}`),
        ...newString.split(/\r?\n/u).map((line) => `+${line}`),
      ].join("\n"),
    };
  }
  return undefined;
}

function toolRows(
  toolName: string,
  input: Readonly<Record<string, JsonValue>> | undefined,
): (readonly [string, string | undefined])[] {
  switch (toolName) {
    case "write_file": {
      const content = stringField(input, "content") ?? "";
      return [
        ["File", stringField(input, "path")],
        [
          stringField(input, "baseSha256") === undefined ? "Creates" : "Overwrites",
          describeText(content),
        ],
      ];
    }
    case "edit":
      return [
        ["File", stringField(input, "path")],
        ["Replaces", describeText(stringField(input, "oldString") ?? "")],
        ["With", describeText(stringField(input, "newString") ?? "")],
        ["Scope", input?.replaceAll === true ? "every occurrence" : "first occurrence"],
      ];
    case "apply_patch": {
      const patch = stringField(input, "patch") ?? "";
      const lines = patch.split(/\r?\n/u);
      return [
        ["File", stringField(input, "path")],
        [
          "Changes",
          `${lines.filter((line) => line.startsWith("@@")).length} hunks, ` +
            `+${lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length} ` +
            `-${lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length}`,
        ],
      ];
    }
    case "read_file":
    case "list_files":
      return [["Path", stringField(input, "path")]];
    case "glob":
      return [
        ["Pattern", stringField(input, "pattern")],
        ["Path", stringField(input, "path")],
      ];
    case "grep":
      return [
        ["Search", stringField(input, "query")],
        ["Path", stringField(input, "path")],
      ];
    case "web_fetch":
      return [["URL", stringField(input, "url")]];
    case "web_search":
      return [["Query", stringField(input, "query")]];
    default:
      return [];
  }
}

/**
 * Fallback for a tool this build does not recognize — every scalar field, but never a long blob.
 * A field that would dominate the prompt is described by shape instead of shown.
 */
function genericRows(
  input: Readonly<Record<string, JsonValue>> | undefined,
): (readonly [string, string | undefined])[] {
  if (input === undefined) return [];
  return Object.entries(input).map(([key, value]) => {
    if (typeof value === "string") {
      return [key, value.length > maximumInlineValue ? describeText(value) : value] as const;
    }
    if (value === null || typeof value !== "object") return [key, String(value)] as const;
    return [key, Array.isArray(value) ? `${value.length} items` : "…"] as const;
  });
}

function environmentRows(
  environment: Readonly<Record<string, string>>,
): (readonly [string, string | undefined])[] {
  const names = Object.keys(environment);
  // Names, never values: an approval prompt is not the place to print a secret.
  return names.length === 0 ? [] : [["Environment", names.sort().join(", ")]];
}

/** "12 lines, 3.4 KB" — enough to judge the size of a change without rendering it. */
function describeText(value: string): string {
  if (value.length === 0) return "empty";
  const segments = value.split(/\r?\n/u);
  // A trailing newline terminates the last line rather than starting an empty one, so a file of
  // 400 newline-terminated lines reads as 400, not 401.
  const lines = segments.at(-1) === "" ? segments.length - 1 : segments.length;
  const bytes = Buffer.byteLength(value, "utf8");
  const size = bytes >= 1_024 ? `${(bytes / 1_024).toFixed(1)} KB` : `${bytes} B`;
  if (lines === 1 && value.length <= 60) return `"${value}"`;
  return `${lines} line${lines === 1 ? "" : "s"}, ${size}`;
}

function rows(
  candidates: readonly (readonly [string, string | undefined])[],
): readonly PermissionSummaryRow[] {
  return Object.freeze(
    candidates
      .filter((entry): entry is readonly [string, string] => {
        const value = entry[1];
        return value !== undefined && value.length > 0;
      })
      .map(([label, value]) => Object.freeze({ label, value: elide(value) })),
  );
}

function elide(value: string): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine.length <= maximumInlineValue
    ? singleLine
    : `${singleLine.slice(0, maximumInlineValue - 1)}…`;
}

function objectValue(value: JsonValue): Readonly<Record<string, JsonValue>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : undefined;
}

function stringField(
  input: Readonly<Record<string, JsonValue>> | undefined,
  key: string,
): string | undefined {
  const value = input?.[key];
  return typeof value === "string" ? value : undefined;
}
