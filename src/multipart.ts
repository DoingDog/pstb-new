import { PasteError } from "./types";

const wireBodyLimit = 67_108_864;
const contentLimit = 10_485_760;
const headerLimit = 8_192;
const textBufferSize = 8_192;
const fieldLimits = {
  content: contentLimit,
  title: 800,
  format: 8,
  expiration: 29,
  password: 128,
  viewOnce: 5,
  customId: 64,
} as const;

type FieldName = keyof typeof fieldLimits;
type ParserState = "initial" | "initialSuffix" | "headers" | "body" | "bodyDelimiterSuffix" | "final" | "finalCr" | "afterFinal";

const nonContentFieldLimitMessages = {
  title: "Must contain at most 200 Unicode scalars.",
  format: "Must be text or markdown.",
  expiration: "Must be permanent, at least 60 seconds, or a timezone-bearing RFC3339 timestamp.",
  password: "Must be empty or 1 to 128 visible ASCII characters.",
  viewOnce: "Must be true or false.",
  customId: "Must be 1 to 64 ASCII letters, digits, underscores, or hyphens.",
} as const satisfies Record<Exclude<FieldName, "content">, string>;

function badRequest(): PasteError {
  return new PasteError("BAD_REQUEST", 400);
}

function unsupportedMediaType(): PasteError {
  return new PasteError("UNSUPPORTED_MEDIA_TYPE", 415, undefined, { accepted: ["application/json", "multipart/form-data"] });
}

function requestTooLarge(): PasteError {
  return new PasteError("REQUEST_TOO_LARGE", 413, undefined, { maxBytes: wireBodyLimit });
}

function contentTooLarge(): PasteError {
  return new PasteError("CONTENT_TOO_LARGE", 413, undefined, { maxBytes: contentLimit });
}

function fieldTooLarge(field: FieldName): PasteError {
  if (field === "content") return contentTooLarge();
  return validationError(field, nonContentFieldLimitMessages[field]);
}

function validationError(field: string, message: string): PasteError {
  return new PasteError("VALIDATION_FAILED", 422, undefined, { fields: [{ field, message }] });
}

function isOws(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

function skipOws(source: string, position: number): number {
  while (isOws(source[position])) position += 1;
  return position;
}

function isTokenCharacter(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    "!#$%&'*+-.^_`|~".includes(character)
  );
}

function readToken(source: string, position: number): { value: string; position: number } | undefined {
  const start = position;
  while (isTokenCharacter(source[position])) position += 1;
  return position === start ? undefined : { value: source.slice(start, position), position };
}

function readQuotedValue(source: string, position: number, error: () => never): { value: string; position: number } {
  let value = "";
  position += 1;
  while (position < source.length) {
    const character = source[position]!;
    const code = character.charCodeAt(0);
    if (character === '"') return { value, position: position + 1 };
    if (character === "\\") {
      position += 1;
      const escaped = source[position];
      if (escaped === undefined || escaped.charCodeAt(0) < 0x20 || escaped.charCodeAt(0) > 0x7e) error();
      value += escaped;
      position += 1;
      continue;
    }
    if (code < 0x20 || code > 0x7e) error();
    value += character;
    position += 1;
  }
  return error();
}

function readParameterValue(source: string, position: number, error: () => never): { value: string; position: number } {
  if (source[position] === '"') return readQuotedValue(source, position, error);
  const token = readToken(source, position);
  return token ?? error();
}

function skipFilenameValue(source: string, position: number, error: () => never): number {
  if (source[position] !== '"') return (readToken(source, position) ?? error()).position;
  position += 1;
  while (position < source.length) {
    const character = source[position]!;
    const code = character.charCodeAt(0);
    if (character === '"') return position + 1;
    if (character === "\\") {
      position += 1;
      const escaped = source[position];
      if (escaped === undefined || escaped.charCodeAt(0) < 0x20 || escaped.charCodeAt(0) === 0x7f) error();
      position += 1;
      continue;
    }
    if (code < 0x20 || code === 0x7f) error();
    position += 1;
  }
  return error();
}

