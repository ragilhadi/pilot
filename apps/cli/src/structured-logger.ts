import type { TextWriter } from "./cli.js";

export type LogLevel = "debug" | "error" | "info" | "warn";

export interface StructuredLogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface StructuredLoggerOptions {
  readonly writer: TextWriter;
  readonly level?: LogLevel;
  readonly now?: () => Date;
  readonly secrets?: readonly string[];
}

const levelPriority: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class StructuredLogger {
  readonly #writer: TextWriter;
  readonly #minimumPriority: number;
  readonly #now: () => Date;
  readonly #secrets: readonly string[];

  constructor(options: StructuredLoggerOptions) {
    this.#writer = options.writer;
    this.#minimumPriority = levelPriority[options.level ?? "warn"];
    this.#now = options.now ?? (() => new Date());
    this.#secrets = Object.freeze(
      [...(options.secrets ?? [])].filter((secret) => secret.length >= 4).sort(longestFirst),
    );
  }

  log(level: LogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    if (levelPriority[level] < this.#minimumPriority) return;
    const record: StructuredLogRecord = {
      timestamp: this.#now().toISOString(),
      level,
      event: sanitizeText(event),
      fields: redactRecord(fields, this.#secrets) as Readonly<Record<string, unknown>>,
    };
    this.#writer.write(`${JSON.stringify(record)}\n`);
  }
}

export function redactStructuredValue(value: unknown, secrets: readonly string[] = []): unknown {
  return redactValue(value, Object.freeze([...secrets].filter((secret) => secret.length >= 4)), "");
}

function redactRecord(value: Readonly<Record<string, unknown>>, secrets: readonly string[]) {
  return redactValue(value, secrets, "");
}

function redactValue(value: unknown, secrets: readonly string[], key: string): unknown {
  if (isSensitiveKey(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, ""));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        sanitizeText(childKey),
        redactValue(childValue, secrets, childKey),
      ]),
    );
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return String(value);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replaceAll("-", "").replaceAll("_", "").toLowerCase();
  return (
    ["authorization", "cookie", "credential", "credentials", "password", "secret", "token"].some(
      (suffix) => normalized === suffix || normalized.endsWith(suffix),
    ) || normalized.endsWith("apikey")
  );
}

function redactText(value: string, secrets: readonly string[]): string {
  let redacted = sanitizeText(value);
  for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted;
}

function sanitizeText(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const allowedWhitespace = codePoint === 9 || codePoint === 10 || codePoint === 13;
      return (!allowedWhitespace && codePoint < 32) || (codePoint >= 127 && codePoint <= 159)
        ? "�"
        : character;
    })
    .join("");
}

function longestFirst(left: string, right: string): number {
  return right.length - left.length || left.localeCompare(right);
}
