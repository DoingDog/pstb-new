import { PasteError } from "./types";

const maxRequestBytes = 67_108_864;
const maxJsonDepth = 256;
const tokenBlockLength = 8_192;

const whitespace = /[ \t\n\r]+/y;

class FlatTextBuffer {
  #blocks: string[] = [];
  #length = 0;
  #parts: string[] = [];

  append(source: string, start = 0, end = source.length): void {
    while (start < end) {
      const next = Math.min(start + tokenBlockLength - this.#length, end);
      this.#parts.push(source.slice(start, next));
      this.#length += next - start;
      start = next;
      if (this.#length === tokenBlockLength) this.flush();
    }
  }

  finish(): string {
    this.flush();
    const value = this.#blocks.join("");
    this.reset();
    return value;
  }

  reset(): void {
    this.#blocks = [];
    this.#length = 0;
    this.#parts = [];
  }

  private flush(): void {
    if (this.#length === 0) return;
    this.#blocks.push(this.#parts.join(""));
    this.#length = 0;
    this.#parts = [];
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type ParserState = "normal" | "string" | "escape" | "unicode" | "number" | "literal";
type NumberState =
  | "minus"
  | "zero"
  | "integer"
  | "fractionFirst"
  | "fraction"
  | "exponentFirst"
  | "exponentSign"
  | "exponent";
type ArrayFrame = { kind: "array"; state: "valueOrEnd" | "value" | "commaOrEnd"; value: JsonValue[] };
type ObjectFrame = {
  key: string | undefined;
  keys: Set<string>;
  kind: "object";
  state: "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd";
  value: JsonObject;
};
type Frame = ArrayFrame | ObjectFrame;

function validationError(field: string, message: string): PasteError {
  return new PasteError("VALIDATION_FAILED", 422, undefined, {
    fields: [{ field, message }],
  });
}

function badRequest(): PasteError {
  return new PasteError("BAD_REQUEST", 400);
}

function requestTooLarge(maxBytes: number): PasteError {
  return new PasteError("REQUEST_TOO_LARGE", 413, undefined, { maxBytes });
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // Preserve the boundary error that caused cancellation.
  }
}

async function visitLimitedBytes(
  request: Request,
  maxBytes: number,
  visit: (chunk: Uint8Array) => void,
): Promise<void> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && !/^(?:0|[1-9]\d*)$/.test(contentLength)) {
    await cancelBody(request.body);
    throw badRequest();
  }
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    await cancelBody(request.body);
    throw requestTooLarge(maxBytes);
  }

  if (request.body === null) return;

  const reader = request.body.getReader();
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      length += value.byteLength;
      if (length > maxBytes) throw requestTooLarge(maxBytes);
      visit(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the boundary error that caused cancellation.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function readLimitedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  await visitLimitedBytes(request, maxBytes, (chunk) => {
    chunks.push(chunk);
    length += chunk.byteLength;
  });

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw badRequest();
  }
}

class StrictJsonParser {
  #frameStack: Frame[] = [];
  #hasRoot = false;
  #literal = "";
  #literalIndex = 0;
  #literalValue: boolean | null = null;
  #number = new FlatTextBuffer();
  #numberState: NumberState = "minus";
  #root: JsonValue | undefined;
  #state: ParserState = "normal";
  #string = new FlatTextBuffer();
  #unicode = "";

  write(source: string): void {
    let position = 0;
    while (position < source.length) {
      switch (this.#state) {
        case "normal":
          position = this.readNormal(source, position);
          break;
        case "string":
          position = this.readString(source, position);
          break;
        case "escape":
          position = this.readEscape(source, position);
          break;
        case "unicode":
          position = this.readUnicode(source, position);
          break;
        case "number":
          position = this.readNumber(source, position);
          break;
        case "literal":
          position = this.readLiteral(source, position);
          break;
      }
    }
  }

