import { describe, expect, it, vi } from "vitest";
import { parseMultipartBoundary, parseMultipartCreateFields } from "./multipart";

const encoder = new TextEncoder();
const wireBodyLimit = 67_108_864;
const contentLimit = 10_485_760;

type Part = {
  body: Uint8Array | string;
  disposition?: string;
  extraHeaders?: string[];
};

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function join(...chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function multipart(boundary: string, parts: Part[], close = true): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(bytes(`--${boundary}\r\n`));
    if (part.disposition !== undefined) chunks.push(bytes(`${part.disposition}\r\n`));
    for (const header of part.extraHeaders ?? []) chunks.push(bytes(`${header}\r\n`));
    chunks.push(bytes("\r\n"));
    chunks.push(typeof part.body === "string" ? bytes(part.body) : part.body);
    chunks.push(bytes("\r\n"));
  }
  if (close) chunks.push(bytes(`--${boundary}--\r\n`));
  return join(...chunks);
}

function multipartWithDispositionBytes(boundary: string, disposition: Uint8Array, body = Uint8Array.of(0xc3)): Uint8Array {
  return join(
    bytes(`--${boundary}\r\n`),
    disposition,
    bytes("\r\n\r\n"),
    body,
    bytes(`\r\n--${boundary}--\r\n`),
  );
}

function formPart(name: string, body: Uint8Array | string, options: { filename?: string; filenameStar?: string; extraHeaders?: string[] } = {}): Part {
  const parameters = [`name=${JSON.stringify(name)}`];
  if (options.filename !== undefined) parameters.push(`filename=${JSON.stringify(options.filename)}`);
  if (options.filenameStar !== undefined) parameters.push(`filename*=${options.filenameStar}`);
  return {
    body,
    disposition: `Content-Disposition: form-data; ${parameters.join("; ")}`,
    ...(options.extraHeaders === undefined ? {} : { extraHeaders: options.extraHeaders }),
  };
}

function request(body: Uint8Array, boundary: string, headers?: HeadersInit): Request {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
    headers: new Headers({ "content-type": `multipart/form-data; boundary=${boundary}`, ...headers }),
  } as Request;
}

function streamedRequest(body: Uint8Array, boundary: string, chunkBytes = 1, headers?: HeadersInit): Request {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === body.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkBytes, body.byteLength);
      controller.enqueue(body.slice(offset, end));
      offset = end;
    },
  });
  return { body: stream, headers: new Headers({ "content-type": `multipart/form-data; boundary=${boundary}`, ...headers }) } as Request;
}

function parsedBoundary(request: Request): string {
  return parseMultipartBoundary(request.headers.get("content-type"));
}

function trackedStream(chunks: Uint8Array[], rejectCancel = false): {
  body: ReadableStream<Uint8Array>;
  state: { cancels: number; pulls: number };
} {
  let position = 0;
  const state = { cancels: 0, pulls: 0 };
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulls += 1;
        const chunk = chunks[position++];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancels += 1;
        if (rejectCancel) return Promise.reject(new Error("cancel failed"));
      },
    }, { highWaterMark: 0 }),
    state,
  };
}

async function fieldsFor(body: Uint8Array, boundary: string, chunkBytes?: number): Promise<Record<string, string>> {
  const source = chunkBytes === undefined ? request(body, boundary) : streamedRequest(body, boundary, chunkBytes);
  return parseMultipartCreateFields(source, parsedBoundary(source));
}

describe("strict multipart boundary", () => {
  it("parses token, quoted semicolon, and quoted-pair boundaries", () => {
    expect(parseMultipartBoundary("multipart/form-data; boundary=WebKitFormBoundary123")).toBe("WebKitFormBoundary123");
    expect(parseMultipartBoundary('Multipart/Form-Data ; boundary = "a;b"')).toBe("a;b");
    expect(parseMultipartBoundary('multipart/form-data; boundary="a\\;b\\\\c"')).toBe("a;b\\c");
  });

  it.each([
    null,
    "",
    "multipart/form-data",
    "multipart/form-data; boundary=",
    "multipart/form-data; boundary=two words",
    "multipart/form-data; boundary=é",
    "multipart/form-data; boundary=bad\x00value",
    'multipart/form-data; boundary="bad "',
    `multipart/form-data; boundary=${"a".repeat(71)}`,
    "multipart/form-data; boundary=x; charset=utf-8",
  ])("rejects unsupported boundary content type: %j", (contentType) => {
    expect(() => parseMultipartBoundary(contentType)).toThrow(expect.objectContaining({
      code: "UNSUPPORTED_MEDIA_TYPE",
      status: 415,
      details: { accepted: ["application/json", "multipart/form-data"] },
    }));
  });
});