function isValidBoundary(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 70 &&
    !value.endsWith(" ") &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code <= 0x7e;
    })
  );
}

/** Parses the one supported multipart Content-Type shape and returns its wire boundary. */
export function parseMultipartBoundary(contentType: string | null): string {
  if (contentType === null) throw unsupportedMediaType();

  let position = skipOws(contentType, 0);
  const mediaType = "multipart/form-data";
  if (contentType.slice(position, position + mediaType.length).toLowerCase() !== mediaType) throw unsupportedMediaType();
  position += mediaType.length;
  if (position < contentType.length && !isOws(contentType[position]) && contentType[position] !== ";") throw unsupportedMediaType();
  position = skipOws(contentType, position);
  if (contentType[position] !== ";") throw unsupportedMediaType();
  position = skipOws(contentType, position + 1);

  const parameter = readToken(contentType, position);
  if (parameter?.value.toLowerCase() !== "boundary") throw unsupportedMediaType();
  position = skipOws(contentType, parameter.position);
  if (contentType[position] !== "=") throw unsupportedMediaType();
  position = skipOws(contentType, position + 1);

  let parsed: { value: string; position: number };
  try {
    parsed = readParameterValue(contentType, position, () => { throw unsupportedMediaType(); });
  } catch {
    throw unsupportedMediaType();
  }
  position = skipOws(contentType, parsed.position);
  if (position !== contentType.length || !isValidBoundary(parsed.value)) throw unsupportedMediaType();
  return parsed.value;
}

function isFieldName(value: string): value is FieldName {
  return Object.hasOwn(fieldLimits, value);
}

function headerText(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) {
    if (byte !== 0x09 && (byte < 0x20 || byte === 0x7f)) throw badRequest();
    value += String.fromCharCode(byte);
  }
  return value;
}

function headerLines(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let position = 0; position < bytes.byteLength; position += 1) {
    if (bytes[position] === 0x0d) {
      if (bytes[position + 1] !== 0x0a) throw badRequest();
      lines.push(headerText(bytes.subarray(start, position)));
      position += 1;
      start = position + 1;
    } else if (bytes[position] === 0x0a) {
      throw badRequest();
    }
  }
  lines.push(headerText(bytes.subarray(start)));
  return lines;
}

function splitHeader(source: string): { name: string; valuePosition: number } {
  const colon = source.indexOf(":");
  if (colon <= 0 || ![...source.slice(0, colon)].every(isTokenCharacter)) throw badRequest();
  return { name: source.slice(0, colon).toLowerCase(), valuePosition: colon + 1 };
}

function parseContentDisposition(source: string): { name: string; file: boolean } {
  const header = splitHeader(source);
  if (header.name !== "content-disposition") throw badRequest();
  let position = skipOws(source, header.valuePosition);
  const disposition = readToken(source, position);
  if (disposition?.value.toLowerCase() !== "form-data") throw badRequest();
  position = skipOws(source, disposition.position);

  const parameters = new Set<string>();
  let name: string | undefined;
  let file = false;
  while (position < source.length) {
    if (source[position] !== ";") throw badRequest();
    position = skipOws(source, position + 1);
    const parameter = readToken(source, position);
    if (parameter === undefined) throw badRequest();
    const key = parameter.value.toLowerCase();
    position = skipOws(source, parameter.position);
    if (source[position] !== "=") throw badRequest();
    position = skipOws(source, position + 1);
    let value: string | undefined;
    if (key === "filename") {
      position = skipOws(source, skipFilenameValue(source, position, () => { throw badRequest(); }));
    } else {
      const parsed = readParameterValue(source, position, () => { throw badRequest(); });
      position = skipOws(source, parsed.position);
      value = parsed.value;
    }
    if (parameters.has(key)) throw badRequest();
    parameters.add(key);
    if (key === "name") {
      name = value!;
    } else if (key === "filename" || /^filename\*(?:\d+\*?)?$/.test(key)) {
      file = true;
    } else {
      throw badRequest();
    }
  }

  if (name === undefined) throw badRequest();
  return { name, file };
}

