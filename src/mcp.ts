import { createMcpHandler, McpServer, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  PasteService,
  type CreateInput,
  type UpdateContentInput,
  type UpdatePasswordInput,
  type UpdateSettingsInput,
} from "./pastes";
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
const expirationInputSchema = z.union([z.number(), z.string(), z.null()]);
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
  code: z.enum([
    "BAD_REQUEST",
    "AMBIGUOUS_PASSWORD",
    "AMBIGUOUS_VERSION",
    "FORBIDDEN",
    "PASTE_NOT_FOUND",
    "REVISION_NOT_FOUND",
    "ID_CONFLICT",
    "VERSION_CONFLICT",
    "VIEW_ONCE_HISTORY_FORBIDDEN",
    "CONTENT_TOO_LARGE",
    "REQUEST_TOO_LARGE",
    "UNSUPPORTED_MEDIA_TYPE",
    "VALIDATION_FAILED",
    "RENDER_FAILED",
    "INTERNAL_ERROR",
    "STORAGE_READ_FAILED",
    "STORAGE_WRITE_FAILED",
    "STORAGE_INCONSISTENT",
    "CONSUME_FAILED",
    "ID_GENERATION_FAILED",
  ]),
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
const mutationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), changed: z.boolean(), paste: pasteSummarySchema }).strict(),
  errorResultSchema,
]);
const pasteDeleteInputSchema = z.object({
  id: z.string(),
  password: z.string().optional(),
  version: z.string().optional(),
}).strict();
const pasteDeleteOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), id: z.string(), deleted: z.literal(true) }).strict(),
  errorResultSchema,
]);
const pasteUpdateInputSchema = z.object({
  id: z.string(),
  content: z.string(),
  password: z.string().optional(),
  version: z.string().optional(),
}).strict();
const pasteHistoryListInputSchema = z.object({
  id: z.string(),
  password: z.string().optional(),
}).strict();
const historyDescriptorSchema = z.object({
  revision: z.number().int().positive().safe(),
  savedAt: z.string(),
  supersededAt: z.string(),
  byteLength: z.number().int().nonnegative().safe(),
}).strict();
const historyListSchema = z.object({
  id: z.string(),
  currentRevision: z.number().int().positive().safe(),
  currentVersion: z.string(),
  revisions: z.array(historyDescriptorSchema),
}).strict();
const pasteHistoryListOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), history: historyListSchema }).strict(),
  errorResultSchema,
]);
const pasteHistoryGetInputSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive().safe(),
  password: z.string().optional(),
}).strict();
const revisionResourceSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive().safe(),
  savedAt: z.string(),
  supersededAt: z.string(),
  byteLength: z.number().int().nonnegative().safe(),
  content: z.string(),
}).strict();
const pasteHistoryGetOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), revision: revisionResourceSchema }).strict(),
  errorResultSchema,
]);
const pasteSettingsUpdateInputSchema = z.object({
  id: z.string(),
  password: z.string().optional(),
  version: z.string().optional(),
  title: z.string().optional(),
  format: z.enum(["text", "markdown"]).optional(),
  expiration: expirationInputSchema.optional(),
  viewOnce: z.boolean().optional(),
}).strict().refine(
  (input) => input.title !== undefined || input.format !== undefined || input.expiration !== undefined || input.viewOnce !== undefined,
  "Must include at least one setting.",
).meta({
  anyOf: [
    { required: ["title"] },
    { required: ["format"] },
    { required: ["expiration"] },
    { required: ["viewOnce"] },
  ],
});
const pastePasswordUpdateInputSchema = z.object({
  id: z.string(),
  password: z.string().optional(),
  newPassword: z.string(),
  version: z.string().optional(),
}).strict();

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

function toUpdateContentInput(input: z.infer<typeof pasteUpdateInputSchema>): UpdateContentInput {
  const result: UpdateContentInput = { content: input.content };
  if (input.password !== undefined) result.password = input.password;
  if (input.version !== undefined) result.version = input.version;
  return result;
}

function toUpdateSettingsInput(input: z.infer<typeof pasteSettingsUpdateInputSchema>): UpdateSettingsInput {
  const result: UpdateSettingsInput = {};
  if (input.password !== undefined) result.password = input.password;
  if (input.version !== undefined) result.version = input.version;
  if (input.title !== undefined) result.title = input.title;
  if (input.format !== undefined) result.format = input.format;
  if (input.expiration !== undefined) result.expiration = input.expiration;
  if (input.viewOnce !== undefined) result.viewOnce = input.viewOnce;
  return result;
}

