import { describe, expect, it, vi } from "vitest";
import { createPasteApi, selectCreateEncoding } from "./api";

const jsonMediaType = "application/json; charset=utf-8";
const noStore = "no-store";

const summary = {
  id: "paste-1",
  title: "Example",
  format: "text" as const,
  viewOnce: false,
  protected: false,
  createdAt: "2026-09-14T12:00:00.000Z",
  updatedAt: "2026-09-14T12:00:00.000Z",
  expiresAt: null,
  expiration: { kind: "permanent" as const },
  version: "v1",
  contentRevision: 1,
  contentBytes: 5,
  createdCountry: null,
  links: {
    view: "/p/paste-1",
    raw: "/p/paste-1/raw",
    html: "/p/paste-1/html",
    markdown: "/p/paste-1/markdown",
    file: "/p/paste-1/file",
  },
};

const snapshot = { ...summary, content: "hello" };
const mutation = { changed: true, paste: summary };
const history = {
  id: "paste-1",
  currentRevision: 1,
  currentVersion: "v1",
  revisions: [{ revision: 0, savedAt: "2026-09-14T11:00:00.000Z", supersededAt: "2026-09-14T12:00:00.000Z", byteLength: 3 }],
};
const revision = {
  id: "paste-1",
  revision: 0,
  savedAt: "2026-09-14T11:00:00.000Z",
  supersededAt: "2026-09-14T12:00:00.000Z",
  byteLength: 3,
  content: "old",
};

type FetchCall = { url: string; init: RequestInit | undefined };

function queuedFetch(...responses: Array<Response | Error>) {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error("Unexpected fetch");
      return response;
    },
  };
}

function api(fetch: ReturnType<typeof queuedFetch>["fetch"]) {
  return createPasteApi({ fetch: fetch as typeof globalThis.fetch, crypto: globalThis.crypto });
}

function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": jsonMediaType, "Cache-Control": noStore, ...headers },
  });
}

function emptyResponse(status: number, headers: HeadersInit = {}): Response {
  return new Response(null, { status, headers: { "Cache-Control": noStore, ...headers } });
}

