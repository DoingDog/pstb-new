import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "./http";
import { assetPaths } from "./generated/assets";
import { renderCreatePage } from "./render";
import type { Env, MutationResult, PasteSummary } from "./types";

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
    expect(methodHtml).toContain("请求方法不被允许");
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
});