describe("strict multipart create fields", () => {
  it("parses standard FormData output into a null-prototype record", async () => {
    const form = new FormData();
    form.set("content", "source");
    form.set("title", "title");
    form.set("format", "markdown");
    form.set("expiration", "permanent");
    form.set("password", "");
    form.set("viewOnce", "false");
    form.set("customId", "custom-id");
    const source = new Request("https://unit.test", { method: "POST", body: form });

    const result = await parseMultipartCreateFields(source, parsedBoundary(source));

    expect(Object.getPrototypeOf(result)).toBeNull();
    expect({ ...result }).toEqual({
      content: "source",
      title: "title",
      format: "markdown",
      expiration: "permanent",
      password: "",
      viewOnce: "false",
      customId: "custom-id",
    });
  });

  it("preserves field order and empty values without applying semantic defaults", async () => {
    const boundary = "order";
    const result = await fieldsFor(multipart(boundary, [
      formPart("title", ""),
      formPart("customId", "chosen"),
      formPart("content", ""),
      formPart("viewOnce", ""),
    ]), boundary);

    expect(Object.keys(result)).toEqual(["title", "customId", "content", "viewOnce"]);
    expect({ ...result }).toEqual({ title: "", customId: "chosen", content: "", viewOnce: "" });
  });

  it("accepts a quoted semicolon boundary in the body parser", async () => {
    const boundary = "unit;boundary";
    const source = request(multipart(boundary, [formPart("content", "value")]), boundary, {
      "content-type": 'multipart/form-data; boundary="unit;boundary"',
    });

    await expect(parseMultipartCreateFields(source, parsedBoundary(source))).resolves.toMatchObject({ content: "value" });
  });

  it("rejects unknown and duplicate field names with the HTTP validation wording", async () => {
    const boundary = "fields";
    await expect(fieldsFor(multipart(boundary, [formPart("unknown", "value")]), boundary)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: [{ field: "unknown", message: "Unknown field." }] },
    });
    await expect(fieldsFor(multipart(boundary, [formPart("content", "one"), formPart("content", "two")]), boundary)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: [{ field: "content", message: "Duplicate field." }] },
    });
  });

  it("rejects missing disposition or name, file parts, and invalid header blocks", async () => {
    const boundary = "headers";
    const invalid = [
      multipart(boundary, [{ body: "value" }]),
      multipart(boundary, [{ body: "value", disposition: "Content-Disposition: form-data" }]),
      multipart(boundary, [formPart("content", "value", { filename: "upload.txt" })]),
      multipart(boundary, [formPart("content", "value", { filenameStar: "utf-8''upload.txt" })]),
      multipart(boundary, [formPart("content", "value", { extraHeaders: ["X-Extra: nope"] })]),
      multipart(boundary, [{ body: "value", disposition: "Content-Disposition form-data; name=content" }]),
    ];

    for (const body of invalid.slice(0, 2).concat(invalid.slice(4))) {
      await expect(fieldsFor(body, boundary)).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
    }
    for (const body of invalid.slice(2, 4)) {
      await expect(fieldsFor(body, boundary)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        details: { fields: [{ field: "content", message: "Must be a string." }] },
      });
    }
  });

  it("requires CRLF framing and a closing delimiter", async () => {
    const boundary = "framing";
    const valid = multipart(boundary, [formPart("content", "value")]);
    const lfOnly = bytes(new TextDecoder().decode(valid).replaceAll("\r\n", "\n"));
    await expect(fieldsFor(lfOnly, boundary)).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
    await expect(fieldsFor(multipart(boundary, [formPart("content", "value")], false), boundary)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
  });

  it("accepts one-byte chunks across every delimiter and header position", async () => {
    const boundary = "split-boundary";
    const body = multipart(boundary, [formPart("content", "split text"), formPart("title", "split title")]);

    await expect(fieldsFor(body, boundary, 1)).resolves.toEqual(Object.assign(Object.create(null), {
      content: "split text",
      title: "split title",
    }));
  });

  it("keeps false delimiter prefixes and exact control text in fields", async () => {
    const boundary = "exact";
    const exact = `leading\n\r\n${String.fromCharCode(0)}�`;
    const prefix = `left\r\n--${boundary}Xright\r\n--${boundary.slice(0, -1)}tail`;
    const result = await fieldsFor(multipart(boundary, [formPart("content", `${exact}${prefix}`)]), boundary, 1);

    expect(result.content).toBe(`${exact}${prefix}`);
  });

  it("rejects malformed UTF-8 both within and across stream chunks", async () => {
    const boundary = "utf8";
    const malformed = join(bytes(`--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n`), Uint8Array.of(0xc3, 0x28), bytes(`\r\n--${boundary}--\r\n`));
    await expect(fieldsFor(malformed, boundary)).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });

    const splitMalformed = join(bytes(`--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n`), Uint8Array.of(0xe2), bytes(`\r\n--${boundary}--\r\n`));
    await expect(fieldsFor(splitMalformed, boundary, 1)).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
  });

  it("checks malformed or oversized Content-Length before reading the stream", async () => {
    const boundary = "length";
    const { body, state } = trackedStream([bytes("never pulled")], true);
    const source = {
      body,
      headers: new Headers({
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(wireBodyLimit + 1),
      }),
    } as Request;

    await expect(parseMultipartCreateFields(source, boundary)).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE",
      details: { maxBytes: wireBodyLimit },
    });
    expect(state).toEqual({ cancels: 1, pulls: 0 });
    expect(source.body?.locked).toBe(false);

    const malformedLength = request(multipart(boundary, [formPart("content", "value")]), boundary, { "content-length": "1.5" });
    await expect(parseMultipartCreateFields(malformedLength, boundary)).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
  });

  it("cancels unknown-length malformed streams without replacing the parser error", async () => {
    const boundary = "cancel";
    const { body, state } = trackedStream([bytes("not a delimiter")], true);
    const source = { body, headers: new Headers({ "content-type": `multipart/form-data; boundary=${boundary}` }) } as Request;

    await expect(parseMultipartCreateFields(source, boundary)).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
    expect(state).toEqual({ cancels: 1, pulls: 1 });
    expect(source.body?.locked).toBe(false);
  });

  it("accepts exactly 10 MiB content and rejects the next raw UTF-8 byte before retaining it", async () => {
    const boundary = "content-limit";
    const content = new Uint8Array(contentLimit).fill(0x61);
    await expect(fieldsFor(multipart(boundary, [formPart("content", content)]), boundary, 65_537)).resolves.toMatchObject({
      content: "a".repeat(contentLimit),
    });

    const tooLarge = new Uint8Array(contentLimit + 1).fill(0x61);
    await expect(fieldsFor(multipart(boundary, [formPart("content", tooLarge)]), boundary, 65_537)).rejects.toMatchObject({
      code: "CONTENT_TOO_LARGE",
      details: { maxBytes: contentLimit },
    });
  });

  const contentScalarChunkCases = [
    { name: "whole body", chunkBytes: undefined },
    { name: "1 MiB chunks", chunkBytes: 1_048_576 },
    { name: "8 KiB chunks", chunkBytes: 8_192 },
    { name: "one-byte chunks", chunkBytes: 1 },
  ] as const;

  it.each(contentScalarChunkCases)(
    "reports a valid UTF-8 scalar crossing the 10 MiB cap with $name",
    async ({ chunkBytes }) => {
      const boundary = "content-utf8-cap";
      const body = multipart(boundary, [
        formPart("content", join(
          new Uint8Array(contentLimit - 1).fill(0x61),
          Uint8Array.of(0xc2, 0xa2),
        )),
      ]);
      await expect(fieldsFor(body, boundary, chunkBytes)).rejects.toMatchObject({
        code: "CONTENT_TOO_LARGE",
        status: 413,
        details: { maxBytes: contentLimit },
      });
    },
    600_000,
  );

  it("reports ordinary ASCII overflow from the writeByte path", async () => {
    const boundary = "write-byte-overflow";
    const candidate = bytes(`\r\n--${boundary}`);
    const content = join(new Uint8Array(contentLimit - candidate.byteLength).fill(0x61), candidate, bytes("X"));

    await expect(fieldsFor(multipart(boundary, [formPart("content", content)]), boundary)).rejects.toMatchObject({
      code: "CONTENT_TOO_LARGE",
      status: 413,
      details: { maxBytes: contentLimit },
    });
  });

  const utf8CapCases = ([
    ["content", contentLimit],
    ["title", 800],
    ["format", 8],
    ["expiration", 29],
    ["password", 128],
    ["viewOnce", 5],
    ["customId", 64],
  ] as const).flatMap(([field, limit]) =>
    ([
      ["two-byte", Uint8Array.of(0xc2, 0xa2)],
      ["three-byte", Uint8Array.of(0xe2, 0x82, 0xac)],
      ["four-byte", Uint8Array.of(0xf0, 0x9f, 0x99, 0x82)],
    ] as const).flatMap(([scalarName, scalar]) =>
      ([
        ["bulk", undefined],
        ["one-byte", 1],
      ] as const).map(([delivery, chunkBytes]) => ({
        field,
        limit,
        scalarName,
        scalar,
        delivery,
        chunkBytes,
      })),
    ),
  );

  it.each(utf8CapCases)(
    "reports $scalarName overflow for $field with $delivery delivery",
    async ({ field, limit, scalar, chunkBytes }) => {
      const boundary = `cap-${field}`;
      const body = multipart(boundary, [
        formPart(field, join(new Uint8Array(limit - 1).fill(0x61), scalar)),
      ]);
      const expected = field === "content"
        ? { code: "CONTENT_TOO_LARGE", status: 413, details: { maxBytes: contentLimit } }
        : { code: "VALIDATION_FAILED", status: 422, details: { fields: [{ field }] } };
      await expect(fieldsFor(body, boundary, chunkBytes)).rejects.toMatchObject(expected);
    },
    600_000,
  );

  it("bounds definitely oversized non-content fields before retaining them", async () => {
    const boundary = "field-limit";
    for (const [field, limit] of Object.entries({ title: 800, format: 8, expiration: 29, password: 128, viewOnce: 5, customId: 64 })) {
      await expect(fieldsFor(multipart(boundary, [formPart(field, "a".repeat(limit + 1))]), boundary)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        details: { fields: [{ field }] },
      });
    }
  });

  it.each(["\n", "\r", "\r\n", "ends with LF\n", "ends with CR\r", "ends with CRLF\r\n"])("preserves trailing text bytes: %j", async (content) => {
    const boundary = "trailing";
    await expect(fieldsFor(multipart(boundary, [formPart("content", content)]), boundary, 1)).resolves.toMatchObject({ content });
  });

  it("accepts valid UTF-8 when every scalar is split between stream chunks", async () => {
    const boundary = "utf8-split";
    await expect(fieldsFor(multipart(boundary, [formPart("content", "中文🙂")]), boundary, 1)).resolves.toMatchObject({ content: "中文🙂" });
  });

  it("accepts a closing delimiter with or without its normal final CRLF", async () => {
    const boundary = "final-crlf";
    const withCrLf = multipart(boundary, [formPart("content", "value")]);
    const withoutCrLf = withCrLf.slice(0, -2);
    await expect(fieldsFor(withCrLf, boundary)).resolves.toMatchObject({ content: "value" });
    await expect(fieldsFor(withoutCrLf, boundary)).resolves.toMatchObject({ content: "value" });
  });

  it("does not call Response.formData and feeds the decoder bounded chunks", async () => {
    const boundary = "bounded";
    const body = multipart(boundary, [formPart("content", "a".repeat(65_536))]);
    const formData = vi.spyOn(Response.prototype, "formData").mockRejectedValue(new Error("must not use Response.formData"));
    const native = TextDecoder;
    const decodedLengths: number[] = [];
    class TrackingTextDecoder extends native {
      override decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string {
        if (input !== undefined) decodedLengths.push(input.byteLength);
        return super.decode(input, options);
      }
    }
    vi.stubGlobal("TextDecoder", TrackingTextDecoder);

    try {
      await expect(fieldsFor(body, boundary)).resolves.toMatchObject({ content: "a".repeat(65_536) });
      expect(formData).not.toHaveBeenCalled();
      expect(Math.max(...decodedLengths)).toBeLessThanOrEqual(8_192);
    } finally {
      vi.unstubAllGlobals();
      formData.mockRestore();
    }
  });

  it.each([undefined, 1])("preserves exact leading BOM and control scalars in every field with %s-byte chunks", async (chunkBytes) => {
    const boundary = "bom";
    const values = {
      content: "﻿content\r\nmixed\n\r\0�",
      title: "﻿title\n\rmixed\r\0�",
      password: "﻿password\r\n\0�",
    };

    await expect(fieldsFor(multipart(boundary, Object.entries(values).map(([name, value]) => formPart(name, value))), boundary, chunkBytes)).resolves.toEqual(
      Object.assign(Object.create(null), values),
    );
  });

  it("checks invalid UTF-8 in the legal field prefix before reporting later content overflow for every delivery size", async () => {
    const boundary = "invalid-before-overflow";
    const oversized = new Uint8Array(contentLimit + 1).fill(0x61);
    oversized.set([0xc3, 0x28]);
    const body = multipart(boundary, [formPart("content", oversized)]);
    const errors = await Promise.all([undefined, 1_048_576, 8_192, 1].map(async (chunkBytes) => {
      try {
        await fieldsFor(body, boundary, chunkBytes);
        return undefined;
      } catch (error) {
        return error;
      }
    }));

    for (const error of errors) expect(error).toMatchObject({ code: "BAD_REQUEST", status: 400 });
  });

  it.each([
    ["title", 800, "Must contain at most 200 Unicode scalars."],
    ["format", 8, "Must be text or markdown."],
    ["expiration", 29, "Must be permanent, at least 60 seconds, or a timezone-bearing RFC3339 timestamp."],
    ["password", 128, "Must be empty or 1 to 128 visible ASCII characters."],
    ["viewOnce", 5, "Must be true or false."],
    ["customId", 64, "Must be 1 to 64 ASCII letters, digits, underscores, or hyphens."],
  ])("returns the canonical field validation for oversized %s", async (field, limit, message) => {
    const boundary = "field-message";

    await expect(fieldsFor(multipart(boundary, [formPart(field, "a".repeat(limit + 1))]), boundary)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: [{ field, message }] },
    });
  });

  it("processes malformed wire prefixes before selecting the wire-size error for every delivery size", async () => {
    const boundary = "wire-prefix";
    const oversized = new Uint8Array(wireBodyLimit + 1);
    oversized[0] = 0x78;
    const errors = await Promise.all([undefined, 1_048_576, 8_192, 1].map(async (chunkBytes) => {
      const source = chunkBytes === undefined ? request(oversized, boundary) : streamedRequest(oversized, boundary, chunkBytes);
      try {
        await parseMultipartCreateFields(source, boundary);
        return undefined;
      } catch (error) {
        return error;
      }
    }));

    for (const error of errors) expect(error).toMatchObject({ code: "BAD_REQUEST", status: 400 });
  });

  it("accepts leading-zero Content-Length values and rejects all non-decimal forms", async () => {
    const boundary = "length-grammar";
    const body = multipart(boundary, [formPart("content", "value")]);
    const leadingZeroLength = request(body, boundary, { "content-length": `000${body.byteLength}` });
    await expect(parseMultipartCreateFields(leadingZeroLength, boundary)).resolves.toMatchObject({ content: "value" });

    for (const contentLength of ["+1", " 1", "1 ", "1.0", "-1", ""]) {
      const source = {
        body: request(body, boundary).body,
        headers: { get: (name: string) => name.toLowerCase() === "content-length" ? contentLength : null },
      } as unknown as Request;
      await expect(parseMultipartCreateFields(source, boundary)).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
    }
  });

  it("rejects duplicate case-insensitive Content-Type parameters", async () => {
    const boundary = "observe";
    const body = bytes(`--${boundary}\r\nContent-Disposition: form-data; name="content"\r\nContent-Type: text/plain; charset=utf-8; CHARSET=ascii\r\n\r\nvalue\r\n--${boundary}--\r\n`);

    await expect(fieldsFor(body, boundary)).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
  });

  it("accepts one valid Content-Type header and rejects unknown, duplicate, and malformed headers", async () => {
    const boundary = "part-headers";
    await expect(fieldsFor(multipart(boundary, [formPart("content", "literal", { extraHeaders: ["Content-Type: text/plain; charset=utf-8"] })]), boundary)).resolves.toMatchObject({
      content: "literal",
    });

    const malformed = [
      multipart(boundary, [formPart("content", "value", { extraHeaders: ["X-Extra: nope"] })]),
      multipart(boundary, [formPart("content", "value", { extraHeaders: ['Content-Disposition: form-data; name="title"'] })]),
      multipart(boundary, [formPart("content", "value", { extraHeaders: ["Content-Type: text/plain", "Content-Type: text/plain"] })]),
      multipart(boundary, [formPart("content", "value", { extraHeaders: ["Content-Type: text/plain; charset="] })]),
      multipart(boundary, [{ body: "value", disposition: 'Content-Disposition: form-data; name="content"; creation-date="today"' }]),
    ];
    for (const body of malformed) await expect(fieldsFor(body, boundary)).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
  });

  it("detects a raw UTF-8 filename as a file before decoding the body", async () => {
    const boundary = "raw-filename";
    const source = join(
      bytes(`--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="café.txt"\r\n\r\n`),
      Uint8Array.of(0xc3),
      bytes(`\r\n--${boundary}--\r\n`),
    );

    await expect(fieldsFor(source, boundary)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
      details: { fields: [{ field: "content", message: "Must be a string." }] },
    });
  });

  it.each([
    ["captured Chromium FormData File", bytes('Content-Disposition: form-data; name="content"; filename="café.txt"')],
    ["captured curl -F", bytes('Content-Disposition: form-data; name="content"; filename="文档.txt"')],
    ["ASCII", bytes('Content-Disposition: form-data; name="content"; filename="upload.txt"')],
    ["invalid UTF-8", join(bytes('Content-Disposition: form-data; name="content"; filename="'), Uint8Array.of(0xff, 0x80), bytes('"'))],
  ])("returns the file validation for %s filename bytes at every delivery size", async (_client, disposition) => {
    const boundary = "filename-delivery";
    const source = multipartWithDispositionBytes(boundary, disposition);

    for (const chunkBytes of [undefined, 1_048_576, 8_192, 1]) {
      await expect(fieldsFor(source, boundary, chunkBytes)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        status: 422,
        details: { fields: [{ field: "content", message: "Must be a string." }] },
      });
    }
  });

  it("rejects raw obs-text outside a quoted filename value", async () => {
    const boundary = "raw-header-grammar";
    const invalidDispositions = [
      join(bytes("Content-Dispo"), Uint8Array.of(0xff), bytes('ition: form-data; name="content"')),
      join(bytes("Content-Disposition: form-data; na"), Uint8Array.of(0xff), bytes('me="content"')),
      join(bytes('Content-Disposition: form-data; name="cont'), Uint8Array.of(0xff), bytes('ent"')),
      join(bytes('Content-Disposition: form-data; name="content"; filename='), Uint8Array.of(0xff)),
    ];

    for (const disposition of invalidDispositions) {
      await expect(fieldsFor(multipartWithDispositionBytes(boundary, disposition), boundary)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        status: 400,
      });
    }
  });

  it.each(["filename", "filename*", "filename*0", "filename*0*", "filename*1", "filename*1*"])("rejects %s parts before decoding their bodies", async (parameter) => {
    const boundary = "file-parameters";
    const source = multipart(boundary, [{
      body: Uint8Array.of(0xc3),
      disposition: `Content-Disposition: form-data; name="content"; ${parameter}="upload.txt"`,
      extraHeaders: ["Content-Type: application/octet-stream"],
    }]);

    for (const chunkBytes of [undefined, 1_048_576, 8_192, 1]) {
      await expect(fieldsFor(source, boundary, chunkBytes)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        status: 422,
        details: { fields: [{ field: "content", message: "Must be a string." }] },
      });
    }
  });
});