function emptyStreamResponse(status: number, headers: HeadersInit = {}): Response & { arrayBuffer: ReturnType<typeof vi.fn> } {
  return {
    status,
    headers: new Headers({ "Cache-Control": noStore, ...headers }),
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
  } as unknown as Response & { arrayBuffer: ReturnType<typeof vi.fn> };
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function resourceResponse(value: Record<string, unknown> & { content: string } = snapshot, headers: HeadersInit = {}): Promise<Response> {
  const bytes = new TextEncoder().encode(value.content);
  const digest = base64Url(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return jsonResponse(value, 200, { ETag: `"sha256-${digest}"`, ...headers });
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function errorResponse(
  status: number,
  error: { code: string; message: string; details?: Record<string, unknown> },
  headers: HeadersInit = {},
): Response {
  return jsonResponse({ error }, status, headers);
}

describe("paste API", () => {
  it("selects create encoding at the UTF-8 wire-byte boundary", () => {
    expect(selectCreateEncoding(62_914_559)).toBe("json");
    expect(selectCreateEncoding(62_914_560)).toBe("json");
    expect(selectCreateEncoding(62_914_561)).toBe("multipart");
  });

  it("validates resource digest with exactly 43 base64url characters", async () => {
    const fetch = queuedFetch(await resourceResponse());
    const result = await api(fetch.fetch).readResource({ id: "paste-1", password: null, ifNoneMatch: null, signal: signal() });
    expect(result).toEqual({ kind: "snapshot", snapshot });

    const shortDigest = queuedFetch(await resourceResponse(snapshot, { ETag: '"sha256-short"' }));
    const malformed = await api(shortDigest.fetch).readResource({ id: "paste-1", password: null, ifNoneMatch: null, signal: signal() });
    expect(malformed).toMatchObject({ kind: "failure", failure: { kind: "malformed", code: "MALFORMED_RESPONSE", status: 200, mutationMayHaveApplied: false } });
  });

  it("encodes credentials in GET query strings and mutation bodies only when non-null", async () => {
    const get = queuedFetch(jsonResponse(summary, 200, { ETag: '"v1"' }));
    await api(get.fetch).getSettings({ id: "paste-1", password: "p a+ss", signal: signal() });
    expect(get.calls[0]?.url).toBe("/api/pastes/paste-1/settings?password=p+a%2Bss");
    expect(get.calls[0]?.init).toEqual({ method: "GET", headers: { Accept: jsonMediaType }, cache: "no-store", signal: get.calls[0]?.init?.signal });

    const save = queuedFetch(jsonResponse(mutation, 200, { ETag: '"v1"' }));
    await api(save.fetch).saveContent({ id: "paste-1", content: "next", password: null, version: "v1", signal: signal() });
    expect(save.calls[0]?.init?.body).toBe(JSON.stringify({ content: "next", version: "v1" }));

    const protectedSave = queuedFetch(jsonResponse(mutation, 200, { ETag: '"v1"' }));
    await api(protectedSave.fetch).saveContent({ id: "paste-1", content: "next", password: "secret", version: "v1", signal: signal() });
    expect(protectedSave.calls[0]?.init?.body).toBe(JSON.stringify({ content: "next", password: "secret", version: "v1" }));
  });

  it("creates with the exact JSON object and validates its matching mutation ETag", async () => {
    const fetch = queuedFetch(jsonResponse(summary, 201, { ETag: '"v1"' }));
    const requestSignal = signal();
    const result = await api(fetch.fetch).create({
      content: "hello",
      title: "Example",
      format: "text",
      expiration: null,
      password: "",
      viewOnce: false,
    }, requestSignal);

    expect(result).toEqual({ ok: true, status: 201, value: summary, etag: '"v1"' });
    expect(fetch.calls).toEqual([{
      url: "/api/pastes",
      init: {
        method: "POST",
        headers: { Accept: jsonMediaType, "Content-Type": jsonMediaType },
        body: JSON.stringify({ content: "hello", title: "Example", format: "text", expiration: null, password: "", viewOnce: false }),
        cache: "no-store",
        signal: requestSignal,
      },
    }]);
  });

  it("uses multipart above the JSON wire limit with each create field exactly once", async () => {
    const content = "a".repeat(62_914_561);
    const fetch = queuedFetch(jsonResponse(summary, 201, { ETag: '"v1"' }));
    await api(fetch.fetch).create({
      content,
      title: "Example",
      format: "markdown",
      expiration: "2026-10-01T00:00:00.000Z",
      password: "secret",
      viewOnce: true,
      customId: "",
    }, signal());

    const body = fetch.calls[0]?.init?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect([...form.keys()]).toEqual(["content", "title", "format", "expiration", "password", "viewOnce", "customId"]);
    expect(form.get("content")).toBe(content);
    expect(form.get("title")).toBe("Example");
    expect(form.get("format")).toBe("markdown");
    expect(form.get("expiration")).toBe("2026-10-01T00:00:00.000Z");
    expect(form.get("password")).toBe("secret");
    expect(form.get("viewOnce")).toBe("true");
    expect(form.get("customId")).toBe("");
  });

  it("reads a resource with no-store, an AbortSignal, and an optional query credential", async () => {
    const response = await resourceResponse();
    const fetch = queuedFetch(response);
    const requestSignal = signal();
    const result = await api(fetch.fetch).readResource({ id: "paste-1", password: null, ifNoneMatch: null, signal: requestSignal });

    expect(result).toEqual({ kind: "snapshot", snapshot });
    expect(fetch.calls).toEqual([{
      url: "/api/pastes/paste-1",
      init: { method: "GET", headers: { Accept: jsonMediaType }, cache: "no-store", signal: requestSignal },
    }]);
  });

  it("accepts a 304 only for its identical strong no-store resource validator", async () => {
    const validator = '"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';
    const fetch = queuedFetch(emptyResponse(304, { ETag: validator }));
    const requestSignal = signal();
    const result = await api(fetch.fetch).readResource({ id: "paste-1", password: null, ifNoneMatch: validator, signal: requestSignal });

    expect(result).toEqual({ kind: "not-modified", etag: validator });
    expect(fetch.calls[0]).toEqual({
      url: "/api/pastes/paste-1",
      init: {
        method: "GET",
        headers: { Accept: jsonMediaType, "If-None-Match": validator },
        cache: "no-store",
        signal: requestSignal,
      },
    });

    const illegal = queuedFetch(emptyResponse(304, { ETag: 'W/"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' }));
    const failed = await api(illegal.fetch).readResource({ id: "paste-1", password: null, ifNoneMatch: validator, signal: signal() });
    expect(failed).toMatchObject({ kind: "failure", failure: { kind: "malformed", code: "MALFORMED_RESPONSE", status: 304, mutationMayHaveApplied: false } });
  });

  it("rejects resource responses with invalid UTF-8, media, cache, schema, or content bytes", async () => {
    const cases = [
      new Response(new Uint8Array([0xff]), { status: 200, headers: { "Content-Type": jsonMediaType, "Cache-Control": noStore, ETag: '"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' } }),
      await resourceResponse(snapshot, { "Content-Type": "application/json" }),
      await resourceResponse(snapshot, { "Cache-Control": "private" }),
      await resourceResponse({ ...snapshot, unknown: true }, {}),
      await resourceResponse({ ...snapshot, id: "" }, {}),
      await resourceResponse({ ...snapshot, updatedAt: "not-a-timestamp" }, {}),
      await resourceResponse({ ...snapshot, version: "" }, {}),
      await resourceResponse({ ...snapshot, contentBytes: 4 }, {}),
      await resourceResponse({ ...snapshot, links: { ...snapshot.links, raw: "" } }, {}),
    ];

    for (const response of cases) {
      const fetch = queuedFetch(response);
      const result = await api(fetch.fetch).readResource({ id: "paste-1", password: null, ifNoneMatch: null, signal: signal() });
      expect(result).toMatchObject({ kind: "failure", failure: { kind: "malformed", code: "MALFORMED_RESPONSE", status: 200, mutationMayHaveApplied: false } });
    }
  });

  it("uses each direct mutation endpoint and omits null credentials", async () => {
    const fetch = queuedFetch(
      jsonResponse(mutation, 200, { ETag: '"v1"' }),
      jsonResponse(mutation, 200, { ETag: '"v1"' }),
      jsonResponse(mutation, 200, { ETag: '"v1"' }),
      jsonResponse(mutation, 200, { ETag: '"v1"' }),
      emptyResponse(204),
    );
    const client = api(fetch.fetch);
    const requestSignal = signal();

    await client.saveContent({ id: "paste-1", content: "next", password: null, version: "v1", signal: requestSignal });
    await client.updateSettings({ id: "paste-1", change: { field: "title", value: "Changed" }, password: null, version: "v1", signal: requestSignal });
    await client.updatePassword({ id: "paste-1", password: null, newPassword: "next-password", version: "v1", signal: requestSignal });
    await client.clearPassword({ id: "paste-1", password: null, version: "v1", signal: requestSignal });
    await client.deletePaste({ id: "paste-1", password: null, version: "v1", signal: requestSignal });

    expect(fetch.calls).toEqual([
      { url: "/api/pastes/paste-1", init: { method: "PATCH", headers: { Accept: jsonMediaType, "Content-Type": jsonMediaType }, body: JSON.stringify({ content: "next", version: "v1" }), cache: "no-store", signal: requestSignal } },
      { url: "/api/pastes/paste-1/settings", init: { method: "PATCH", headers: { Accept: jsonMediaType, "Content-Type": jsonMediaType }, body: JSON.stringify({ title: "Changed", version: "v1" }), cache: "no-store", signal: requestSignal } },
      { url: "/api/pastes/paste-1/password", init: { method: "PUT", headers: { Accept: jsonMediaType, "Content-Type": jsonMediaType }, body: JSON.stringify({ newPassword: "next-password", version: "v1" }), cache: "no-store", signal: requestSignal } },
      { url: "/api/pastes/paste-1/password", init: { method: "DELETE", headers: { Accept: jsonMediaType, "Content-Type": jsonMediaType }, body: JSON.stringify({ version: "v1" }), cache: "no-store", signal: requestSignal } },
      { url: "/api/pastes/paste-1", init: { method: "DELETE", headers: { Accept: jsonMediaType, "Content-Type": jsonMediaType }, body: JSON.stringify({ version: "v1" }), cache: "no-store", signal: requestSignal } },
    ]);
  });

  it("serializes each settings change and sends non-null credentials in its body", async () => {
    const changes = [
      { field: "format" as const, value: "markdown" as const },
      { field: "expiration" as const, value: 3_600 },
      { field: "viewOnce" as const, value: true },
    ];
    const fetch = queuedFetch(...changes.map(() => jsonResponse(mutation, 200, { ETag: '"v1"' })));
    const client = api(fetch.fetch);

    for (const change of changes) {
      await client.updateSettings({ id: "paste-1", change, password: "secret", version: "v1", signal: signal() });
    }

    expect(fetch.calls.map((call) => call.init?.body)).toEqual([
      JSON.stringify({ format: "markdown", password: "secret", version: "v1" }),
      JSON.stringify({ expiration: 3_600, password: "secret", version: "v1" }),
      JSON.stringify({ viewOnce: true, password: "secret", version: "v1" }),
    ]);
  });

  it("uses direct no-store GET endpoints for settings and history", async () => {
    const fetch = queuedFetch(
      jsonResponse(summary, 200, { ETag: '"v1"' }),
      jsonResponse(history, 200, { ETag: '"v1"' }),
      jsonResponse(revision, 200, { ETag: '"history-1"' }),
    );
    const client = api(fetch.fetch);
    const requestSignal = signal();

    expect(await client.getSettings({ id: "paste-1", password: null, signal: requestSignal })).toEqual({ ok: true, status: 200, value: summary, etag: '"v1"' });
    expect(await client.listHistory({ id: "paste-1", password: null, signal: requestSignal })).toEqual({ ok: true, status: 200, value: history, etag: '"v1"' });
    expect(await client.getHistory({ id: "paste-1", revision: 0, password: null, signal: requestSignal })).toEqual({ ok: true, status: 200, value: revision, etag: '"history-1"' });

    expect(fetch.calls).toEqual([
      { url: "/api/pastes/paste-1/settings", init: { method: "GET", headers: { Accept: jsonMediaType }, cache: "no-store", signal: requestSignal } },
      { url: "/api/pastes/paste-1/history", init: { method: "GET", headers: { Accept: jsonMediaType }, cache: "no-store", signal: requestSignal } },
      { url: "/api/pastes/paste-1/history/0", init: { method: "GET", headers: { Accept: jsonMediaType }, cache: "no-store", signal: requestSignal } },
    ]);
  });

  it("requires each documented success status, response media, cache, schema, and matching ETag", async () => {
    const cases: Array<{ response: Response; call: () => Promise<unknown> }> = [];
    const wrongCreateStatus = queuedFetch(jsonResponse(summary, 200, { ETag: '"v1"' }));
    cases.push({ response: jsonResponse(summary), call: () => api(wrongCreateStatus.fetch).create({ content: "hello", title: "Example", format: "text", expiration: null, password: "", viewOnce: false }, signal()) });
    const unmatchedMutationTag = queuedFetch(jsonResponse(mutation, 200, { ETag: '"v2"' }));
    cases.push({ response: jsonResponse(mutation), call: () => api(unmatchedMutationTag.fetch).saveContent({ id: "paste-1", content: "next", password: null, version: "v1", signal: signal() }) });
    const malformedSettings = queuedFetch(jsonResponse({ ...summary, extra: true }, 200, { ETag: '"v1"' }));
    cases.push({ response: jsonResponse(summary), call: () => api(malformedSettings.fetch).getSettings({ id: "paste-1", password: null, signal: signal() }) });
    const wrongHistoryTag = queuedFetch(jsonResponse(history, 200, { ETag: '"v2"' }));
    cases.push({ response: jsonResponse(history), call: () => api(wrongHistoryTag.fetch).listHistory({ id: "paste-1", password: null, signal: signal() }) });
    const badHistoryBody = queuedFetch(jsonResponse({ ...revision, byteLength: 4 }, 200, { ETag: '"history-1"' }));
    cases.push({ response: jsonResponse(revision), call: () => api(badHistoryBody.fetch).getHistory({ id: "paste-1", revision: 0, password: null, signal: signal() }) });

    for (const { call } of cases) {
      const result = await call();
      expect(result).toMatchObject({ ok: false, failure: { kind: "malformed", code: "MALFORMED_RESPONSE" } });
    }
  });

  it("accepts only the documented error body and takes mutationMayHaveApplied only from boolean details", async () => {
    const error = queuedFetch(errorResponse(409, { code: "VERSION_CONFLICT", message: "changed", details: { mutationMayHaveApplied: false, other: "value" } }));
    expect(await api(error.fetch).saveContent({ id: "paste-1", content: "next", password: null, version: "v1", signal: signal() })).toEqual({
      ok: false,
      failure: { kind: "http", status: 409, code: "VERSION_CONFLICT", details: { mutationMayHaveApplied: false, other: "value" }, mutationMayHaveApplied: false },
    });

    const noBoolean = queuedFetch(errorResponse(400, { code: "BAD_REQUEST", message: "bad", details: { mutationMayHaveApplied: "false" } }));
    expect(await api(noBoolean.fetch).saveContent({ id: "paste-1", content: "next", password: null, version: "v1", signal: signal() })).toEqual({
      ok: false,
      failure: { kind: "http", status: 400, code: "BAD_REQUEST", details: { mutationMayHaveApplied: "false" }, mutationMayHaveApplied: null },
    });

    const invalid = queuedFetch(jsonResponse({ error: { code: "FORBIDDEN", message: "no", details: [], extra: true } }, 403));
    expect(await api(invalid.fetch).getSettings({ id: "paste-1", password: null, signal: signal() })).toMatchObject({
      ok: false,
      failure: { kind: "malformed", status: 403, code: "MALFORMED_RESPONSE", mutationMayHaveApplied: false },
    });
  });

  it("classifies dispatched mutation uncertainty separately from read network and malformed failures", async () => {
    const mutationNetwork = queuedFetch(new TypeError("offline"));
    expect(await api(mutationNetwork.fetch).deletePaste({ id: "paste-1", password: null, version: "v1", signal: signal() })).toEqual({
      ok: false,
      failure: { kind: "network", status: null, code: "NETWORK_ERROR", mutationMayHaveApplied: true },
    });

    const readNetwork = queuedFetch(new TypeError("offline"));
    expect(await api(readNetwork.fetch).readResource({ id: "paste-1", password: null, ifNoneMatch: null, signal: signal() })).toEqual({
      kind: "failure",
      failure: { kind: "network", status: null, code: "NETWORK_ERROR", mutationMayHaveApplied: false },
    });

    const malformedMutation = queuedFetch(jsonResponse({ changed: true }, 200, { ETag: '"v1"' }));
    expect(await api(malformedMutation.fetch).clearPassword({ id: "paste-1", password: null, version: "v1", signal: signal() })).toMatchObject({
      ok: false,
      failure: { kind: "malformed", status: 200, code: "MALFORMED_RESPONSE", mutationMayHaveApplied: true },
    });
  });

  it("accepts delete only as an empty 204 and does not invent a value", async () => {
    const accepted = queuedFetch(emptyResponse(204));
    expect(await api(accepted.fetch).deletePaste({ id: "paste-1", password: null, version: "v1", signal: signal() })).toEqual({ ok: true, status: 204, value: null, etag: null });

    const malformed = queuedFetch(emptyResponse(204, { "Content-Length": "1" }));
    expect(await api(malformed.fetch).deletePaste({ id: "paste-1", password: null, version: "v1", signal: signal() })).toMatchObject({
      ok: false,
      failure: { kind: "malformed", status: 204, code: "MALFORMED_RESPONSE", mutationMayHaveApplied: true },
    });
  });

  it("review round 1: rejects ID-addressed success payloads for another paste", async () => {
    const otherSummary = { ...summary, id: "paste-2" };
    const fetch = queuedFetch(
      jsonResponse(otherSummary, 200, { ETag: '"v1"' }),
      jsonResponse({ changed: true, paste: otherSummary }, 200, { ETag: '"v1"' }),
      jsonResponse({ ...history, id: "paste-2" }, 200, { ETag: '"v1"' }),
    );
    const client = api(fetch.fetch);
    const results = await Promise.all([
      client.getSettings({ id: "paste-1", password: null, signal: signal() }),
      client.saveContent({ id: "paste-1", content: "next", password: null, version: "v1", signal: signal() }),
      client.listHistory({ id: "paste-1", password: null, signal: signal() }),
    ]);

    expect(results).toMatchObject([
      { ok: false, failure: { kind: "malformed", status: 200, code: "MALFORMED_RESPONSE", mutationMayHaveApplied: false } },
      { ok: false, failure: { kind: "malformed", status: 200, code: "MALFORMED_RESPONSE", mutationMayHaveApplied: true } },
      { ok: false, failure: { kind: "malformed", status: 200, code: "MALFORMED_RESPONSE", mutationMayHaveApplied: false } },
    ]);
  });

  it("review round 1: accepts case-insensitive HTTP header tokens", async () => {
    const validator = '"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';
    const json = queuedFetch(jsonResponse(summary, 200, { ETag: '"v1"', "Content-Type": "Application/JSON; Charset=UTF-8", "Cache-Control": "No-Store" }));
    const notModified = queuedFetch(emptyResponse(304, { ETag: validator, "Cache-Control": "No-Store" }));
    const deleted = queuedFetch(emptyResponse(204, { "Cache-Control": "No-Store" }));
    const results = await Promise.all([
      api(json.fetch).getSettings({ id: "paste-1", password: null, signal: signal() }),
      api(notModified.fetch).readResource({ id: "paste-1", password: null, ifNoneMatch: validator, signal: signal() }),
      api(deleted.fetch).deletePaste({ id: "paste-1", password: null, version: "v1", signal: signal() }),
    ]);

    expect(results).toEqual([
      { ok: true, status: 200, value: summary, etag: '"v1"' },
      { kind: "not-modified", etag: validator },
      { ok: true, status: 204, value: null, etag: null },
    ]);
  });

  it("review round 1: does not read bodyless 304 and 204 responses", async () => {
    const validator = '"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';
    const notModified = emptyResponse(304, { ETag: validator });
    const deleted = emptyResponse(204);
    const notModifiedReader = vi.spyOn(notModified, "arrayBuffer").mockImplementation(async () => { throw new Error("304 body read"); });
    const deletedReader = vi.spyOn(deleted, "arrayBuffer").mockImplementation(async () => { throw new Error("204 body read"); });
    const results = await Promise.all([
      api(queuedFetch(notModified).fetch).readResource({ id: "paste-1", password: null, ifNoneMatch: validator, signal: signal() }),
      api(queuedFetch(deleted).fetch).deletePaste({ id: "paste-1", password: null, version: "v1", signal: signal() }),
    ]);

    expect(results).toEqual([
      { kind: "not-modified", etag: validator },
      { ok: true, status: 204, value: null, etag: null },
    ]);
    expect(notModifiedReader).not.toHaveBeenCalled();
    expect(deletedReader).not.toHaveBeenCalled();
  });

  it("review round 1: rejects present zero-length 304 and 204 streams", async () => {
    const validator = '"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';
    const notModified = emptyStreamResponse(304, { ETag: validator });
    const deleted = emptyStreamResponse(204);
    const results = await Promise.all([
      api(queuedFetch(notModified).fetch).readResource({ id: "paste-1", password: null, ifNoneMatch: validator, signal: signal() }),
      api(queuedFetch(deleted).fetch).deletePaste({ id: "paste-1", password: null, version: "v1", signal: signal() }),
    ]);

    expect(results).toMatchObject([
      { kind: "failure", failure: { kind: "malformed", status: 304, code: "MALFORMED_RESPONSE", mutationMayHaveApplied: false } },
      { ok: false, failure: { kind: "malformed", status: 204, code: "MALFORMED_RESPONSE", mutationMayHaveApplied: true } },
    ]);
    expect(notModified.arrayBuffer).not.toHaveBeenCalled();
    expect(deleted.arrayBuffer).not.toHaveBeenCalled();
  });

  it("review round 1: rejects extra response media and cache tokens", async () => {
    const validator = '"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';
    const json = queuedFetch(jsonResponse(summary, 200, { ETag: '"v1"', "Content-Type": "application/json; charset=utf-8; profile=full" }));
    const notModified = queuedFetch(emptyResponse(304, { ETag: validator, "Cache-Control": "no-store, private" }));
    const deleted = queuedFetch(emptyResponse(204, { "Cache-Control": "no-store, private" }));
    const results = await Promise.all([
      api(json.fetch).getSettings({ id: "paste-1", password: null, signal: signal() }),
      api(notModified.fetch).readResource({ id: "paste-1", password: null, ifNoneMatch: validator, signal: signal() }),
      api(deleted.fetch).deletePaste({ id: "paste-1", password: null, version: "v1", signal: signal() }),
    ]);

    expect(results).toMatchObject([
      { ok: false, failure: { kind: "malformed", status: 200, code: "MALFORMED_RESPONSE", mutationMayHaveApplied: false } },
      { kind: "failure", failure: { kind: "malformed", status: 304, code: "MALFORMED_RESPONSE", mutationMayHaveApplied: false } },
      { ok: false, failure: { kind: "malformed", status: 204, code: "MALFORMED_RESPONSE", mutationMayHaveApplied: true } },
    ]);
  });

  it("review round 1: enforces the one-minute relative expiration boundary", async () => {
    const tooShort = queuedFetch(jsonResponse({ ...summary, expiration: { kind: "relative", seconds: 59 } }, 200, { ETag: '"v1"' }));
    const minimum = queuedFetch(jsonResponse({ ...summary, expiration: { kind: "relative", seconds: 60 } }, 200, { ETag: '"v1"' }));
    const results = await Promise.all([
      api(tooShort.fetch).getSettings({ id: "paste-1", password: null, signal: signal() }),
      api(minimum.fetch).getSettings({ id: "paste-1", password: null, signal: signal() }),
    ]);

    expect(results).toMatchObject([
      { ok: false, failure: { kind: "malformed", status: 200, code: "MALFORMED_RESPONSE", mutationMayHaveApplied: false } },
      { ok: true, status: 200, value: { ...summary, expiration: { kind: "relative", seconds: 60 } }, etag: '"v1"' },
    ]);
  });
});
