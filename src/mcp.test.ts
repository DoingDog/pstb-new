import { describe, expect, it } from "vitest";
import { handleMcp } from "./mcp";
import type { Env } from "./types";

const context = undefined as unknown as ExecutionContext;
const env = undefined as unknown as Env;
const url = "https://paste.test/mcp";

function request(method: string, headers?: HeadersInit, body?: BodyInit | null): Request {
  const init: RequestInit = { method };
  if (headers !== undefined) init.headers = headers;
  if (body !== undefined) init.body = body;
  return new Request(url, init);
}

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
});
