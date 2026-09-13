import { describe, expect, it } from "vitest";
import {
  decodeUtf8,
  parseStrictJsonObject,
  parseStrictJsonObjectOrEmpty,
  readLimitedBytes,
  type StrictJsonParsePolicy,
} from "./json";
import { PasteError } from "./types";

const wireBodyLimit = 67_108_864;
const contentBodyLimit = 10_485_760;

type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };

const fieldBoundPolicy: StrictJsonParsePolicy = {
  maxRetainedCodeUnits: contentBodyLimit + 4_096,
  maxTopLevelKeyCodeUnits: "expiration".length,
  topLevelStringMaxCodeUnits: new Map([
    ["content", contentBodyLimit],
    ["title", 400],
    ["format", "markdown".length],
    ["expiration", 29],
    ["password", 128],
    ["customId", 64],
    ["version", 53],
  ]),
  onStringLimit: (field) => field === "content"
    ? new PasteError("CONTENT_TOO_LARGE", 413, undefined, { maxBytes: contentBodyLimit })
    : new PasteError("VALIDATION_FAILED", 422),
  onRetainedLimit: () => new PasteError("BAD_REQUEST", 400),
  topLevelUtf8ByteMax: new Map([["content", contentBodyLimit]]),
};

function request(body: BodyInit, headers?: HeadersInit): Request {
  return new Request("https://unit.test", {
    method: "POST",
    body,
    ...(headers === undefined ? {} : { headers }),
  });
}

function streamedRequest(body: ReadableStream<Uint8Array>, headers?: HeadersInit): Request {
  return { body, headers: new Headers(headers) } as Request;
}

function chunkedUtf8Request(source: string, chunkBytes = 65_537): Request {
  const bytes = new TextEncoder().encode(source);
  let position = 0;
  return streamedRequest(new ReadableStream({
    pull(controller) {
      if (position === bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(position + chunkBytes, bytes.byteLength);
      controller.enqueue(bytes.subarray(position, end));
      position = end;
    },
  }));
}

function trackedBody(chunks: number, chunkBytes: number, rejectCancel = false): {
  body: ReadableStream<Uint8Array>;
  state: { cancels: number; pulls: number };
} {
  const state = { cancels: 0, pulls: 0 };
  let sent = 0;
  return {
    body: new ReadableStream({
      pull(controller) {
        state.pulls += 1;
        if (sent === chunks) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
      },
      cancel() {
        state.cancels += 1;
        if (rejectCancel) return Promise.reject(new Error("cancel failed"));
      },
    }, { highWaterMark: 0 }),
    state,
  };
}

function exactLengthWhitespaceBody(bytes: number): ReadableStream<Uint8Array> {
  const whitespace = new Uint8Array(65_536).fill(0x20);
  let remaining = bytes - 2;
  let started = false;
  return new ReadableStream({
    pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(Uint8Array.of(0x7b));
        return;
      }
      if (remaining > 0) {
        const chunk = remaining < whitespace.byteLength ? whitespace.subarray(0, remaining) : whitespace;
        remaining -= chunk.byteLength;
        controller.enqueue(chunk);
        return;
      }
      controller.enqueue(Uint8Array.of(0x7d));
      controller.close();
    },
  });
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state;
  };
}

function fuzzValue(next: () => number, depth = 0): JsonValue {
  const choice = depth >= 3 ? next() % 4 : next() % 6;
  if (choice === 0) return null;
  if (choice === 1) return (next() % 2_000_001 - 1_000_000) / 10;
  if (choice === 2) return next() % 2 === 0;
  if (choice === 3) {
    const strings = ["", "plain", "\"\\\b\f\n\r\t", "中文", "🙂", String.fromCharCode(0), "line separator"];
    return strings[next() % strings.length]!;
  }
  if (choice === 4) {
    return Array.from({ length: next() % 4 }, () => fuzzValue(next, depth + 1));
  }

  const object: { [key: string]: JsonValue } = {};
  for (let index = 0; index < next() % 4; index += 1) {
    object[`key_${index}_${next() % 100}`] = fuzzValue(next, depth + 1);
  }
  return object;
}

