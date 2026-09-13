import { Hono } from "hono";
import { parseStrictJsonObject, parseStrictJsonObjectOrEmpty, type StrictJsonParsePolicy } from "./json";
import { PasteService, type CreateInput, type UpdateContentInput } from "./pastes";
import { resolveServerLocale } from "./i18n";
import { applicationHeaders, renderCreatePage, renderErrorPage } from "./render";
import { isPasteError, PasteError, type Env } from "./types";

const createFields = new Set(["content", "title", "format", "expiration", "password", "viewOnce", "customId"]);
const contentBodyLimit = 10_485_760;
const wireBodyLimit = 67_108_864;
const textPlainUtf8 = "text/plain; charset=utf-8";

function createInput(value: Record<string, unknown>): CreateInput {
  const input: CreateInput = { content: value.content as string };
  if ("title" in value) input.title = value.title as string;
  if ("format" in value) input.format = value.format as Exclude<CreateInput["format"], undefined>;
  if ("expiration" in value) input.expiration = value.expiration as Exclude<CreateInput["expiration"], undefined>;
  if ("password" in value) input.password = value.password as string;
  if ("viewOnce" in value) input.viewOnce = value.viewOnce as boolean;
  if ("customId" in value) input.customId = value.customId as string;
  return input;
}

function validationError(field: string, message: string): PasteError {
  return new PasteError("VALIDATION_FAILED", 422, undefined, { fields: [{ field, message }] });
}

function createMediaType(request: Request): "json" | "multipart" {
  const contentType = request.headers.get("content-type")?.trim();
  const parts = contentType?.split(";").map((part) => part.trim()) ?? [];
  if (parts[0]?.toLowerCase() === "application/json" && (parts.length === 1 || (parts.length === 2 && /^charset=utf-8$/i.test(parts[1]!)))) {
    return "json";
  }
  if (/^multipart\/form-data\s*;\s*boundary\s*=\s*(?:[!#$%&'*+\-.^_`|~0-9a-z]+|"(?:[^"\\\r\n]|\\[^\r\n])+")\s*$/i.test(contentType ?? "")) {
    return "multipart";
  }
  throw new PasteError("UNSUPPORTED_MEDIA_TYPE", 415, undefined, { accepted: ["application/json", "multipart/form-data"] });
}

function textMediaType(request: Request): void {
  if (!/^text\/plain\s*;\s*charset\s*=\s*utf-8\s*$/i.test(request.headers.get("content-type")?.trim() ?? "")) {
    throw new PasteError("UNSUPPORTED_MEDIA_TYPE", 415, undefined, { accepted: [textPlainUtf8] });
  }
}

function queryOrHeaderPassword(request: Request): string | undefined {
  const passwords = new URL(request.url).searchParams.getAll("password");
  if (passwords.length > 1) throw new PasteError("AMBIGUOUS_PASSWORD", 400);
  return passwords[0] ?? request.headers.get("x-paste-password") ?? undefined;
}

function ifMatchVersion(request: Request): string | undefined {
  const value = request.headers.get("if-match");
  if (value === null) return undefined;
  const match = /^"([\x21\x23-\x7e\x80-\xff]*)"$/.exec(value);
  if (match === null) throw new PasteError("AMBIGUOUS_VERSION", 400);
  return match[1]!;
}

function badRequest(): PasteError {
  return new PasteError("BAD_REQUEST", 400);
}

function contentTooLarge(): PasteError {
  return new PasteError("CONTENT_TOO_LARGE", 413, undefined, { maxBytes: contentBodyLimit });
}

function requestTooLarge(): PasteError {
  return new PasteError("REQUEST_TOO_LARGE", 413, undefined, { maxBytes: wireBodyLimit });
}

function jsonStringLimitError(field: string): PasteError {
  switch (field) {
    case "content":
      return contentTooLarge();
    case "title":
      return validationError("title", "Must contain at most 200 Unicode scalars.");
    case "format":
      return validationError("format", "Must be text or markdown.");
    case "expiration":
      return validationError("expiration", "Must be permanent, at least 60 seconds, or a timezone-bearing RFC3339 timestamp.");
    case "password":
      return validationError("password", "Must be empty or 1 to 128 visible ASCII characters.");
    case "customId":
      return validationError("id", "Must be 1 to 64 ASCII letters, digits, underscores, or hyphens.");
    case "version":
      return new PasteError("VERSION_CONFLICT", 409);
    case "viewOnce":
      return validationError("viewOnce", "Must be a boolean.");
    case "body":
      return validationError("body", "Unknown field.");
    default:
      return badRequest();
  }
}

const httpJsonPolicy: StrictJsonParsePolicy = {
  maxRetainedCodeUnits: contentBodyLimit + 4_096,
  maxTopLevelKeyCodeUnits: "expiration".length,
  topLevelStringMaxCodeUnits: new Map([
    ["content", contentBodyLimit],
    ["title", 400],
    ["format", "markdown".length],
    ["expiration", 29],
    ["password", 128],
    ["viewOnce", 0],
    ["customId", 64],
    ["version", 53],
  ]),
  onStringLimit: jsonStringLimitError,
  onRetainedLimit: badRequest,
};

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Preserve the boundary error that caused cancellation.
  }
}

