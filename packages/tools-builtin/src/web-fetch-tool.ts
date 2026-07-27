import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { CancellationError, defineTool, PilotError, type ToolDefinition } from "@pilotrun/core";
import * as z from "zod";

const defaultMaxBytes = 200_000;
const hardMaxBytes = 2_000_000;
const defaultTimeoutMs = 15_000;
const maxRedirects = 5;
const userAgent = "PilotBot/1.0 (+https://github.com/ragilhadi/pilot)";

export const WebFetchInputSchema = z
  .object({
    url: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !/[\0\s]/u.test(value), "The URL must not contain spaces or null bytes"),
    maxBytes: z.number().int().min(1_024).max(hardMaxBytes).default(defaultMaxBytes),
  })
  .strict()
  .readonly();

export const WebFetchOutputSchema = z
  .object({
    requestedUrl: z.string(),
    finalUrl: z.string(),
    status: z.number().int(),
    contentType: z.string().nullable(),
    content: z.string(),
    bytesFetched: z.number().int().nonnegative(),
    truncated: z.boolean(),
    redirected: z.boolean(),
    sanitizedCharacters: z.number().int().nonnegative(),
    provenance: z
      .object({ source: z.literal("web"), untrusted: z.literal(true) })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export type WebFetchInput = z.output<typeof WebFetchInputSchema>;
export type WebFetchOutput = z.output<typeof WebFetchOutputSchema>;

type WebFetchErrorCode =
  | "PILOT_WEB_FETCH_BLOCKED"
  | "PILOT_WEB_FETCH_FAILED"
  | "PILOT_WEB_FETCH_INVALID_URL"
  | "PILOT_WEB_FETCH_UNSUPPORTED_CONTENT";

export class WebFetchToolError extends PilotError {
  constructor(
    code: WebFetchErrorCode,
    message: string,
    metadata: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
    /**
     * Overrides the generic per-code text. Used where the specific reason (an HTTP status, a
     * malformed URL) is more actionable than the category and contains nothing sensitive.
     */
    safeMessage?: string,
  ) {
    super({
      code,
      message,
      safeMessage: safeMessage ?? defaultSafeMessage(code),
      metadata,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

function defaultSafeMessage(code: WebFetchErrorCode): string {
  switch (code) {
    case "PILOT_WEB_FETCH_BLOCKED":
      return "The requested URL is not allowed to be fetched";
    case "PILOT_WEB_FETCH_INVALID_URL":
      return "The url argument is not a valid http(s) URL";
    case "PILOT_WEB_FETCH_UNSUPPORTED_CONTENT":
      return "The response was not text content that could be returned";
    case "PILOT_WEB_FETCH_FAILED":
      return "The web request could not be completed";
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export interface WebFetchToolOptions {
  readonly fetch?: FetchLike;
  readonly resolveHost?: HostResolver;
  readonly timeoutMs?: number;
  /** Escape hatch for tests only; never enable in production. */
  readonly allowPrivateHosts?: boolean;
}

const defaultResolveHost: HostResolver = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true });
  return records.map((record) => record.address);
};

export function createWebFetchTool(
  options: WebFetchToolOptions = {},
): ToolDefinition<typeof WebFetchInputSchema, typeof WebFetchOutputSchema> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const allowPrivateHosts = options.allowPrivateHosts ?? false;

  return defineTool({
    name: "web_fetch",
    description:
      "Fetch a single http(s) URL and return its text content (HTML is reduced to readable text), " +
      "bounded and sanitized. Use it to read documentation, changelogs, or issue pages. Binary " +
      "responses and private or loopback addresses are refused.",
    inputSchema: WebFetchInputSchema,
    outputSchema: WebFetchOutputSchema,
    metadata: {
      risk: "network",
      concurrency: "parallel-safe",
      timeoutMs: timeoutMs + 5_000,
      maxOutputBytes: hardMaxBytes + 65_536,
      requiredPermissions: ["network.access"],
    },
    execute: async (input, context) => {
      throwIfCancelled(context.signal);
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]);
      const requestedUrl = normalizeRequestedUrl(input.url);
      const { response, finalUrl, redirected } = await followRedirects(
        requestedUrl,
        fetchImpl,
        resolveHost,
        allowPrivateHosts,
        signal,
        context.signal,
      );

      const contentType = response.headers.get("content-type");
      assertTextContentType(contentType);
      const { bytes, truncated } = await readBounded(
        response,
        input.maxBytes,
        signal,
        context.signal,
      );
      if (bytes.includes(0)) {
        throw new WebFetchToolError(
          "PILOT_WEB_FETCH_UNSUPPORTED_CONTENT",
          "The response body contains null bytes and is treated as binary",
          { finalUrl },
        );
      }
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const text = isHtml(contentType) ? htmlToText(decoded) : decoded;
      const sanitized = sanitizeText(text);

      const output: WebFetchOutput = Object.freeze({
        requestedUrl,
        finalUrl,
        status: response.status,
        contentType,
        content: sanitized.text,
        bytesFetched: bytes.length,
        truncated,
        redirected,
        sanitizedCharacters: sanitized.sanitizedCharacters,
        provenance: { source: "web" as const, untrusted: true as const },
      });
      return {
        output,
        metadata: {
          untrusted: true,
          truncated,
          status: response.status,
          finalUrl,
          sanitizedCharacters: sanitized.sanitizedCharacters,
        },
      };
    },
  });
}

/**
 * Repairs the URL shapes models actually emit before any validation runs.
 *
 * A bare `example.com/docs` used to pass the string schema, fail `new URL`, and surface as "the
 * requested URL is not allowed to be fetched" — a missing scheme reported as a security refusal.
 * Markdown autolinks (`<https://…>`) and trailing sentence punctuation are the same class of
 * mistake. Anything still unparseable afterwards gets a specific, retryable invalid-URL error.
 */
export function normalizeRequestedUrl(rawUrl: string): string {
  let candidate = rawUrl.trim();
  const autolink = /^<(.+)>$/su.exec(candidate);
  if (autolink?.[1] !== undefined) candidate = autolink[1].trim();
  // A URL that genuinely ends in one of these is vanishingly rare; a sentence that ends in one
  // right after a URL is not.
  candidate = candidate.replace(/[.,;:!?'"]+$/u, "");
  // Only strip a closing bracket that has no opener, so real URLs keep their balanced parentheses.
  while (/[)\]}]$/u.test(candidate) && !hasMatchingOpener(candidate)) {
    candidate = candidate.slice(0, -1);
  }
  if (candidate.length === 0) {
    throw new WebFetchToolError(
      "PILOT_WEB_FETCH_INVALID_URL",
      "The URL is empty",
      { rawUrl },
      undefined,
      "The url argument is empty. Pass an absolute URL such as https://example.com/page.",
    );
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(candidate)) {
    if (candidate.startsWith("//")) return `https:${candidate}`;
    return `https://${candidate}`;
  }
  return candidate;
}

function hasMatchingOpener(value: string): boolean {
  const closer = value.at(-1);
  const opener = closer === ")" ? "(" : closer === "]" ? "[" : "{";
  return value.slice(0, -1).includes(opener);
}

async function followRedirects(
  requestedUrl: string,
  fetchImpl: FetchLike,
  resolveHost: HostResolver,
  allowPrivateHosts: boolean,
  signal: AbortSignal,
  cancelSignal: AbortSignal,
): Promise<{ response: Response; finalUrl: string; redirected: boolean }> {
  let current = requestedUrl;
  let redirected = false;
  for (let hop = 0; ; hop += 1) {
    await assertPublicUrl(current, resolveHost, allowPrivateHosts);
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          accept: "text/*, application/json, application/xhtml+xml",
          "user-agent": userAgent,
        },
      });
    } catch (error) {
      if (cancelSignal.aborted) throw new CancellationError(cancelSignal.reason);
      throw new WebFetchToolError(
        "PILOT_WEB_FETCH_FAILED",
        "The web request failed or timed out",
        { url: current },
        error,
      );
    }
    const location = response.headers.get("location");
    if (isRedirectStatus(response.status) && location !== null) {
      if (hop >= maxRedirects) {
        throw new WebFetchToolError("PILOT_WEB_FETCH_BLOCKED", "Too many redirects", {
          url: current,
        });
      }
      current = resolveRedirect(location, current);
      redirected = true;
      continue;
    }
    if (!response.ok) {
      throw new WebFetchToolError(
        "PILOT_WEB_FETCH_FAILED",
        `The server responded with status ${response.status}`,
        { url: current, status: response.status },
        undefined,
        // Without the status the model cannot tell a 404 (wrong URL, pick another) from a 429
        // (transient, worth retrying) from a network failure.
        `The server responded with HTTP ${response.status}${
          response.statusText === "" ? "" : ` ${response.statusText}`
        }.`,
      );
    }
    return { response, finalUrl: current, redirected };
  }
}