  finish(): JsonValue {
    if (this.#state === "number") {
      this.finishNumber();
    } else if (this.#state !== "normal") {
      this.invalid();
    }
    if (!this.#hasRoot) this.invalid();
    return this.#root!;
  }

  private readNormal(source: string, position: number): number {
    whitespace.lastIndex = position;
    const match = whitespace.exec(source);
    if (match !== null) return whitespace.lastIndex;
    if (this.#hasRoot) this.invalid();

    const character = source[position]!;
    switch (character) {
      case "{":
        this.startContainer("object");
        return position + 1;
      case "[":
        this.startContainer("array");
        return position + 1;
      case "}":
      case "]":
      case ":":
      case ",":
        this.acceptPunctuation(character);
        return position + 1;
      case '"':
        this.startString();
        return position + 1;
      case "t":
        this.startLiteral("true", true);
        return position + 1;
      case "f":
        this.startLiteral("false", false);
        return position + 1;
      case "n":
        this.startLiteral("null", null);
        return position + 1;
      case "-":
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7":
      case "8":
      case "9":
        return this.startNumber(source, position);
      default:
        this.invalid();
    }
  }

  private readString(source: string, position: number): number {
    const end = this.findStringSpecial(source, position);
    if (end > position) this.#string.append(source, position, end);
    if (end === source.length) return end;

    const character = source[end]!;
    if (character === '"') {
      const value = this.finishString();
      this.#state = "normal";
      this.acceptString(value);
    } else if (character === "\\") {
      this.#state = "escape";
    } else {
      this.invalid();
    }
    return end + 1;
  }

  private findStringSpecial(source: string, position: number): number {
    while (position < source.length) {
      const code = source.charCodeAt(position);
      if (code === 0x22 || code === 0x5c || code <= 0x1f) return position;
      position += 1;
    }
    return position;
  }

  private readEscape(source: string, position: number): number {
    const character = source[position]!;
    switch (character) {
      case '"':
      case "\\":
      case "/":
        this.#string.append(character);
        this.#state = "string";
        return position + 1;
      case "b":
        this.#string.append("\b");
        this.#state = "string";
        return position + 1;
      case "f":
        this.#string.append("\f");
        this.#state = "string";
        return position + 1;
      case "n":
        this.#string.append("\n");
        this.#state = "string";
        return position + 1;
      case "r":
        this.#string.append("\r");
        this.#state = "string";
        return position + 1;
      case "t":
        this.#string.append("\t");
        this.#state = "string";
        return position + 1;
      case "u":
        this.#unicode = "";
        this.#state = "unicode";
        return position + 1;
      default:
        this.invalid();
    }
  }

  private readUnicode(source: string, position: number): number {
    const character = source[position]!;
    if (!this.isHexadecimal(character)) this.invalid();
    this.#unicode += character;
    if (this.#unicode.length === 4) {
      this.#string.append(String.fromCharCode(Number.parseInt(this.#unicode, 16)));
      this.#state = "string";
    }
    return position + 1;
  }

  private readNumber(source: string, position: number): number {
    const character = source[position]!;
    switch (this.#numberState) {
      case "minus":
        if (character === "0") return this.appendNumber(source, position, position + 1, "zero");
        if (this.isDigitOneToNine(character)) return this.readNumberDigits(source, position, "integer");
        this.invalid();
      case "zero":
        if (character === ".") return this.appendNumber(source, position, position + 1, "fractionFirst");
        if (character === "e" || character === "E") return this.appendNumber(source, position, position + 1, "exponentFirst");
        if (this.isNumberDelimiter(character)) {
          this.finishNumber();
          return position;
        }
        this.invalid();
      case "integer":
        if (this.isDigit(character)) return this.readNumberDigits(source, position, "integer");
        if (character === ".") return this.appendNumber(source, position, position + 1, "fractionFirst");
        if (character === "e" || character === "E") return this.appendNumber(source, position, position + 1, "exponentFirst");
        if (this.isNumberDelimiter(character)) {
          this.finishNumber();
          return position;
        }
        this.invalid();
      case "fractionFirst":
        if (this.isDigit(character)) return this.readNumberDigits(source, position, "fraction");
        this.invalid();
      case "fraction":
        if (this.isDigit(character)) return this.readNumberDigits(source, position, "fraction");
        if (character === "e" || character === "E") return this.appendNumber(source, position, position + 1, "exponentFirst");
        if (this.isNumberDelimiter(character)) {
          this.finishNumber();
          return position;
        }
        this.invalid();
      case "exponentFirst":
        if (character === "+" || character === "-") return this.appendNumber(source, position, position + 1, "exponentSign");
        if (this.isDigit(character)) return this.readNumberDigits(source, position, "exponent");
        this.invalid();
      case "exponentSign":
        if (this.isDigit(character)) return this.readNumberDigits(source, position, "exponent");
        this.invalid();
      case "exponent":
        if (this.isDigit(character)) return this.readNumberDigits(source, position, "exponent");
        if (this.isNumberDelimiter(character)) {
          this.finishNumber();
          return position;
        }
        this.invalid();
    }
  }

  private appendNumber(source: string, start: number, end: number, state: NumberState): number {
    this.#number.append(source, start, end);
    this.#numberState = state;
    return end;
  }

  private readNumberDigits(source: string, position: number, state: NumberState): number {
    let end = position + 1;
    while (end < source.length && this.isDigit(source[end]!)) end += 1;
    return this.appendNumber(source, position, end, state);
  }

  private readLiteral(source: string, position: number): number {
    if (source[position] !== this.#literal[this.#literalIndex]) this.invalid();
    this.#literalIndex += 1;
    if (this.#literalIndex === this.#literal.length) {
      const value = this.#literalValue;
      this.#state = "normal";
      this.acceptValue(value);
    }
    return position + 1;
  }

  private startContainer(kind: Frame["kind"]): void {
    this.assertValueExpected();
    if (this.#frameStack.length >= maxJsonDepth) this.invalid();
    if (kind === "array") {
      this.#frameStack.push({ kind, state: "valueOrEnd", value: [] });
    } else {
      this.#frameStack.push({ kind, key: undefined, keys: new Set(), state: "keyOrEnd", value: {} });
    }
  }

  private acceptPunctuation(character: "}" | "]" | ":" | ","): void {
    const frame = this.#frameStack.at(-1);
    if (frame === undefined) this.invalid();

    switch (character) {
      case "}":
        if (frame.kind !== "object" || (frame.state !== "keyOrEnd" && frame.state !== "commaOrEnd")) this.invalid();
        this.#frameStack.pop();
        this.acceptValue(frame.value);
        return;
      case "]":
        if (frame.kind !== "array" || (frame.state !== "valueOrEnd" && frame.state !== "commaOrEnd")) this.invalid();
        this.#frameStack.pop();
        this.acceptValue(frame.value);
        return;
      case ":":
        if (frame.kind !== "object" || frame.state !== "colon") this.invalid();
        frame.state = "value";
        return;
      case ",":
        if (frame.state !== "commaOrEnd") this.invalid();
        frame.state = frame.kind === "array" ? "value" : "key";
        return;
    }
  }

  private acceptString(value: string): void {
    const frame = this.#frameStack.at(-1);
    if (frame?.kind === "object" && (frame.state === "keyOrEnd" || frame.state === "key")) {
      if (frame.keys.has(value)) throw validationError(value, "Duplicate field.");
      frame.keys.add(value);
      frame.key = value;
      frame.state = "colon";
      return;
    }
    this.acceptValue(value);
  }

  private acceptValue(value: JsonValue): void {
    const frame = this.#frameStack.at(-1);
    if (frame === undefined) {
      if (this.#hasRoot) this.invalid();
      this.#root = value;
      this.#hasRoot = true;
      return;
    }

    if (frame.kind === "array") {
      if (frame.state !== "valueOrEnd" && frame.state !== "value") this.invalid();
      frame.value.push(value);
      frame.state = "commaOrEnd";
      return;
    }

    if (frame.state !== "value" || frame.key === undefined) this.invalid();
    Object.defineProperty(frame.value, frame.key, { enumerable: true, configurable: true, writable: true, value });
    frame.key = undefined;
    frame.state = "commaOrEnd";
  }

  private assertValueExpected(): void {
    const frame = this.#frameStack.at(-1);
    if (frame === undefined) {
      if (this.#hasRoot) this.invalid();
      return;
    }
    if (frame.kind === "array") {
      if (frame.state === "valueOrEnd" || frame.state === "value") return;
    } else if (frame.state === "value") {
      return;
    }
    this.invalid();
  }

  private startString(): void {
    this.#string.reset();
    this.#state = "string";
  }

  private finishString(): string {
    return this.#string.finish();
  }

  private startNumber(source: string, position: number): number {
    const character = source[position]!;
    this.#number.reset();
    this.#numberState = character === "-" ? "minus" : character === "0" ? "zero" : "integer";
    this.#state = "number";
    this.appendNumber(source, position, position + 1, this.#numberState);
    return position + 1 === source.length ? source.length : this.readNumber(source, position + 1);
  }

  private finishNumber(): void {
    if (this.#numberState !== "zero" && this.#numberState !== "integer" && this.#numberState !== "fraction" && this.#numberState !== "exponent") {
      this.invalid();
    }
    const value = Number(this.#number.finish());
    this.#state = "normal";
    this.acceptValue(value);
  }

  private startLiteral(literal: string, value: boolean | null): void {
    this.#literal = literal;
    this.#literalIndex = 1;
    this.#literalValue = value;
    this.#state = "literal";
  }

  private isNumberDelimiter(character: string): boolean {
    return character === " " || character === "\t" || character === "\n" || character === "\r" || "[]{}:,".includes(character);
  }

  private isDigit(character: string): boolean {
    return character >= "0" && character <= "9";
  }

  private isDigitOneToNine(character: string): boolean {
    return character >= "1" && character <= "9";
  }

  private isHexadecimal(character: string): boolean {
    return /^[\da-fA-F]$/.test(character);
  }

  private invalid(): never {
    throw badRequest();
  }
}

function decodeChunk(decoder: TextDecoder, bytes: Uint8Array, stream: boolean): string {
  try {
    return decoder.decode(bytes, { stream });
  } catch {
    throw badRequest();
  }
}

export async function parseStrictJsonObject(request: Request, allowedKeys: ReadonlySet<string>): Promise<JsonObject> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parser = new StrictJsonParser();
  await visitLimitedBytes(request, maxRequestBytes, (chunk) => {
    parser.write(decodeChunk(decoder, chunk, true));
  });
  parser.write(decodeChunk(decoder, new Uint8Array(), false));

  const value = parser.finish();
  if (value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw validationError("body", "Expected a JSON object.");
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw validationError(key, "Unknown field.");
  }
  return value as JsonObject;
}
