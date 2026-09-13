import { describe, expect, it, vi } from "vitest";
import { handleMcp } from "./mcp";
import { renderMarkdown } from "./render";
import type { Env } from "./types";

vi.mock("./render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render")>();
  return { ...actual, renderMarkdown: vi.fn(actual.renderMarkdown) };
});

const context = undefined as unknown as ExecutionContext;
const url = "https://paste.test/mcp";
const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
};

type Entry = { value: string; metadata: unknown };

class RecordingKV {
  readonly entries = new Map<string, Entry>();
  failDeletes = false;

  seed(key: string, value: string, metadata: unknown = null): void {
    this.entries.set(key, { value, metadata: structuredClone(metadata) });
  }

  async get(key: string): Promise<string | null> {
    return this.entries.get(key)?.value ?? null;
  }

  async getWithMetadata(key: string): Promise<{ value: string | null; metadata: unknown }> {
    const entry = this.entries.get(key);
    return { value: entry?.value ?? null, metadata: entry?.metadata ?? null };
  }

  async put(key: string, value: string, options?: { metadata?: unknown }): Promise<void> {
    this.entries.set(key, { value, metadata: structuredClone(options?.metadata ?? null) });
  }

  async delete(key: string): Promise<void> {
    if (this.failDeletes) throw new Error("delete failed");
    this.entries.delete(key);
  }
}

function request(method: string, headers?: HeadersInit, body?: BodyInit | null): Request {
  const init: RequestInit = { method };
  if (headers !== undefined) init.headers = headers;
  if (body !== undefined) init.body = body;
  return new Request(url, init);
}

function modernRequest(method: string, params: Record<string, unknown>, name?: string): Request {
  const headers: HeadersInit = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
  };
  if (name !== undefined) headers["mcp-name"] = name;
  return request("POST", headers, JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: { ...params, _meta: meta },
  }));
}

async function toolCallBody(
  toolEnv: Env,
  name: string,
  args?: Record<string, unknown>,
  country?: string,
): Promise<Record<string, any>> {
  const toolRequest = modernRequest("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }, name);
  if (country !== undefined) Object.defineProperty(toolRequest, "cf", { value: { country } });
  const response = await handleMcp(toolRequest, toolEnv, context);
  expect(response.status).toBe(200);
  return await response.json() as Record<string, any>;
}

async function toolCall(
  toolEnv: Env,
  name: string,
  args: Record<string, unknown>,
  country?: string,
): Promise<Record<string, any>> {
  const body = await toolCallBody(toolEnv, name, args, country);
  expect(body.error).toBeUndefined();
  return body.result;
}

function expectResultText(result: Record<string, any>): void {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]).toMatchObject({ type: "text", text: JSON.stringify(result.structuredContent) });
}

function toolEnv(kv = new RecordingKV()): { env: Env; kv: RecordingKV } {
  return { env: { PASTE_DB: kv as unknown as KVNamespace }, kv };
}

const env = toolEnv().env;

