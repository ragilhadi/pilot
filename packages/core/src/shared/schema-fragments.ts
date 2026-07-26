import * as z from "zod";

/**
 * Reusable Zod fragments. These were previously copy-pasted across the message, model,
 * permission, and tool modules; centralizing them keeps a single source of truth for the
 * identifier grammars and shared refinements the domain schemas are built from.
 */

/** Lowercase snake_case tool name, e.g. `read_file`. */
export const toolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u, "Tool names must use lowercase snake_case");

/** Lowercase kebab-case provider id, e.g. `openai-compatible`. */
export const providerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/u, "Provider IDs must use lowercase kebab-case");

/** Generic non-empty, length-bounded identifier used by permission and audit records. */
export const boundedIdentifier = z.string().min(1).max(256);

/** The finish reason reported by a model response or completion stream event. */
export const finishReasonSchema = z.enum([
  "content-filter",
  "error",
  "length",
  "stop",
  "tool-calls",
  "unknown",
]);

/**
 * Builds a URL schema restricted to the HTTP(S) protocols. Callers supply the message so the
 * validation error stays specific to the field (provider base URL, image source, and so on).
 */
export function httpOrHttpsUrl(message: string): z.ZodType<string> {
  return z.url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, message);
}
