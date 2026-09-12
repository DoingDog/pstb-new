import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env, MutationResult, PasteSummary } from "./types";

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

describe("HTTP slice 1", () => {
  it("serves the create page and its exact root method contract", async () => {
    const get = await request("/", { headers: { "accept-language": "zh-CN" } });

    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(await get.text()).toContain("创建粘贴内容");

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

    const method = await request("/", { method: "POST" });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET,HEAD,OPTIONS");
    expect(method.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(method.headers.get("cache-control")).toBe("no-store");
    await expect(method.json()).resolves.toEqual({
      error: { code: "BAD_REQUEST", message: "The request is malformed." },
    });
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
});
