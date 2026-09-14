import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "./http";
import { renderCreatePage, renderMarkdown, renderMarkdownDocument, renderPastePage, renderPasswordPage } from "./render";
import type { Env, MutationResult, PasteResource, PasteSummary } from "./types";

const wireBodyLimit = 67_108_864;

vi.mock("./render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render")>();
  return {
    ...actual,
    renderCreatePage: vi.fn(actual.renderCreatePage),
    renderMarkdown: vi.fn(actual.renderMarkdown),
    renderMarkdownDocument: vi.fn(actual.renderMarkdownDocument),
    renderPastePage: vi.fn(actual.renderPastePage),
    renderPasswordPage: vi.fn(actual.renderPasswordPage),
  };
});

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index");
    }
  }
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`https://paste.test${path}`, init));
}

function localRequest(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(createHttpApp(env as unknown as Env).fetch(new Request(`https://paste.test${path}`, init)));
}

async function createJsonPaste(input: Record<string, unknown>): Promise<PasteSummary> {
  const response = await request("/api/pastes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(201);
  return await response.json() as PasteSummary;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function readBootstrap(html: string): unknown {
  const match = /<script id="bootstrap" type="application\/json">([^<]*)<\/script>/.exec(html);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!);
}

async function deletePaste(id: string): Promise<void> {
  await Promise.all([
    (env as unknown as Env).PASTE_DB.delete(id),
    (env as unknown as Env).PASTE_DB.delete(`__cfpb:meta:${id}`),
    (env as unknown as Env).PASTE_DB.delete(`__cfpb:rev:${id}:0`),
    (env as unknown as Env).PASTE_DB.delete(`__cfpb:rev:${id}:1`),
    (env as unknown as Env).PASTE_DB.delete(`__cfpb:rev:${id}:2`),
  ]);
}

function rawContentTypeRequest(path: string, method: string, contentType: string, body: ReadableStream<Uint8Array> | null = null): Request {
  return {
    body,
    headers: { get: (name: string) => name.toLowerCase() === "content-type" ? contentType : null } as Headers,
    method,
    url: `https://paste.test${path}`,
  } as Request;
}

type HttpMultipartPart = { headers: readonly string[]; body: string | Uint8Array };

function multipartBody(boundary: string, parts: readonly HttpMultipartPart[], close = true): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(encoder.encode(`--${boundary}\r\n`));
    for (const header of part.headers) chunks.push(encoder.encode(`${header}\r\n`));
    chunks.push(encoder.encode("\r\n"));
    chunks.push(typeof part.body === "string" ? encoder.encode(part.body) : part.body);
    chunks.push(encoder.encode("\r\n"));
  }
  if (close) chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function multipartField(name: string, body: string | Uint8Array, extraHeaders: readonly string[] = []): HttpMultipartPart {
  return { headers: [`Content-Disposition: form-data; name="${name}"`, ...extraHeaders], body };
}

