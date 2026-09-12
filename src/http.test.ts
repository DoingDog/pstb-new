import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env, PasteSummary } from "./types";

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

    for (const path of ["/api", "/delete/example", "/api/pastes/example", "/raw/example"]) {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        error: { code: "PASTE_NOT_FOUND", message: "The paste was not found." },
      });
    }
  });
});
