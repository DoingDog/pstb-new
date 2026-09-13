import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PasteService, type CreateInput } from "./pastes";
import { deriveDownloadFileName, renderMarkdown } from "./render";
import { isPasteError, PasteError, type Env, type LoadedPaste } from "./types";

const allow = "POST,OPTIONS";
const textPlainUtf8 = "text/plain; charset=utf-8";
const textHtmlUtf8 = "text/html; charset=utf-8";

const expirationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("permanent") }).strict(),
  z.object({ kind: z.literal("relative"), seconds: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("absolute") }).strict(),
]);
const pasteSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  format: z.enum(["text", "markdown"]),
  viewOnce: z.boolean(),
  protected: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string(),
  expiresAt: z.string().nullable(),
  expiration: expirationSchema,
  version: z.string(),
  contentRevision: z.number().int().positive(),
  contentBytes: z.number().int().nonnegative(),
  createdCountry: z.string().nullable(),
  links: z.object({
    view: z.string(),
    raw: z.string(),
    html: z.string(),
    markdown: z.string(),
    file: z.string(),
  }).strict(),
}).strict();
const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();
const errorResultSchema = z.object({ ok: z.literal(false), error: errorSchema }).strict();
const pasteCreateInputSchema = z.object({
  content: z.string(),
  title: z.string().optional(),
  format: z.enum(["text", "markdown"]).optional(),
  expiration: z.union([z.number(), z.string(), z.null()]).optional(),
  password: z.string().optional(),
  viewOnce: z.boolean().optional(),
  customId: z.string().optional(),
}).strict();
const pasteCreateOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), paste: pasteSummarySchema }).strict(),
  errorResultSchema,
]);
const pasteGetInputSchema = z.object({
  id: z.string(),
  password: z.string().optional(),
  representation: z.enum(["source", "raw", "html", "markdown", "file"]).optional(),
}).strict();
const pasteGetOutputSchema = z.union([
  z.discriminatedUnion("representation", [
    z.object({ ok: z.literal(true), paste: pasteSummarySchema, representation: z.literal("source"), mediaType: z.literal(textPlainUtf8), content: z.string(), fileName: z.null() }).strict(),
    z.object({ ok: z.literal(true), paste: pasteSummarySchema, representation: z.literal("raw"), mediaType: z.literal(textPlainUtf8), content: z.string(), fileName: z.null() }).strict(),
    z.object({ ok: z.literal(true), paste: pasteSummarySchema, representation: z.literal("html"), mediaType: z.literal(textHtmlUtf8), content: z.string(), fileName: z.null() }).strict(),
    z.object({ ok: z.literal(true), paste: pasteSummarySchema, representation: z.literal("markdown"), mediaType: z.literal(textHtmlUtf8), content: z.string(), fileName: z.null() }).strict(),
    z.object({ ok: z.literal(true), paste: pasteSummarySchema, representation: z.literal("file"), mediaType: z.literal("application/octet-stream"), content: z.string(), fileName: z.string() }).strict(),
  ]),
  errorResultSchema,
]);

function toCreateInput(input: z.infer<typeof pasteCreateInputSchema>): CreateInput {
  const result: CreateInput = { content: input.content };
  if (input.title !== undefined) result.title = input.title;
  if (input.format !== undefined) result.format = input.format;
  if (input.expiration !== undefined) result.expiration = input.expiration;
  if (input.password !== undefined) result.password = input.password;
  if (input.viewOnce !== undefined) result.viewOnce = input.viewOnce;
  if (input.customId !== undefined) result.customId = input.customId;
  return result;
}

type Representation = "source" | "raw" | "html" | "markdown" | "file";

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
  isError?: true;
};

function toolResult(structuredContent: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(isError ? { isError: true as const } : {}),
  };
}

function pasteErrorResult(error: PasteError): ToolResult {
  const payload = {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  return toolResult(payload, true);
}

function prepareRepresentation(loaded: LoadedPaste, representation: Representation): {
  mediaType: string;
  content: string;
  fileName: string | null;
} {
  switch (representation) {
    case "source":
    case "raw":
      return { mediaType: textPlainUtf8, content: loaded.content, fileName: null };
    case "html":
      return { mediaType: textHtmlUtf8, content: loaded.content, fileName: null };
    case "markdown":
      try {
        return { mediaType: textHtmlUtf8, content: renderMarkdown(loaded.content), fileName: null };
      } catch {
        throw new PasteError("RENDER_FAILED", 500);
      }
    case "file":
      return { mediaType: "application/octet-stream", content: loaded.content, fileName: deriveDownloadFileName(loaded.summary) };
  }
}

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

  const country = request.cf?.country;
  return createMcpHandler(() => {
    const service = new PasteService(env.PASTE_DB);
    const server = new McpServer({ name: "cf-pastebin", version: "2.0.0" });

    server.registerTool("paste_create", {
      description: "Create a paste.",
      inputSchema: pasteCreateInputSchema,
      outputSchema: pasteCreateOutputSchema,
    }, async (input) => {
      try {
        const paste = await service.create(toCreateInput(input), typeof country === "string" ? { country } : {});
        return toolResult({ ok: true, paste });
      } catch (error) {
        if (isPasteError(error)) return pasteErrorResult(error);
        throw error;
      }
    });

    server.registerTool("paste_get", {
      description: "Get a paste representation.",
      inputSchema: pasteGetInputSchema,
      outputSchema: pasteGetOutputSchema,
    }, async (input) => {
      try {
        const loaded = await service.loadContent(input.id, input.password);
        const representation = input.representation ?? "source";
        const prepared = prepareRepresentation(loaded, representation);
        const result = toolResult({ ok: true, paste: loaded.summary, representation, ...prepared });
        if (loaded.summary.viewOnce) await service.consume(loaded);
        return result;
      } catch (error) {
        if (isPasteError(error)) return pasteErrorResult(error);
        throw error;
      }
    });

    return server;
  }).fetch(request);
}
