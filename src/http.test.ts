import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "./http";
import { assetPaths } from "./generated/assets";
import { renderCreatePage } from "./render";
import type { Env, MutationResult, PasteSummary } from "./types";

const wireBodyLimit = 67_108_864;

vi.mock("./render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render")>();
  return { ...actual, renderCreatePage: vi.fn(actual.renderCreatePage) };
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

describe("HTTP slice 1", () => {
  it("serves the create page and its exact root method contract", async () => {
    const get = await request("/", { headers: { "accept-language": "zh-CN" } });

    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(await get.text()).toContain("创建剪贴板");

    const head = await request("/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(await head.text()).toBe("");

    const options = await request("/", { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toBe("GET,HEAD,OPTIONS");
    expect(options.headers.get("cache-control")).toBe("no-store");
    expect(await options.text()).toBe("");

    const method = await request("/", { method: "POST", headers: { "accept-language": "zh-CN" } });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET,HEAD,OPTIONS");
    expect(method.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(method.headers.get("cache-control")).toBe("no-store");
    expect(method.headers.get("content-security-policy")).toBeTruthy();
    expect(method.headers.get("x-content-type-options")).toBe("nosniff");
    const methodHtml = await method.text();
    expect(methodHtml).toContain(`href="${assetPaths.appCss}"`);
    expect(methodHtml).toContain(`src="${assetPaths.appJs}"`);
    expect(methodHtml).toContain('data-workbench="error"');
    expect(methodHtml).toContain('data-i18n-error="METHOD_NOT_ALLOWED">请求方法不被允许。请返回创建页面。');
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
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        error: { code: "PASTE_NOT_FOUND", message: "The paste was not found." },
      });
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

  it("exposes only the canonical mutation method contract for a paste resource", async () => {
    const options = await request("/api/pastes/example", { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toBe("PUT,PATCH,DELETE,OPTIONS");
    expect(options.headers.get("cache-control")).toBe("no-store");
    expect(await options.text()).toBe("");

    const method = await request("/api/pastes/example", { method: "GET" });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("PUT,PATCH,DELETE,OPTIONS");
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

  it("cancels an oversized multipart stream without Content-Length", async () => {
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

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "REQUEST_TOO_LARGE", details: { maxBytes: 67_108_864 } },
    });
    expect(cancelled).toBe(true);
  });

  it("preserves REQUEST_TOO_LARGE when counted multipart cancellation rejects", async () => {
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

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "REQUEST_TOO_LARGE", details: { maxBytes: 67_108_864 } },
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
});
