import { runId, toolCallId } from "@pilotrun/core";
import { describe, expect, it, vi } from "vitest";
import {
  createTavilyWebSearchProvider,
  createWebSearchTool,
  type WebSearchFetch,
  type WebSearchProvider,
} from "../src/index.js";

function context() {
  return {
    runId: runId("run-search"),
    callId: toolCallId("call-search"),
    signal: new AbortController().signal,
  };
}

function tavilyResponse(results: unknown[]): Response {
  return Response.json({ query: "query", results, response_time: 0.2 });
}

describe("web_search tool", () => {
  it("normalizes, sanitizes, deduplicates, and bounds provider results", async () => {
    const provider: WebSearchProvider = {
      id: "fake-search",
      async search() {
        return {
          results: [
            {
              title: "<strong>First</strong>\u0007 title",
              url: "https://example.com/a",
              description: "A &amp; B",
            },
            {
              title: "Duplicate",
              url: "https://example.com/a",
              description: "ignored",
            },
            {
              title: "Unsafe",
              url: "javascript:alert(1)",
              description: "ignored",
            },
            {
              title: "Second",
              url: "https://example.com/b",
              description: "second result",
              publishedAt: "2026-07-29",
            },
            {
              title: "Over limit",
              url: "https://example.com/c",
              description: "ignored",
            },
          ],
          moreResultsAvailable: false,
        };
      },
    };

    const result = await createWebSearchTool(provider).execute(
      { query: "example query", maxResults: 2 },
      context(),
    );

    expect(result.output).toMatchObject({
      query: "example query",
      provider: "fake-search",
      resultCount: 2,
      moreResultsAvailable: true,
      provenance: { source: "web-search", untrusted: true },
      results: [
        {
          title: "First � title",
          url: "https://example.com/a",
          description: "A & B",
        },
        {
          title: "Second",
          url: "https://example.com/b",
          description: "second result",
          publishedAt: "2026-07-29",
        },
      ],
    });
    expect(result.output.sanitizedCharacters).toBeGreaterThan(0);
    expect(result.metadata).toMatchObject({
      untrusted: true,
      provider: "fake-search",
      resultCount: 2,
    });
  });

  it("declares network risk and rejects malformed model-facing input", () => {
    const provider: WebSearchProvider = {
      id: "fake-search",
      async search() {
        return { results: [], moreResultsAvailable: false };
      },
    };
    const definition = createWebSearchTool(provider);

    expect(definition.metadata).toMatchObject({
      risk: "network",
      concurrency: "parallel-safe",
      requiredPermissions: ["network.access"],
    });
    expect(() => definition.inputSchema.parse({ query: "" })).toThrow();
    expect(() => definition.inputSchema.parse({ query: "x", maxResults: 21 })).toThrow();
    expect(() => definition.inputSchema.parse({ query: "x", freshness: "hour" })).toThrow();
    expect(() => definition.inputSchema.parse({ query: "x", extra: true })).toThrow();
  });

  it("sends a bounded Tavily request without exposing the API key in the URL or body", async () => {
    const fetchImpl = vi.fn<WebSearchFetch>(async () =>
      tavilyResponse([
        {
          title: "Node.js documentation",
          url: "https://nodejs.org/api/globals.html",
          content: "AbortSignal documentation",
          published_date: "2026-07-01T00:00:00Z",
        },
      ]),
    );
    const provider = createTavilyWebSearchProvider({
      apiKey: "test-secret-key",
      fetch: fetchImpl,
    });

    const response = await provider.search({
      query: "AbortSignal.any",
      maxResults: 5,
      freshness: "month",
      signal: new AbortController().signal,
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.tavily.com/search");
    expect(url).not.toContain("test-secret-key");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-secret-key");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "AbortSignal.any",
      search_depth: "basic",
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      time_range: "month",
    });
    expect(String(init?.body)).not.toContain("test-secret-key");
    expect(response).toEqual({
      results: [
        {
          title: "Node.js documentation",
          url: "https://nodejs.org/api/globals.html",
          description: "AbortSignal documentation",
          publishedAt: "2026-07-01T00:00:00Z",
        },
      ],
      moreResultsAvailable: false,
    });
  });

  it.each([
    {
      status: 401,
      code: "PILOT_WEB_SEARCH_AUTHENTICATION",
      retryable: false,
    },
    {
      status: 429,
      code: "PILOT_WEB_SEARCH_RATE_LIMITED",
      retryable: true,
    },
    {
      status: 503,
      code: "PILOT_WEB_SEARCH_FAILED",
      retryable: true,
    },
  ])("maps Tavily HTTP $status to $code", async ({ status, code, retryable }) => {
    const provider = createTavilyWebSearchProvider({
      apiKey: "key",
      fetch: async () => new Response("not returned", { status }),
    });

    await expect(
      provider.search({
        query: "query",
        maxResults: 5,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code, retryable, metadata: { status } });
  });

  it("rejects malformed and oversized provider responses", async () => {
    const malformed = createTavilyWebSearchProvider({
      apiKey: "key",
      fetch: async () => new Response("{", { status: 200 }),
    });
    await expect(
      malformed.search({
        query: "query",
        maxResults: 5,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "PILOT_WEB_SEARCH_INVALID_RESPONSE" });

    const oversized = createTavilyWebSearchProvider({
      apiKey: "key",
      fetch: async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": "1000001" },
        }),
    });
    await expect(
      oversized.search({
        query: "query",
        maxResults: 5,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "PILOT_WEB_SEARCH_INVALID_RESPONSE" });
  });
});