function parseContentType(source: string): void {
  const header = splitHeader(source);
  if (header.name !== "content-type") throw badRequest();
  let position = skipOws(source, header.valuePosition);
  const type = readToken(source, position);
  if (type === undefined || source[type.position] !== "/") throw badRequest();
  const subtype = readToken(source, type.position + 1);
  if (subtype === undefined) throw badRequest();
  position = skipOws(source, subtype.position);
  while (position < source.length) {
    if (source[position] !== ";") throw badRequest();
    position = skipOws(source, position + 1);
    const parameter = readToken(source, position);
    if (parameter === undefined) throw badRequest();
    position = skipOws(source, parameter.position);
    if (source[position] !== "=") throw badRequest();
    position = skipOws(source, position + 1);
    const value = readParameterValue(source, position, () => { throw badRequest(); });
    position = skipOws(source, value.position);
  }
}

function parsePartHeaders(bytes: Uint8Array): { name: string; file: boolean } {
  let disposition: { name: string; file: boolean } | undefined;
  let contentType = false;
  for (const line of headerLines(bytes)) {
    const header = splitHeader(line);
    if (header.name === "content-disposition") {
      if (disposition !== undefined) throw badRequest();
      disposition = parseContentDisposition(line);
    } else if (header.name === "content-type") {
      if (contentType) throw badRequest();
      parseContentType(line);
      contentType = true;
    } else {
      throw badRequest();
    }
  }
  if (disposition === undefined) throw badRequest();
  return disposition;
}

class TextFieldBuffer {
  #byteLength = 0;
  #chunks: string[] = [];
  #decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  #pending = new Uint8Array(textBufferSize);
  #pendingLength = 0;

  constructor(
    private readonly field: FieldName,
    private readonly limit: number,
  ) {}