function streamBytes(bytes: Uint8Array, chunkBytes: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkBytes, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

function multipartCreateRequest(
  body: Uint8Array | ReadableStream<Uint8Array>,
  contentType: string,
  headers: HeadersInit = {},
): Request {
  return new Request("https://paste.test/api/pastes", {
    method: "POST",
    headers: { "content-type": contentType, ...headers },
    body: body instanceof Uint8Array ? streamBytes(body, body.byteLength) : body,
  });
}

describe("HTTP slice 1", () => {
  it("serves the create page and its exact root method contract", async () => {
    const get = await request("/", { headers: { "accept-language": "zh-CN" } });

    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(get.headers.get("cache-control")).toBe("no-store");
    const getHtml = await get.text();
    expect(readBootstrap(getHtml)).toEqual({ page: "create", locale: "zh-CN" });
    expect(getHtml).toContain('<div id="app"></div>');

    const head = await request("/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(await head.text()).toBe("");

    const options = await request("/", { method: "OPTIONS" });
    expect(options.status).toBe(405);
    expect(options.headers.get("allow")).toBe("GET,HEAD");
    expect(options.headers.get("cache-control")).toBe("no-store");
    expect(readBootstrap(await options.text())).toMatchObject({ page: "error", status: 405 });

    const method = await request("/", { method: "POST", headers: { "accept-language": "zh-CN" } });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET,HEAD");
    expect(method.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(method.headers.get("cache-control")).toBe("no-store");
    expect(method.headers.get("content-security-policy")).toBeTruthy();
    expect(method.headers.get("x-content-type-options")).toBe("nosniff");
    const methodHtml = await method.text();
    expect(readBootstrap(methodHtml)).toEqual({
      page: "error",
      locale: "zh-CN",
      status: 405,
      errorCode: "METHOD_NOT_ALLOWED",
    });
    expect(methodHtml).toContain('<div id="app"></div>');
    expect(methodHtml).not.toContain("请求方法不被允许。请返回创建页面。");
  });

  it("does not render the create page for HEAD", async () => {
    vi.mocked(renderCreatePage).mockClear();

    const response = await createHttpApp(env as unknown as Env).fetch(new Request("https://paste.test/", { method: "HEAD" }));

    expect(response.status).toBe(200);
    expect(renderCreatePage).not.toHaveBeenCalled();
  });

  it("creates a JSON paste in the test KV with clean response headers", async () => {
    const id = `http-${crypto.randomUUID()}`;
    const response = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        content: "exact\r\nsource",
        title: "HTTP title",
        format: "markdown",
        expiration: "permanent",
        password: "secret",
        viewOnce: true,
        customId: id,
      }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(`/${id}`);
    const paste = await response.json() as PasteSummary;
    expect(response.headers.get("etag")).toBe(`"${paste.version}"`);
    expect(paste).toMatchObject({
      id,
      title: "HTTP title",
      format: "markdown",
      expiration: { kind: "permanent" },
      protected: true,
      viewOnce: true,
      contentBytes: 13,
      links: { view: `/${id}` },
    });
    expect(JSON.stringify(paste)).not.toContain("secret");
    await expect((env as unknown as Env).PASTE_DB.get(id)).resolves.toBe("exact\r\nsource");

    await Promise.all([
      (env as unknown as Env).PASTE_DB.delete(id),
      (env as unknown as Env).PASTE_DB.delete(`__cfpb:meta:${id}`),
      (env as unknown as Env).PASTE_DB.delete(`__cfpb:rev:${id}:0`),
      (env as unknown as Env).PASTE_DB.delete(`__cfpb:rev:${id}:1`),
      (env as unknown as Env).PASTE_DB.delete(`__cfpb:rev:${id}:2`),
    ]);
  });

  it("accepts quoted UTF-8 charsets and zero-padded Content-Length on every JSON and text boundary", async () => {
    const id = `http-${crypto.randomUUID()}`;
    const createBody = JSON.stringify({ content: "old", customId: id, expiration: "permanent" });
    const create = await request("/api/pastes", {
      method: "POST",
      headers: {
        "content-type": 'application/json; charset="UTF-8"',
        "content-length": `000${new TextEncoder().encode(createBody).byteLength}`,
      },
      body: createBody,
    });
    expect(create.status).toBe(201);
    const created = await create.json() as PasteSummary;

    try {
      const patchBody = JSON.stringify({ content: "patched", version: created.version });
      const patch = await request(`/api/pastes/${id}`, {
        method: "PATCH",
        headers: {
          "content-type": 'application/json; charset="utf-8"',
          "content-length": `000${new TextEncoder().encode(patchBody).byteLength}`,
        },
        body: patchBody,
      });
      expect(patch.status).toBe(200);

      const put = await request(`/api/pastes/${id}`, {
        method: "PUT",
        headers: { "content-type": 'text/plain; charset="UTF-8"', "content-length": "0003" },
        body: "put",
      });
      expect(put.status).toBe(200);

      const deleted = await request(`/api/pastes/${id}`, {
        method: "DELETE",
        headers: { "content-type": 'application/json; charset="utf-8"', "content-length": "0002" },
        body: "{}",
      });
      expect(deleted.status).toBe(204);
    } finally {
      await deletePaste(id);
    }
  });

  it("cancels an overlong password while parsing streamed create JSON", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(`{"content":"new","password":"${"x".repeat(65_536)}"}`));
      },
      cancel() {
        cancelled = true;
        return Promise.reject(new Error("cancel failed"));
      },
    }, { highWaterMark: 0 });
    const response = await createHttpApp(env as unknown as Env).fetch(new Request("https://paste.test/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { fields: [{ field: "password" }] } },
    });
    expect(cancelled).toBe(true);
  });

  it("preserves create JSON validation before malformed UTF-8 across stream chunks", async () => {
    const app = createHttpApp(env as unknown as Env);
    const body = (chunks: readonly Uint8Array[]) => new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    for (const prefix of ['{"content":0', '{"format":"markdownx']) {
      const encodedPrefix = new TextEncoder().encode(prefix);
      const bytes = new Uint8Array(encodedPrefix.byteLength + 3);
      bytes.set(encodedPrefix);
      bytes.set([0xc3, 0x28, 0x7d], encodedPrefix.byteLength);
      for (const chunks of [[bytes], [bytes.subarray(0, encodedPrefix.byteLength), bytes.subarray(encodedPrefix.byteLength)]]) {
        const response = await app.fetch(new Request("https://paste.test/api/pastes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body(chunks),
        }));
        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "VALIDATION_FAILED" } });
      }
    }
  });

  it("creates a multipart paste with form values normalized at the HTTP boundary", async () => {
    const id = `http-${crypto.randomUUID()}`;
    const form = new FormData();
    form.set("content", "multipart source");
    form.set("title", "Multipart title");
    form.set("format", "text");
    form.set("expiration", "permanent");
    form.set("password", "");
    form.set("viewOnce", "false");
    form.set("customId", id);

    const response = await request("/api/pastes", { method: "POST", body: form });

    expect(response.status).toBe(201);
    const paste = await response.json() as PasteSummary;
    expect(paste).toMatchObject({ id, title: "Multipart title", protected: false, viewOnce: false });
    await expect((env as unknown as Env).PASTE_DB.get(id)).resolves.toBe("multipart source");

    await Promise.all([
      (env as unknown as Env).PASTE_DB.delete(id),
      (env as unknown as Env).PASTE_DB.delete(`__cfpb:meta:${id}`),
      (env as unknown as Env).PASTE_DB.delete(`__cfpb:rev:${id}:0`),
      (env as unknown as Env).PASTE_DB.delete(`__cfpb:rev:${id}:1`),
      (env as unknown as Env).PASTE_DB.delete(`__cfpb:rev:${id}:2`),
    ]);
  });

  it("returns no-store JSON errors for invalid create inputs", async () => {
    const malformed = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"content":',
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("no-store");
    await expect(malformed.json()).resolves.toEqual({
      error: { code: "BAD_REQUEST", message: "The request is malformed." },
    });

    const duplicate = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"content":"first","content":"second"}',
    });
    expect(duplicate.status).toBe(422);
    await expect(duplicate.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { fields: [{ field: "content", message: "Duplicate field." }] } },
    });

    const unsupported = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "content",
    });
    expect(unsupported.status).toBe(415);
    await expect(unsupported.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The media type is not supported.",
        details: { accepted: ["application/json", "multipart/form-data"] },
      },
    });

    const form = new FormData();
    form.append("content", "first");
    form.append("content", "second");
    const duplicateForm = await request("/api/pastes", { method: "POST", body: form });
    expect(duplicateForm.status).toBe(422);
    await expect(duplicateForm.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { fields: [{ field: "content", message: "Duplicate field." }] } },
    });

    const reservedId = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "content", customId: "api" }),
    });
    expect(reservedId.status).toBe(422);
    await expect(reservedId.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { fields: [{ field: "id", message: "Is reserved." }] } },
    });
  });

  it("reports a custom ID collision without writing a replacement", async () => {
    const id = `http-${crypto.randomUUID()}`;
    const create = () => request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "content", customId: id }),
    });

    expect((await create()).status).toBe(201);
    const conflict = await create();
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: {
        code: "ID_CONFLICT",
        message: "That ID is already in use.",
        details: { id },
      },
    });
    await expect((env as unknown as Env).PASTE_DB.get(id)).resolves.toBe("content");

    await Promise.all([
      (env as unknown as Env).PASTE_DB.delete(id),
      (env as unknown as Env).PASTE_DB.delete(`__cfpb:meta:${id}`),
      (env as unknown as Env).PASTE_DB.delete(`__cfpb:rev:${id}:0`),
      (env as unknown as Env).PASTE_DB.delete(`__cfpb:rev:${id}:1`),
      (env as unknown as Env).PASTE_DB.delete(`__cfpb:rev:${id}:2`),
    ]);
  });

  it("keeps unimplemented routes at 404 and exposes only the create method contract", async () => {
    const options = await request("/api/pastes", { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toBe("POST,OPTIONS");
    expect(options.headers.get("cache-control")).toBe("no-store");

    const method = await request("/api/pastes", { method: "GET" });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST,OPTIONS");
    await expect(method.json()).resolves.toEqual({
      error: { code: "BAD_REQUEST", message: "The request is malformed." },
    });

    for (const path of ["/api", "/delete/example", "/raw/example"]) {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      if (path === "/raw/example") {
        expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      } else if (path === "/delete/example") {
        expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(readBootstrap(await response.text())).toMatchObject({ page: "error", status: 404 });
      } else {
        expect(response.headers.get("content-type"), path).toBe("application/json; charset=utf-8");
        await expect(response.json()).resolves.toEqual({
          error: { code: "PASTE_NOT_FOUND", message: "The paste was not found." },
        });
      }
    }
  });

  it("updates content through PUT with query password and If-Match", async () => {
    const id = `http-${crypto.randomUUID()}`;
    const createdResponse = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "old", password: "secret", customId: id, expiration: "permanent" }),
    });
    const created = await createdResponse.json() as PasteSummary;

    const response = await request(`/api/pastes/${id}?password=secret`, {
      method: "PUT",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "if-match": `"${created.version}"`,
      },
      body: "new\r\nsource",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json() as MutationResult;
    expect(response.headers.get("etag")).toBe(`"${result.paste.version}"`);
    expect(result).toMatchObject({ changed: true, paste: { id, contentBytes: 11, protected: true } });
    expect(JSON.stringify(result)).not.toContain("secret");
    await expect((env as unknown as Env).PASTE_DB.get(id)).resolves.toBe("new\r\nsource");

    await deletePaste(id);
  });

  it("updates content through PATCH using the body password before query and header credentials", async () => {
    const id = `http-${crypto.randomUUID()}`;
    const createdResponse = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "old", password: "right", customId: id, expiration: "permanent" }),
    });
    const created = await createdResponse.json() as PasteSummary;

    const response = await request(`/api/pastes/${id}?password=wrong-query`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": `"${created.version}"`,
        "x-paste-password": "wrong-header",
      },
      body: JSON.stringify({ content: "new", password: "right", version: created.version }),
    });

    expect(response.status).toBe(200);
    const result = await response.json() as MutationResult;
    expect(response.headers.get("etag")).toBe(`"${result.paste.version}"`);
    expect(result).toMatchObject({ changed: true, paste: { id, protected: true } });
    await expect((env as unknown as Env).PASTE_DB.get(id)).resolves.toBe("new");

    await deletePaste(id);
  });

  it("treats impossible current-password JSON values as opaque credentials", async () => {
    for (const password of [String.fromCharCode(0x1f), "x".repeat(3_300)]) {
      const protectedId = `http-${crypto.randomUUID()}`;
      const unprotectedId = `http-${crypto.randomUUID()}`;
      const createProtected = await request("/api/pastes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "old", password: "right", customId: protectedId, expiration: "permanent" }),
      });
      const createUnprotected = await request("/api/pastes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "old", customId: unprotectedId, expiration: "permanent" }),
      });
      expect(createProtected.status).toBe(201);
      expect(createUnprotected.status).toBe(201);

      try {
        const patchPayload = JSON.stringify({ content: "new", password });
        expect((await request("/api/pastes/missing", {
          method: "PATCH", headers: { "content-type": "application/json" }, body: patchPayload,
        })).status).toBe(404);
        expect((await request(`/api/pastes/${protectedId}`, {
          method: "PATCH", headers: { "content-type": "application/json" }, body: patchPayload,
        })).status).toBe(403);
        expect((await request(`/api/pastes/${unprotectedId}`, {
          method: "PATCH", headers: { "content-type": "application/json" }, body: patchPayload,
        })).status).toBe(200);

        const deletePayload = JSON.stringify({ password });
        expect((await request("/api/pastes/missing", {
          method: "DELETE", headers: { "content-type": "application/json" }, body: deletePayload,
        })).status).toBe(404);
        expect((await request(`/api/pastes/${protectedId}`, {
          method: "DELETE", headers: { "content-type": "application/json" }, body: deletePayload,
        })).status).toBe(403);
        expect((await request(`/api/pastes/${unprotectedId}`, {
          method: "DELETE", headers: { "content-type": "application/json" }, body: deletePayload,
        })).status).toBe(204);
      } finally {
        await deletePaste(protectedId);
        await deletePaste(unprotectedId);
      }
    }

    for (const password of [String.fromCharCode(0x1f), "x".repeat(3_300)]) {
      const response = await request("/api/pastes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "new", password }),
      });
      expect(response.status).toBe(422);
    }
  });

  it("rejects noncanonical PATCH payloads and version carriers before mutation", async () => {
    const id = `http-${crypto.randomUUID()}`;
    const createdResponse = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "old", customId: id, expiration: "permanent" }),
    });
    const created = await createdResponse.json() as PasteSummary;

    const unknown = await request(`/api/pastes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: '{"content":"new","unknown":true}',
    });
    expect(unknown.status).toBe(422);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    await expect(unknown.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { fields: [{ field: "unknown", message: "Unknown field." }] } },
    });

    const duplicate = await request(`/api/pastes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: '{"content":"new","content":"other"}',
    });
    expect(duplicate.status).toBe(422);
    await expect(duplicate.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { fields: [{ field: "content", message: "Duplicate field." }] } },
    });

    const wrongType = await request(`/api/pastes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: 1 }),
    });
    expect(wrongType.status).toBe(422);
    await expect(wrongType.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { fields: [{ field: "content", message: "Must be a string." }] } },
    });

    const unsupported = await request(`/api/pastes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "text/plain" },
      body: "new",
    });
    expect(unsupported.status).toBe(415);
    await expect(unsupported.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The media type is not supported.",
        details: { accepted: ["application/json"] },
      },
    });

    const ambiguousPassword = await request(`/api/pastes/${id}?password=one&password=two`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "new" }),
    });
    expect(ambiguousPassword.status).toBe(400);
    await expect(ambiguousPassword.json()).resolves.toEqual({
      error: { code: "AMBIGUOUS_PASSWORD", message: "The password is ambiguous." },
    });

    const ambiguousVersion = await request(`/api/pastes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "if-match": `"${created.version}"` },
      body: JSON.stringify({ content: "new", version: "different" }),
    });
    expect(ambiguousVersion.status).toBe(400);
    await expect(ambiguousVersion.json()).resolves.toEqual({
      error: { code: "AMBIGUOUS_VERSION", message: "The version is ambiguous." },
    });

    const invalidIfMatch = await request(`/api/pastes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "if-match": "*" },
      body: JSON.stringify({ content: "new" }),
    });
    expect(invalidIfMatch.status).toBe(400);
    await expect(invalidIfMatch.json()).resolves.toEqual({
      error: { code: "AMBIGUOUS_VERSION", message: "The version is ambiguous." },
    });
    await expect((env as unknown as Env).PASTE_DB.get(id)).resolves.toBe("old");

    await deletePaste(id);
  });

  it("uses best-effort version conflicts and last-write-wins PATCH updates", async () => {
    const id = `http-${crypto.randomUUID()}`;
    const createdResponse = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "old", customId: id, expiration: "permanent" }),
    });
    const created = await createdResponse.json() as PasteSummary;

    const conflict = await request(`/api/pastes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "conflict", version: "stale" }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: {
        code: "VERSION_CONFLICT",
        message: "The paste changed after this page loaded.",
        details: { currentVersion: created.version, updatedAt: created.updatedAt },
      },
    });

    const lww = await request(`/api/pastes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "overwritten" }),
    });
    expect(lww.status).toBe(200);
    const result = await lww.json() as MutationResult;
    expect(result).toMatchObject({ changed: true, paste: { id } });
    expect(lww.headers.get("etag")).toBe(`"${result.paste.version}"`);
    await expect((env as unknown as Env).PASTE_DB.get(id)).resolves.toBe("overwritten");

    await deletePaste(id);
  });

  it("deletes through the canonical route with body credentials and version", async () => {
    const id = `http-${crypto.randomUUID()}`;
    const createdResponse = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "remove me", password: "right", customId: id, expiration: "permanent" }),
    });
    const created = await createdResponse.json() as PasteSummary;

    const response = await request(`/api/pastes/${id}?password=wrong-query`, {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-paste-password": "wrong-header" },
      body: JSON.stringify({ password: "right", version: created.version }),
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    await expect((env as unknown as Env).PASTE_DB.get(id)).resolves.toBeNull();
    await expect((env as unknown as Env).PASTE_DB.get(`__cfpb:meta:${id}`)).resolves.toBeNull();

    const repeated = await request(`/api/pastes/${id}`, { method: "DELETE" });
    expect(repeated.status).toBe(404);
    await expect(repeated.json()).resolves.toEqual({
      error: { code: "PASTE_NOT_FOUND", message: "The paste was not found." },
    });
  });

  it("uses the API method matrix for a paste resource", async () => {
    const options = await request("/api/pastes/example", { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toBe("GET,HEAD,PUT,PATCH,DELETE,OPTIONS");
    expect(options.headers.get("cache-control")).toBe("no-store");
    expect(await options.text()).toBe("");

    const method = await request("/api/pastes/example", { method: "POST" });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET,HEAD,PUT,PATCH,DELETE,OPTIONS");
    expect(method.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(method.headers.get("cache-control")).toBe("no-store");
    await expect(method.json()).resolves.toEqual({
      error: { code: "BAD_REQUEST", message: "The request is malformed." },
    });
  });

  it("requires multipart viewOnce exactly once", async () => {
    const missing = new FormData();
    missing.set("content", "source");
    const missingResponse = await request("/api/pastes", { method: "POST", body: missing });
    expect(missingResponse.status).toBe(422);
    await expect(missingResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { fields: [{ field: "viewOnce" }] } },
    });

    const duplicate = new FormData();
    duplicate.set("content", "source");
    duplicate.append("viewOnce", "true");
    duplicate.append("viewOnce", "false");
    const duplicateResponse = await request("/api/pastes", { method: "POST", body: duplicate });
    expect(duplicateResponse.status).toBe(422);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { fields: [{ field: "viewOnce" }] } },
    });
  });

  it("accepts a quoted multipart boundary containing a semicolon and rejects invalid parameters", async () => {
    const id = `http-${crypto.randomUUID()}`;
    const boundary = "paste;boundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="content"',
      "",
      "multipart source",
      `--${boundary}`,
      'Content-Disposition: form-data; name="viewOnce"',
      "",
      "false",
      `--${boundary}`,
      'Content-Disposition: form-data; name="customId"',
      "",
      id,
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const created = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary="${boundary}"` },
      body,
    });
    expect(created.status).toBe(201);
    await deletePaste(id);

    for (const contentType of [
      "multipart/form-data; boundary",
      "multipart/form-data; boundary=first; boundary=second",
    ]) {
      const response = await request("/api/pastes", {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
      expect(response.status).toBe(415);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "UNSUPPORTED_MEDIA_TYPE", details: { accepted: ["application/json", "multipart/form-data"] } },
      });
    }
  });

  it("streams a quoted-pair multipart boundary one byte at a time without stripping a content BOM", async () => {
    const app = createHttpApp(env as unknown as Env);
    const id = `http-${crypto.randomUUID()}`;
    const boundary = "stream;boundary";
    const body = multipartBody(boundary, [
      multipartField("content", `${String.fromCharCode(0xfeff)}multipart source`),
      multipartField("viewOnce", "false"),
      multipartField("customId", id),
    ]);

    try {
      const response = await app.fetch(multipartCreateRequest(
        streamBytes(body, 1),
        'multipart/form-data; boundary="stream\\;boundary"',
      ));

      expect(response.status).toBe(201);
      await expect((env as unknown as Env).PASTE_DB.get(id)).resolves.toBe(`${String.fromCharCode(0xfeff)}multipart source`);
    } finally {
      await deletePaste(id);
    }
  });

  it("preserves strict multipart parser errors through the create route", async () => {
    const boundary = "strict-errors";
    const cases = [
      {
        name: "fatal malformed UTF-8",
        body: (id: string) => multipartBody(boundary, [
          multipartField("content", Uint8Array.of(0xc3, 0x28)),
          multipartField("viewOnce", "false"),
          multipartField("customId", id),
        ]),
        error: { code: "BAD_REQUEST", status: 400 },
      },
      {
        name: "filename parts",
        body: (id: string) => multipartBody(boundary, [
          { headers: ['Content-Disposition: form-data; name="content"; filename="upload.txt"'], body: "source" },
          multipartField("viewOnce", "false"),
          multipartField("customId", id),
        ]),
        error: { code: "VALIDATION_FAILED", status: 422, details: { fields: [{ field: "content", message: "Must be a string." }] } },
      },
      {
        name: "RFC2231 filename variants",
        body: (id: string) => multipartBody(boundary, [
          { headers: ['Content-Disposition: form-data; name="content"; filename*0*=utf-8\'\'upload.txt'], body: "source" },
          multipartField("viewOnce", "false"),
          multipartField("customId", id),
        ]),
        error: { code: "VALIDATION_FAILED", status: 422, details: { fields: [{ field: "content", message: "Must be a string." }] } },
      },
      {
        name: "case-insensitive duplicate part Content-Type parameters",
        body: (id: string) => multipartBody(boundary, [
          multipartField("content", "source", ["Content-Type: text/plain; charset=utf-8; CHARSET=ascii"]),
          multipartField("viewOnce", "false"),
          multipartField("customId", id),
        ]),
        error: { code: "BAD_REQUEST", status: 400 },
      },
      {
        name: "a malformed closing delimiter",
        body: (id: string) => multipartBody(boundary, [
          multipartField("content", "source"),
          multipartField("viewOnce", "false"),
          multipartField("customId", id),
        ], false),
        error: { code: "BAD_REQUEST", status: 400 },
      },
      {
        name: "LF-only framing",
        body: (id: string) => new TextEncoder().encode(
          new TextDecoder().decode(multipartBody(boundary, [
            multipartField("content", "source"),
            multipartField("viewOnce", "false"),
            multipartField("customId", id),
          ])).replaceAll("\r\n", "\n"),
        ),
        error: { code: "BAD_REQUEST", status: 400 },
      },
    ];

    for (const testCase of cases) {
      const id = `http-${crypto.randomUUID()}`;
      try {
        const response = await createHttpApp(env as unknown as Env).fetch(multipartCreateRequest(
          streamBytes(testCase.body(id), 1),
          `multipart/form-data; boundary=${boundary}`,
        ));

        expect(response.status, testCase.name).toBe(testCase.error.status);
        await expect(response.json()).resolves.toEqual({
          error: {
            code: testCase.error.code,
            message: testCase.error.code === "BAD_REQUEST" ? "The request is malformed." : "One or more fields are invalid.",
            ...(testCase.error.details === undefined ? {} : { details: testCase.error.details }),
          },
        });
      } finally {
        await deletePaste(id);
      }
    }
  });

  it("accepts a declared 64 MiB multipart Content-Length", async () => {
    const boundary = "wire-limit";
    const id = `http-${crypto.randomUUID()}`;
    const exact = multipartBody(boundary, [
      multipartField("content", "source"),
      multipartField("viewOnce", "false"),
      multipartField("customId", id),
    ]);

    try {
      const accepted = await createHttpApp(env as unknown as Env).fetch(multipartCreateRequest(
        exact,
        `multipart/form-data; boundary=${boundary}`,
        { "content-length": String(wireBodyLimit) },
      ));
      expect(accepted.status).toBe(201);
    } finally {
      await deletePaste(id);
    }
  });

  it("accepts exactly 10 MiB multipart content and rejects a split multibyte scalar over it", async () => {
    const boundary = "content-limit";
    const id = `http-${crypto.randomUUID()}`;
    const content = new Uint8Array(10_485_760).fill(0x61);
    const exact = multipartBody(boundary, [
      multipartField("content", content),
      multipartField("viewOnce", "false"),
      multipartField("customId", id),
    ]);

    try {
      const response = await createHttpApp(env as unknown as Env).fetch(multipartCreateRequest(
        streamBytes(exact, 65_537),
        `multipart/form-data; boundary=${boundary}`,
      ));
      expect(response.status).toBe(201);
    } finally {
      await deletePaste(id);
    }

    const split = new Uint8Array(10_485_761);
    split.fill(0x61, 0, 10_485_759);
    split.set([0xc2, 0xa2], 10_485_759);
    const tooLarge = multipartBody(boundary, [
      multipartField("content", split),
      multipartField("viewOnce", "false"),
    ]);
    const contentPrefixLength = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n`).byteLength;
    const response = await createHttpApp(env as unknown as Env).fetch(multipartCreateRequest(
      streamBytes(tooLarge, contentPrefixLength + 10_485_760),
      `multipart/form-data; boundary=${boundary}`,
    ));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "CONTENT_TOO_LARGE",
        message: "The content exceeds the maximum size.",
        details: { maxBytes: 10_485_760 },
      },
    });
  }, 60_000);

  it("accepts Content-Type tokens, quoted-pairs, case, and HTTP OWS", async () => {
    const app = createHttpApp(env as unknown as Env);
    const id = `http-${crypto.randomUUID()}`;
    const boundary = "paste;boundary";
    const body = new TextEncoder().encode([
      `--${boundary}`,
      'Content-Disposition: form-data; name="content"',
      "",
      "multipart source",
      `--${boundary}`,
      'Content-Disposition: form-data; name="viewOnce"',
      "",
      "false",
      `--${boundary}`,
      'Content-Disposition: form-data; name="customId"',
      "",
      id,
      `--${boundary}--`,
      "",
    ].join("\r\n"));
    const multipart = await app.fetch(rawContentTypeRequest(
      "/api/pastes",
      "POST",
      " \tMULTIPART/FORM-DATA \t;\tBOUNDARY \t=\t\"paste\\;boundary\"\t",
      new ReadableStream({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
    ));
    expect(multipart.status).toBe(201);
    await deletePaste(id);

    const cases = [
      ["/api/pastes", "POST", " \tAPPLICATION/JSON\t", [400, 422]],
      ["/api/pastes", "POST", " \tAPPLICATION/JSON \t;\tCHARSET \t=\t\"UTF\\-8\"\t", [400, 422]],
      ["/api/pastes/missing", "PUT", " \tTEXT/PLAIN \t;\tCHARSET \t=\t\"UTF\\-8\"\t", [422]],
    ] as const;

    for (const [path, method, contentType, statuses] of cases) {
      const response = await app.fetch(rawContentTypeRequest(path, method, contentType));
      expect(statuses).toContain(response.status);
    }
  });

  it("rejects invalid Content-Type grammar before pulling request bodies", async () => {
    const app = createHttpApp(env as unknown as Env);
    const nonHttpWhitespace = " ";
    const cases = [
      {
        path: "/api/pastes",
        method: "POST",
        mediaType: "application/json",
        parameter: "charset",
        value: "utf-8",
        wrongValue: "latin1",
        accepted: ["application/json", "multipart/form-data"],
      },
      {
        path: "/api/pastes/missing",
        method: "PUT",
        mediaType: "text/plain",
        parameter: "charset",
        value: "utf-8",
        wrongValue: "latin1",
        accepted: ["text/plain; charset=utf-8"],
      },
      {
        path: "/api/pastes",
        method: "POST",
        mediaType: "multipart/form-data",
        parameter: "boundary",
        value: "paste-boundary",
        wrongValue: "\"\"",
        accepted: ["application/json", "multipart/form-data"],
      },
    ] as const;

    for (const { path, method, mediaType, parameter, value, wrongValue, accepted } of cases) {
      for (const contentType of [
        `${nonHttpWhitespace}${mediaType}; ${parameter}=${value}`,
        `${mediaType}; ${parameter}=${value}${nonHttpWhitespace}`,
        `${mediaType};${nonHttpWhitespace}${parameter}=${value}`,
        `${mediaType}; ${parameter}${nonHttpWhitespace}=${value}`,
        `${mediaType}; ${parameter}="${value}\\`,
        `${mediaType}; ${parameter}="${value}\\"`,
        `${mediaType}; ${parameter}=${value}; ${parameter}=${value}`,
        `${mediaType}; ${parameter}=${value}; extra=value`,
        `${mediaType}; ${parameter}=${wrongValue}`,
      ]) {
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.close();
          },
        }, { highWaterMark: 0 });
        const response = await app.fetch(rawContentTypeRequest(path, method, contentType, body));

        expect(response.status).toBe(415);
        await expect(response.json()).resolves.toEqual({
          error: {
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: "The media type is not supported.",
            details: { accepted },
          },
        });
        expect(pulls).toBe(0);
      }
    }
  });

  it("requires text/plain; charset=utf-8 for PUT and accepts case-insensitive whitespace", async () => {
    const unsupported = await request("/api/pastes/missing", {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "new source",
    });
    expect(unsupported.status).toBe(415);
    await expect(unsupported.json()).resolves.toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE", details: { accepted: ["text/plain; charset=utf-8"] } },
    });

    const id = `http-${crypto.randomUUID()}`;
    const create = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "old", customId: id, expiration: "permanent" }),
    });
    expect(create.status).toBe(201);

    try {
      const response = await request(`/api/pastes/${id}`, {
        method: "PUT",
        headers: { "content-type": "TEXT/PLAIN ; CHARSET = UTF-8" },
        body: "new source",
      });
      expect(response.status).toBe(200);
      await expect((env as unknown as Env).PASTE_DB.get(id)).resolves.toBe("new source");
    } finally {
      await deletePaste(id);
    }
  });

  it("preserves a leading UTF-8 BOM in PUT content", async () => {
    const bom = String.fromCharCode(0xfeff);
    const id = `http-${crypto.randomUUID()}`;
    const created = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "old", customId: id, expiration: "permanent" }),
    });
    expect(created.status).toBe(201);

    try {
      const response = await request(`/api/pastes/${id}`, {
        method: "PUT",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: `${bom}new source`,
      });
      expect(response.status).toBe(200);
      await expect((env as unknown as Env).PASTE_DB.get(id)).resolves.toBe(`${bom}new source`);
    } finally {
      await deletePaste(id);
    }
  });

  it.each([
    ["without a BOM", "x".repeat(10_485_760), 404],
    ["with a BOM", `${String.fromCharCode(0xfeff)}${"x".repeat(10_485_757)}`, 404],
    ["without a BOM plus one byte", "x".repeat(10_485_761), 413],
    ["with a BOM plus one byte", `${String.fromCharCode(0xfeff)}${"x".repeat(10_485_758)}`, 413],
  ])("enforces the 10 MiB PUT limit %s", async (_description, body, status) => {
    const response = await request("/api/pastes/missing", {
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body,
    });

    expect(response.status).toBe(status);
    if (status === 413) {
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "CONTENT_TOO_LARGE", details: { maxBytes: 10_485_760 } },
      });
    }
  }, 10_000);

  it("rejects wildcard, weak, list, space, and control If-Match values", async () => {
    for (const ifMatch of ["*", 'W/"version"', '"one", "two"', '"has space"', '"has\tcontrol"']) {
      const response = await request("/api/pastes/missing", {
        method: "PUT",
        headers: { "content-type": "text/plain; charset=utf-8", "if-match": ifMatch },
        body: "new source",
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { code: "AMBIGUOUS_VERSION", message: "The version is ambiguous." },
      });
    }
  });

  it("rejects malformed encoded IDs and treats encoded slashes as route misses", async () => {
    const requests: RequestInit[] = [
      { method: "PUT", headers: { "content-type": "text/plain; charset=utf-8" }, body: "new source" },
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "new source" }) },
      { method: "DELETE" },
      { method: "OPTIONS" },
      { method: "GET" },
    ];

    for (const init of requests) {
      const response = await request("/api/pastes/%ZZ", init);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { code: "BAD_REQUEST", message: "The request is malformed." },
      });
    }

    for (const init of requests) {
      const response = await request("/api/pastes/a%2Fb", init);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: { code: "PASTE_NOT_FOUND", message: "The paste was not found." },
      });
    }
  });

  it("treats a zero-byte DELETE stream without Content-Length as an omitted body", async () => {
    const id = `http-${crypto.randomUUID()}`;
    const created = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "delete me", customId: id, expiration: "permanent" }),
    });
    expect(created.status).toBe(201);

    try {
      const response = await request(`/api/pastes/${id}`, {
        method: "DELETE",
        body: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      });
      expect(response.status).toBe(204);
    } finally {
      await deletePaste(id);
    }
  });

  it("rejects a known nonempty DELETE media type before the delayed first byte", async () => {
    const storage = { get: vi.fn(), getWithMetadata: vi.fn(), put: vi.fn(), delete: vi.fn() };
    const app = createHttpApp({ PASTE_DB: storage } as unknown as Env);
    let pulls = 0;
    let cancelled = false;
    let releaseFirstByte!: () => void;
    const firstByte = new Promise<void>((resolve) => { releaseFirstByte = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        await firstByte;
        controller.enqueue(Uint8Array.of(0x20));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const responsePromise = app.fetch({
      body,
      headers: {
        get(name: string) {
          if (name.toLowerCase() === "content-length") return "1";
          return name.toLowerCase() === "content-type" ? "application/json " : null;
        },
      } as Headers,
      method: "DELETE",
      url: "https://paste.test/api/pastes/missing",
    } as Request);
    let deadline: ReturnType<typeof setTimeout> | undefined;

    try {
      const response = await Promise.race([
        responsePromise,
        new Promise<Response>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("DELETE waited for its first byte")), 100); }),
      ]);
      expect(response.status).toBe(415);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "UNSUPPORTED_MEDIA_TYPE" } });
      expect(pulls).toBe(0);
      expect(cancelled).toBe(true);
      for (const operation of Object.values(storage)) expect(operation).not.toHaveBeenCalled();
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      releaseFirstByte();
      await responsePromise;
    }
  });

  it("rejects an oversized DELETE Content-Length before the delayed first byte", async () => {
    let pulls = 0;
    let cancelled = false;
    let releaseFirstByte!: () => void;
    const firstByte = new Promise<void>((resolve) => { releaseFirstByte = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        await firstByte;
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        cancelled = true;
        return Promise.reject(new Error("cancel failed"));
      },
    }, { highWaterMark: 0 });
    const responsePromise = createHttpApp(env as unknown as Env).fetch(new Request("https://paste.test/api/pastes/missing", {
      method: "DELETE",
      headers: { "content-length": "67108865" },
      body,
    }));
    let deadline: ReturnType<typeof setTimeout> | undefined;

    try {
      const response = await Promise.race([
        responsePromise,
        new Promise<Response>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("DELETE waited for its first byte")), 100); }),
      ]);
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "REQUEST_TOO_LARGE", details: { maxBytes: 67_108_864 } },
      });
      expect(pulls).toBe(0);
      expect(cancelled).toBe(true);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      releaseFirstByte();
      await responsePromise;
    }
  });

  it("parses a nonempty streaming DELETE JSON body without awaiting a tee branch cancellation", async () => {
    const id = `http-${crypto.randomUUID()}`;
    const createdResponse = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "delete me", customId: id, expiration: "permanent" }),
    });
    const created = await createdResponse.json() as PasteSummary;
    let chunks = 0;
    const clone = vi.spyOn(Request.prototype, "clone");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        if (chunks === 1) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ version: created.version })));
        } else {
          controller.close();
        }
      },
    }, { highWaterMark: 0 });

    try {
      const response = await createHttpApp(env as unknown as Env).fetch(new Request(`https://paste.test/api/pastes/${id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body,
      }));

      expect(response.status).toBe(204);
      expect(chunks).toBe(2);
      expect(clone).not.toHaveBeenCalled();
      await expect((env as unknown as Env).PASTE_DB.get(id)).resolves.toBeNull();
    } finally {
      clone.mockRestore();
      await deletePaste(id);
    }
  }, 1_000);

  it("stops a streaming PUT at the first content byte beyond 10 MiB", async () => {
    const chunk = new Uint8Array(1_048_576).fill(0x61);
    let chunks = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks < 10) {
          chunks += 1;
          controller.enqueue(chunk);
        } else if (chunks === 10) {
          chunks += 1;
          controller.enqueue(Uint8Array.of(0x61));
        }
      },
      cancel() {
        cancelled = true;
        return Promise.reject(new Error("cancel failed"));
      },
    }, { highWaterMark: 0 });
    const response = await createHttpApp(env as unknown as Env).fetch(new Request("https://paste.test/api/pastes/missing", {
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body,
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CONTENT_TOO_LARGE", details: { maxBytes: 10_485_760 } },
    });
    expect(chunks).toBe(11);
    expect(cancelled).toBe(true);
  }, 1_000);

  it("rejects an oversized multipart body from Content-Length before parsing it", async () => {
    const boundary = "paste-boundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="content"',
      "",
      "source",
      `--${boundary}`,
      'Content-Disposition: form-data; name="viewOnce"',
      "",
      "false",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const response = await request("/api/pastes", {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": "67108865",
      },
      body,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "REQUEST_TOO_LARGE", details: { maxBytes: 67_108_864 } },
    });
  });

  it("preserves REQUEST_TOO_LARGE when announced multipart cancellation rejects", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return Promise.reject(new Error("cancel failed"));
      },
    });
    const response = await createHttpApp(env as unknown as Env).fetch(new Request("https://paste.test/api/pastes", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=paste-boundary",
        "content-length": "67108865",
      },
      body,
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "REQUEST_TOO_LARGE", details: { maxBytes: 67_108_864 } },
    });
    expect(cancelled).toBe(true);
  });

  it("preserves malformed multipart before its unknown-length wire limit", async () => {
    let chunks = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks < 64) {
          chunks += 1;
          controller.enqueue(new Uint8Array(1_048_576));
        } else if (chunks === 64) {
          chunks += 1;
          controller.enqueue(new Uint8Array(1));
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await createHttpApp(env as unknown as Env).fetch(new Request("https://paste.test/api/pastes", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=paste-boundary" },
      body,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(cancelled).toBe(true);
  });

  it("preserves malformed multipart when cancellation rejects", async () => {
    let chunks = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks < 64) {
          chunks += 1;
          controller.enqueue(new Uint8Array(1_048_576));
        } else if (chunks === 64) {
          chunks += 1;
          controller.enqueue(new Uint8Array(1));
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
        return Promise.reject(new Error("cancel failed"));
      },
    });
    const response = await createHttpApp(env as unknown as Env).fetch(new Request("https://paste.test/api/pastes", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=paste-boundary" },
      body,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(cancelled).toBe(true);
  });

  it("rejects malformed JSON and text Content-Length values while accepting zero-padded exact limits", async () => {
    for (const contentLength of ["+2", "-2", " 2", "2 ", "2\t"]) {
      const headers = {
        get(name: string) {
          if (name === "content-type") return "application/json";
          return name === "content-length" ? contentLength : null;
        },
      } as Headers;
      const json = await createHttpApp(env as unknown as Env).fetch({
        body: null,
        headers,
        method: "POST",
        url: "https://paste.test/api/pastes",
      } as Request);
      expect(json.status).toBe(400);
      const text = await createHttpApp(env as unknown as Env).fetch({
        body: null,
        headers: {
          get(name: string) {
            if (name === "content-type") return "text/plain; charset=utf-8";
            return name === "content-length" ? contentLength : null;
          },
        } as Headers,
        method: "PUT",
        url: "https://paste.test/api/pastes/missing",
      } as Request);
      expect(text.status).toBe(400);
    }

    const jsonExact = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "00067108864" },
      body: "{}",
    });
    expect(jsonExact.status).toBe(422);
    const jsonOver = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "00067108865" },
      body: "{}",
    });
    expect(jsonOver.status).toBe(413);

    const textExact = await request("/api/pastes/missing", {
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8", "content-length": "00010485760" },
      body: "",
    });
    expect(textExact.status).toBe(422);
    const textOver = await request("/api/pastes/missing", {
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8", "content-length": "00010485761" },
      body: "",
    });
    expect(textOver.status).toBe(413);
  });

  it("rejects every wrong top-level kind before nested JSON descendants are retained", async () => {
    const createCases: Array<[string, unknown, string]> = [
      ["content", { nested: true }, "content"],
      ["title", [], "title"],
      ["format", false, "format"],
      ["expiration", {}, "expiration"],
      ["password", [], "password"],
      ["viewOnce", "true", "viewOnce"],
      ["customId", 1, "id"],
    ];
    for (const [field, invalid, errorField] of createCases) {
      const response = await request("/api/pastes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "source", [field]: invalid }),
      });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "VALIDATION_FAILED", details: { fields: [{ field: errorField }] } },
      });
    }

    for (const [field, invalid] of [["content", []], ["password", 1], ["version", false]] as const) {
      const response = await request("/api/pastes/missing", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "source", [field]: invalid }),
      });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "VALIDATION_FAILED", details: { fields: [{ field }] } },
      });
    }

    for (const [field, invalid] of [["password", {}], ["version", 1]] as const) {
      const response = await request("/api/pastes/missing", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: invalid }),
      });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "VALIDATION_FAILED", details: { fields: [{ field }] } },
      });
    }

    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(`{"password":{${'"nested":['.repeat(1_024)}`));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const nested = await createHttpApp(env as unknown as Env).fetch(new Request("https://paste.test/api/pastes/missing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
    }));
    expect(nested.status).toBe(422);
    expect(cancelled).toBe(true);
  });

  it("defers unknown top-level fields until JSON syntax, UTF-8, and wire limits are checked", async () => {
    for (const source of ['{"unknown"', '{"unknown":', '{"unknown":1', '{"unknown":{', '{"unknown":[', '{"unknown":{"nested":}']) {
      const response = await request("/api/pastes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: source,
      });
      expect(response.status).toBe(400);
    }
    const complete = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"unknown":{"nested":[1]}}',
    });
    expect(complete.status).toBe(422);
    await expect(complete.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { fields: [{ field: "unknown", message: "Unknown field." }] } },
    });
    const invalidUtf8 = await createHttpApp(env as unknown as Env).fetch(new Request("https://paste.test/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0x7b, 0x22, 0x75, 0x6e, 0x6b, 0x6e, 0x6f, 0x77, 0x6e, 0x22, 0x3a, 0xc3, 0x28]),
    }));
    expect(invalidUtf8.status).toBe(400);
  });

  it("defers route-unknown fields ahead of PATCH kind and DELETE content limits", async () => {
    const malformedPatch = await request("/api/pastes/missing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: '{"content":"x","title":{',
    });
    expect(malformedPatch.status).toBe(400);
    await expect(malformedPatch.json()).resolves.toEqual({
      error: { code: "BAD_REQUEST", message: "The request is malformed." },
    });

    const longTitlePatch = await request("/api/pastes/missing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: `{"content":"x","title":"${"x".repeat(401)}"}`,
    });
    expect(longTitlePatch.status).toBe(422);
    await expect(longTitlePatch.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { fields: [{ field: "title", message: "Unknown field." }] } },
    });

    const unknownDelete = await request("/api/pastes/missing", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: `{"content":"${"x".repeat(10_485_761)}"}`,
    });
    expect(unknownDelete.status).toBe(422);
    await expect(unknownDelete.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { fields: [{ field: "content", message: "Unknown field." }] } },
    });

    const longNumberDelete = await request("/api/pastes/missing", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: `{"expiration":1${"0".repeat(64)}}`,
    });
    expect(longNumberDelete.status).toBe(422);
    await expect(longNumberDelete.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { fields: [{ field: "expiration", message: "Unknown field." }] } },
    });
  }, 20_000);

  it("does not synthesize a bare version conflict for a 54-code-unit version", async () => {
    const id = `http-${crypto.randomUUID()}`;
    const created = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "old", password: "right", customId: id, expiration: "permanent" }),
    });
    expect(created.status).toBe(201);
    const version = "v".repeat(54);

    try {
      const missing = await request("/api/pastes/missing", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "new", version }),
      });
      expect(missing.status).toBe(404);
      const wrongPassword = await request(`/api/pastes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "new", password: "wrong", version }),
      });
      expect(wrongPassword.status).toBe(403);
      const correctPassword = await request(`/api/pastes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "new", password: "right", version }),
      });
      expect(correctPassword.status).toBe(409);
      await expect(correctPassword.json()).resolves.toMatchObject({
        error: { code: "VERSION_CONFLICT", details: { currentVersion: expect.any(String), updatedAt: expect.any(String) } },
      });
    } finally {
      await deletePaste(id);
    }
  });

  it("keeps exact max content bounded while long opaque versions preserve mutation precedence", async () => {
    const protectedId = `http-${crypto.randomUUID()}`;
    const unprotectedId = `http-${crypto.randomUUID()}`;
    const protectedCreate = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "old", password: "right", customId: protectedId, expiration: "permanent" }),
    });
    const unprotectedCreate = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "old", customId: unprotectedId, expiration: "permanent" }),
    });
    expect(protectedCreate.status).toBe(201);
    expect(unprotectedCreate.status).toBe(201);

    const content = "x".repeat(10_485_760);
    const version = "x".repeat(3_300);
    const patch = (id: string, password?: string) => request(`/api/pastes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, version, ...(password === undefined ? {} : { password }) }),
    });

    try {
      expect((await patch("missing")).status).toBe(404);
      expect((await patch(unprotectedId)).status).toBe(409);
      expect((await patch(protectedId, "wrong")).status).toBe(403);
      expect((await patch(protectedId, "right")).status).toBe(409);
    } finally {
      await deletePaste(protectedId);
      await deletePaste(unprotectedId);
    }
  }, 40_000);

  it("compares long body versions to If-Match while streaming decoded JSON", async () => {
    const id = `http-${crypto.randomUUID()}`;
    const created = await request("/api/pastes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "old", customId: id, expiration: "permanent" }),
    });
    expect(created.status).toBe(201);

    const value = "a".repeat(3_300);
    try {
      const equal = await request(`/api/pastes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "if-match": `"${value}"` },
        body: JSON.stringify({ content: "new", version: value }),
      });
      expect(equal.status).toBe(409);

      const escaped = await request(`/api/pastes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "if-match": '"legacy"' },
        body: '{"content":"new","version":"\\u006c\\u0065\\u0067\\u0061\\u0063\\u0079"}',
      });
      expect(escaped.status).toBe(409);

      for (const bodyVersion of [`b${value.slice(1)}`, `${value.slice(0, -1)}b`]) {
        const response = await request(`/api/pastes/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", "if-match": `"${value}"` },
          body: JSON.stringify({ content: "new", version: bodyVersion }),
        });
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "AMBIGUOUS_VERSION" } });
      }

      const malformedTail = await request(`/api/pastes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "if-match": `"${value}"` },
        body: `{"content":"new","version":"${value}" trailing`,
      });
      expect(malformedTail.status).toBe(400);
      await expect(malformedTail.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });

      const malformedHeader = await request(`/api/pastes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "if-match": "*" },
        body: '{"content":',
      });
      expect(malformedHeader.status).toBe(400);
      await expect(malformedHeader.json()).resolves.toMatchObject({ error: { code: "AMBIGUOUS_VERSION" } });
    } finally {
      await deletePaste(id);
    }
  });

  it("returns the content scalar validation before size for a large escaped-surrogate PATCH stream", async () => {
    const repetitions = 10_485_761;
    const contentLength = new TextEncoder().encode('{"content":"').byteLength + repetitions * "\\uD800".length + 2;
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode('{"content":"\\uD800\\uD800'));
      },
      cancel() {
        cancelled = true;
        return Promise.reject(new Error("cancel failed"));
      },
    }, { highWaterMark: 0 });
    const response = await createHttpApp(env as unknown as Env).fetch(new Request("https://paste.test/api/pastes/missing", {
      method: "PATCH",
      headers: { "content-type": "application/json", "content-length": String(contentLength) },
      body,
    }));

    expect(contentLength).toBeLessThanOrEqual(wireBodyLimit);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { fields: [{ field: "content", message: "Must contain only Unicode scalar values." }] } },
    });
    expect(pulls).toBe(1);
    expect(cancelled).toBe(true);
  });

  it("proves malformed UTF-8 in a PUT chunk before reporting its content size", async () => {
    const bytes = new Uint8Array(10_485_762).fill(0x61);
    bytes[bytes.length - 2] = 0xc3;
    bytes[bytes.length - 1] = 0x28;
    const response = await createHttpApp(env as unknown as Env).fetch(new Request("https://paste.test/api/pastes/missing", {
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: bytes,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("flushes pending UTF-8 before reporting a streamed PUT over its content limit", async () => {
    const content = new Uint8Array(10_485_760).fill(0x61);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(content);
        } else {
          controller.enqueue(Uint8Array.of(0xc3));
          controller.close();
        }
      },
    }, { highWaterMark: 0 });
    const response = await createHttpApp(env as unknown as Env).fetch(new Request("https://paste.test/api/pastes/missing", {
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "BAD_REQUEST", message: "The request is malformed." },
    });
    expect(pulls).toBe(2);
  }, 20_000);

  it("accepts multi-megabyte legal expiration number spellings", async () => {
    const ids: string[] = [];
    try {
      for (const expiration of [
        `60.${"0".repeat(2 * 1024 * 1024)}`,
        `6e${"0".repeat(2 * 1024 * 1024)}1`,
      ]) {
        const id = `http-${crypto.randomUUID()}`;
        ids.push(id);
        const response = await request("/api/pastes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `{"content":"source","customId":"${id}","expiration":${expiration}}`,
        });
        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toMatchObject({ expiration: { kind: "relative", seconds: 60 } });
      }
    } finally {
      await Promise.all(ids.map(deletePaste));
    }
  }, 20_000);

  it("uses the rounded binary64 value for expiration domain validation", async () => {
    const ids: string[] = [];
    try {
      for (const expiration of [
        "59.999999999999999999999999999999999999999999999999999999999999999999999999",
        "60.000000000000003552713678800500929355621337890625",
      ]) {
        const id = `http-${crypto.randomUUID()}`;
        ids.push(id);
        const response = await request("/api/pastes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `{"content":"source","customId":"${id}","expiration":${expiration}}`,
        });
        expect(response.status).toBe(201);
      }
      for (const expiration of [
        "59.99999999999999",
        "60.0000000000000035527136788005009293556213378906251",
        `60.000000000000003552713678800500929355621337890625${"0".repeat(2 * 1024 * 1024)}1`,
        "9007199254740992",
        "253402300800",
        "1e100000",
        "1e-100000",
        "-0",
      ]) {
        const response = await request("/api/pastes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `{"content":"source","expiration":${expiration}}`,
        });
        expect(response.status).toBe(422);
      }
    } finally {
      await Promise.all(ids.map(deletePaste));
    }
  });

  it("accepts normal numeric expiration spellings and rejects malformed or extra charset parameters", async () => {
    const ids: string[] = [];
    try {
      for (const expiration of ["60", "6e1", "60.0"]) {
        const id = `http-${crypto.randomUUID()}`;
        ids.push(id);
        const response = await request("/api/pastes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `{"content":"source","customId":"${id}","expiration":${expiration}}`,
        });
        expect(response.status).toBe(201);
      }
      const pathological = await request("/api/pastes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"content":"source","expiration":1${"0".repeat(64)}}`,
      });
      expect(pathological.status).toBe(422);
      await expect(pathological.json()).resolves.toMatchObject({
        error: { code: "VALIDATION_FAILED", details: { fields: [{ field: "expiration" }] } },
      });
      for (const contentType of [
        "application/json; charset=latin1",
        'application/json; charset="utf-8\\"',
        'application/json; charset="utf-8"; charset=utf-8',
        "application/json; charset=utf-8; boundary=x",
      ]) {
        const response = await request("/api/pastes", {
          method: "POST",
          headers: { "content-type": contentType },
          body: '{"content":"source"}',
        });
        expect(response.status).toBe(415);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "UNSUPPORTED_MEDIA_TYPE", details: { accepted: ["application/json", "multipart/form-data"] } },
        });
      }
      for (const contentType of [
        "text/plain; charset=latin1",
        'text/plain; charset="utf-8\\"',
        'text/plain; charset="utf-8"; charset=utf-8',
      ]) {
        const response = await request("/api/pastes/missing", {
          method: "PUT",
          headers: { "content-type": contentType },
          body: "source",
        });
        expect(response.status).toBe(415);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "UNSUPPORTED_MEDIA_TYPE", details: { accepted: ["text/plain; charset=utf-8"] } },
        });
      }
    } finally {
      await Promise.all(ids.map((id) => deletePaste(id)));
    }
  });

  describe("strong conditional validator", () => {
    it("uses exact PasteResource bytes as the strong conditional validator", async () => {
      const paste = await createJsonPaste({ content: "etag\r\n🙂", expiration: "permanent" });
      try {
        const first = await request(`/api/pastes/${paste.id}`);
        expect(first.status).toBe(200);
        const bytes = new Uint8Array(await first.clone().arrayBuffer());
        const expected: PasteResource = {
          id: paste.id,
          title: paste.title,
          format: paste.format,
          viewOnce: paste.viewOnce,
          protected: paste.protected,
          createdAt: paste.createdAt,
          updatedAt: paste.updatedAt,
          expiresAt: paste.expiresAt,
          expiration: paste.expiration.kind === "relative"
            ? { kind: "relative", seconds: paste.expiration.seconds }
            : { kind: paste.expiration.kind },
          version: paste.version,
          contentRevision: paste.contentRevision,
          contentBytes: paste.contentBytes,
          createdCountry: paste.createdCountry,
          links: {
            view: paste.links.view,
            raw: paste.links.raw,
            html: paste.links.html,
            markdown: paste.links.markdown,
            file: paste.links.file,
          },
          content: "etag\r\n🙂",
        };
        const expectedBytes = new TextEncoder().encode(JSON.stringify(expected));
        expect(bytes).toEqual(expectedBytes);
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        const etag = `"sha256-${base64Url(digest)}"`;
        expect(first.headers.get("etag")).toBe(etag);
        expect(await first.json()).toEqual(expected);

        for (const validator of [etag, `W/${etag}`, `"other", W/${etag}`, "*"]) {
          const response = await request(`/api/pastes/${paste.id}`, { headers: { "if-none-match": validator } });
          expect(response.status).toBe(304);
          expect(response.headers.get("etag")).toBe(etag);
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(response.headers.has("content-type")).toBe(false);
          expect(response.headers.has("content-length")).toBe(false);
          expect(await response.arrayBuffer()).toHaveProperty("byteLength", 0);
        }

        const headMatch = await request(`/api/pastes/${paste.id}`, {
          method: "HEAD",
          headers: { "if-none-match": etag },
        });
        expect(headMatch.status).toBe(304);
        expect(await headMatch.arrayBuffer()).toHaveProperty("byteLength", 0);
        const headMiss = await request(`/api/pastes/${paste.id}`, {
          method: "HEAD",
          headers: { "if-none-match": '"not-the-current-tag"' },
        });
        expect(headMiss.status).toBe(200);
        expect(headMiss.headers.get("etag")).toBe(etag);
        expect(await headMiss.arrayBuffer()).toHaveProperty("byteLength", 0);
      } finally {
        await deletePaste(paste.id);
      }
    });

    it.each(['*, "tag"', '"a",', ',"a"', 'W/"unterminated', '"bad space"'])(
      "reports BAD_REQUEST for malformed ordinary validator %s after authorization",
      async (ifNoneMatch) => {
        const paste = await createJsonPaste({ content: "protected", password: "right", expiration: "permanent" });
        try {
          const response = await request(`/api/pastes/${paste.id}?password=right`, { headers: { "if-none-match": ifNoneMatch } });
          expect(response.status).toBe(400);
          await expect(response.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
        } finally {
          await deletePaste(paste.id);
        }
      },
    );

    it("parses a literal backslash entity tag as a legal nonmatch", async () => {
      const paste = await createJsonPaste({ content: "backslash", expiration: "permanent" });
      try {
        const response = await request(`/api/pastes/${paste.id}`, { headers: { "if-none-match": '"not\\tag"' } });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ id: paste.id, content: "backslash" });
      } finally {
        await deletePaste(paste.id);
      }
    });

    it.each(['*, "tag"', '"a",', ',"a"', 'W/"unterminated', '"bad space"'])(
      "ignores malformed validator %s while consuming a view-once GET",
      async (ifNoneMatch) => {
        const paste = await createJsonPaste({ content: "view once", viewOnce: true, expiration: "permanent" });
        try {
          const response = await request(`/api/pastes/${paste.id}`, { headers: { "if-none-match": ifNoneMatch } });
          expect(response.status).toBe(200);
          await expect(response.json()).resolves.toMatchObject({ id: paste.id, content: "view once" });
          expect((await request(`/api/pastes/${paste.id}`)).status).toBe(404);
        } finally {
          await deletePaste(paste.id);
        }
      },
    );

    it("keeps view-once HEAD validator-blind without consumption", async () => {
      const paste = await createJsonPaste({ content: "view once", viewOnce: true, expiration: "permanent" });
      try {
        const initialHead = await request(`/api/pastes/${paste.id}`, { method: "HEAD" });
        const etag = initialHead.headers.get("etag");
        expect(initialHead.status).toBe(200);
        expect(etag).toMatch(/^"sha256-[A-Za-z0-9_-]{43}"$/u);
        expect(await initialHead.arrayBuffer()).toHaveProperty("byteLength", 0);
        for (const ifNoneMatch of [etag!, '"bad space"']) {
          const response = await request(`/api/pastes/${paste.id}`, {
            method: "HEAD",
            headers: { "if-none-match": ifNoneMatch },
          });
          expect(response.status).toBe(200);
          expect(response.headers.get("etag")).toBe(etag);
          expect(await response.arrayBuffer()).toHaveProperty("byteLength", 0);
        }
        const get = await request(`/api/pastes/${paste.id}`, { headers: { "if-none-match": "*" } });
        expect(get.status).toBe(200);
        await expect(get.json()).resolves.toMatchObject({ id: paste.id, content: "view once" });
        expect((await request(`/api/pastes/${paste.id}`)).status).toBe(404);
      } finally {
        await deletePaste(paste.id);
      }
    });
  });

  describe("browser route matrix", () => {
    const representationRows = [
      ["raw", "text/plain; charset=utf-8"],
      ["html", "text/html; charset=utf-8"],
      ["md", "text/html; charset=utf-8"],
      ["file", "application/octet-stream"],
    ] as const;

    it.each(representationRows)("serves %s GET and non-consuming HEAD", async (route, mediaType) => {
      const paste = await createJsonPaste({ content: "exact\r\n<body>🙂</body>", expiration: "permanent" });
      try {
        const head = await request(`/${route}/${paste.id}`, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.headers.get("content-type")).toBe(mediaType);
        expect(await head.text()).toBe("");
        const get = await request(`/${route}/${paste.id}`);
        expect(get.status).toBe(200);
      } finally {
        await deletePaste(paste.id);
      }
    });

    it("does not render browser or markdown bodies for HEAD", async () => {
      const paste = await createJsonPaste({ content: "# source", format: "markdown", expiration: "permanent" });
      try {
        vi.mocked(renderPastePage).mockClear();
        vi.mocked(renderMarkdownDocument).mockClear();
        vi.mocked(renderMarkdown).mockClear();
        for (const path of [`/${paste.id}`, `/md/${paste.id}`]) {
          const response = await localRequest(path, { method: "HEAD" });
          expect(response.status, path).toBe(200);
          expect(await response.text()).toBe("");
        }
        expect(renderPastePage).not.toHaveBeenCalled();
        expect(renderMarkdownDocument).not.toHaveBeenCalled();
        expect(renderMarkdown).not.toHaveBeenCalled();
      } finally {
        await deletePaste(paste.id);
      }
    });

    it("serves the browser page and password bootstrap", async () => {
      const publicPaste = await createJsonPaste({ content: "browser source", expiration: "permanent" });
      const protectedPaste = await createJsonPaste({ content: "protected source", password: "right", expiration: "permanent" });
      try {
        const page = await request(`/${publicPaste.id}`);
        expect(page.status).toBe(200);
        expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(readBootstrap(await page.text())).toMatchObject({ page: "paste", consumed: false, paste: { id: publicPaste.id } });

        for (const path of [`/${protectedPaste.id}`, `/raw/${protectedPaste.id}`, `/html/${protectedPaste.id}`, `/md/${protectedPaste.id}`, `/file/${protectedPaste.id}`]) {
          const response = await request(path);
          expect(response.status, path).toBe(path === `/${protectedPaste.id}` ? 200 : 403);
          if (path === `/${protectedPaste.id}`) {
            expect(readBootstrap(await response.text())).toEqual({ page: "password", locale: "en", errorCode: null });
            const wrong = await localRequest(`${path}?password=wrong`);
            expect(wrong.status).toBe(403);
            expect(readBootstrap(await wrong.text())).toEqual({ page: "password", locale: "en", errorCode: "FORBIDDEN" });
          }
        }
      } finally {
        await deletePaste(publicPaste.id);
        await deletePaste(protectedPaste.id);
      }
    });

    it("keeps direct representations exact", async () => {
      const paste = await createJsonPaste({
        content: "exact\r\n<body>🙂</body>",
        title: "Résumé.txt",
        format: "markdown",
        expiration: "permanent",
      });
      try {
        const raw = await request(`/raw/${paste.id}`);
        expect(await raw.text()).toBe("exact\r\n<body>🙂</body>");
        expect(raw.headers.has("content-security-policy")).toBe(false);
        expect(raw.headers.has("x-content-type-options")).toBe(false);
        expect(raw.headers.has("referrer-policy")).toBe(false);

        const html = await request(`/html/${paste.id}`);
        expect(await html.text()).toBe("exact\r\n<body>🙂</body>");
        expect(html.headers.has("content-security-policy")).toBe(false);
        expect(html.headers.has("x-content-type-options")).toBe(false);
        expect(html.headers.has("referrer-policy")).toBe(false);

        const markdown = await request(`/md/${paste.id}`);
        const markdownBody = await markdown.text();
        expect(markdown.headers.get("content-security-policy")).toBeTruthy();
        expect(markdownBody.match(/id="bootstrap"/g)).toHaveLength(1);
        expect(markdownBody.match(/id="source-data"/g)).toHaveLength(1);
        expect(markdownBody.match(/id="initial-markdown-preview"/g)).toHaveLength(1);

        const file = await request(`/file/${paste.id}`);
        expect(await file.text()).toBe("exact\r\n<body>🙂</body>");
        expect(file.headers.get("content-disposition")).toBe(`attachment; filename="paste-${paste.id}.txt"; filename*=UTF-8''R%C3%A9sum%C3%A9.txt`);
      } finally {
        await deletePaste(paste.id);
      }
    });

    it("rejects ambiguous direct credentials before rendering", async () => {
      const publicPaste = await createJsonPaste({ content: "public", expiration: "permanent" });
      const protectedPaste = await createJsonPaste({ content: "private", password: "right", expiration: "permanent" });
      try {
        for (const path of [`/${publicPaste.id}`, `/raw/${publicPaste.id}`, `/html/${publicPaste.id}`, `/md/${publicPaste.id}`, `/file/${publicPaste.id}`, `/${protectedPaste.id}`, `/raw/${protectedPaste.id}`, `/html/${protectedPaste.id}`, `/md/${protectedPaste.id}`, `/file/${protectedPaste.id}`]) {
          const response = await localRequest(`${path}?password=one&password=two`);
          expect(response.status, path).toBe(400);
        }
      } finally {
        await deletePaste(publicPaste.id);
        await deletePaste(protectedPaste.id);
      }
    });

    it("does not authorize direct routes with headers", async () => {
      const paste = await createJsonPaste({ content: "private", password: "right", expiration: "permanent" });
      try {
        for (const path of [`/raw/${paste.id}`, `/html/${paste.id}`, `/md/${paste.id}`, `/file/${paste.id}`]) {
          expect((await request(path, { headers: { "x-paste-password": "right" } })).status, path).toBe(403);
          expect((await request(`${path}?password=right`)).status, path).toBe(200);
        }
      } finally {
        await deletePaste(paste.id);
      }
    });

    it("uses password form fields to authorize without consuming", async () => {
      const paste = await createJsonPaste({ content: "private", password: "a+b %&#?", viewOnce: true, expiration: "permanent" });
      try {
        const form = (body: string, contentType = "application/x-www-form-urlencoded") => localRequest(`/${paste.id}`, {
          method: "POST",
          headers: { "content-type": contentType },
          body,
        });
        expect((await form("")).status).toBe(403);
        expect((await form("password=")).status).toBe(403);
        expect((await form(new URLSearchParams({ password: "wrong" }).toString())).status).toBe(403);
        expect((await form("password=right&password=right")).status).toBe(422);
        expect((await form("unknown=value")).status).toBe(422);
        expect((await form("password=right", "application/json")).status).toBe(415);

        const encoded = new URLSearchParams({ password: "a+b %&#?" }).toString();
        const authorized = await form(encoded);
        expect(authorized.status, encoded).toBe(302);
        expect(authorized.headers.get("location")).toBe(`/${paste.id}?password=a%2Bb+%25%26%23%3F`);
        await expect((env as unknown as Env).PASTE_DB.get(paste.id)).resolves.toBe("private");
        expect((await request(`/${paste.id}?password=a%2Bb+%25%26%23%3F`)).status).toBe(200);
      } finally {
        await deletePaste(paste.id);
      }
    });

    it("uses browser and direct method matrices before storage", async () => {
      const database = (env as unknown as Env).PASTE_DB;
      const get = vi.spyOn(database, "get");
      const getWithMetadata = vi.spyOn(database, "getWithMetadata");
      const erase = vi.spyOn(database, "delete");
      try {
        for (const [path, allow] of [["/", "GET,HEAD"], ["/matrix", "GET,HEAD,POST"], ["/raw/matrix", "GET,HEAD"], ["/html/matrix", "GET,HEAD"], ["/md/matrix", "GET,HEAD"], ["/file/matrix", "GET,HEAD"]] as const) {
          get.mockClear();
          getWithMetadata.mockClear();
          erase.mockClear();
          const response = await request(path, { method: "OPTIONS" });
          expect(response.status, path).toBe(405);
          expect(response.headers.get("allow"), path).toBe(allow);
          expect(get, path).not.toHaveBeenCalled();
          expect(getWithMetadata, path).not.toHaveBeenCalled();
          expect(erase, path).not.toHaveBeenCalled();
        }
      } finally {
        get.mockRestore();
        getWithMetadata.mockRestore();
        erase.mockRestore();
      }
    });
  });

  describe("view-once order", () => {
    it("prepares browser view-once bodies before deleting all keys", async () => {
      const paste = await createJsonPaste({ content: "prepared", viewOnce: true, expiration: "permanent" });
      const database = (env as unknown as Env).PASTE_DB;
      const originalDelete = database.delete.bind(database);
      const events: string[] = [];
      vi.mocked(renderPastePage).mockImplementationOnce(() => {
        events.push("body-prepared");
        return "prepared body";
      });
      const erase = vi.spyOn(database, "delete").mockImplementation(async (key) => {
        if (key === paste.id) events.push("delete-main");
        else if (key === `__cfpb:meta:${paste.id}`) events.push("delete-meta");
        else if (key.startsWith(`__cfpb:rev:${paste.id}:`)) events.push(`delete-revision-${key.slice(-1)}`);
        return originalDelete(key);
      });
      try {
        const response = await localRequest(`/${paste.id}`);
        events.push("response-observed");
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("prepared body");
        expect(events[0]).toBe("body-prepared");
        const main = events.indexOf("delete-main");
        const meta = events.indexOf("delete-meta");
        const responseObserved = events.indexOf("response-observed");
        expect(main).toBeGreaterThanOrEqual(0);
        expect(meta).toBeGreaterThan(main);
        const revisionEvents = events.slice(main + 1, meta);
        expect(revisionEvents).toHaveLength(3);
        expect(new Set(revisionEvents)).toEqual(new Set(["delete-revision-0", "delete-revision-1", "delete-revision-2"]));
        expect(responseObserved).toBeGreaterThan(meta);
      } finally {
        vi.mocked(renderPastePage).mockClear();
        erase.mockRestore();
        await deletePaste(paste.id);
      }
    });

    it("does not consume a view-once paste when direct rendering fails", async () => {
      const paste = await createJsonPaste({ content: "# source", format: "markdown", viewOnce: true, expiration: "permanent" });
      const database = (env as unknown as Env).PASTE_DB;
      await Promise.all([0, 1, 2].map((slot) => database.put(`__cfpb:rev:${paste.id}:${slot}`, "sentinel")));
      vi.mocked(renderMarkdownDocument).mockImplementationOnce(() => { throw new Error("render failed"); });
      try {
        const response = await localRequest(`/md/${paste.id}`);
        expect(response.status).toBe(500);
        for (const key of [paste.id, `__cfpb:meta:${paste.id}`, `__cfpb:rev:${paste.id}:0`, `__cfpb:rev:${paste.id}:1`, `__cfpb:rev:${paste.id}:2`]) {
          await expect((env as unknown as Env).PASTE_DB.get(key)).resolves.not.toBeNull();
        }
      } finally {
        vi.mocked(renderMarkdownDocument).mockClear();
        await deletePaste(paste.id);
      }
    });

    it("returns CONSUME_FAILED without source when a direct delete fails", async () => {
      const paste = await createJsonPaste({ content: "source", viewOnce: true, expiration: "permanent" });
      const database = (env as unknown as Env).PASTE_DB;
      const originalDelete = database.delete.bind(database);
      const erase = vi.spyOn(database, "delete").mockImplementation(async (key) => {
        if (key === paste.id) throw new Error("delete failed");
        return originalDelete(key);
      });
      try {
        const response = await request(`/raw/${paste.id}`);
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("1");
        const error = await response.text();
        expect(error).not.toContain("source");
        expect(error).toContain("view-once paste could not be consumed");
      } finally {
        erase.mockRestore();
        await deletePaste(paste.id);
      }
    });
  });

  describe("ip-trace", () => {
    it.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("reflects %s exactly", async (method) => {
      const response = await request("/ip-trace?query=exact", {
        method,
        headers: { authorization: "Bearer value", cookie: "name=value", "x-exact": "header" },
        ...(method === "GET" || method === "HEAD" ? {} : { body: "exact body" }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-headers")).toBe("*");
      expect(response.headers.get("access-control-allow-methods")).toBe("GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      if (method === "HEAD") {
        expect(await response.text()).toBe("");
      } else {
        await expect(response.json()).resolves.toMatchObject({
          url: "https://paste.test/ip-trace?query=exact",
          method,
          data: method === "GET" ? "" : "exact body",
          headers: expect.objectContaining({ authorization: "Bearer value", cookie: "name=value", "x-exact": "header" }),
        });
      }
    });
  });

  describe("method and header matrix", () => {
    it("rejects malformed nested API paths before dispatch and direct malformed paths", async () => {
      const database = (env as unknown as Env).PASTE_DB;
      const get = vi.spyOn(database, "get");
      const getWithMetadata = vi.spyOn(database, "getWithMetadata");
      const erase = vi.spyOn(database, "delete");
      const apiTemplates = [
        "/api/pastes/%ZZ/settings",
        "/api/pastes/%ZZ/password",
        "/api/pastes/%ZZ/history",
        "/api/pastes/%ZZ/history/1",
        "/api/pastes/%ZZ/read",
      ];
      for (const path of [...apiTemplates, "/%ZZ", "/raw/%ZZ", "/html/%ZZ", "/md/%ZZ", "/file/%ZZ"]) {
        for (const method of ["GET", "OPTIONS"] as const) {
          get.mockClear();
          getWithMetadata.mockClear();
          erase.mockClear();
          const response = await localRequest(path, { method });
          expect(response.status, `${method} ${path}`).toBe(400);
          const mediaType = path.startsWith("/api/")
            ? "application/json; charset=utf-8"
            : path.startsWith("/raw/") || path.startsWith("/html/") || path.startsWith("/md/") || path.startsWith("/file/")
              ? "text/plain; charset=utf-8"
              : "text/html; charset=utf-8";
          expect(response.headers.get("content-type"), path).toBe(mediaType);
          expect(get).not.toHaveBeenCalled();
          expect(getWithMetadata).not.toHaveBeenCalled();
          expect(erase).not.toHaveBeenCalled();
        }
      }
      for (const path of [
        "/api/pastes/a%2Fb/settings",
        "/api/pastes/a%2Fb/password",
        "/api/pastes/a%2Fb/history",
        "/api/pastes/a%2Fb/history/1",
        "/api/pastes/a%2Fb/read",
        "/api/pastes/a/settings/extra",
        "/a%2Fb",
        "/raw/a%2Fb",
        "/html/a%2Fb",
        "/md/a%2Fb",
        "/file/a%2Fb",
        "/raw/a/extra",
      ]) {
        for (const method of ["GET", "OPTIONS"] as const) {
          get.mockClear();
          getWithMetadata.mockClear();
          erase.mockClear();
          expect((await localRequest(path, { method })).status, `${method} ${path}`).toBe(404);
          expect(get).not.toHaveBeenCalled();
          expect(getWithMetadata).not.toHaveBeenCalled();
          expect(erase).not.toHaveBeenCalled();
        }
      }
      get.mockRestore();
      getWithMetadata.mockRestore();
      erase.mockRestore();
    });

    it("keeps special OPTIONS and legacy routes unchanged", async () => {
      expect((await request("/api/pastes/matrix", { method: "OPTIONS" })).status).toBe(204);
      expect((await request("/ip-trace", { method: "OPTIONS" })).status).toBe(200);
      expect((await request("/mcp", { method: "OPTIONS" })).status).toBe(204);
      for (const path of ["/api", "/delete/example"]) expect((await request(path)).status, path).toBe(404);
      for (const method of ["GET", "HEAD"] as const) {
        const response = await localRequest("/assets/missing-hash.js", { method });
        expect(response.status, method).toBe(404);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      const method = await localRequest("/assets/missing-hash.js", { method: "POST" });
      expect(method.status).toBe(405);
      expect(method.headers.get("allow")).toBe("GET,HEAD");
    });
  });

  describe("view-once body ownership", () => {
    it("prepares final response bytes before consuming a view-once paste", async () => {
      const paste = await createJsonPaste({ content: "prepared before consume", viewOnce: true, expiration: "permanent" });
      const database = (env as unknown as Env).PASTE_DB;
      const deleteOriginal = database.delete.bind(database);
      let consumed = false;
      const remove = vi.spyOn(database, "delete").mockImplementation(async (...args) => {
        consumed = true;
        return deleteOriginal(...args);
      });
      const nativeUint8Array = Uint8Array;
      const guardedUint8Array = new Proxy(nativeUint8Array, {
        construct(target, argumentsList, newTarget) {
          if (consumed) throw new Error("response bytes allocated after consume");
          return Reflect.construct(target, argumentsList, newTarget);
        },
      });

      try {
        vi.stubGlobal("Uint8Array", guardedUint8Array);
        const response = await request(`/api/pastes/${paste.id}`);
        vi.unstubAllGlobals();
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ id: paste.id, content: "prepared before consume" });
      } finally {
        vi.unstubAllGlobals();
        remove.mockRestore();
        await deletePaste(paste.id);
      }
    });
  });

  describe("API method matrix", () => {
    it("returns the exact API method matrix and Allow values", async () => {
      const apiAllow = [
        ["/api/pastes/ID", "GET,HEAD,PUT,PATCH,DELETE,OPTIONS"],
        ["/api/pastes/ID/settings", "GET,HEAD,PATCH,OPTIONS"],
        ["/api/pastes/ID/password", "PUT,DELETE,OPTIONS"],
        ["/api/pastes/ID/history", "GET,HEAD,OPTIONS"],
        ["/api/pastes/ID/history/1", "GET,HEAD,OPTIONS"],
        ["/api/pastes/ID/read", "GET,HEAD,POST,OPTIONS"],
      ] as const;

      for (const [template, allow] of apiAllow) {
        const path = template.replace("ID", "matrix");
        const options = await request(path, { method: "OPTIONS" });
        expect(options.status, path).toBe(204);
        expect(options.headers.get("allow"), path).toBe(allow);
        expect(options.headers.get("cache-control"), path).toBe("no-store");
        expect(await options.text(), path).toBe("");

        const invalidMethod = path.endsWith("/read") ? "PATCH" : "POST";
        const method = await request(path, { method: invalidMethod });
        expect(method.status, path).toBe(405);
        expect(method.headers.get("allow"), path).toBe(allow);
        await expect(method.json(), path).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
      }
    });
  });

  describe("settings API", () => {
    it("uses strict SettingsBody schema, credentials, versions, and version ETags", async () => {
      const paste = await createJsonPaste({ content: "settings", password: "right", expiration: "permanent" });
      try {
        for (const [body, field] of [
          [{ password: "right" }, "settings"],
          [{ password: "right", title: "title", unknown: true }, "unknown"],
          [{ password: "right", viewOnce: "true" }, "viewOnce"],
        ] as const) {
          const response = await request(`/api/pastes/${paste.id}/settings`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          expect(response.status).toBe(422);
          await expect(response.json()).resolves.toMatchObject({
            error: { code: "VALIDATION_FAILED", details: { fields: [{ field }] } },
          });
        }

        const query = await request(`/api/pastes/${paste.id}/settings?password=right`, {
          headers: { "x-paste-password": "wrong" },
        });
        expect(query.status).toBe(200);
        expect(query.headers.get("etag")).toBe(`"${paste.version}"`);
        await expect(query.json()).resolves.toMatchObject({ id: paste.id, protected: true });

        const header = await request(`/api/pastes/${paste.id}/settings`, {
          headers: { "x-paste-password": "right" },
        });
        expect(header.status).toBe(200);
        expect(header.headers.get("etag")).toBe(`"${paste.version}"`);

        const head = await request(`/api/pastes/${paste.id}/settings?password=right`, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.headers.get("etag")).toBe(`"${paste.version}"`);
        expect(await head.arrayBuffer()).toHaveProperty("byteLength", 0);

        const updated = await request(`/api/pastes/${paste.id}/settings?password=wrong-query`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "if-match": `"${paste.version}"`,
            "x-paste-password": "wrong-header",
          },
          body: JSON.stringify({ password: "right", version: paste.version, title: "changed", format: "markdown" }),
        });
        expect(updated.status).toBe(200);
        const result = await updated.json() as MutationResult;
        expect(result).toMatchObject({ changed: true, paste: { id: paste.id, title: "changed", format: "markdown" } });
        expect(updated.headers.get("etag")).toBe(`"${result.paste.version}"`);

        const ambiguousVersion = await request(`/api/pastes/${paste.id}/settings`, {
          method: "PATCH",
          headers: { "content-type": "application/json", "if-match": '"legacy"' },
          body: JSON.stringify({ password: "right", version: result.paste.version, title: "ignored" }),
        });
        expect(ambiguousVersion.status).toBe(400);
        await expect(ambiguousVersion.json()).resolves.toMatchObject({ error: { code: "AMBIGUOUS_VERSION" } });
      } finally {
        await deletePaste(paste.id);
      }
    });

    it("defers duplicate password errors until coherent resource authority without writes", async () => {
      const protectedPaste = await createJsonPaste({ content: "protected", password: "right", expiration: "permanent" });
      const unprotectedPaste = await createJsonPaste({ content: "unprotected", expiration: "permanent" });
      const database = (env as unknown as Env).PASTE_DB;
      const put = vi.spyOn(database, "put");
      const erase = vi.spyOn(database, "delete");
      try {
        const missing = await request("/api/pastes/missing?password=one&password=two", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "new", password: "right" }),
        });
        expect(missing.status).toBe(404);

        const wrongPassword = await request(`/api/pastes/${protectedPaste.id}?password=one&password=two`, {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-paste-password": "wrong" },
          body: JSON.stringify({ content: "new", password: "wrong" }),
        });
        expect(wrongPassword.status).toBe(403);

        const authorized = await request(`/api/pastes/${protectedPaste.id}?password=one&password=two`, {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-paste-password": "wrong" },
          body: JSON.stringify({ content: "new", password: "right" }),
        });
        expect(authorized.status).toBe(400);
        await expect(authorized.json()).resolves.toMatchObject({ error: { code: "AMBIGUOUS_PASSWORD" } });

        const duplicatePut = await request(`/api/pastes/${unprotectedPaste.id}?password=one&password=two`, {
          method: "PUT",
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: "changed",
        });
        expect(duplicatePut.status).toBe(400);
        const duplicatePatch = await request(`/api/pastes/${unprotectedPaste.id}?password=one&password=two`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "changed" }),
        });
        expect(duplicatePatch.status).toBe(400);
        const duplicateDelete = await request(`/api/pastes/${unprotectedPaste.id}?password=one&password=two`, { method: "DELETE" });
        expect(duplicateDelete.status).toBe(400);
        expect(put).not.toHaveBeenCalled();
        expect(erase).not.toHaveBeenCalled();
        await expect(database.get(unprotectedPaste.id)).resolves.toBe("unprotected");
      } finally {
        put.mockRestore();
        erase.mockRestore();
        await deletePaste(protectedPaste.id);
        await deletePaste(unprotectedPaste.id);
      }
    });
  });

  describe("password API", () => {
    it("uses strict PasswordPutBody and PasswordDeleteBody schemas", async () => {
      const paste = await createJsonPaste({ content: "password schema", expiration: "permanent" });
      try {
        for (const [method, body, field] of [
          ["PUT", {}, "newPassword"],
          ["PUT", { newPassword: "next", title: "unexpected" }, "title"],
          ["PUT", { newPassword: false }, "newPassword"],
          ["DELETE", { newPassword: "unexpected" }, "newPassword"],
        ] as const) {
          const response = await request(`/api/pastes/${paste.id}/password`, {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          expect(response.status).toBe(422);
          await expect(response.json()).resolves.toMatchObject({
            error: { code: "VALIDATION_FAILED", details: { fields: [{ field }] } },
          });
        }
      } finally {
        await deletePaste(paste.id);
      }
    });

    it("stops streamed newPassword at its first excess code unit", async () => {
      let pulls = 0;
      let cancelled = false;
      let releaseCompletion!: () => void;
      const completion = new Promise<void>((resolve) => { releaseCompletion = resolve; });
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new TextEncoder().encode(`{"newPassword":"${"x".repeat(128)}`));
          } else if (pulls === 2) {
            controller.enqueue(new TextEncoder().encode("x"));
          } else {
            await completion;
            controller.enqueue(new TextEncoder().encode('"}'));
            controller.close();
          }
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 });
      const responsePromise = createHttpApp(env as unknown as Env).fetch(new Request("https://paste.test/api/pastes/missing/password", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      }));
      let deadline: ReturnType<typeof setTimeout> | undefined;

      try {
        const response = await Promise.race([
          responsePromise,
          new Promise<Response>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("newPassword parser waited past its first excess code unit")), 100); }),
        ]);
        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toEqual({
          error: {
            code: "VALIDATION_FAILED",
            message: "One or more fields are invalid.",
            details: { fields: [{ field: "password", message: "Must be empty or 1 to 128 visible ASCII characters." }] },
          },
        });
        expect(pulls).toBe(2);
        expect(cancelled).toBe(true);
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
        releaseCompletion();
        await responsePromise;
      }
    });

    it("applies password-domain validation to newPassword without validating opaque current-password candidates", async () => {
      for (const [newPassword, status] of [
        ["!~".repeat(64), 200],
        ["x".repeat(129), 422],
        [String.fromCharCode(0x1f), 422],
        ["é", 422],
      ] as const) {
        const paste = await createJsonPaste({ content: "password candidate", expiration: "permanent" });
        try {
          const response = await request(`/api/pastes/${paste.id}/password`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ newPassword }),
          });
          expect(response.status).toBe(status);
          if (status === 422) {
            await expect(response.json()).resolves.toEqual({
              error: {
                code: "VALIDATION_FAILED",
                message: "One or more fields are invalid.",
                details: { fields: [{ field: "password", message: "Must be empty or 1 to 128 visible ASCII characters." }] },
              },
            });
          }
        } finally {
          await deletePaste(paste.id);
        }
      }

      for (const password of [String.fromCharCode(0x1f), "x".repeat(129)]) {
        const protectedPaste = await createJsonPaste({ content: "protected password candidate", password: "right", expiration: "permanent" });
        try {
          const response = await request(`/api/pastes/${protectedPaste.id}/password`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password, newPassword: "next" }),
          });
          expect(response.status).toBe(403);
        } finally {
          await deletePaste(protectedPaste.id);
        }
      }
    });

    it("sets, changes, and clears passwords with body credential precedence and ETags", async () => {
      const paste = await createJsonPaste({ content: "password lifecycle", expiration: "permanent" });
      try {
        const set = await request(`/api/pastes/${paste.id}/password`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ newPassword: "first", version: paste.version }),
        });
        expect(set.status).toBe(200);
        const setResult = await set.json() as MutationResult;
        expect(setResult).toMatchObject({ changed: true, paste: { id: paste.id, protected: true } });
        expect(set.headers.get("etag")).toBe(`"${setResult.paste.version}"`);

        const changed = await request(`/api/pastes/${paste.id}/password?password=wrong-query`, {
          method: "PUT",
          headers: { "content-type": "application/json", "x-paste-password": "wrong-header" },
          body: JSON.stringify({ password: "first", newPassword: "second", version: setResult.paste.version }),
        });
        expect(changed.status).toBe(200);
        const changedResult = await changed.json() as MutationResult;
        expect(changedResult).toMatchObject({ changed: true, paste: { id: paste.id, protected: true } });
        expect(changed.headers.get("etag")).toBe(`"${changedResult.paste.version}"`);

        const ambiguousVersion = await request(`/api/pastes/${paste.id}/password`, {
          method: "PUT",
          headers: { "content-type": "application/json", "if-match": '"legacy"' },
          body: JSON.stringify({ password: "second", newPassword: "third", version: changedResult.paste.version }),
        });
        expect(ambiguousVersion.status).toBe(400);
        await expect(ambiguousVersion.json()).resolves.toMatchObject({ error: { code: "AMBIGUOUS_VERSION" } });

        const cleared = await request(`/api/pastes/${paste.id}/password`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "second", version: changedResult.paste.version }),
        });
        expect(cleared.status).toBe(200);
        const clearedResult = await cleared.json() as MutationResult;
        expect(clearedResult).toMatchObject({ changed: true, paste: { id: paste.id, protected: false } });
        expect(cleared.headers.get("etag")).toBe(`"${clearedResult.paste.version}"`);
      } finally {
        await deletePaste(paste.id);
      }
    });
  });

  describe("history API", () => {
    it("lists and snapshots canonical history revisions with current version ETags", async () => {
      const paste = await createJsonPaste({ content: "old history", expiration: "permanent" });
      try {
        const update = await request(`/api/pastes/${paste.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "new history", version: paste.version }),
        });
        expect(update.status).toBe(200);
        const updateResult = await update.json() as MutationResult;

        const list = await request(`/api/pastes/${paste.id}/history`);
        expect(list.status).toBe(200);
        const history = await list.json() as { id: string; currentRevision: number; currentVersion: string; revisions: Array<{ revision: number }> };
        expect(history).toMatchObject({ id: paste.id, currentRevision: 2, currentVersion: updateResult.paste.version, revisions: [{ revision: 1 }] });
        expect(list.headers.get("etag")).toBe(`"${updateResult.paste.version}"`);

        const snapshot = await request(`/api/pastes/${paste.id}/history/1`);
        expect(snapshot.status).toBe(200);
        expect(snapshot.headers.get("etag")).toBe(`"${updateResult.paste.version}"`);
        await expect(snapshot.json()).resolves.toMatchObject({ id: paste.id, revision: 1, content: "old history" });

        for (const path of [`/api/pastes/${paste.id}/history`, `/api/pastes/${paste.id}/history/1`]) {
          const head = await request(path, { method: "HEAD" });
          expect(head.status).toBe(200);
          expect(head.headers.get("etag")).toBe(`"${updateResult.paste.version}"`);
          expect(await head.arrayBuffer()).toHaveProperty("byteLength", 0);
        }

        const noncanonical = await request(`/api/pastes/${paste.id}/history/01`);
        expect(noncanonical.status).toBe(400);
        await expect(noncanonical.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
      } finally {
        await deletePaste(paste.id);
      }
    });

    it("forbids history on view-once pastes", async () => {
      const paste = await createJsonPaste({ content: "view once history", viewOnce: true, expiration: "permanent" });
      try {
        for (const path of [`/api/pastes/${paste.id}/history`, `/api/pastes/${paste.id}/history/1`]) {
          const response = await request(path);
          expect(response.status).toBe(409);
          await expect(response.json()).resolves.toMatchObject({ error: { code: "VIEW_ONCE_HISTORY_FORBIDDEN" } });
        }
      } finally {
        await deletePaste(paste.id);
      }
    });
  });

  describe("read API", () => {
    it("ignores every If-None-Match value and returns a current version ETag", async () => {
      const paste = await createJsonPaste({ content: "read resource", expiration: "permanent" });
      try {
        for (const ifNoneMatch of [undefined, `"${paste.version}"`, '"bad space"']) {
          for (const method of ["GET", "HEAD", "POST"] as const) {
            const response = await request(`/api/pastes/${paste.id}/read`, {
              method,
              headers: {
                ...(method === "POST" ? { "content-type": "application/json" } : {}),
                ...(ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch }),
              },
              ...(method === "POST" ? { body: "{}" } : {}),
            });
            expect(response.status, `${method} ${ifNoneMatch}`).toBe(200);
            expect(response.headers.get("etag"), `${method} ${ifNoneMatch}`).toBe(`"${paste.version}"`);
            if (method === "HEAD") {
              expect(await response.arrayBuffer()).toHaveProperty("byteLength", 0);
            } else {
              await expect(response.json()).resolves.toMatchObject({ id: paste.id, content: "read resource" });
            }
          }
        }

        for (const [body, field] of [[{ version: paste.version }, "version"], [{ password: false }, "password"]] as const) {
          const response = await request(`/api/pastes/${paste.id}/read`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          expect(response.status).toBe(422);
          await expect(response.json()).resolves.toMatchObject({
            error: { code: "VALIDATION_FAILED", details: { fields: [{ field }] } },
          });
        }
      } finally {
        await deletePaste(paste.id);
      }
    });

    it("uses body, unique query, and header credentials in order and defers duplicate query errors", async () => {
      const protectedPaste = await createJsonPaste({ content: "protected read", password: "right", expiration: "permanent" });
      const unprotectedPaste = await createJsonPaste({ content: "unprotected read", expiration: "permanent" });
      try {
        const body = await request(`/api/pastes/${protectedPaste.id}/read?password=wrong-query`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-paste-password": "wrong-header" },
          body: JSON.stringify({ password: "right" }),
        });
        expect(body.status).toBe(200);
        expect(body.headers.get("etag")).toBe(`"${protectedPaste.version}"`);
        await expect(body.json()).resolves.toMatchObject({ content: "protected read" });

        const query = await request(`/api/pastes/${protectedPaste.id}/read?password=right`, {
          headers: { "x-paste-password": "wrong-header" },
        });
        expect(query.status).toBe(200);
        const header = await request(`/api/pastes/${protectedPaste.id}/read`, { headers: { "x-paste-password": "right" } });
        expect(header.status).toBe(200);

        const missing = await request("/api/pastes/missing/read?password=one&password=two");
        expect(missing.status).toBe(404);
        const wrong = await request(`/api/pastes/${protectedPaste.id}/read?password=one&password=two`, {
          headers: { "x-paste-password": "wrong" },
        });
        expect(wrong.status).toBe(403);
        const authorized = await request(`/api/pastes/${protectedPaste.id}/read?password=one&password=two`, {
          headers: { "x-paste-password": "right" },
        });
        expect(authorized.status).toBe(400);
        await expect(authorized.json()).resolves.toMatchObject({ error: { code: "AMBIGUOUS_PASSWORD" } });
        const bodyAuthorized = await request(`/api/pastes/${protectedPaste.id}/read?password=one&password=two`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-paste-password": "wrong" },
          body: JSON.stringify({ password: "right" }),
        });
        expect(bodyAuthorized.status).toBe(400);
        const unprotected = await request(`/api/pastes/${unprotectedPaste.id}/read?password=one&password=two`);
        expect(unprotected.status).toBe(400);
      } finally {
        await deletePaste(protectedPaste.id);
        await deletePaste(unprotectedPaste.id);
      }
    });

    it("returns content then consumes a view-once paste after HEAD", async () => {
      const paste = await createJsonPaste({ content: "view-once read", viewOnce: true, expiration: "permanent" });
      try {
        const head = await request(`/api/pastes/${paste.id}/read`, { method: "HEAD", headers: { "if-none-match": '"bad space"' } });
        expect(head.status).toBe(200);
        expect(head.headers.get("etag")).toBe(`"${paste.version}"`);
        expect(await head.arrayBuffer()).toHaveProperty("byteLength", 0);

        const get = await request(`/api/pastes/${paste.id}/read`, { headers: { "if-none-match": "*" } });
        expect(get.status).toBe(200);
        await expect(get.json()).resolves.toMatchObject({ id: paste.id, content: "view-once read" });
        expect((await request(`/api/pastes/${paste.id}/read`)).status).toBe(404);
      } finally {
        await deletePaste(paste.id);
      }
    });
  });
});
