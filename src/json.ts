import { PasteError } from "./types";

const maxRequestBytes = 67_108_864;
const maxJsonDepth = 256;
const tokenBlockLength = 8_192;
const retainedContainerUnits = 256;
const retainedKeyUnits = 32;

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

// Safe expiration results are at least 60, where a binary64 rounding midpoint needs no more than 48 decimal places.
const retainedSignificantDigits = 64;
const maxTrackedExponent = 1_000_000_000;

export class BoundedDecimalNumberAccumulator implements StrictJsonNumberAccumulator {
  #coefficientDigits = 0;
  #decimalPosition = 0;
  #exponentMagnitude = 0;
  #exponentNegative = false;
  #firstSignificantPosition = 0;
  #fraction = false;
  #guard = "";
  #inExponent = false;
  #negative = false;
  #prefix = "";
  #sticky = false;

  append(source: string, start: number, end: number): void {
    for (let position = start; position < end; position += 1) {
      const character = source[position]!;
      if (this.#inExponent) {
        if (character === "+" || character === "-") {
          this.#exponentNegative = character === "-";
        } else {
          this.#exponentMagnitude = Math.min(maxTrackedExponent, this.#exponentMagnitude * 10 + Number(character));
        }
        continue;
      }
      if (character === "-") {
        this.#negative = true;
      } else if (character === ".") {
        this.#fraction = true;
      } else if (character === "e" || character === "E") {
        this.#inExponent = true;
      } else {
        this.#coefficientDigits += 1;
        if (!this.#fraction) this.#decimalPosition += 1;
        if (this.#firstSignificantPosition === 0 && character !== "0") {
          this.#firstSignificantPosition = this.#coefficientDigits;
        }
        if (this.#firstSignificantPosition !== 0) this.appendSignificant(character);
      }
    }
  }

  finish(): number {
    if (this.#firstSignificantPosition === 0) return this.#negative ? -0 : 0;

    const exponent = this.#exponentNegative ? -this.#exponentMagnitude : this.#exponentMagnitude;
    const scientificExponent = this.saturatingAdd(
      this.saturatingAdd(this.#decimalPosition, exponent),
      -this.#firstSignificantPosition,
    );
    // A nonzero tail only changes a safe-result midpoint when it lies at this retained boundary.
    const significand = `${this.#prefix}${this.#guard}${this.#sticky ? "1" : ""}`;
    const scale = scientificExponent - significand.length + 1;
    return Number(`${this.#negative ? "-" : ""}${significand}e${scale}`);
  }

  private appendSignificant(character: string): void {
    if (this.#prefix.length < retainedSignificantDigits) {
      this.#prefix += character;
    } else if (this.#guard === "") {
      this.#guard = character;
    } else if (character !== "0") {
      this.#sticky = true;
    }
  }

  private saturatingAdd(left: number, right: number): number {
    if (right > maxTrackedExponent - left) return maxTrackedExponent;
    if (right < -maxTrackedExponent - left) return -maxTrackedExponent;
    return left + right;
  }
}

export const impossibleOpaqueMatch: unique symbol = Symbol("impossible opaque match");

type JsonValue = null | boolean | number | string | typeof impossibleOpaqueMatch | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export type StrictJsonKind = "array" | "boolean" | "null" | "number" | "object" | "string";

const objectRootKind = new Set<StrictJsonKind>(["object"]);

export type StrictJsonOpaqueStringPolicy = {
  maxCodeUnits: number;
  canContinue: (prefix: string, next: string) => boolean;
  isComplete: (value: string) => boolean;
};

export type StrictJsonNumberAccumulator = {
  append: (source: string, start: number, end: number) => void;
  finish: () => number;
};

export type StrictJsonParsePolicy = {
  maxRetainedCodeUnits: number;
  maxTopLevelKeyCodeUnits: number;
  topLevelStringMaxCodeUnits: ReadonlyMap<string, number>;
  onStringLimit: (field: string) => PasteError;
  onRetainedLimit: () => PasteError;
  expectedTopLevelKinds?: ReadonlyMap<string, ReadonlySet<StrictJsonKind>>;
  onUnexpectedTopLevelKind?: (field: string) => PasteError;
  topLevelNumberMaxCodeUnits?: ReadonlyMap<string, number>;
  topLevelNumberAccumulators?: ReadonlyMap<string, () => StrictJsonNumberAccumulator>;
  topLevelUtf8ByteMax?: ReadonlyMap<string, number>;
  topLevelOpaqueStrings?: ReadonlyMap<string, StrictJsonOpaqueStringPolicy>;
  topLevelOpaqueStringComparisons?: ReadonlyMap<string, string>;
};

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
type ArrayFrame = { discard: boolean; kind: "array"; state: "valueOrEnd" | "value" | "commaOrEnd"; value: JsonValue[] };
type ObjectFrame = {
  discard: boolean;
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

function validateContentLength(request: Request, maxBytes: number): number | undefined {
  const contentLength = request.headers.get("content-length");
  if (contentLength === null) return undefined;
  if (!/^\d+$/.test(contentLength)) throw badRequest();
  const length = Number(contentLength);
  if (length > maxBytes) throw requestTooLarge(maxBytes);
  return length;
}

async function visitLimitedBytes(
  request: Request,
  maxBytes: number,
  visit: (chunk: Uint8Array) => void,
  onNonEmpty?: () => void,
): Promise<boolean> {
  let announcedNonEmpty = false;
  try {
    const contentLength = validateContentLength(request, maxBytes);
    if (contentLength !== undefined && contentLength > 0) {
      onNonEmpty?.();
      announcedNonEmpty = true;
    }
  } catch (error) {
    await cancelBody(request.body);
    throw error;
  }

  if (request.body === null) return false;

  const reader = request.body.getReader();
  let hasBytes = false;
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return hasBytes;
      if (!hasBytes && value.byteLength > 0) {
        if (!announcedNonEmpty) onNonEmpty?.();
        hasBytes = true;
      }
      const acceptedLength = Math.min(value.byteLength, maxBytes - length);
      if (acceptedLength > 0) visit(value.subarray(0, acceptedLength));
      length += acceptedLength;
      if (acceptedLength !== value.byteLength) throw requestTooLarge(maxBytes);
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
  #allowedTopLevelKeys: ReadonlySet<string> | undefined;
  #deferredError: PasteError | undefined;
  #deferredUnknownKey: string | undefined;
  #frameStack: Frame[] = [];
  #hasRoot = false;
  #literal = "";
  #literalIndex = 0;
  #literalValue: boolean | null = null;
  #number = new FlatTextBuffer();
  #numberAccumulator: StrictJsonNumberAccumulator | undefined;
  #numberDiscarded = false;
  #numberLength = 0;
  #numberLimit: number | undefined;
  #numberLimitField: string | undefined;
  #numberState: NumberState = "minus";
  #policy: StrictJsonParsePolicy | undefined;
  #retainedCodeUnits = 0;
  #root: JsonValue | undefined;
  #rootKinds: ReadonlySet<StrictJsonKind>;
  #state: ParserState = "normal";
  #string = new FlatTextBuffer();
  #stringByteLimit: number | undefined;
  #stringDiscarded = false;
  #stringField: string | undefined;
  #stringIsKey = false;
  #stringKeyHash = 2_166_136_261;
  #stringKeyTooLong = false;
  #stringLength = 0;
  #stringMatchesDeferredUnknownKey = false;
  #stringTopLevelKeyCandidates: Set<string> | undefined;
  #stringLimit: number | undefined;
  #stringLimitField: string | undefined;
  #stringOpaque: StrictJsonOpaqueStringPolicy | undefined;
  #stringOpaqueComparison: string | undefined;
  #stringOpaqueComparisonMatches = true;
  #stringOpaqueImpossible = false;
  #stringOpaquePrefix = "";
  #stringPendingHighSurrogate = false;
  #stringStoredLength = 0;
  #stringUtf8Bytes = 0;
  #unicode = "";

  constructor(
    allowedTopLevelKeys?: ReadonlySet<string>,
    policy?: StrictJsonParsePolicy,
    rootKinds: ReadonlySet<StrictJsonKind> = objectRootKind,
  ) {
    this.#allowedTopLevelKeys = allowedTopLevelKeys;
    this.#policy = policy;
    this.#rootKinds = rootKinds;
  }

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
    if (this.#deferredError !== undefined) throw this.#deferredError;
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
    if (end > position) this.appendString(source, position, end);
    if (end === source.length) return end;

    const character = source[end]!;
    if (character === '"') {
      const value = this.finishString();
      this.#state = "normal";
      if (typeof value === "string") this.acceptString(value);
      else this.acceptValue(value);
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
        this.appendString(character);
        this.#state = "string";
        return position + 1;
      case "b":
        this.appendString("\b");
        this.#state = "string";
        return position + 1;
      case "f":
        this.appendString("\f");
        this.#state = "string";
        return position + 1;
      case "n":
        this.appendString("\n");
        this.#state = "string";
        return position + 1;
      case "r":
        this.appendString("\r");
        this.#state = "string";
        return position + 1;
      case "t":
        this.appendString("\t");
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
      this.appendString(String.fromCharCode(Number.parseInt(this.#unicode, 16)));
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
    const length = end - start;
    if (this.#numberLimit !== undefined && this.#numberLength > this.#numberLimit - length) {
      throw this.#policy!.onStringLimit(this.#numberLimitField!);
    }
    if (!this.#numberDiscarded) {
      if (this.#numberAccumulator !== undefined) {
        this.#numberAccumulator.append(source, start, end);
      } else {
        this.retain(length);
        this.#number.append(source, start, end);
      }
    }
    this.#numberLength += length;
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
    this.assertRootKind(kind);
    this.assertValueExpected();
    this.assertTopLevelKind(kind);
    if (this.#frameStack.length >= maxJsonDepth) this.invalid();
    const discard = this.isDiscardingValue();
    if (!discard) this.retain(retainedContainerUnits);
    if (kind === "array") {
      this.#frameStack.push({ discard, kind, state: "valueOrEnd", value: [] });
    } else {
      this.#frameStack.push({ discard, kind, key: undefined, keys: new Set(), state: "keyOrEnd", value: {} });
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
      if (this.#stringDiscarded) {
        let allowedKey: string | undefined;
        for (const candidate of this.#stringTopLevelKeyCandidates ?? []) {
          if (candidate.length === this.#stringLength) {
            allowedKey = candidate;
            break;
          }
        }
        if (allowedKey !== undefined) {
          if (frame.keys.has(allowedKey)) throw validationError(allowedKey, "Duplicate field.");
          this.retain(retainedKeyUnits);
          frame.keys.add(allowedKey);
          frame.key = allowedKey;
          frame.state = "colon";
          return;
        }
        if (this.#stringMatchesDeferredUnknownKey && this.#stringLength === this.#deferredUnknownKey!.length) {
          this.#deferredError = validationError(this.#deferredUnknownKey!, "Duplicate field.");
        }
        frame.key = "";
        frame.state = "colon";
        return;
      }
      const topLevel = this.#frameStack.length === 1;
      const unknown = topLevel && this.#policy !== undefined && !this.#allowedTopLevelKeys?.has(value);
      if (frame.keys.has(value)) {
        if (unknown) {
          this.#deferredError = validationError(this.#stringKeyTooLong ? "body" : value, "Duplicate field.");
        } else {
          throw validationError(value, "Duplicate field.");
        }
      } else {
        this.retain(retainedKeyUnits);
        frame.keys.add(value);
      }
      if (unknown && this.#deferredError === undefined) {
        this.#deferredError = validationError(this.#stringKeyTooLong ? "body" : value, "Unknown field.");
        if (!this.#stringKeyTooLong) this.#deferredUnknownKey = value;
      }
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
      if (!frame.discard) {
        this.retain(retainedContainerUnits);
        frame.value.push(value);
      }
      frame.state = "commaOrEnd";
      return;
    }

    if (frame.state !== "value" || frame.key === undefined) this.invalid();
    if (!this.isDiscardingValue()) {
      this.retain(retainedContainerUnits);
      Object.defineProperty(frame.value, frame.key, { enumerable: true, configurable: true, writable: true, value });
    }
    frame.key = undefined;
    frame.state = "commaOrEnd";
  }

  private topLevelValueField(): string | undefined {
    const frame = this.#frameStack.at(-1);
    return this.#frameStack.length === 1 && frame?.kind === "object" && frame.state === "value"
      ? frame.key
      : undefined;
  }

  private isDiscardingValue(): boolean {
    const frame = this.#frameStack.at(-1);
    if (frame === undefined) return false;
    if (frame.discard) return true;
    const field = this.topLevelValueField();
    return this.#policy !== undefined && field !== undefined && !this.#allowedTopLevelKeys?.has(field);
  }

  private assertTopLevelKind(kind: StrictJsonKind): void {
    const field = this.topLevelValueField();
    if (field === undefined || !this.#allowedTopLevelKeys?.has(field)) return;
    const expected = this.#policy?.expectedTopLevelKinds?.get(field);
    if (expected !== undefined && !expected.has(kind)) {
      throw this.#policy?.onUnexpectedTopLevelKind?.(field) ?? badRequest();
    }
  }

  private assertRootKind(kind: StrictJsonKind): void {
    if (this.#frameStack.length === 0 && !this.#hasRoot && !this.#rootKinds.has(kind)) {
      throw validationError("body", "Expected a JSON object.");
    }
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
    this.#stringByteLimit = undefined;
    this.#stringDiscarded = false;
    this.#stringField = undefined;
    this.#stringIsKey = false;
    this.#stringKeyHash = 2_166_136_261;
    this.#stringKeyTooLong = false;
    this.#stringLength = 0;
    this.#stringMatchesDeferredUnknownKey = false;
    this.#stringTopLevelKeyCandidates = undefined;
    this.#stringLimit = undefined;
    this.#stringLimitField = undefined;
    this.#stringOpaque = undefined;
    this.#stringOpaqueComparison = undefined;
    this.#stringOpaqueComparisonMatches = true;
    this.#stringOpaqueImpossible = false;
    this.#stringOpaquePrefix = "";
    this.#stringPendingHighSurrogate = false;
    this.#stringStoredLength = 0;
    this.#stringUtf8Bytes = 0;

    const policy = this.#policy;
    const frame = this.#frameStack.at(-1);
    this.#stringIsKey = frame?.kind === "object" && (frame.state === "keyOrEnd" || frame.state === "key");
    if (this.#stringIsKey) {
      this.#stringDiscarded = frame!.discard || (this.#frameStack.length === 1 && this.#deferredError !== undefined);
      this.#stringMatchesDeferredUnknownKey = this.#stringDiscarded && this.#frameStack.length === 1 && this.#deferredUnknownKey !== undefined;
      if (this.#stringDiscarded && this.#frameStack.length === 1) {
        this.#stringTopLevelKeyCandidates = new Set(this.#allowedTopLevelKeys);
      }
    } else {
      this.assertRootKind("string");
      this.assertValueExpected();
      this.assertTopLevelKind("string");
      this.#stringDiscarded = this.isDiscardingValue();
    }
    if (policy !== undefined && frame?.kind === "object" && this.#frameStack.length === 1 && !this.#stringIsKey && frame.key !== undefined && this.#allowedTopLevelKeys?.has(frame.key)) {
      this.#stringField = frame.key;
      this.#stringOpaque = policy.topLevelOpaqueStrings?.get(frame.key);
      this.#stringOpaqueComparison = policy.topLevelOpaqueStringComparisons?.get(frame.key);
      this.#stringByteLimit = this.#stringOpaque === undefined ? policy.topLevelUtf8ByteMax?.get(frame.key) : undefined;
      const limit = this.#stringOpaque === undefined ? policy.topLevelStringMaxCodeUnits.get(frame.key) : undefined;
      if (this.#stringByteLimit === undefined && limit !== undefined) {
        this.#stringLimit = limit;
        this.#stringLimitField = frame.key;
      }
    }
    this.#state = "string";
  }

  private appendString(source: string, start = 0, end = source.length): void {
    const length = end - start;
    if (this.#stringLimit !== undefined && this.#stringLength > this.#stringLimit - length) {
      throw this.#policy!.onStringLimit(this.#stringLimitField!);
    }
    if (this.#stringByteLimit !== undefined) this.countStringUtf8Bytes(source, start, end);
    if (this.#stringOpaqueComparison !== undefined && this.#stringOpaqueComparisonMatches) {
      for (let position = start; position < end; position += 1) {
        if (source.charCodeAt(position) !== this.#stringOpaqueComparison.charCodeAt(this.#stringLength + position - start)) {
          this.#stringOpaqueComparisonMatches = false;
          break;
        }
      }
    }
    for (const candidate of this.#stringTopLevelKeyCandidates ?? []) {
      for (let position = start; position < end; position += 1) {
        if (source.charCodeAt(position) !== candidate.charCodeAt(this.#stringLength + position - start)) {
          this.#stringTopLevelKeyCandidates!.delete(candidate);
          break;
        }
      }
    }
    if (this.#stringMatchesDeferredUnknownKey) {
      const expected = this.#deferredUnknownKey!;
      for (let position = start; position < end; position += 1) {
        if (source.charCodeAt(position) !== expected.charCodeAt(this.#stringLength + position - start)) {
          this.#stringMatchesDeferredUnknownKey = false;
          break;
        }
      }
    }
    if (this.#stringIsKey && !this.#stringDiscarded) {
      for (let position = start; position < end; position += 1) {
        this.#stringKeyHash = Math.imul(this.#stringKeyHash ^ source.charCodeAt(position), 16_777_619) >>> 0;
      }
    }
    this.#stringLength += length;
    if (this.#stringOpaque !== undefined) {
      this.appendOpaqueString(source, start, end);
      return;
    }
    if (this.#stringDiscarded) return;

    let capturedEnd = end;
    if (this.#stringIsKey && this.#policy !== undefined) {
      const remaining = this.#policy.maxTopLevelKeyCodeUnits - this.#stringStoredLength;
      if (remaining <= 0) {
        this.#stringKeyTooLong = true;
        return;
      }
      capturedEnd = Math.min(end, start + remaining);
      if (capturedEnd !== end) this.#stringKeyTooLong = true;
    }
    if (capturedEnd === start) return;
    this.retain(capturedEnd - start);
    this.#string.append(source, start, capturedEnd);
    this.#stringStoredLength += capturedEnd - start;
  }

  private appendOpaqueString(source: string, start: number, end: number): void {
    const opaque = this.#stringOpaque!;
    for (let position = start; position < end; position += 1) {
      if (this.#stringOpaqueImpossible) return;
      const next = source[position]!;
      if (
        this.#stringOpaquePrefix.length === opaque.maxCodeUnits ||
        !opaque.canContinue(this.#stringOpaquePrefix, next)
      ) {
        this.#stringOpaqueImpossible = true;
        return;
      }
      this.retain(1);
      this.#stringOpaquePrefix += next;
    }
  }

  private finishString(): string | typeof impossibleOpaqueMatch {
    if (this.#stringByteLimit !== undefined && this.#stringPendingHighSurrogate) {
      throw validationError(this.#stringField!, "Must contain only Unicode scalar values.");
    }
    if (this.#stringOpaque !== undefined) {
      const value = this.#stringOpaquePrefix;
      this.#string.reset();
      if (this.#stringOpaqueComparison !== undefined) {
        if (this.#stringLength !== this.#stringOpaqueComparison.length) this.#stringOpaqueComparisonMatches = false;
        if (this.#stringOpaqueComparisonMatches) return this.#stringOpaqueComparison;
      }
      return this.#stringOpaqueImpossible || !this.#stringOpaque.isComplete(value) ? impossibleOpaqueMatch : value;
    }
    const value = this.#string.finish();
    return this.#stringIsKey && this.#stringKeyTooLong
      ? `${String.fromCharCode(0)}long-key:${this.#stringLength}:${this.#stringKeyHash}`
      : value;
  }

  private countStringUtf8Bytes(source: string, start: number, end: number): void {
    for (let position = start; position < end; position += 1) {
      const code = source.charCodeAt(position);
      if (this.#stringPendingHighSurrogate) {
        if (code < 0xdc00 || code > 0xdfff) {
          throw validationError(this.#stringField!, "Must contain only Unicode scalar values.");
        }
        this.#stringPendingHighSurrogate = false;
        this.addStringUtf8Bytes(4);
        continue;
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        this.#stringPendingHighSurrogate = true;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        throw validationError(this.#stringField!, "Must contain only Unicode scalar values.");
      }
      this.addStringUtf8Bytes(code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3);
    }
  }

  private addStringUtf8Bytes(bytes: number): void {
    if (bytes > this.#stringByteLimit! - this.#stringUtf8Bytes) {
      throw this.#policy!.onStringLimit(this.#stringField!);
    }
    this.#stringUtf8Bytes += bytes;
  }

  private retain(codeUnits: number): void {
    const policy = this.#policy;
    if (policy === undefined) return;
    if (codeUnits > policy.maxRetainedCodeUnits - this.#retainedCodeUnits) throw policy.onRetainedLimit();
    this.#retainedCodeUnits += codeUnits;
  }

  private startNumber(source: string, position: number): number {
    this.assertRootKind("number");
    this.assertValueExpected();
    this.assertTopLevelKind("number");
    const character = source[position]!;
    const field = this.topLevelValueField();
    this.#number.reset();
    this.#numberDiscarded = this.isDiscardingValue();
    this.#numberAccumulator = this.#numberDiscarded || field === undefined || !this.#allowedTopLevelKeys?.has(field)
      ? undefined
      : this.#policy?.topLevelNumberAccumulators?.get(field)?.();
    this.#numberLength = 0;
    this.#numberLimit = this.#numberAccumulator === undefined && field !== undefined && this.#allowedTopLevelKeys?.has(field)
      ? this.#policy?.topLevelNumberMaxCodeUnits?.get(field)
      : undefined;
    this.#numberLimitField = field;
    this.#numberState = character === "-" ? "minus" : character === "0" ? "zero" : "integer";
    this.#state = "number";
    this.appendNumber(source, position, position + 1, this.#numberState);
    return position + 1 === source.length ? source.length : this.readNumber(source, position + 1);
  }

  private finishNumber(): void {
    if (this.#numberState !== "zero" && this.#numberState !== "integer" && this.#numberState !== "fraction" && this.#numberState !== "exponent") {
      this.invalid();
    }
    const value = this.#numberDiscarded ? 0 : this.#numberAccumulator?.finish() ?? Number(this.#number.finish());
    this.#state = "normal";
    this.acceptValue(value);
  }

  private startLiteral(literal: string, value: boolean | null): void {
    this.assertRootKind(value === null ? "null" : "boolean");
    this.assertValueExpected();
    this.assertTopLevelKind(value === null ? "null" : "boolean");
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

type Utf8DecodeState = { pending: Uint8Array };

type Utf8Prefix = { length: number; malformed: boolean };

function appendUtf8Pending(pending: Uint8Array, bytes: Uint8Array): Uint8Array {
  if (pending.byteLength === 0) return bytes;
  const source = new Uint8Array(pending.byteLength + bytes.byteLength);
  source.set(pending);
  source.set(bytes, pending.byteLength);
  return source;
}

function validUtf8Prefix(bytes: Uint8Array): Utf8Prefix {
  let position = 0;
  while (position < bytes.byteLength) {
    const first = bytes[position]!;
    let length = 1;
    let secondMinimum = 0x80;
    let secondMaximum = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) {
      length = 2;
    } else if (first === 0xe0) {
      length = 3;
      secondMinimum = 0xa0;
    } else if ((first >= 0xe1 && first <= 0xec) || (first >= 0xee && first <= 0xef)) {
      length = 3;
    } else if (first === 0xed) {
      length = 3;
      secondMaximum = 0x9f;
    } else if (first === 0xf0) {
      length = 4;
      secondMinimum = 0x90;
    } else if (first >= 0xf1 && first <= 0xf3) {
      length = 4;
    } else if (first === 0xf4) {
      length = 4;
      secondMaximum = 0x8f;
    } else if (first > 0x7f) {
      return { length: position, malformed: true };
    }

    const available = Math.min(length, bytes.byteLength - position);
    for (let offset = 1; offset < available; offset += 1) {
      const byte = bytes[position + offset]!;
      if (byte < (offset === 1 ? secondMinimum : 0x80) || byte > (offset === 1 ? secondMaximum : 0xbf)) {
        return { length: position, malformed: true };
      }
    }
    if (available < length) return { length: position, malformed: false };
    position += length;
  }
  return { length: position, malformed: false };
}

function decodeChunk(
  decoder: TextDecoder,
  state: Utf8DecodeState,
  bytes: Uint8Array,
  stream: boolean,
  write: (source: string) => void,
): void {
  if (!stream) {
    let source: string;
    try {
      source = decoder.decode(appendUtf8Pending(state.pending, bytes));
    } catch {
      throw badRequest();
    }
    write(source);
    return;
  }
  for (let start = 0; start < bytes.byteLength; start += tokenBlockLength) {
    const input = appendUtf8Pending(state.pending, bytes.subarray(start, Math.min(start + tokenBlockLength, bytes.byteLength)));
    const prefix = validUtf8Prefix(input);
    let source: string;
    try {
      source = decoder.decode(input.subarray(0, prefix.length), { stream: true });
    } catch {
      throw badRequest();
    }
    write(source);
    if (prefix.malformed) throw badRequest();
    state.pending = input.slice(prefix.length);
  }
}

async function parseStrictJsonValue(
  request: Request,
  allowedKeys: ReadonlySet<string> | undefined,
  rootKinds: ReadonlySet<StrictJsonKind>,
  allowEmpty: boolean,
  onNonEmpty?: () => void,
  policy?: StrictJsonParsePolicy,
): Promise<JsonValue | undefined> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const state: Utf8DecodeState = { pending: new Uint8Array() };
  const parser = new StrictJsonParser(allowedKeys, policy, rootKinds);
  const hasBytes = await visitLimitedBytes(request, maxRequestBytes, (chunk) => {
    decodeChunk(decoder, state, chunk, true, (source) => parser.write(source));
  }, onNonEmpty);
  if (!hasBytes && allowEmpty) return undefined;
  decodeChunk(decoder, state, new Uint8Array(), false, (source) => parser.write(source));
  return parser.finish();
}

export async function parseStrictJson(request: Request, rootKinds: ReadonlySet<StrictJsonKind>): Promise<unknown> {
  return (await parseStrictJsonValue(request, undefined, rootKinds, false))!;
}

async function parseStrictJsonObjectValue(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  allowEmpty: boolean,
  onNonEmpty?: () => void,
  policy?: StrictJsonParsePolicy,
): Promise<JsonObject | undefined> {
  const value = await parseStrictJsonValue(request, allowedKeys, objectRootKind, allowEmpty, onNonEmpty, policy);
  if (value === undefined) return undefined;

  if (value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw validationError("body", "Expected a JSON object.");
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw validationError(key, "Unknown field.");
  }
  return value as JsonObject;
}

export async function parseStrictJsonObject(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  policy?: StrictJsonParsePolicy,
): Promise<JsonObject> {
  return (await parseStrictJsonObjectValue(request, allowedKeys, false, undefined, policy))!;
}

export async function parseStrictJsonObjectOrEmpty(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  onNonEmpty: () => void = () => {},
  policy?: StrictJsonParsePolicy,
): Promise<JsonObject | undefined> {
  return parseStrictJsonObjectValue(request, allowedKeys, true, onNonEmpty, policy);
}
