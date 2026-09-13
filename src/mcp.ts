import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { Env } from "./types";

const allow = "POST,OPTIONS";

function hasAllowedOrigin(request: Request): boolean {
  const value = request.headers.get("origin");
  if (value === null) return true;

  try {
    const origin = new URL(value);
    const defaultPort = origin.protocol === "http:" ? "80" : origin.protocol === "https:" ? "443" : "";
    const explicitDefaultOrigin = defaultPort === "" ? "" : `${origin.protocol}//${origin.hostname}:${defaultPort}`;

    return (value === origin.origin || value === explicitDefaultOrigin)
      && origin.origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!hasAllowedOrigin(request)) return new Response(null, { status: 403 });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { Allow: allow } });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: allow } });

  return createMcpHandler(() => new McpServer({ name: "cf-pastebin", version: "2.0.0" })).fetch(request);
}
