import { runId, toolCallId } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import {
  createWebFetchTool,
  type FetchLike,
  type HostResolver,
  type WebFetchToolOptions,
} from "../src/index.js";

const publicResolver: HostResolver = async (hostname) =>
  hostname === "internal.test" ? ["10.0.0.5"] : ["93.184.216.34"];

function textResponse(body: string, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

function tool(fetchImpl: FetchLike, extra: Partial<WebFetchToolOptions> = {}) {
  return createWebFetchTool({ fetch: fetchImpl, resolveHost: publicResolver, ...extra });
}

function context() {
  return {
    runId: runId("run-web"),
    callId: toolCallId("call-web"),
    signal: new AbortController().signal,
  };
}

describe("web_fetch tool", () => {
  it("fetches text content from a public host with correct provenance", async () => {
    const fetchImpl: FetchLike = async () => textResponse("hello from the docs");
    const result = await tool(fetchImpl).execute(
      { url: "https://example.com/docs", maxBytes: 200_000 },
      context(),
    );

    expect(result.output).toMatchObject({
      requestedUrl: "https://example.com/docs",
      finalUrl: "https://example.com/docs",
      status: 200,
      content: "hello from the docs",
      truncated: false,
      redirected: false,
      provenance: { source: "web", untrusted: true },
    });
    expect(result.metadata).toMatchObject({ untrusted: true, status: 200 });
  });

  it("reduces HTML to readable text and decodes entities", async () => {
    const html =
      "<html><head><style>.x{}</style><script>bad()</script></head>" +
      "<body><h1>Title</h1><p>First &amp; second</p><p>Third</p></body></html>";
    const fetchImpl: FetchLike = async () => textResponse(html, "text/html; charset=utf-8");
    const result = await tool(fetchImpl).execute({ url: "https://example.com" }, context());

    expect(result.output.content).toBe("Title\nFirst & second\nThird");
    expect(result.output.content).not.toContain("bad()");
  });

  it("declares network risk and requires the network permission", () => {
    const definition = tool(async () => textResponse("x"));
    expect(definition.metadata.risk).toBe("network");
    expect(definition.metadata.requiredPermissions).toEqual(["network.access"]);
  });

  it("blocks non-http(s) schemes without calling fetch", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return textResponse("x");
    };
    await expect(
      tool(fetchImpl).execute({ url: "file:///etc/passwd" }, context()),
    ).rejects.toMatchObject({ code: "PILOT_WEB_FETCH_BLOCKED" });
    expect(called).toBe(false);
  });

  it("blocks URLs with embedded credentials", async () => {
    await expect(
      tool(async () => textResponse("x")).execute(
        { url: "https://user:pass@example.com" },
        context(),
      ),
    ).rejects.toMatchObject({ code: "PILOT_WEB_FETCH_BLOCKED" });
  });

  it("blocks a loopback IP literal", async () => {
    await expect(
      tool(async () => textResponse("x")).execute({ url: "http://127.0.0.1/admin" }, context()),
    ).rejects.toMatchObject({ code: "PILOT_WEB_FETCH_BLOCKED" });
  });

  it("blocks the cloud metadata address", async () => {
    await expect(
      tool(async () => textResponse("x")).execute(
        { url: "http://169.254.169.254/latest/meta-data/" },
        context(),
      ),
    ).rejects.toMatchObject({ code: "PILOT_WEB_FETCH_BLOCKED" });
  });

  it("blocks a host that resolves to a private address", async () => {
    await expect(
      tool(async () => textResponse("x")).execute({ url: "https://internal.test" }, context()),
    ).rejects.toMatchObject({ code: "PILOT_WEB_FETCH_BLOCKED", metadata: { address: "10.0.0.5" } });
  });

  it("re-validates redirect targets and blocks a redirect to a private host", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url === "https://example.com/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://internal.test/x" },
        });
      }
      return textResponse("should not reach here");
    };
    await expect(
      tool(fetchImpl).execute({ url: "https://example.com/start" }, context()),
    ).rejects.toMatchObject({ code: "PILOT_WEB_FETCH_BLOCKED", metadata: { address: "10.0.0.5" } });
  });

  it("follows a redirect to a public host and reports redirected", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url === "https://example.com/a") {
        return new Response(null, { status: 301, headers: { location: "https://example.com/b" } });
      }
      return textResponse("final page");
    };
    const result = await tool(fetchImpl).execute({ url: "https://example.com/a" }, context());
    expect(result.output).toMatchObject({
      finalUrl: "https://example.com/b",
      redirected: true,
      content: "final page",
    });
  });

  it("rejects binary content types", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("", { status: 200, headers: { "content-type": "image/png" } });
    await expect(
      tool(fetchImpl).execute({ url: "https://example.com/logo.png" }, context()),
    ).rejects.toMatchObject({ code: "PILOT_WEB_FETCH_UNSUPPORTED_CONTENT" });
  });

  it("treats a body with null bytes as unsupported binary", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(Buffer.from([104, 105, 0, 33]), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    await expect(
      tool(fetchImpl).execute({ url: "https://example.com/data" }, context()),
    ).rejects.toMatchObject({ code: "PILOT_WEB_FETCH_UNSUPPORTED_CONTENT" });
  });

  it("truncates the body at maxBytes", async () => {
    const fetchImpl: FetchLike = async () => textResponse("a".repeat(5_000));
    const result = await tool(fetchImpl).execute(
      { url: "https://example.com/big", maxBytes: 1_024 },
      context(),
    );
    expect(result.output.truncated).toBe(true);
    expect(result.output.bytesFetched).toBe(1_024);
    expect(result.output.content.length).toBe(1_024);
  });

  it("surfaces a non-ok status as a failed fetch", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
    await expect(
      tool(fetchImpl).execute({ url: "https://example.com/missing" }, context()),
    ).rejects.toMatchObject({ code: "PILOT_WEB_FETCH_FAILED", metadata: { status: 404 } });
  });

  it("rejects model-facing input that violates the schema", () => {
    const definition = tool(async () => textResponse("x"));
    expect(() => definition.inputSchema.parse({ url: "" })).toThrow();
    expect(() => definition.inputSchema.parse({ url: "https://x.com extra" })).toThrow();
    expect(() => definition.inputSchema.parse({ url: "https://x.com", maxBytes: 10 })).toThrow();
    expect(() => definition.inputSchema.parse({ url: "https://x.com", extra: 1 })).toThrow();
  });
});