function resolveRedirect(location: string, base: string): string {
  try {
    return new URL(location, base).toString();
  } catch (error) {
    throw new WebFetchToolError(
      "PILOT_WEB_FETCH_BLOCKED",
      "The redirect target is not a valid URL",
      { location },
      error,
    );
  }
}

/**
 * Refuse anything that is not a plain http(s) request to a public host. Resolves
 * DNS and rejects if any resolved address is private/loopback/link-local, which
 * blocks the common SSRF vectors (including cloud metadata at 169.254.169.254).
 * Residual risk: DNS rebinding between this check and the actual connection.
 */
async function assertPublicUrl(
  rawUrl: string,
  resolveHost: HostResolver,
  allowPrivateHosts: boolean,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new WebFetchToolError(
      "PILOT_WEB_FETCH_INVALID_URL",
      "The URL is not valid",
      { rawUrl },
      error,
      `"${rawUrl}" is not a valid URL. Pass an absolute URL including the scheme, for example ` +
        "https://example.com/page.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchToolError(
      "PILOT_WEB_FETCH_INVALID_URL",
      "Only http and https URLs are allowed",
      { protocol: url.protocol },
      undefined,
      `The scheme "${url.protocol}" is not supported. Only http:// and https:// URLs can be fetched.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new WebFetchToolError(
      "PILOT_WEB_FETCH_BLOCKED",
      "URLs with embedded credentials are not allowed",
    );
  }
  if (allowPrivateHosts) return;

  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const literalFamily = isIP(hostname);
  const addresses =
    literalFamily !== 0 ? [hostname] : await resolveHostOrBlock(resolveHost, hostname);
  if (addresses.length === 0) {
    throw new WebFetchToolError("PILOT_WEB_FETCH_BLOCKED", "The host could not be resolved", {
      hostname,
    });
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new WebFetchToolError(
        "PILOT_WEB_FETCH_BLOCKED",
        "The host resolves to a private, loopback, or link-local address",
        { hostname, address },
      );
    }
  }
}

async function resolveHostOrBlock(
  resolveHost: HostResolver,
  hostname: string,
): Promise<readonly string[]> {
  try {
    return await resolveHost(hostname);
  } catch (error) {
    throw new WebFetchToolError(
      "PILOT_WEB_FETCH_BLOCKED",
      "The host could not be resolved",
      { hostname },
      error,
    );
  }
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 and 192.0.2.0/24 special-use
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedIpv6(address: string): boolean {
  const value = address.toLowerCase().split("%")[0] ?? "";
  if (value === "::1" || value === "::") return true; // loopback, unspecified
  if (
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb")
  ) {
    return true; // link-local fe80::/10
  }
  if (value.startsWith("fc") || value.startsWith("fd")) return true; // unique local fc00::/7
  if (value.startsWith("ff")) return true; // multicast
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  if (mapped?.[1] !== undefined) return isBlockedIpv4(mapped[1]);
  return false;
}

async function readBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  cancelSignal: AbortSignal,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const body = response.body;
  if (body === null) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const remaining = maxBytes - total;
      if (value.byteLength >= remaining) {
        chunks.push(Buffer.from(value.subarray(0, remaining)));
        total += remaining;
        truncated = value.byteLength > remaining || truncated;
        break;
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } catch (error) {
    if (cancelSignal.aborted) throw new CancellationError(cancelSignal.reason);
    throw new WebFetchToolError(
      "PILOT_WEB_FETCH_FAILED",
      "The response body could not be read",
      {},
      error,
    );
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (cancelSignal.aborted) throw new CancellationError(cancelSignal.reason);
  // The loop also breaks when the fetch timeout fires mid-body. Reporting that partial read as a
  // complete response would let a model conclude it had the whole document, so flag it as
  // truncated — the same signal it already uses to decide whether to narrow the request.
  return { bytes: Buffer.concat(chunks, total), truncated: truncated || signal.aborted };
}

function assertTextContentType(contentType: string | null): void {
  if (contentType === null) return; // Allow missing content-type; body is still null-byte checked.
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const textual =
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/xhtml+xml" ||
    type === "application/javascript" ||
    type === "application/ld+json" ||
    type.endsWith("+json") ||
    type.endsWith("+xml");
  if (!textual) {
    throw new WebFetchToolError(
      "PILOT_WEB_FETCH_UNSUPPORTED_CONTENT",
      `The response content type ${type} is not text`,
      { contentType: type },
    );
  }
}

function isHtml(contentType: string | null): boolean {
  if (contentType === null) return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "text/html" || type === "application/xhtml+xml";
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Dependency-free HTML-to-text: drop scripts/styles, turn block tags into line breaks. */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/giu, " ")
      .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)\s*>/giu, "\n")
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<[^>]+>/gu, " "),
  )
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return codePointToString(Number.parseInt(entity.slice(2), 16));
    if (lower.startsWith("#")) return codePointToString(Number.parseInt(entity.slice(1), 10));
    return named[lower] ?? match;
  });
}

function codePointToString(codePoint: number): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return "";
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

function sanitizeText(value: string): { text: string; sanitizedCharacters: number } {
  let sanitizedCharacters = 0;
  let text = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafe =
      codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      (codePoint >= 127 && codePoint <= 159);
    if (unsafe) {
      sanitizedCharacters += 1;
      text += "�";
    } else {
      text += character;
    }
  }
  return { text, sanitizedCharacters };
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancellationError(signal.reason);
}