describe("strict JSON boundary", () => {
  it("returns undefined only for a zero-byte stream", async () => {
    const empty = streamedRequest(new ReadableStream({ start(controller) { controller.close(); } }));
    let nonEmpty = 0;
    await expect(parseStrictJsonObjectOrEmpty(empty, new Set(), () => { nonEmpty += 1; })).resolves.toBeUndefined();
    expect(nonEmpty).toBe(0);

    const value = await parseStrictJsonObjectOrEmpty(
      chunkedUtf8Request('{"password":"right"}'),
      new Set(["password"]),
      () => { nonEmpty += 1; },
    );
    expect(value).toEqual({ password: "right" });
    expect(nonEmpty).toBe(1);
  });

  it("rejects an oversized Content-Length before handling null or zero-byte bodies", async () => {
    const headers = { "content-length": String(wireBodyLimit + 1) };
    const nullBody = { body: null, headers: new Headers(headers) } as Request;
    await expect(parseStrictJsonObjectOrEmpty(nullBody, new Set())).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE",
      status: 413,
      details: { maxBytes: wireBodyLimit },
    });

    const { body, state } = trackedBody(0, 1, true);
    await expect(parseStrictJsonObjectOrEmpty(streamedRequest(body, headers), new Set())).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE",
      status: 413,
      details: { maxBytes: wireBodyLimit },
    });
    expect(state).toEqual({ cancels: 1, pulls: 0 });
  });

  it("accepts zero-padded Content-Length values and rejects non-digit values", async () => {
    await expect(
      parseStrictJsonObject(streamedRequest(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      }), { "content-length": "0002" }), new Set()),
    ).resolves.toEqual({});

    for (const contentLength of ["+2", "-2", " 2", "2 ", "2\t"]) {
      await expect(parseStrictJsonObject(streamedRequest(new ReadableStream({ start(controller) { controller.close(); } }), {
        "content-length": contentLength,
      }), new Set())).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
    }
  });

  it("defers unknown-field errors until malformed JSON and UTF-8 have been checked", async () => {
    for (const source of [
      '{"unknown"',
      '{"unknown":',
      '{"unknown":1',
      '{"unknown":{',
      '{"unknown":[',
      '{"unknown":{"nested":}',
    ]) {
      await expect(parseStrictJsonObject(request(source), new Set())).rejects.toMatchObject({
        code: "BAD_REQUEST",
        status: 400,
      });
    }

    await expect(parseStrictJsonObject(request('{"unknown":{"nested":[1]}}'), new Set())).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
    await expect(parseStrictJsonObject(request(new Uint8Array([0x7b, 0x22, 0x75, 0x6e, 0x6b, 0x6e, 0x6f, 0x77, 0x6e, 0x22, 0x3a, 0xc3, 0x28])), new Set())).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
  });

  it("rejects duplicate credential keys before JSON.parse can overwrite them", async () => {
    await expect(
      parseStrictJsonObject(request('{"password":"right","password":"wrong"}'), new Set(["password"])),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
  });

  it.each([
    [new Uint8Array([0xc3, 0x28]), "BAD_REQUEST"],
    [new TextEncoder().encode('{"unknown":1}'), "VALIDATION_FAILED"],
  ])("rejects malformed or unknown input", async (body, code) => {
    await expect(parseStrictJsonObject(request(body), new Set())).rejects.toMatchObject({ code });
  });

  it("rejects duplicate keys at nested object depth", async () => {
    await expect(
      parseStrictJsonObject(request('{"settings":{"title":"first","title":"second"}}'), new Set(["settings"])),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
  });

  it("rejects trailing tokens after a complete JSON value", async () => {
    await expect(parseStrictJsonObject(request('{"title":"ok"} null'), new Set(["title"]))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
  });

  it.each(["[]", "null", '"text"', "1", "false"])("rejects non-object top-level JSON: %s", async (body) => {
    await expect(parseStrictJsonObject(request(body), new Set())).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
  });

  it("cancels an announced oversized body without pulling it", async () => {
    const { body, state } = trackedBody(1, 1, true);
    const oversized = streamedRequest(body, { "content-length": String(wireBodyLimit + 1) });

    await expect(parseStrictJsonObject(oversized, new Set())).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE",
      status: 413,
      details: { maxBytes: wireBodyLimit },
    });
    expect(state).toEqual({ cancels: 1, pulls: 0 });
    expect(oversized.body?.locked).toBe(false);
  });

  it("cancels a streamed body as soon as it exceeds 64 MiB", async () => {
    const { body, state } = trackedBody(65, 1_048_576);
    const oversized = streamedRequest(body);

    await expect(parseStrictJsonObject(oversized, new Set())).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE",
      status: 413,
      details: { maxBytes: wireBodyLimit },
    });
    expect(state).toEqual({ cancels: 1, pulls: 65 });
    expect(oversized.body?.locked).toBe(false);
  });

  it("preserves REQUEST_TOO_LARGE when overflow cancellation rejects", async () => {
    const { body, state } = trackedBody(1, 2, true);
    const oversized = streamedRequest(body);

    await expect(readLimitedBytes(oversized, 1)).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE",
      status: 413,
      details: { maxBytes: 1 },
    });
    expect(state).toEqual({ cancels: 1, pulls: 1 });
    expect(oversized.body?.locked).toBe(false);
  });

  it("accepts an exact 64 MiB body with no body-sized parsed value", async () => {
    await expect(parseStrictJsonObject(streamedRequest(exactLengthWhitespaceBody(wireBodyLimit)), new Set())).resolves.toEqual({});
  });

  it("rejects a deeply nested array root before parsing its descendants", async () => {
    await expect(parseStrictJsonObject(request("[".repeat(10_000) + "0" + "]".repeat(10_000)), new Set())).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
  });

  it("rejects deeply nested objects with PasteError", async () => {
    await expect(parseStrictJsonObject(request('{"value":'.repeat(10_000) + "0" + "}".repeat(10_000)), new Set())).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
  });

  it("accepts escaped JSON property names after decoding them", async () => {
    await expect(
      parseStrictJsonObject(request('{"pas\\u0073word":"correct"}'), new Set(["password"])),
    ).resolves.toEqual({ password: "correct" });
  });

  it("parses a multi-megabyte escaped string across decoded chunks", async () => {
    const length = 2 * 1024 * 1024;
    const parsed = await parseStrictJsonObject(
      chunkedUtf8Request(`{"value":"${"\\u0061".repeat(length)}"}`),
      new Set(["value"]),
    );

    expect(parsed.value).toBe("a".repeat(length));
  });

  it("accepts a long numeric token without a token-length limit", async () => {
    const parsed = await parseStrictJsonObject(
      chunkedUtf8Request(`{"value":1${"0".repeat(4 * 1024 * 1024)}}`),
      new Set(["value"]),
    );

    expect(parsed.value).toBe(Infinity);
  });

  it.each([
    ["content", "x".repeat(contentBodyLimit), "x".repeat(contentBodyLimit + 1), "CONTENT_TOO_LARGE"],
    ["password", "x".repeat(128), "x".repeat(129), "VALIDATION_FAILED"],
    ["customId", "x".repeat(64), "x".repeat(65), "VALIDATION_FAILED"],
    ["title", "🙂".repeat(200), `${"🙂".repeat(200)}x`, "VALIDATION_FAILED"],
    ["format", "markdown", "markdownx", "VALIDATION_FAILED"],
    ["expiration", "9999-12-31T23:59:59.999+23:59", "9999-12-31T23:59:59.999+23:590", "VALIDATION_FAILED"],
    ["version", "123e4567-e89b-42d3-a456-426614174000.9007199254740991", "123e4567-e89b-42d3-a456-426614174000.90071992547409910", "VALIDATION_FAILED"],
  ])("retains %s through its exact field bound and rejects one decoded code unit over", async (field, exact, over, code) => {
    const allowedKeys = new Set([field]);
    await expect(parseStrictJsonObject(request(JSON.stringify({ [field]: exact })), allowedKeys, fieldBoundPolicy)).resolves.toEqual({ [field]: exact });
    await expect(parseStrictJsonObject(request(JSON.stringify({ [field]: over })), allowedKeys, fieldBoundPolicy)).rejects.toMatchObject({ code });
  });

  it.each([
    ["arrays", `{"password":[${Array(128).fill("0").join(",")}]}`],
    ["objects", `{"password":{${Array.from({ length: 64 }, (_value, index) => `"key${index}":0`).join(",")}}}`],
    ["small strings", `{"password":[${Array(128).fill('"x"').join(",")}]}`],
  ])("bounds aggregate retained parser state for malformed nested %s", async (_kind, source) => {
    const policy: StrictJsonParsePolicy = { ...fieldBoundPolicy, maxRetainedCodeUnits: 1_024 };
    await expect(parseStrictJsonObject(request(source), new Set(["password"]), policy)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
  });

  it("preserves a field overflow when cancellation of one large input chunk rejects", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(`{"password":"${"x".repeat(65_536)}"}`));
      },
      cancel() {
        cancelled += 1;
        return Promise.reject(new Error("cancel failed"));
      },
    }, { highWaterMark: 0 });
    const overflow = streamedRequest(body);

    await expect(parseStrictJsonObject(overflow, new Set(["password"]), fieldBoundPolicy)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
    expect(cancelled).toBe(1);
    expect(overflow.body?.locked).toBe(false);
  });

  it("reads a body with the supplied byte limit and decodes valid UTF-8", async () => {
    const bytes = await readLimitedBytes(request(new TextEncoder().encode("中文")), 6);
    expect(decodeUtf8(bytes)).toBe("中文");
  });

  it("matches JSON.parse for 1,000 deterministic valid JSON values", async () => {
    for (let seed = 1; seed <= 1_000; seed += 1) {
      const value = fuzzValue(random(seed));
      const source = JSON.stringify({ value });
      await expect(parseStrictJsonObject(request(source), new Set(["value"]))).resolves.toEqual(JSON.parse(source));
    }
  });

  it.each([
    '{"nested":{"key":1,"key":2}}',
    '{"items":[{"key":1,"key":2}]}',
  ])("rejects duplicate-object fixtures excluded from the JSON.parse comparison: %s", async (source) => {
    await expect(parseStrictJsonObject(request(source), new Set(["nested", "items"]))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
  });

  it("charges retained numeric syntax and cancels before a policy-sized token is buffered", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(`{"expiration":1${"0".repeat(4_096)}}`));
      },
      cancel() {
        cancelled = true;
        return Promise.reject(new Error("cancel failed"));
      },
    }, { highWaterMark: 0 });
    const parsed = streamedRequest(body);
    const policy: StrictJsonParsePolicy = { ...fieldBoundPolicy, maxRetainedCodeUnits: 1_024 };

    await expect(parseStrictJsonObject(parsed, new Set(["expiration"]), policy)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
    expect(cancelled).toBe(true);
    expect(parsed.body?.locked).toBe(false);
  });

  it("rejects a known string field at its numeric opening token before retaining its descendants", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"content":1'));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const policy: StrictJsonParsePolicy = {
      ...fieldBoundPolicy,
      expectedTopLevelKinds: new Map([["content", new Set(["string"] as const)]]),
      onUnexpectedTopLevelKind: (field) => new PasteError("VALIDATION_FAILED", 422, undefined, {
        fields: [{ field, message: "Must be a string." }],
      }),
    };

    await expect(parseStrictJsonObject(streamedRequest(body), new Set(["content"]), policy)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
      details: { fields: [{ field: "content", message: "Must be a string." }] },
    });
    expect(cancelled).toBe(true);
  });

  it("validates content Unicode scalar pairs across parser chunks before applying its UTF-8 byte limit", async () => {
    for (const source of ['{"content":"🙂"}', '{"content":"\\uD83D\\uDE42"}']) {
      await expect(parseStrictJsonObject(chunkedUtf8Request(source, 1), new Set(["content"]), fieldBoundPolicy)).resolves.toEqual({
        content: "🙂",
      });
    }
    for (const source of [
      '{"content":"\\uD800"}',
      '{"content":"\\uDC00"}',
      '{"content":"\\uD800x"}',
      '{"content":"\\uD800\\uD800"}',
      '{"content":"\\uDC00\\uD800"}',
    ]) {
      await expect(parseStrictJsonObject(chunkedUtf8Request(source, 1), new Set(["content"]), fieldBoundPolicy)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        status: 422,
        details: { fields: [{ field: "content", message: "Must contain only Unicode scalar values." }] },
      });
    }
  });

  it("enforces content byte limits for multibyte Unicode scalars", async () => {
    const exact = `${"€".repeat(Math.floor(contentBodyLimit / 3))}x`;
    await expect(parseStrictJsonObject(request(JSON.stringify({ content: exact })), new Set(["content"]), fieldBoundPolicy)).resolves.toEqual({
      content: exact,
    });
    await expect(parseStrictJsonObject(request(JSON.stringify({ content: `${exact}x` })), new Set(["content"]), fieldBoundPolicy)).rejects.toMatchObject({
      code: "CONTENT_TOO_LARGE",
      status: 413,
      details: { maxBytes: contentBodyLimit },
    });
  }, 20_000);

  it("defers policy unknown fields through malformed JSON, UTF-8, and wire-size failures without retaining their values", async () => {
    for (const source of ['{"unknown"', '{"unknown":', '{"unknown":{', '{"unknown":[', '{"unknown":{"nested":}']) {
      await expect(parseStrictJsonObject(request(source), new Set(["content"]), fieldBoundPolicy)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        status: 400,
      });
    }
    await expect(parseStrictJsonObject(request(new Uint8Array([0x7b, 0x22, 0x75, 0x6e, 0x6b, 0x6e, 0x6f, 0x77, 0x6e, 0x22, 0x3a, 0xc3, 0x28])), new Set(["content"]), fieldBoundPolicy)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
    await expect(parseStrictJsonObject(streamedRequest(new ReadableStream({ start(controller) { controller.close(); } }), {
      "content-length": String(wireBodyLimit + 1),
    }), new Set(["content"]), fieldBoundPolicy)).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE", status: 413 });
    await expect(parseStrictJsonObject(request(JSON.stringify({ unknown: "x".repeat(2 * 1024 * 1024) })), new Set(["content"]), {
      ...fieldBoundPolicy,
      maxRetainedCodeUnits: 1_024,
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    await expect(parseStrictJsonObject(request('{"unknown":1,"unknown":2}'), new Set(["content"]), fieldBoundPolicy)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
      details: { fields: [{ field: "unknown", message: "Duplicate field." }] },
    });
    await expect(parseStrictJsonObject(request('{"unknown":1,"content":"first","content":"second"}'), new Set(["content"]), fieldBoundPolicy)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
      details: { fields: [{ field: "content", message: "Duplicate field." }] },
    });
  });

  it("cancels an exact-wire-limit numeric stream before retaining a body-sized number", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode(`{"expiration":1${"0".repeat(8_192)}`));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const policy: StrictJsonParsePolicy = { ...fieldBoundPolicy, maxRetainedCodeUnits: 1_024 };
    const parsed = streamedRequest(body, { "content-length": String(wireBodyLimit) });

    await expect(parseStrictJsonObject(parsed, new Set(["expiration"]), policy)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
    expect(pulls).toBe(1);
    expect(cancelled).toBe(true);
    expect(parsed.body?.locked).toBe(false);
  });

  it("rejects a non-object root before retaining a streamed array", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 10) controller.enqueue(encoder.encode(`${pulls === 1 ? "[" : ""}${"0,".repeat(4_500)}`));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const parsed = streamedRequest(body);

    await expect(parseStrictJsonObject(parsed, new Set(["content"]), fieldBoundPolicy)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
      details: { fields: [{ field: "body", message: "Expected a JSON object." }] },
    });
    expect(pulls).toBe(1);
    expect(cancelled).toBe(true);
  });

  it("discards nested keys of an unknown top-level value", async () => {
    const fields = Array.from({ length: 300_000 }, (_value, index) => `"u${index}":0`).join(",");

    await expect(parseStrictJsonObject(request(`{"unknown":{${fields}}}`), new Set(["content"]), fieldBoundPolicy)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
      details: { fields: [{ field: "unknown", message: "Unknown field." }] },
    });
  }, 20_000);
});