function toUpdatePasswordInput(input: z.infer<typeof pastePasswordUpdateInputSchema>): UpdatePasswordInput {
  const result: UpdatePasswordInput = { newPassword: input.newPassword };
  if (input.password !== undefined) result.password = input.password;
  if (input.version !== undefined) result.version = input.version;
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

function defineTool<Input extends z.ZodType, Output extends z.ZodType>(
  inputSchema: Input,
  outputSchema: Output,
  callback: (input: z.infer<Input>) => Promise<ToolResult>,
) {
  return {
    inputSchema,
    outputSchema,
    callback,
    async call(arguments_: unknown): Promise<ToolResult> {
      const input = inputSchema.safeParse(arguments_ === undefined ? {} : arguments_);
      if (!input.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid tool arguments");

      const result = await callback(input.data);
      if (!outputSchema.safeParse(result.structuredContent).success) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid tool result");
      }
      return result;
    },
  };
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

    const pasteCreate = defineTool(pasteCreateInputSchema, pasteCreateOutputSchema, async (input) => {
      try {
        const paste = await service.create(toCreateInput(input), typeof country === "string" ? { country } : {});
        return toolResult({ ok: true, paste });
      } catch (error) {
        if (isPasteError(error)) return pasteErrorResult(error);
        throw error;
      }
    });
    const pasteGet = defineTool(pasteGetInputSchema, pasteGetOutputSchema, async (input) => {
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
    const pasteUpdate = defineTool(pasteUpdateInputSchema, mutationResultSchema, async (input) => {
      try {
        const { changed, paste } = await service.updateContent(input.id, toUpdateContentInput(input));
        return toolResult({ ok: true, changed, paste });
      } catch (error) {
        if (isPasteError(error)) return pasteErrorResult(error);
        throw error;
      }
    });
    const pasteDelete = defineTool(pasteDeleteInputSchema, pasteDeleteOutputSchema, async (input) => {
      try {
        await service.delete(input.id, input.password, input.version);
        return toolResult({ ok: true, id: input.id, deleted: true });
      } catch (error) {
        if (isPasteError(error)) return pasteErrorResult(error);
        throw error;
      }
    });
    const pasteHistoryList = defineTool(pasteHistoryListInputSchema, pasteHistoryListOutputSchema, async (input) => {
      try {
        const history = await service.listHistory(input.id, input.password);
        return toolResult({ ok: true, history });
      } catch (error) {
        if (isPasteError(error)) return pasteErrorResult(error);
        throw error;
      }
    });
    const pasteHistoryGet = defineTool(pasteHistoryGetInputSchema, pasteHistoryGetOutputSchema, async (input) => {
      try {
        const revision = await service.getHistory(input.id, String(input.revision), input.password);
        return toolResult({ ok: true, revision });
      } catch (error) {
        if (isPasteError(error)) return pasteErrorResult(error);
        throw error;
      }
    });
    const pasteSettingsUpdate = defineTool(pasteSettingsUpdateInputSchema, mutationResultSchema, async (input) => {
      try {
        const { changed, paste } = await service.updateSettings(input.id, toUpdateSettingsInput(input));
        return toolResult({ ok: true, changed, paste });
      } catch (error) {
        if (isPasteError(error)) return pasteErrorResult(error);
        throw error;
      }
    });
    const pastePasswordUpdate = defineTool(pastePasswordUpdateInputSchema, mutationResultSchema, async (input) => {
      try {
        const { changed, paste } = await service.updatePassword(input.id, toUpdatePasswordInput(input));
        return toolResult({ ok: true, changed, paste });
      } catch (error) {
        if (isPasteError(error)) return pasteErrorResult(error);
        throw error;
      }
    });

    const pasteCreateRegistration = server.registerTool("paste_create", {
      description: "Create a paste.",
      inputSchema: pasteCreate.inputSchema,
      outputSchema: pasteCreate.outputSchema,
    }, pasteCreate.callback);
    const pasteGetRegistration = server.registerTool("paste_get", {
      description: "Get a paste representation.",
      inputSchema: pasteGet.inputSchema,
      outputSchema: pasteGet.outputSchema,
    }, pasteGet.callback);
    const pasteUpdateRegistration = server.registerTool("paste_update", {
      description: "Update paste content.",
      inputSchema: pasteUpdate.inputSchema,
      outputSchema: pasteUpdate.outputSchema,
    }, pasteUpdate.callback);
    const pasteDeleteRegistration = server.registerTool("paste_delete", {
      description: "Delete a paste.",
      inputSchema: pasteDelete.inputSchema,
      outputSchema: pasteDelete.outputSchema,
    }, pasteDelete.callback);
    const pasteHistoryListRegistration = server.registerTool("paste_history_list", {
      description: "List paste history.",
      inputSchema: pasteHistoryList.inputSchema,
      outputSchema: pasteHistoryList.outputSchema,
    }, pasteHistoryList.callback);
    const pasteHistoryGetRegistration = server.registerTool("paste_history_get", {
      description: "Get a paste history revision.",
      inputSchema: pasteHistoryGet.inputSchema,
      outputSchema: pasteHistoryGet.outputSchema,
    }, pasteHistoryGet.callback);
    const pasteSettingsUpdateRegistration = server.registerTool("paste_settings_update", {
      description: "Update paste settings.",
      inputSchema: pasteSettingsUpdate.inputSchema,
      outputSchema: pasteSettingsUpdate.outputSchema,
    }, pasteSettingsUpdate.callback);
    const pastePasswordUpdateRegistration = server.registerTool("paste_password_update", {
      description: "Update a paste password.",
      inputSchema: pastePasswordUpdate.inputSchema,
      outputSchema: pastePasswordUpdate.outputSchema,
    }, pastePasswordUpdate.callback);
    const tools = new Map([
      ["paste_create", { definition: pasteCreate, registration: pasteCreateRegistration }],
      ["paste_get", { definition: pasteGet, registration: pasteGetRegistration }],
      ["paste_update", { definition: pasteUpdate, registration: pasteUpdateRegistration }],
      ["paste_delete", { definition: pasteDelete, registration: pasteDeleteRegistration }],
      ["paste_history_list", { definition: pasteHistoryList, registration: pasteHistoryListRegistration }],
      ["paste_history_get", { definition: pasteHistoryGet, registration: pasteHistoryGetRegistration }],
      ["paste_settings_update", { definition: pasteSettingsUpdate, registration: pasteSettingsUpdateRegistration }],
      ["paste_password_update", { definition: pastePasswordUpdate, registration: pastePasswordUpdateRegistration }],
    ]);

    server.server.setRequestHandler("tools/call", async (request) => {
      const tool = tools.get(request.params.name);
      if (tool === undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
      if (!tool.registration.enabled) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} disabled`);
      return server.server.projectCallToolResult(
        await tool.definition.call(request.params.arguments),
        tool.registration.outputSchemaJson,
      );
    });

    return server;
  }).fetch(request);
}
