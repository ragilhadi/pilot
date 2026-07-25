import { basename } from "node:path";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  CombinedAutocompleteProvider,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { NodeRipgrepRunner, type RipgrepRunner } from "@pilotrun/tools-builtin";

const MAX_LISTED_FILES = 5_000;
const MAX_SUGGESTIONS = 20;
const LIST_TIMEOUT_MS = 2_000;
const MAX_STDOUT_BYTES = 8_000_000;
const CACHE_TTL_MS = 2_000;

interface WorkspaceFile {
  readonly path: string;
  readonly name: string;
}

export interface WorkspaceFileAutocompleteOptions {
  readonly commands?: (AutocompleteItem | SlashCommand)[];
  readonly basePath: string;
  /** Injectable for tests. Defaults to the bundled ripgrep runner. */
  readonly runner?: RipgrepRunner;
  readonly now?: () => number;
}

/**
 * Autocomplete provider for the composer that suggests workspace files when the
 * user types `@`. File listing is delegated to the bundled ripgrep (`rg
 * --files`), which honours `.gitignore`, `.ignore`, and `.pilotignore`, so
 * ignored files (for example a `.env`) never appear in the picker. Slash
 * commands and non-`@` path completion fall through to pi-tui's
 * {@link CombinedAutocompleteProvider}.
 */
export class WorkspaceFileAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ["@", "/"];
  readonly #delegate: CombinedAutocompleteProvider;
  readonly #basePath: string;
  readonly #runner: RipgrepRunner;
  readonly #now: () => number;
  #cache: { readonly files: readonly WorkspaceFile[]; readonly loadedAt: number } | undefined;

  constructor(options: WorkspaceFileAutocompleteOptions) {
    this.#delegate = new CombinedAutocompleteProvider(options.commands ?? [], options.basePath);
    this.#basePath = options.basePath;
    this.#runner = options.runner ?? new NodeRipgrepRunner();
    this.#now = options.now ?? Date.now;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const line = lines[cursorLine] ?? "";
    const before = line.slice(0, cursorCol);
    const token = extractAtToken(before);
    if (token !== null) {
      const { rawPrefix, isQuotedPrefix } = parseAtPrefix(token);
      const files = await this.#listFiles(options.signal);
      const items = rankFiles(files, rawPrefix, isQuotedPrefix);
      if (items.length === 0) {
        return null;
      }
      return { items, prefix: token };
    }
    return this.#delegate.getSuggestions(lines, cursorLine, cursorCol, options);
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    if (prefix.startsWith("@")) {
      return applyAtCompletion(lines, cursorLine, cursorCol, item, prefix);
    }
    return this.#delegate.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.#delegate.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }

  async #listFiles(signal: AbortSignal): Promise<readonly WorkspaceFile[]> {
    const now = this.#now();
    if (this.#cache !== undefined && now - this.#cache.loadedAt < CACHE_TTL_MS) {
      return this.#cache.files;
    }
    const files: WorkspaceFile[] = [];
    try {
      await this.#runner.run({
        cwd: this.#basePath,
        args: ["--files", "--hidden", "--glob", "!.git/**", "--ignore-file", ".pilotignore"],
        signal,
        timeoutMs: LIST_TIMEOUT_MS,
        maxStdoutBytes: MAX_STDOUT_BYTES,
        maxStderrBytes: 65_536,
        onLine: (rawLine) => {
          const path = rawLine.replaceAll("\\", "/").trim();
          if (path.length > 0) {
            files.push({ path, name: basename(path) });
          }
          return files.length < MAX_LISTED_FILES;
        },
      });
    } catch {
      // ripgrep missing or failed — fall back to any cached listing.
      return this.#cache?.files ?? [];
    }
    const frozen = Object.freeze(files);
    this.#cache = { files: frozen, loadedAt: now };
    return frozen;
  }
}

// A mention token begins with `@` at a token boundary. Quoted mentions
// (`@"src/a b.ts"`) may contain spaces; unquoted mentions run until whitespace.
function extractAtToken(before: string): string | null {
  const quoted = /@"[^"]*$/u.exec(before);
  if (quoted !== null) {
    const at = before.length - quoted[0].length;
    if (isTokenBoundary(before, at)) {
      return before.slice(at);
    }
  }
  const whitespace = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\t"));
  const tokenStart = whitespace + 1;
  const candidate = before.slice(tokenStart);
  if (candidate.startsWith("@") && !candidate.includes('"')) {
    return candidate;
  }
  return null;
}

function isTokenBoundary(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const previous = text[index - 1] ?? "";
  return previous === " " || previous === "\t" || previous === "(" || previous === "[";
}

function parseAtPrefix(token: string): {
  readonly rawPrefix: string;
  readonly isQuotedPrefix: boolean;
} {
  if (token.startsWith('@"')) {
    return { rawPrefix: token.slice(2), isQuotedPrefix: true };
  }
  return { rawPrefix: token.slice(1), isQuotedPrefix: false };
}

function rankFiles(
  files: readonly WorkspaceFile[],
  query: string,
  isQuotedPrefix: boolean,
): AutocompleteItem[] {
  const normalizedQuery = query.replaceAll("\\", "/").toLowerCase();
  const scored: { readonly file: WorkspaceFile; readonly score: number }[] = [];
  for (const file of files) {
    const score = normalizedQuery.length === 0 ? 1 : scoreFile(file, normalizedQuery);
    if (score > 0) {
      scored.push({ file, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  return scored.slice(0, MAX_SUGGESTIONS).map(({ file }) => ({
    value: buildAtValue(file.path, isQuotedPrefix),
    label: file.name,
    description: file.path,
  }));
}

function scoreFile(file: WorkspaceFile, query: string): number {
  const name = file.name.toLowerCase();
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 50;
  if (file.path.toLowerCase().includes(query)) return 30;
  return 0;
}

function buildAtValue(path: string, isQuotedPrefix: boolean): string {
  return isQuotedPrefix || path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function applyAtCompletion(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  item: AutocompleteItem,
  prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
  const line = lines[cursorLine] ?? "";
  const beforePrefix = line.slice(0, cursorCol - prefix.length);
  const afterCursor = line.slice(cursorCol);
  const suffix = " ";
  const newLines = [...lines];
  newLines[cursorLine] = `${beforePrefix}${item.value}${suffix}${afterCursor}`;
  return {
    lines: newLines,
    cursorLine,
    cursorCol: beforePrefix.length + item.value.length + suffix.length,
  };
}