describe("MCP transport boundary", () => {
  it("accepts missing, exact, and explicit-default-port Origins", async () => {
    for (const origin of [undefined, "https://paste.test", "https://paste.test:443"]) {
      const response = await handleMcp(request("OPTIONS", origin === undefined ? undefined : { origin }), env, context);

      expect(response.status).toBe(204);
      expect(response.headers.get("allow")).toBe("POST,OPTIONS");
    }
  });

  it("rejects invalid Origins before method handling", async () => {
    for (const origin of [
      "null",
      "https://",
      "https://paste.test,https://other.test",
      "https://user@paste.test",
      "https://paste.test/path",
      "https://paste.test?query=value",
      "https://paste.test#fragment",
      "https://other.test",
    ]) {
      const response = await handleMcp(request("OPTIONS", { origin }), env, context);

      expect(response.status).toBe(403);
    }
  });

  it("returns the POST and OPTIONS method contract without delegating other methods", async () => {
    const options = await handleMcp(request("OPTIONS"), env, context);
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toBe("POST,OPTIONS");

    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE"]) {
      const response = await handleMcp(request(method), env, context);

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST,OPTIONS");
    }
  });

  it("serves the exact modern discovery fixture as JSON", async () => {
    const response = await handleMcp(request("POST", {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "server/discover",
    }, JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
        },
      },
    })), env, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        supportedVersions: ["2026-07-28"],
        _meta: {
          "io.modelcontextprotocol/serverInfo": { name: "cf-pastebin", version: "2.0.0" },
        },
      },
    });
  });

  it("serves independent stateless legacy initialize fixtures as SSE", async () => {
    const legacy = () => request("POST", {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    }, JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    }));

    for (const response of [
      await handleMcp(legacy(), env, context),
      await handleMcp(legacy(), env, context),
    ]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("mcp-session-id")).toBeNull();
      await expect(response.text()).resolves.toContain('"protocolVersion":"2025-11-25"');
    }
  });

  it("lists paste_create then paste_get as its exact tool surface", async () => {
    const { env: toolEnvironment } = toolEnv();
    const response = await handleMcp(modernRequest("tools/list", {}), toolEnvironment, context);

    expect(response.status).toBe(200);
    const body = await response.json() as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(["paste_create", "paste_get"]);
  });

  it("returns JSON-RPC InvalidParams for malformed modern tool calls", async () => {
    const { env: toolEnvironment } = toolEnv();

    for (const [name, args] of [
      ["paste_create", {}],
      ["paste_create", { content: "source", unexpected: true }],
      ["paste_create", { content: 1 }],
      ["paste_get", {}],
      ["paste_get", { id: "missing", unexpected: true }],
      ["paste_get", { id: 1 }],
      ["unknown", {}],
    ] as const) {
      const body = await toolCallBody(toolEnvironment, name, args);

      expect(body).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32602 } });
      expect(body).not.toHaveProperty("result");
    }

    const absentArguments = await toolCallBody(toolEnvironment, "paste_create");
    expect(absentArguments).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32602 } });
    expect(absentArguments).not.toHaveProperty("result");
  });

  it("returns stateless legacy JSON-RPC errors for malformed tool calls", async () => {
    const { env: toolEnvironment } = toolEnv();
    const response = await handleMcp(request("POST", {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    }, JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "paste_create", arguments: {} },
    })), toolEnvironment, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const body = await response.text();
    expect(body).toContain('"code":-32602');
    expect(body).not.toContain('"result"');
  });

  it("creates a paste with PasteService defaults and the request country", async () => {
    const { env: toolEnvironment, kv } = toolEnv();
    const result = await toolCall(toolEnvironment, "paste_create", { content: "exact source", customId: "mcp-create" }, "CA");

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      paste: {
        id: "mcp-create",
        title: "",
        format: "text",
        viewOnce: false,
        protected: false,
        expiration: { kind: "relative", seconds: 86_400 },
        createdCountry: "CA",
      },
    });
    expectResultText(result);
    expect(kv.entries.get("mcp-create")?.value).toBe("exact source");
  });

  it("returns PasteError results for create validation and conflicts", async () => {
    const { env: toolEnvironment } = toolEnv();
    const empty = await toolCall(toolEnvironment, "paste_create", { content: "", customId: "mcp-empty" });
    await toolCall(toolEnvironment, "paste_create", { content: "first", customId: "mcp-conflict" });
    const conflict = await toolCall(toolEnvironment, "paste_create", { content: "second", customId: "mcp-conflict" });

    for (const [result, code] of [[empty, "VALIDATION_FAILED"], [conflict, "ID_CONFLICT"]] as const) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, error: { code } });
      expectResultText(result);
    }
  });

  it("never returns the plaintext password from paste_create", async () => {
    const { env: toolEnvironment } = toolEnv();
    const result = await toolCall(toolEnvironment, "paste_create", {
      content: "protected source",
      customId: "mcp-password-omission",
      password: "plaintext-password",
    });

    expect(result.structuredContent).toMatchObject({ ok: true, paste: { protected: true } });
    expect(JSON.stringify(result)).not.toContain("plaintext-password");
    expectResultText(result);
  });

  it("gets all source representations without changing the stored format", async () => {
    const { env: toolEnvironment } = toolEnv();
    const source = "## Heading\n\n<script>alert(1)</script>";
    await toolCall(toolEnvironment, "paste_create", {
      content: source,
      customId: "mcp-representations",
      title: "draft/final\\copy.  ",
      format: "markdown",
      expiration: "permanent",
    });

    for (const [representation, mediaType, content, fileName] of [
      ["source", "text/plain; charset=utf-8", source, null],
      ["raw", "text/plain; charset=utf-8", source, null],
      ["html", "text/html; charset=utf-8", source, null],
      ["file", "application/octet-stream", source, "draft_final_copy"],
    ] as const) {
      const result = await toolCall(toolEnvironment, "paste_get", { id: "mcp-representations", representation });
      expect(result.structuredContent).toMatchObject({ ok: true, representation, mediaType, content, fileName });
      expect(result.structuredContent.paste.format).toBe("markdown");
      expectResultText(result);
    }

    const markdown = await toolCall(toolEnvironment, "paste_get", { id: "mcp-representations", representation: "markdown" });
    expect(markdown.structuredContent).toMatchObject({
      ok: true,
      representation: "markdown",
      mediaType: "text/html; charset=utf-8",
      fileName: null,
    });
    expect(markdown.structuredContent.content).toContain("<h2>Heading</h2>");
    expect(markdown.structuredContent.content).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markdown.structuredContent.content).not.toContain("<script>alert(1)</script>");
    expectResultText(markdown);
  });

  it("gets a zero-byte legacy source through the public PasteSummary schema", async () => {
    const { env: toolEnvironment, kv } = toolEnv();
    kv.seed("mcp-empty-legacy", "");

    const result = await toolCall(toolEnvironment, "paste_get", { id: "mcp-empty-legacy" });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      representation: "source",
      mediaType: "text/plain; charset=utf-8",
      content: "",
      paste: { contentBytes: 0 },
    });
    expectResultText(result);
  });

  it("requires only the tool password for protected paste_get", async () => {
    const { env: toolEnvironment } = toolEnv();
    await toolCall(toolEnvironment, "paste_create", {
      content: "protected source",
      customId: "mcp-protected",
      password: "correct-password",
    });

    const missing = await toolCall(toolEnvironment, "paste_get", { id: "mcp-protected" });
    const wrong = await toolCall(toolEnvironment, "paste_get", { id: "mcp-protected", password: "wrong-password" });
    const correct = await toolCall(toolEnvironment, "paste_get", { id: "mcp-protected", password: "correct-password" });

    for (const result of [missing, wrong]) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(JSON.stringify(result)).not.toContain("correct-password");
      expectResultText(result);
    }
    expect(correct.isError).toBeUndefined();
    expect(correct.structuredContent).toMatchObject({ ok: true, content: "protected source" });
    expect(JSON.stringify(correct)).not.toContain("correct-password");
    expectResultText(correct);
  });

  it("consumes a view-once paste only after preparing its first result", async () => {
    const { env: toolEnvironment } = toolEnv();
    await toolCall(toolEnvironment, "paste_create", {
      content: "view once source",
      customId: "mcp-view-once",
      viewOnce: true,
    });

    const first = await toolCall(toolEnvironment, "paste_get", { id: "mcp-view-once" });
    const second = await toolCall(toolEnvironment, "paste_get", { id: "mcp-view-once" });

    expect(first.structuredContent).toMatchObject({ ok: true, content: "view once source" });
    expectResultText(first);
    expect(second.isError).toBe(true);
    expect(second.structuredContent).toMatchObject({ ok: false, error: { code: "PASTE_NOT_FOUND" } });
    expectResultText(second);
  });

  it("returns a render failure without consuming a view-once paste", async () => {
    const { env: toolEnvironment } = toolEnv();
    await toolCall(toolEnvironment, "paste_create", {
      content: "# source",
      customId: "mcp-render-failure",
      format: "markdown",
      viewOnce: true,
    });
    vi.mocked(renderMarkdown).mockImplementationOnce(() => { throw new Error("render failed"); });

    const failed = await toolCall(toolEnvironment, "paste_get", { id: "mcp-render-failure", representation: "markdown" });
    const retry = await toolCall(toolEnvironment, "paste_get", { id: "mcp-render-failure" });

    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({ ok: false, error: { code: "RENDER_FAILED" } });
    expect(failed.structuredContent).not.toHaveProperty("content");
    expectResultText(failed);
    expect(retry.structuredContent).toMatchObject({ ok: true, content: "# source" });
    expectResultText(retry);
  });

  it("returns a consume failure without representation content", async () => {
    const { env: toolEnvironment, kv } = toolEnv();
    await toolCall(toolEnvironment, "paste_create", {
      content: "view once source",
      customId: "mcp-consume-failure",
      viewOnce: true,
    });
    kv.failDeletes = true;

    const result = await toolCall(toolEnvironment, "paste_get", { id: "mcp-consume-failure" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "CONSUME_FAILED" } });
    expect(result.structuredContent).not.toHaveProperty("content");
    expectResultText(result);
  });
});
