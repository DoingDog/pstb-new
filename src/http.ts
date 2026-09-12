import { Hono } from "hono";
import { decodeUtf8, parseStrictJsonObject, readLimitedBytes } from "./json";
import { PasteService, type CreateInput, type UpdateContentInput } from "./pastes";
import { applicationHeaders, renderCreatePage, type Locale } from "./render";
import { isPasteError, PasteError, type Env } from "./types";

const createFields = new Set(["content", "title", "format", "expiration", "password", "viewOnce", "customId"]);

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
  const parts = request.headers.get("content-type")?.split(";").map((part) => part.trim()) ?? [];
  if (parts[0]?.toLowerCase() === "application/json" && (parts.length === 1 || (parts.length === 2 && /^charset=utf-8$/i.test(parts[1]!)))) {
    return "json";
  }
  if (parts[0]?.toLowerCase() === "multipart/form-data" && parts.length === 2 && /^boundary=.+$/i.test(parts[1]!)) {
    return "multipart";
  }
  throw new PasteError("UNSUPPORTED_MEDIA_TYPE", 415, undefined, { accepted: ["application/json", "multipart/form-data"] });
}

function textMediaType(request: Request): void {
  const parts = request.headers.get("content-type")?.split(";").map((part) => part.trim()) ?? [];
  if (parts[0]?.toLowerCase() !== "text/plain" || (parts.length !== 1 && (parts.length !== 2 || !/^charset=utf-8$/i.test(parts[1]!)))) {
    throw new PasteError("UNSUPPORTED_MEDIA_TYPE", 415, undefined, { accepted: ["text/plain"] });
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
  const match = /^"([^"]*)"$/.exec(value);
  if (match === null) throw new PasteError("AMBIGUOUS_VERSION", 400);
  return match[1]!;
}

async function parseTextContent(request: Request): Promise<string> {
  textMediaType(request);
  return decodeUtf8(await readLimitedBytes(request, 67_108_864));
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
  const value = await parseStrictJsonObject(request, new Set(["content", "password", "version"]));
  if (typeof value.content !== "string") throw validationError("content", "Must be a string.");
  return { content: value.content, ...parseMutationCredentials(value) };
}

async function parseDeleteBody(request: Request): Promise<MutationCredentials> {
  if (request.body === null || request.headers.get("content-length") === "0") return {};
  jsonMediaType(request);
  return parseMutationCredentials(await parseStrictJsonObject(request, new Set(["password", "version"])));
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
  let form: FormData;
  try {
    form = await request.formData();
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

  const input: Record<string, unknown> = { ...values };
  if (Object.hasOwn(values, "expiration")) {
    const value = values.expiration!;
    input.expiration = value === "" ? "permanent" : /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  }
  if (Object.hasOwn(values, "viewOnce")) {
    const value = values.viewOnce!;
    if (value !== "true" && value !== "false") throw validationError("viewOnce", "Must be true or false.");
    input.viewOnce = value === "true";
  }
  return createInput(input);
}

async function parseCreate(request: Request): Promise<CreateInput> {
  return createMediaType(request) === "json"
    ? createInput(await parseStrictJsonObject(request, createFields))
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

function locale(request: Request): Locale {
  return request.headers.get("accept-language")?.split(",", 1)[0]?.trim().toLowerCase().startsWith("zh")
    ? "zh-CN"
    : "en";
}

export function createHttpApp(env: Env): Hono {
  const app = new Hono();

  app.use("*", async (context, next) => {
    await next();
    context.res.headers.set("Cache-Control", "no-store");
  });

  app.onError((error) => errorResponse(isPasteError(error) ? error : new PasteError("INTERNAL_ERROR", 500)));
  app.notFound(() => errorResponse(new PasteError("PASTE_NOT_FOUND", 404)));

  app.get("/", (context) => new Response(renderCreatePage(locale(context.req.raw)), { headers: applicationHeaders() }));
  app.on(["HEAD"], "/", () => new Response(null, { headers: applicationHeaders() }));
  app.options("/", () => new Response(null, { status: 204, headers: { Allow: "GET,HEAD,OPTIONS" } }));
  app.all("/", () => methodNotAllowed("GET,HEAD,OPTIONS"));

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