  write(source: Uint8Array, start = 0, end = source.byteLength): void {
    const prefixEnd = start + Math.min(end - start, this.limit - this.#byteLength);
    this.#byteLength += prefixEnd - start;
    while (start < prefixEnd) {
      const amount = Math.min(this.#pending.byteLength - this.#pendingLength, prefixEnd - start);
      this.#pending.set(source.subarray(start, start + amount), this.#pendingLength);
      this.#pendingLength += amount;
      start += amount;
      if (this.#pendingLength === this.#pending.byteLength) this.flush(true);
    }
    if (prefixEnd !== end) {
      this.validate(false);
      throw fieldTooLarge(this.field);
    }
  }

  writeByte(byte: number): void {
    if (this.#byteLength === this.limit) {
      this.validate(false);
      throw fieldTooLarge(this.field);
    }
    this.#byteLength += 1;
    this.#pending[this.#pendingLength] = byte;
    this.#pendingLength += 1;
    if (this.#pendingLength === this.#pending.byteLength) this.flush(true);
  }

  finish(): string {
    this.validate();
    const chunks = this.#chunks;
    this.#chunks = [];
    return chunks.join("");
  }

  private validate(final = true): void {
    this.flush(true);
    if (!final) return;
    try {
      const tail = this.#decoder.decode();
      if (tail !== "") this.#chunks.push(tail);
    } catch {
      throw badRequest();
    }
  }

  private flush(stream: boolean): void {
    if (this.#pendingLength === 0) return;
    try {
      const value = this.#decoder.decode(this.#pending.subarray(0, this.#pendingLength), { stream });
      if (value !== "") this.#chunks.push(value);
      this.#pendingLength = 0;
    } catch {
      throw badRequest();
    }
  }
}

class MultipartCreateParser {
  #boundaryDelimiter: Uint8Array;
  #bodyCandidate: Uint8Array;
  #bodyCandidateLength = 0;
  #currentField: FieldName | undefined;
  #currentValue: TextFieldBuffer | undefined;
  #delimiterSuffix = new Uint8Array(2);
  #delimiterSuffixLength = 0;
  #fields: Record<string, string> = Object.create(null) as Record<string, string>;
  #header = new Uint8Array(headerLimit);
  #headerLength = 0;
  #initialDelimiter: Uint8Array;
  #initialPosition = 0;
  #initialSuffix = new Uint8Array(2);
  #initialSuffixLength = 0;
  #state: ParserState = "initial";

  constructor(boundary: string) {
    const boundaryBytes = new TextEncoder().encode(boundary);
    this.#initialDelimiter = new Uint8Array(boundaryBytes.byteLength + 2);
    this.#initialDelimiter.set([0x2d, 0x2d]);
    this.#initialDelimiter.set(boundaryBytes, 2);
    this.#boundaryDelimiter = new Uint8Array(boundaryBytes.byteLength + 4);
    this.#boundaryDelimiter.set([0x0d, 0x0a, 0x2d, 0x2d]);
    this.#boundaryDelimiter.set(boundaryBytes, 4);
    this.#bodyCandidate = new Uint8Array(this.#boundaryDelimiter.byteLength);
  }

  write(bytes: Uint8Array): void {
    let position = 0;
    while (position < bytes.byteLength) {
      switch (this.#state) {
        case "initial":
          position = this.writeInitial(bytes, position);
          break;
        case "initialSuffix":
          this.writeInitialSuffix(bytes[position]!);
          position += 1;
          break;
        case "headers":
          this.writeHeaderByte(bytes[position]!);
          position += 1;
          break;
        case "body":
          position = this.writeBody(bytes, position);
          break;
        case "bodyDelimiterSuffix":
          this.writeDelimiterSuffix(bytes[position]!);
          position += 1;
          break;
        case "final":
          this.#state = bytes[position] === 0x0d ? "finalCr" : this.invalid();
          position += 1;
          break;
        case "finalCr":
          if (bytes[position] !== 0x0a) this.invalid();
          this.#state = "afterFinal";
          position += 1;
          break;
        case "afterFinal":
          this.invalid();
      }
    }
  }

  finish(): Record<string, string> {
    if (this.#state !== "final" && this.#state !== "afterFinal") this.invalid();
    return this.#fields;
  }

  private writeInitial(bytes: Uint8Array, position: number): number {
    while (position < bytes.byteLength && this.#state === "initial") {
      if (bytes[position] !== this.#initialDelimiter[this.#initialPosition]) this.invalid();
      this.#initialPosition += 1;
      position += 1;
      if (this.#initialPosition === this.#initialDelimiter.byteLength) this.#state = "initialSuffix";
    }
    return position;
  }

  private writeInitialSuffix(byte: number): void {
    this.#initialSuffix[this.#initialSuffixLength] = byte;
    this.#initialSuffixLength += 1;
    if (this.#initialSuffixLength !== 2) return;
    if (this.#initialSuffix[0] === 0x2d && this.#initialSuffix[1] === 0x2d) {
      this.#state = "final";
      return;
    }
    if (this.#initialSuffix[0] === 0x0d && this.#initialSuffix[1] === 0x0a) {
      this.startHeaders();
      return;
    }
    this.invalid();
  }

  private writeHeaderByte(byte: number): void {
    if (this.#headerLength === this.#header.byteLength) this.invalid();
    this.#header[this.#headerLength] = byte;
    this.#headerLength += 1;
    if (
      this.#headerLength >= 4 &&
      this.#header[this.#headerLength - 4] === 0x0d &&
      this.#header[this.#headerLength - 3] === 0x0a &&
      this.#header[this.#headerLength - 2] === 0x0d &&
      this.#header[this.#headerLength - 1] === 0x0a
    ) {
      this.startPart(this.#header.subarray(0, this.#headerLength - 4));
    }
  }

  private writeBody(bytes: Uint8Array, position: number): number {
    while (position < bytes.byteLength && this.#state === "body") {
      if (this.#bodyCandidateLength === 0) {
        const carriageReturn = bytes.indexOf(0x0d, position);
        if (carriageReturn === -1) {
          this.currentValue().write(bytes, position);
          return bytes.byteLength;
        }
        if (carriageReturn > position) {
          this.currentValue().write(bytes, position, carriageReturn);
          position = carriageReturn;
        }
      }
      this.writeBodyByte(bytes[position]!);
      position += 1;
    }
    return position;
  }

  private writeBodyByte(byte: number): void {
    if (this.#bodyCandidateLength === 0) {
      if (byte === this.#boundaryDelimiter[0]) {
        this.#bodyCandidate[0] = byte;
        this.#bodyCandidateLength = 1;
      } else {
        this.currentValue().writeByte(byte);
      }
      return;
    }

    if (byte === this.#boundaryDelimiter[this.#bodyCandidateLength]) {
      this.#bodyCandidate[this.#bodyCandidateLength] = byte;
      this.#bodyCandidateLength += 1;
      if (this.#bodyCandidateLength === this.#bodyCandidate.byteLength) {
        this.#delimiterSuffixLength = 0;
        this.#state = "bodyDelimiterSuffix";
      }
      return;
    }

    this.currentValue().write(this.#bodyCandidate, 0, this.#bodyCandidateLength);
    this.#bodyCandidateLength = 0;
    this.writeBodyByte(byte);
  }

  private writeDelimiterSuffix(byte: number): void {
    this.#delimiterSuffix[this.#delimiterSuffixLength] = byte;
    this.#delimiterSuffixLength += 1;
    if (this.#delimiterSuffixLength !== 2) return;

    if (this.#delimiterSuffix[0] === 0x2d && this.#delimiterSuffix[1] === 0x2d) {
      this.completePart();
      this.#state = "final";
      return;
    }
    if (this.#delimiterSuffix[0] === 0x0d && this.#delimiterSuffix[1] === 0x0a) {
      this.completePart();
      this.startHeaders();
      return;
    }

    this.currentValue().write(this.#boundaryDelimiter);
    const first = this.#delimiterSuffix[0]!;
    const second = this.#delimiterSuffix[1]!;
    this.#bodyCandidateLength = 0;
    this.#state = "body";
    this.writeBodyByte(first);
    this.writeBodyByte(second);
  }

  private startHeaders(): void {
    this.#headerLength = 0;
    this.#state = "headers";
  }

  private startPart(header: Uint8Array): void {
    const { name, file } = parsePartHeaders(header);
    if (file) throw validationError(name, "Must be a string.");
    if (!isFieldName(name)) throw validationError(name, "Unknown field.");
    if (Object.hasOwn(this.#fields, name)) throw validationError(name, "Duplicate field.");
    this.#currentField = name;
    this.#currentValue = new TextFieldBuffer(name, fieldLimits[name]);
    this.#bodyCandidateLength = 0;
    this.#state = "body";
  }

  private completePart(): void {
    const field = this.#currentField;
    if (field === undefined) this.invalid();
    Object.defineProperty(this.#fields, field, {
      configurable: true,
      enumerable: true,
      value: this.currentValue().finish(),
      writable: true,
    });
    this.#currentField = undefined;
    this.#currentValue = undefined;
    this.#bodyCandidateLength = 0;
  }

  private currentValue(): TextFieldBuffer {
    if (this.#currentValue === undefined) this.invalid();
    return this.#currentValue;
  }

  private invalid(): never {
    throw badRequest();
  }
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // Preserve the parser error that caused cancellation.
  }
}

/** Reads one multipart request stream and returns the textual paste-create fields. */
export async function parseMultipartCreateFields(request: Request, boundary: string): Promise<Record<string, string>> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && !/^\d+$/.test(contentLength)) {
    await cancelBody(request.body);
    throw badRequest();
  }
  if (contentLength !== null && BigInt(contentLength) > BigInt(wireBodyLimit)) {
    await cancelBody(request.body);
    throw requestTooLarge();
  }

  const body = request.body;
  const parser = new MultipartCreateParser(boundary);
  if (body === null) return parser.finish();

  const reader = body.getReader();
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return parser.finish();
      if (value === undefined) continue;
      const prefixLength = Math.min(value.byteLength, wireBodyLimit - length);
      parser.write(value.subarray(0, prefixLength));
      length += prefixLength;
      if (prefixLength !== value.byteLength) throw requestTooLarge();
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the parser error that caused cancellation.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}
