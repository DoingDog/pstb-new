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

function streamedBody(chunks: number, chunkBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent === chunks) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
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

  it("rejects an announced body larger than 64 MiB before reading it", async () => {
    await expect(
      parseStrictJsonObject(request("{}", { "content-length": String(wireBodyLimit + 1) }), new Set()),
    ).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE",
      status: 413,
      details: { maxBytes: wireBodyLimit },
    });
  });

  it("rejects a streamed body once it exceeds 64 MiB", async () => {
    await expect(
      parseStrictJsonObject(request(streamedBody(65, 1_048_576)), new Set()),
    ).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE",
      status: 413,
      details: { maxBytes: wireBodyLimit },
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