async function parseTextContent(request: Request): Promise<string> {
  textMediaType(request);
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && !/^(?:0|[1-9]\d*)$/.test(contentLength)) {
    await cancelBody(request.body);
    throw badRequest();
  }
  if (contentLength !== null && Number(contentLength) > wireBodyLimit) {
    await cancelBody(request.body);
    throw requestTooLarge();
  }
  if (contentLength !== null && Number(contentLength) > contentBodyLimit) {
    await cancelBody(request.body);
    throw contentTooLarge();
  }
  if (request.body === null) return "";

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const reader = request.body.getReader();
  const chunks: string[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > contentBodyLimit - length) throw contentTooLarge();
      length += value.byteLength;
      try {
        chunks.push(decoder.decode(value, { stream: true }));
      } catch {
        throw badRequest();
      }
    }
    try {
      chunks.push(decoder.decode());
    } catch {
      throw badRequest();
    }
    return chunks.join("");
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the boundary error that caused cancellation.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function readMultipartBytes(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const body = request.body;
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && BigInt(contentLength) > BigInt(wireBodyLimit)) {
    try {
      await body?.cancel();
    } catch {
      // Preserve the boundary error that caused cancellation.
    }
    throw requestTooLarge();
  }
  if (body === null) return new Uint8Array();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      if (value.byteLength > wireBodyLimit - length) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the boundary error that caused cancellation.
        }
        throw requestTooLarge();
      }
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type MutationCredentials = { password?: string; version?: string };
type ContentPatch = MutationCredentials & { content: string };

function jsonMediaType(request: Request): void {
  const parts = request.headers.get("content-type")?.split(";").map((part) => part.trim()) ?? [];
  if (parts[0]?.toLowerCase() !== "application/json" || (parts.length !== 1 && (parts.length !== 2 || !/^charset=utf-8$/i.test(parts[1]!)))) {
    throw new PasteError("UNSUPPORTED_MEDIA_TYPE", 415, undefined, { accepted: ["application/json"] });
  }
}

function parseMutationCredentials(value: Record<string, unknown>): MutationCredentials {
  const result: MutationCredentials = {};
  if (Object.hasOwn(value, "password")) {
    if (typeof value.password !== "string") throw validationError("password", "Must be a string.");
    result.password = value.password;
  }
  if (Object.hasOwn(value, "version")) {
    if (typeof value.version !== "string") throw validationError("version", "Must be a string.");
    result.version = value.version;
  }
  return result;
}

async function parseContentPatch(request: Request): Promise<ContentPatch> {
  jsonMediaType(request);
  const value = await parseStrictJsonObject(request, new Set(["content", "password", "version"]), httpJsonPolicy);
  if (typeof value.content !== "string") throw validationError("content", "Must be a string.");
  return { content: value.content, ...parseMutationCredentials(value) };
}

async function parseDeleteBody(request: Request): Promise<MutationCredentials> {
  const value = await parseStrictJsonObjectOrEmpty(
    request,
    new Set(["password", "version"]),
    () => jsonMediaType(request),
    httpJsonPolicy,
  );
  return value === undefined ? {} : parseMutationCredentials(value);
}

function passwordForBodyMutation(request: Request, body: { password?: string }): string | undefined {
  const queryOrHeader = queryOrHeaderPassword(request);
  return body.password ?? queryOrHeader;
}

function mutationVersion(request: Request, body: { version?: string }): string | undefined {
  const headerVersion = ifMatchVersion(request);
  if (body.version !== undefined && headerVersion !== undefined && body.version !== headerVersion) {
    throw new PasteError("AMBIGUOUS_VERSION", 400);
  }
  return body.version ?? headerVersion;
}

function contentUpdateInput(content: string, password: string | undefined, version: string | undefined): UpdateContentInput {
  const input: UpdateContentInput = { content };
  if (password !== undefined) input.password = password;
  if (version !== undefined) input.version = version;
  return input;
}

async function parseMultipartCreate(request: Request): Promise<CreateInput> {
  const bytes = await readMultipartBytes(request);
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "Content-Type": request.headers.get("content-type")! } }).formData();
  } catch {
    throw new PasteError("BAD_REQUEST", 400);
  }

  const values: Record<string, string> = Object.create(null);
  for (const [name, value] of form) {
    if (!createFields.has(name)) throw validationError(name, "Unknown field.");
    if (Object.hasOwn(values, name)) throw validationError(name, "Duplicate field.");
    if (typeof value !== "string") throw validationError(name, "Must be a string.");
    values[name] = value;
  }
  if (!Object.hasOwn(values, "viewOnce")) throw validationError("viewOnce", "Required.");

  const input: Record<string, unknown> = { ...values };
  if (Object.hasOwn(values, "expiration")) {
    const value = values.expiration!;
    input.expiration = value === "" ? "permanent" : /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  }
  const viewOnce = values.viewOnce!;
  if (viewOnce !== "true" && viewOnce !== "false") throw validationError("viewOnce", "Must be true or false.");
  input.viewOnce = viewOnce === "true";
  return createInput(input);
}

