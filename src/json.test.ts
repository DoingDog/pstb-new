import { describe, expect, it } from "vitest";
import { decodeUtf8, parseStrictJsonObject, readLimitedBytes } from "./json";

const wireBodyLimit = 67_108_864;

type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };

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

  it.each([
    ["arrays", "[".repeat(10_000) + "0" + "]".repeat(10_000)],
    ["objects", '{"value":'.repeat(10_000) + "0" + "}".repeat(10_000)],
  ])("rejects deeply nested %s with PasteError", async (_kind, body) => {
    await expect(parseStrictJsonObject(request(body), new Set())).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
  });

  it("accepts escaped JSON property names after decoding them", async () => {
    await expect(
      parseStrictJsonObject(request('{"pas\\u0073word":"correct"}'), new Set(["password"])),
    ).resolves.toEqual({ password: "correct" });
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
});
