import { PasteError } from "./types";

const maxRequestBytes = 67_108_864;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

function validationError(field: string, message: string): PasteError {
  return new PasteError("VALIDATION_FAILED", 422, undefined, {
    fields: [{ field, message }],
  });
}

export async function readLimitedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(contentLength)) throw new PasteError("BAD_REQUEST", 400);
    if (Number(contentLength) > maxBytes) {
      throw new PasteError("REQUEST_TOO_LARGE", 413, undefined, { maxBytes });
    }
  }

  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new PasteError("REQUEST_TOO_LARGE", 413, undefined, { maxBytes });
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

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
    throw new PasteError("BAD_REQUEST", 400);
  }
}

class StrictJsonParser {
  #position = 0;

  constructor(private readonly source: string) {}

  parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.#position !== this.source.length) this.invalid();
    return value;
  }

  private parseValue(): JsonValue {
    switch (this.source[this.#position]) {
      case "{":
        return this.parseObject();
      case "[":
        return this.parseArray();
      case '"':
        return this.parseString();
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.parseLiteral("null", null);
      default:
        return this.parseNumber();
    }
  }

  private parseObject(): JsonObject {
    this.expect("{");
    this.skipWhitespace();
    const result: JsonObject = {};
    const keys = new Set<string>();
    if (this.consume("}")) return result;

    while (true) {
      this.skipWhitespace();
      if (this.source[this.#position] !== '"') this.invalid();
      const key = this.parseString();
      if (keys.has(key)) throw validationError(key, "Duplicate field.");
      keys.add(key);
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      const value = this.parseValue();
      Object.defineProperty(result, key, { enumerable: true, configurable: true, writable: true, value });
      this.skipWhitespace();
      if (this.consume("}")) return result;
      this.expect(",");
    }
  }

  private parseArray(): JsonValue[] {
    this.expect("[");
    this.skipWhitespace();
    const result: JsonValue[] = [];
    if (this.consume("]")) return result;

    while (true) {
      this.skipWhitespace();
      result.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume("]")) return result;
      this.expect(",");
    }
  }

  private parseString(): string {
    this.expect('"');
    let result = "";
    while (this.#position < this.source.length) {
      const character = this.source[this.#position++];
      if (character === '"') return result;
      if (character === "\\") {
        const escape = this.source[this.#position++];
        switch (escape) {
          case '"':
          case "\\":
          case "/":
            result += escape;
            break;
          case "b":
            result += "\b";
            break;
          case "f":
            result += "\f";
            break;
          case "n":
            result += "\n";
            break;
          case "r":
            result += "\r";
            break;
          case "t":
            result += "\t";
            break;
          case "u": {
            const hexadecimal = this.source.slice(this.#position, this.#position + 4);
            if (!/^[\da-fA-F]{4}$/.test(hexadecimal)) this.invalid();
            this.#position += 4;
            result += String.fromCharCode(Number.parseInt(hexadecimal, 16));
            break;
          }
          default:
            this.invalid();
        }
      } else {
        if (character === undefined || character.charCodeAt(0) <= 0x1f) this.invalid();
        result += character;
      }
    }
    this.invalid();
  }

  private parseLiteral<T extends null | boolean>(literal: string, value: T): T {
    if (this.source.slice(this.#position, this.#position + literal.length) !== literal) this.invalid();
    this.#position += literal.length;
    return value;
  }

  private parseNumber(): number {
    const start = this.#position;
    if (this.consume("-")) {
      if (this.#position === this.source.length) this.invalid();
    }

    if (this.consume("0")) {
      // A following digit is rejected by the enclosing delimiter check.
    } else {
      const first = this.source[this.#position];
      if (first === undefined || first < "1" || first > "9") this.invalid();
      this.#position += 1;
      while (this.isDigit(this.source[this.#position])) this.#position += 1;
    }

    if (this.consume(".")) {
      if (!this.isDigit(this.source[this.#position])) this.invalid();
      while (this.isDigit(this.source[this.#position])) this.#position += 1;
    }

    if (this.source[this.#position] === "e" || this.source[this.#position] === "E") {
      this.#position += 1;
      if (this.source[this.#position] === "+" || this.source[this.#position] === "-") this.#position += 1;
      if (!this.isDigit(this.source[this.#position])) this.invalid();
      while (this.isDigit(this.source[this.#position])) this.#position += 1;
    }

    return Number(this.source.slice(start, this.#position));
  }

  private skipWhitespace(): void {
    while (true) {
      const character = this.source[this.#position];
      if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r") return;
      this.#position += 1;
    }
  }

  private consume(character: string): boolean {
    if (this.source[this.#position] !== character) return false;
    this.#position += 1;
    return true;
  }

  private expect(character: string): void {
    if (!this.consume(character)) this.invalid();
  }

  private isDigit(character: string | undefined): boolean {
    return character !== undefined && character >= "0" && character <= "9";
  }

  private invalid(): never {
    throw new PasteError("BAD_REQUEST", 400);
  }
}

export async function parseStrictJsonObject(request: Request, allowedKeys: ReadonlySet<string>): Promise<JsonObject> {
  const value = new StrictJsonParser(decodeUtf8(await readLimitedBytes(request, maxRequestBytes))).parse();
  if (value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw validationError("body", "Expected a JSON object.");
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw validationError(key, "Unknown field.");
  }
  return value as JsonObject;
}