async function parseCreate(request: Request): Promise<CreateInput> {
  return createMediaType(request) === "json"
    ? createInput(await parseStrictJsonObject(request, createFields, httpJsonPolicy))
    : parseMultipartCreate(request);
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  if (headers !== undefined) {
    for (const [name, value] of new Headers(headers)) responseHeaders.set(name, value);
  }
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function errorResponse(error: PasteError): Response {
  const body: {
    error: {
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };
  } = { error: { code: error.code, message: error.message } };
  if (error.details !== undefined) body.error.details = error.details;

  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  if (error.status === 503) headers.set("Retry-After", "1");
  return new Response(JSON.stringify(body), { status: error.status, headers });
}

function methodNotAllowed(allow: string): Response {
  const response = errorResponse(new PasteError("BAD_REQUEST", 405));
  response.headers.set("Allow", allow);
  return response;
}

function rootMethodNotAllowed(request: Request): Response {
  const requestLocale = resolveServerLocale(request.headers.get("accept-language"));
  const response = new Response(renderErrorPage({
    locale: requestLocale,
    errorCode: "METHOD_NOT_ALLOWED",
  }), { status: 405, headers: applicationHeaders() });
  response.headers.set("Allow", "GET,HEAD,OPTIONS");
  return response;
}

function pastePathError(request: Request): PasteError | undefined {
  const match = /^\/api\/pastes\/([^/]+)$/.exec(new URL(request.url).pathname);
  if (match === null) return undefined;
  try {
    if (decodeURIComponent(match[1]!).includes("/")) return new PasteError("PASTE_NOT_FOUND", 404);
  } catch {
    return new PasteError("BAD_REQUEST", 400);
  }
  return undefined;
}

export function createHttpApp(env: Env): Hono {
  const app = new Hono();

  app.use("*", async (context, next) => {
    const error = pastePathError(context.req.raw);
    if (error !== undefined) return errorResponse(error);
    await next();
    context.res.headers.set("Cache-Control", "no-store");
  });

  app.onError((error) => errorResponse(isPasteError(error) ? error : new PasteError("INTERNAL_ERROR", 500)));
  app.notFound(() => errorResponse(new PasteError("PASTE_NOT_FOUND", 404)));

  app.on(["GET", "HEAD"], "/", (context) => context.req.raw.method === "HEAD"
    ? new Response(null, { headers: applicationHeaders() })
    : new Response(renderCreatePage(resolveServerLocale(context.req.raw.headers.get("accept-language"))), { headers: applicationHeaders() }));
  app.options("/", () => new Response(null, { status: 204, headers: { Allow: "GET,HEAD,OPTIONS" } }));
  app.all("/", (context) => rootMethodNotAllowed(context.req.raw));

  app.post("/api/pastes", async (context) => {
    const country = context.req.raw.cf?.country;
    const paste = await new PasteService(env.PASTE_DB).create(
      await parseCreate(context.req.raw),
      typeof country === "string" ? { country } : {},
    );
    return jsonResponse(paste, 201, { ETag: `"${paste.version}"`, Location: `/${paste.id}` });
  });
  app.options("/api/pastes", () => new Response(null, { status: 204, headers: { Allow: "POST,OPTIONS" } }));
  app.all("/api/pastes", () => methodNotAllowed("POST,OPTIONS"));

  app.put("/api/pastes/:id", async (context) => {
    const request = context.req.raw;
    const result = await new PasteService(env.PASTE_DB).updateContent(
      context.req.param("id"),
      contentUpdateInput(await parseTextContent(request), queryOrHeaderPassword(request), ifMatchVersion(request)),
    );
    return jsonResponse(result, 200, { ETag: `"${result.paste.version}"` });
  });

  app.patch("/api/pastes/:id", async (context) => {
    const request = context.req.raw;
    const body = await parseContentPatch(request);
    const result = await new PasteService(env.PASTE_DB).updateContent(
      context.req.param("id"),
      contentUpdateInput(body.content, passwordForBodyMutation(request, body), mutationVersion(request, body)),
    );
    return jsonResponse(result, 200, { ETag: `"${result.paste.version}"` });
  });

  app.delete("/api/pastes/:id", async (context) => {
    const request = context.req.raw;
    const body = await parseDeleteBody(request);
    await new PasteService(env.PASTE_DB).delete(
      context.req.param("id"),
      passwordForBodyMutation(request, body),
      mutationVersion(request, body),
    );
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  });
  app.options("/api/pastes/:id", () => new Response(null, { status: 204, headers: { Allow: "PUT,PATCH,DELETE,OPTIONS" } }));
  app.all("/api/pastes/:id", () => methodNotAllowed("PUT,PATCH,DELETE,OPTIONS"));

  return app;
}
