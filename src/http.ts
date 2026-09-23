import { Hono } from "hono";
import { BoundedDecimalNumberAccumulator, impossibleOpaqueMatch, parseStrictJsonObject, parseStrictJsonObjectOrEmpty, type StrictJsonKind, type StrictJsonParsePolicy } from "./json";
import { parseMultipartBoundary, parseMultipartCreateFields } from "./multipart";
import { PasteService, type CreateInput, type UpdateContentInput, type UpdateSettingsInput } from "./pastes";
import { resolveServerLocale } from "./i18n";
import {
  applicationHeaders,
  deriveDownloadHeaders,
  renderCreatePage,
  renderErrorPage,
  renderMarkdownDocument,
  renderPastePage,
  renderPasswordPage,
} from "./render";
import { isPasteError, PasteError, type Env, type LoadedPaste, type PasteResource } from "./types";

const createFields = new Set(["content", "title", "format", "expiration", "password", "viewOnce", "customId"]);
const contentBodyLimit = 10_485_760;
const wireBodyLimit = 67_108_864;
const textPlainUtf8 = "text/plain; charset=utf-8";
const decoderSliceBytes = 8_192;

type ParsedMediaType = { type: string; subtype: string; parameters: Array<{ name: string; value: string }> };

function isHttpOws(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

function skipHttpOws(source: string, position: number): number {
  while (isHttpOws(source[position])) position += 1;
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

function isQuotedPairCharacter(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return code === 0x09 || (code >= 0x20 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
}

function isQuotedText(character: string): boolean {
  const code = character.charCodeAt(0);
  return code === 0x09 || (code >= 0x20 && code <= 0x21) || (code >= 0x23 && code <= 0x5b) || (code >= 0x5d && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
}

function readQuotedString(source: string, position: number): { value: string; position: number } | undefined {
  let value = "";
  position += 1;
  while (position < source.length) {
    const character = source[position]!;
    if (character === '"') return { value, position: position + 1 };
    if (character === "\\") {
      const escaped = source[position + 1];
      if (!isQuotedPairCharacter(escaped)) return undefined;
      value += escaped;
      position += 2;
      continue;
    }
    if (!isQuotedText(character)) return undefined;
    value += character;
    position += 1;
  }
  return undefined;
}

function readParameterValue(source: string, position: number): { value: string; position: number } | undefined {
  return source[position] === '"' ? readQuotedString(source, position) : readToken(source, position);
}

function parseMediaType(value: string | null): ParsedMediaType | undefined {
  if (value === null) return undefined;

  let position = skipHttpOws(value, 0);
  const type = readToken(value, position);
  if (type === undefined || value[type.position] !== "/") return undefined;
  const subtype = readToken(value, type.position + 1);
  if (subtype === undefined) return undefined;
  position = skipHttpOws(value, subtype.position);

  const parameters: ParsedMediaType["parameters"] = [];
  while (value[position] === ";") {
    position = skipHttpOws(value, position + 1);
    const name = readToken(value, position);
    if (name === undefined) return undefined;
    position = skipHttpOws(value, name.position);
    if (value[position] !== "=") return undefined;
    position = skipHttpOws(value, position + 1);
    const parameterValue = readParameterValue(value, position);
    if (parameterValue === undefined) return undefined;
    parameters.push({ name: name.value, value: parameterValue.value });
    position = skipHttpOws(value, parameterValue.position);
  }

  return position === value.length ? { type: type.value, subtype: subtype.value, parameters } : undefined;
}

function hasUtf8MediaType(request: Request, type: string, subtype: string, parameterRequired: boolean): boolean {
  const mediaType = parseMediaType(request.headers.get("content-type"));
  if (mediaType?.type.toLowerCase() !== type || mediaType.subtype.toLowerCase() !== subtype) return false;
  if (mediaType.parameters.length === 0) return !parameterRequired;
  if (mediaType.parameters.length !== 1) return false;
  const parameter = mediaType.parameters[0]!;
  return parameter.name.toLowerCase() === "charset" && parameter.value.toLowerCase() === "utf-8";
}

function hasJsonUtf8MediaType(request: Request): boolean {
  return hasUtf8MediaType(request, "application", "json", false);
}

function createInput(value: Record<string, unknown>): CreateInput {
  const input: CreateInput = { content: value.content as string };
  if ("title" in value) input.title = value.title as string;
  if ("format" in value) input.format = value.format as Exclude<CreateInput["format"], undefined>;
  if ("expiration" in value) input.expiration = value.expiration as Exclude<CreateInput["expiration"], undefined>;
  if ("password" in value) input.password = value.password as string;
  if ("viewOnce" in value) input.viewOnce = value.viewOnce as boolean;
  if ("customId" in value) input.customId = value.customId as string;
  return input;
}

function validationError(field: string, message: string): PasteError {
  return new PasteError("VALIDATION_FAILED", 422, undefined, { fields: [{ field, message }] });
}

function createMediaType(request: Request): "json" | { boundary: string } {
  if (hasJsonUtf8MediaType(request)) return "json";
  return { boundary: parseMultipartBoundary(request.headers.get("content-type")) };
}

function textMediaType(request: Request): void {
  if (!hasUtf8MediaType(request, "text", "plain", true)) {
    throw new PasteError("UNSUPPORTED_MEDIA_TYPE", 415, undefined, { accepted: [textPlainUtf8] });
  }
}

function passwordSelection(request: Request, bodyPassword?: OpaqueMutationValue): PasswordSelection {
  const passwords = new URL(request.url).searchParams.getAll("password");
  const password = bodyPassword ?? (passwords.length === 1 ? passwords[0] : request.headers.get("x-paste-password") ?? undefined);
  return { ...(password === undefined ? {} : { password }), ambiguous: passwords.length > 1 };
}

function ifMatchVersion(request: Request): string | undefined {
  const value = request.headers.get("if-match");
  if (value === null) return undefined;
  const match = /^"([\x21\x23-\x7e\x80-\xff]*)"$/.exec(value);
  if (match === null) throw new PasteError("AMBIGUOUS_VERSION", 400);
  return match[1]!;
}

type EntityTagCondition = { any: true } | { any: false; opaqueTags: string[] };

function isEntityTagCharacter(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return code === 0x21 || (code >= 0x23 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
}

function parseIfNoneMatch(value: string | null): EntityTagCondition | undefined {
  if (value === null) return undefined;
  let position = skipHttpOws(value, 0);
  if (value[position] === "*") {
    position = skipHttpOws(value, position + 1);
    if (position !== value.length) throw badRequest();
    return { any: true };
  }

  const opaqueTags: string[] = [];
  while (position < value.length) {
    if (value.startsWith("W/", position)) position += 2;
    if (value[position] !== '"') throw badRequest();
    const start = ++position;
    while (value[position] !== '"') {
      if (!isEntityTagCharacter(value[position])) throw badRequest();
      position += 1;
    }
    opaqueTags.push(value.slice(start, position));
    position = skipHttpOws(value, position + 1);
    if (position === value.length) return { any: false, opaqueTags };
    if (value[position] !== ",") throw badRequest();
    position = skipHttpOws(value, position + 1);
    if (position === value.length) throw badRequest();
  }
  throw badRequest();
}

function ifNoneMatchMatches(condition: EntityTagCondition | undefined, etag: string): boolean {
  return condition?.any === true || (condition?.any === false && condition.opaqueTags.includes(etag.slice(1, -1)));
}

function badRequest(): PasteError {
  return new PasteError("BAD_REQUEST", 400);
}

function contentTooLarge(): PasteError {
  return new PasteError("CONTENT_TOO_LARGE", 413, undefined, { maxBytes: contentBodyLimit });
}

function requestTooLarge(): PasteError {
  return new PasteError("REQUEST_TOO_LARGE", 413, undefined, { maxBytes: wireBodyLimit });
}

function jsonStringLimitError(field: string): PasteError {
  switch (field) {
    case "content":
      return contentTooLarge();
    case "title":
      return validationError("title", "Must contain at most 200 Unicode scalars.");
    case "format":
      return validationError("format", "Must be text or markdown.");
    case "expiration":
      return validationError("expiration", "Must be permanent, at least 60 seconds, or a timezone-bearing RFC3339 timestamp.");
    case "password":
    case "newPassword":
      return validationError("password", "Must be empty or 1 to 128 visible ASCII characters.");
    case "customId":
      return validationError("id", "Must be 1 to 64 ASCII letters, digits, underscores, or hyphens.");
    case "version":
      return validationError("version", "Must be at most 53 code units.");
    case "viewOnce":
      return validationError("viewOnce", "Must be a boolean.");
    case "body":
      return validationError("body", "Unknown field.");
    default:
      return badRequest();
  }
}

function jsonKindError(field: string): PasteError {
  switch (field) {
    case "content":
    case "title":
    case "format":
    case "password":
    case "version":
    case "newPassword":
      return validationError(field, "Must be a string.");
    case "customId":
      return validationError("id", "Must be 1 to 64 ASCII letters, digits, underscores, or hyphens.");
    case "viewOnce":
      return validationError("viewOnce", "Must be a boolean.");
    case "expiration":
      return jsonStringLimitError("expiration");
    default:
      return badRequest();
  }
}

const httpJsonKinds: ReadonlyMap<string, ReadonlySet<StrictJsonKind>> = new Map([
  ["content", new Set<StrictJsonKind>(["string"])],
  ["title", new Set<StrictJsonKind>(["string"])],
  ["format", new Set<StrictJsonKind>(["string"])],
  ["expiration", new Set<StrictJsonKind>(["null", "number", "string"])],
  ["password", new Set<StrictJsonKind>(["string"])],
  ["viewOnce", new Set<StrictJsonKind>(["boolean"])],
  ["customId", new Set<StrictJsonKind>(["string"])],
  ["version", new Set<StrictJsonKind>(["string"])],
  ["newPassword", new Set<StrictJsonKind>(["string"])],
]);

function isLowerHexadecimal(character: string): boolean {
  return (character >= "0" && character <= "9") || (character >= "a" && character <= "f");
}

function isPossibleCanonicalVersionPrefix(value: string): boolean {
  if ("legacy".startsWith(value)) return true;
  const uuidLength = 36;
  const uuidCharacters = Math.min(value.length, uuidLength);
  for (let position = 0; position < uuidCharacters; position += 1) {
    const character = value[position]!;
    if (position === 8 || position === 13 || position === 18 || position === 23) {
      if (character !== "-") return false;
    } else if (position === 14) {
      if (character !== "4") return false;
    } else if (position === 19) {
      if (!"89ab".includes(character)) return false;
    } else if (!isLowerHexadecimal(character)) {
      return false;
    }
  }
  if (value.length <= uuidLength) return true;
  if (value[uuidLength] !== ".") return false;
  const counter = value.slice(uuidLength + 1);
  return (
    counter === "" ||
    (/^[1-9]\d*$/.test(counter) &&
      counter.length <= "9007199254740991".length &&
      (counter.length < "9007199254740991".length || counter <= "9007199254740991"))
  );
}

function isCanonicalVersion(value: string): boolean {
  if (value === "legacy") return true;
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([1-9]\d*)$/.exec(value);
  return match !== null && Number.isSafeInteger(Number(match[2]));
}

const mutationOpaqueStrings = new Map([
  ["password", {
    maxCodeUnits: 128,
    canContinue: (_prefix: string, next: string) => next >= " " && next <= "~",
    isComplete: (value: string) => value.length > 0,
  }],
  ["version", {
    maxCodeUnits: 53,
    canContinue: (prefix: string, next: string) => isPossibleCanonicalVersionPrefix(prefix + next),
    isComplete: isCanonicalVersion,
  }],
]);

const httpJsonPolicy: StrictJsonParsePolicy = {
  maxRetainedCodeUnits: contentBodyLimit + 4_096,
  maxTopLevelKeyCodeUnits: "newPassword".length,
  topLevelStringMaxCodeUnits: new Map([
    ["content", contentBodyLimit],
    ["title", 400],
    ["format", "markdown".length],
    ["expiration", 29],
    ["password", 128],
    ["newPassword", 128],
    ["viewOnce", 0],
    ["customId", 64],
  ]),
  expectedTopLevelKinds: httpJsonKinds,
  onRetainedLimit: badRequest,
  onStringLimit: jsonStringLimitError,
  onUnexpectedTopLevelKind: jsonKindError,
  topLevelNumberAccumulators: new Map([["expiration", () => new BoundedDecimalNumberAccumulator()]]),
  topLevelUtf8ByteMax: new Map([["content", contentBodyLimit]]),
};

function mutationJsonPolicy(ifMatch: string | undefined): StrictJsonParsePolicy {
  return {
    ...httpJsonPolicy,
    topLevelOpaqueStrings: mutationOpaqueStrings,
    ...(ifMatch === undefined ? {} : { topLevelOpaqueStringComparisons: new Map([["version", ifMatch]]) }),
  };
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Preserve the boundary error that caused cancellation.
  }
}

function appendUtf8Tail(tail: Uint8Array, length: number, source: Uint8Array): number {
  if (source.byteLength >= tail.byteLength) {
    tail.set(source.subarray(source.byteLength - tail.byteLength));
    return tail.byteLength;
  }
  const retained = Math.min(length, tail.byteLength - source.byteLength);
  if (retained > 0) tail.copyWithin(0, length - retained, length);
  tail.set(source, retained);
  return retained + source.byteLength;
}

function pendingUtf8ContinuationBytes(tail: Uint8Array, length: number): number {
  let continuations = 0;
  while (continuations < length && continuations < 3 && tail[length - continuations - 1]! >= 0x80 && tail[length - continuations - 1]! <= 0xbf) {
    continuations += 1;
  }
  const lead = tail[length - continuations - 1];
  const expected = lead !== undefined && lead >= 0xc2 && lead <= 0xdf
    ? 1
    : lead !== undefined && lead >= 0xe0 && lead <= 0xef
      ? 2
      : lead !== undefined && lead >= 0xf0 && lead <= 0xf4
        ? 3
        : 0;
  return expected > continuations ? expected - continuations : 0;
}

async function resolvePendingUtf8AtContentLimit(
  decoder: TextDecoder,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  initial: Uint8Array,
  tail: Uint8Array,
  tailLength: number,
): Promise<never> {
  let source = initial;
  const readPrefix = async (length: number): Promise<Uint8Array> => {
    const prefix = new Uint8Array(length);
    let offset = 0;
    while (offset < prefix.byteLength) {
      if (source.byteLength === 0) {
        const next = await reader.read();
        if (next.done) throw badRequest();
        source = next.value;
        continue;
      }
      const copied = Math.min(prefix.byteLength - offset, source.byteLength);
      prefix.set(source.subarray(0, copied), offset);
      offset += copied;
      source = source.subarray(copied);
    }
    return prefix;
  };

  let needed = pendingUtf8ContinuationBytes(tail, tailLength);
  try {
    if (needed === 0) {
      const first = await readPrefix(1);
      decoder.decode(first, { stream: true });
      needed = pendingUtf8ContinuationBytes(first, first.byteLength);
    }
    if (needed > 0) decoder.decode(await readPrefix(needed), { stream: true });
    decoder.decode();
  } catch {
    throw badRequest();
  }
  throw contentTooLarge();
}

async function parseTextContent(request: Request, validateMediaType = true): Promise<string> {
  if (validateMediaType) textMediaType(request);
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && !/^\d+$/.test(contentLength)) {
    await cancelBody(request.body);
    throw badRequest();
  }
  if (contentLength !== null && Number(contentLength) > wireBodyLimit) {
    await cancelBody(request.body);
    throw requestTooLarge();
  }
  if (contentLength !== null && Number(contentLength) > contentBodyLimit) {
    await cancelBody(request.body);
    throw contentTooLarge();
  }
  if (request.body === null) return "";

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const reader = request.body.getReader();
  const chunks: string[] = [];
  const tail = new Uint8Array(4);
  let length = 0;
  let tailLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let start = 0; start < value.byteLength; start += decoderSliceBytes) {
        const slice = value.subarray(start, Math.min(start + decoderSliceBytes, value.byteLength));
        const acceptedLength = Math.min(slice.byteLength, contentBodyLimit - length);
        const accepted = slice.subarray(0, acceptedLength);
        let decoded: string;
        try {
          decoded = decoder.decode(accepted, { stream: true });
        } catch {
          throw badRequest();
        }
        length += accepted.byteLength;
        tailLength = appendUtf8Tail(tail, tailLength, accepted);
        chunks.push(decoded);
        if (accepted.byteLength !== slice.byteLength) {
          await resolvePendingUtf8AtContentLimit(decoder, reader, slice.subarray(accepted.byteLength), tail, tailLength);
        }
      }
    }
    try {
      chunks.push(decoder.decode());
    } catch {
      throw badRequest();
    }
    return chunks.join("");
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

type OpaqueMutationValue = string | typeof impossibleOpaqueMatch;
type PasswordSelection = { password?: OpaqueMutationValue; ambiguous: boolean };
type MutationCredentials = { password?: OpaqueMutationValue; version?: OpaqueMutationValue };
type ContentPatch = MutationCredentials & { content: string };
type PasswordPutBody = MutationCredentials & { newPassword: string };
type SettingsBody = MutationCredentials & Pick<UpdateSettingsInput, "title" | "format" | "expiration" | "viewOnce">;

function jsonMediaType(request: Request): void {
  if (!hasJsonUtf8MediaType(request)) {
    throw new PasteError("UNSUPPORTED_MEDIA_TYPE", 415, undefined, { accepted: ["application/json"] });
  }
}

function parseMutationCredentials(value: Record<string, unknown>): MutationCredentials {
  const result: MutationCredentials = {};
  if (Object.hasOwn(value, "password")) {
    if (typeof value.password !== "string" && value.password !== impossibleOpaqueMatch) {
      throw validationError("password", "Must be a string.");
    }
    result.password = value.password;
  }
  if (Object.hasOwn(value, "version")) {
    if (typeof value.version !== "string" && value.version !== impossibleOpaqueMatch) {
      throw validationError("version", "Must be a string.");
    }
    result.version = value.version;
  }
  return result;
}

async function parseContentPatch(request: Request, ifMatch: string | undefined): Promise<ContentPatch> {
  jsonMediaType(request);
  const value = await parseStrictJsonObject(request, new Set(["content", "password", "version"]), mutationJsonPolicy(ifMatch));
  if (typeof value.content !== "string") throw validationError("content", "Must be a string.");
  return { content: value.content, ...parseMutationCredentials(value) };
}

async function parseDeleteBody(request: Request, ifMatch: string | undefined): Promise<MutationCredentials> {
  const value = await parseStrictJsonObjectOrEmpty(
    request,
    new Set(["password", "version"]),
    () => jsonMediaType(request),
    mutationJsonPolicy(ifMatch),
  );
  return value === undefined ? {} : parseMutationCredentials(value);
}

async function parseSettingsBody(request: Request, ifMatch: string | undefined): Promise<SettingsBody> {
  jsonMediaType(request);
  const value = await parseStrictJsonObject(
    request,
    new Set(["password", "version", "title", "format", "expiration", "viewOnce"]),
    mutationJsonPolicy(ifMatch),
  );
  const result: SettingsBody = parseMutationCredentials(value);
  if (Object.hasOwn(value, "title")) result.title = value.title as string;
  if (Object.hasOwn(value, "format") && value.format !== undefined) result.format = value.format as NonNullable<SettingsBody["format"]>;
  if (Object.hasOwn(value, "expiration") && value.expiration !== undefined) result.expiration = value.expiration as NonNullable<SettingsBody["expiration"]>;
  if (Object.hasOwn(value, "viewOnce") && value.viewOnce !== undefined) result.viewOnce = value.viewOnce as boolean;
  if (result.title === undefined && result.format === undefined && result.expiration === undefined && result.viewOnce === undefined) {
    throw validationError("settings", "Must include at least one setting.");
  }
  return result;
}

async function parsePasswordPutBody(request: Request, ifMatch: string | undefined): Promise<PasswordPutBody> {
  jsonMediaType(request);
  const value = await parseStrictJsonObject(request, new Set(["password", "newPassword", "version"]), mutationJsonPolicy(ifMatch));
  if (typeof value.newPassword !== "string") throw validationError("newPassword", "Must be a string.");
  return { ...parseMutationCredentials(value), newPassword: value.newPassword };
}

async function parseReadPostBody(request: Request): Promise<MutationCredentials> {
  const value = await parseStrictJsonObjectOrEmpty(
    request,
    new Set(["password"]),
    () => jsonMediaType(request),
    mutationJsonPolicy(undefined),
  );
  return value === undefined ? {} : parseMutationCredentials(value);
}

async function parsePasswordForm(request: Request): Promise<string | undefined> {
  if (!hasUtf8MediaType(request, "application", "x-www-form-urlencoded", false)) {
    throw new PasteError("UNSUPPORTED_MEDIA_TYPE", 415, undefined, { accepted: ["application/x-www-form-urlencoded"] });
  }
  const entries = [...new URLSearchParams(await parseTextContent(request, false))];
  if (entries.length === 0) return undefined;
  const unknown = entries.find(([name]) => name !== "password");
  if (unknown !== undefined) throw validationError(unknown[0], "Unknown field.");
  if (entries.length > 1) throw validationError("password", "Duplicate field.");
  return entries[0]![1];
}

async function loadWithPassword(
  service: PasteService,
  id: string,
  selection: PasswordSelection,
  options?: { cleanupExpired?: boolean },
): Promise<LoadedPaste> {
  if (!selection.ambiguous) return service.loadContent(id, selection.password, options);
  try {
    await service.loadContent(id, impossibleOpaqueMatch, options);
  } catch (error) {
    if (!isPasteError(error) || error.code !== "FORBIDDEN") throw error;
  }
  throw new PasteError("AMBIGUOUS_PASSWORD", 400);
}

async function rejectAmbiguousPasswordAfterLoad(service: PasteService, id: string, selection: PasswordSelection): Promise<void> {
  if (selection.ambiguous) await loadWithPassword(service, id, selection);
}

function currentPassword(selection: PasswordSelection): string | undefined {
  return typeof selection.password === "string" ? selection.password : undefined;
}

function mutationVersion(body: MutationCredentials, headerVersion: string | undefined): OpaqueMutationValue | undefined {
  if (body.version !== undefined && headerVersion !== undefined && body.version !== headerVersion) {
    throw new PasteError("AMBIGUOUS_VERSION", 400);
  }
  return body.version ?? headerVersion;
}

function contentUpdateInput(content: string, password: OpaqueMutationValue | undefined, version: OpaqueMutationValue | undefined): UpdateContentInput {
  const input: UpdateContentInput = { content };
  if (password !== undefined) input.password = password;
  if (version !== undefined) input.version = version;
  return input;
}

async function parseMultipartCreate(request: Request, boundary: string): Promise<CreateInput> {
  const values = await parseMultipartCreateFields(request, boundary);
  if (!Object.hasOwn(values, "viewOnce")) throw validationError("viewOnce", "Required.");

  const input: Record<string, unknown> = { ...values };
  if (Object.hasOwn(values, "expiration")) {
    const value = values.expiration!;
    input.expiration = value === "" ? "permanent" : /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  }
  const viewOnce = values.viewOnce!;
  if (viewOnce !== "true" && viewOnce !== "false") throw validationError("viewOnce", "Must be true or false.");
  input.viewOnce = viewOnce === "true";
  return createInput(input);
}

async function parseCreate(request: Request): Promise<CreateInput> {
  const mediaType = createMediaType(request);
  return mediaType === "json"
    ? createInput(await parseStrictJsonObject(request, createFields, httpJsonPolicy))
    : parseMultipartCreate(request, mediaType.boundary);
}

function jsonResponseHeaders(headers?: HeadersInit): Headers {
  const responseHeaders = new Headers({
    "Cache-Control": "no-store, no-transform",
    "Content-Type": "application/json; charset=utf-8",
  });
  if (headers !== undefined) {
    for (const [name, value] of new Headers(headers)) responseHeaders.set(name, value);
  }
  return responseHeaders;
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, headers: jsonResponseHeaders(headers) });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function serializePasteResource(loaded: LoadedPaste): Uint8Array<ArrayBuffer> {
  const summary = loaded.summary;
  const value: PasteResource = {
    id: summary.id,
    title: summary.title,
    format: summary.format,
    viewOnce: summary.viewOnce,
    protected: summary.protected,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    expiresAt: summary.expiresAt,
    expiration: summary.expiration.kind === "relative"
      ? { kind: "relative", seconds: summary.expiration.seconds }
      : { kind: summary.expiration.kind },
    version: summary.version,
    contentRevision: summary.contentRevision,
    contentBytes: summary.contentBytes,
    createdCountry: summary.createdCountry,
    links: {
      view: summary.links.view,
      raw: summary.links.raw,
      html: summary.links.html,
      markdown: summary.links.markdown,
      file: summary.links.file,
    },
    content: loaded.content,
  };
  return new TextEncoder().encode(JSON.stringify(value));
}

async function strongResponseEtag(bytes: Uint8Array<ArrayBuffer>): Promise<`"sha256-${string}"`> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `"sha256-${base64Url(digest)}"`;
}

function notModifiedResponse(etag: string): Response {
  return new Response(null, { status: 304, headers: { "Cache-Control": "no-store", ETag: etag } });
}

async function pasteResourceResponse(
  service: PasteService,
  loaded: LoadedPaste,
  request: Request,
  conditional: boolean,
  versionEtag: boolean,
): Promise<Response> {
  const bytes = serializePasteResource(loaded);
  const etag = versionEtag ? `"${loaded.summary.version}"` : await strongResponseEtag(bytes);
  const headers = jsonResponseHeaders({ ETag: etag });
  if (conditional && !loaded.summary.viewOnce && ifNoneMatchMatches(parseIfNoneMatch(request.headers.get("if-none-match")), etag)) {
    return notModifiedResponse(etag);
  }
  if (request.method === "HEAD") return new Response(null, { headers });
  if (loaded.summary.viewOnce) await service.consume(loaded);
  return new Response(bytes, { headers });
}

function errorResponse(error: PasteError): Response {
  const body: {
    error: {
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };
  } = { error: { code: error.code, message: error.message } };
  if (error.details !== undefined) body.error.details = error.details;

  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  if (error.status === 503) headers.set("Retry-After", "1");
  return new Response(JSON.stringify(body), { status: error.status, headers });
}

function methodNotAllowed(allow: string): Response {
  const response = errorResponse(new PasteError("BAD_REQUEST", 405));
  response.headers.set("Allow", allow);
  return response;
}

function pastePathError(request: Request): PasteError | undefined {
  const pathname = new URL(request.url).pathname;
  const matches = [
    /^\/api\/pastes\/([^/]+)(?:\/(?:settings|password|read)|\/history(?:\/([^/]+))?)?$/.exec(pathname),
    /^\/(?:raw|html|md|file)\/([^/]+)$/.exec(pathname),
    /^\/([^/]+)$/.exec(pathname),
  ];
  const match = matches.find((candidate) => candidate !== null);
  if (match === undefined || match === null) return undefined;
  const segments = match.slice(1).filter((segment): segment is string => segment !== undefined);
  if (segments.length === 0 || ["api", "ip-trace", "assets"].includes(segments[0]!)) return undefined;
  try {
    if (segments.some((segment) => decodeURIComponent(segment).includes("/"))) {
      return new PasteError("PASTE_NOT_FOUND", 404);
    }
  } catch {
    return new PasteError("BAD_REQUEST", 400);
  }
  return undefined;
}

function browserErrorResponse(request: Request, error: PasteError): Response {
  const response = new Response(renderErrorPage({
    locale: resolveServerLocale(request.headers.get("accept-language")),
    status: error.status,
    errorCode: error.code,
  }), { status: error.status, headers: applicationHeaders() });
  if (error.status === 503) response.headers.set("Retry-After", "1");
  return response;
}

function directErrorResponse(error: PasteError): Response {
  const headers = new Headers({ "Cache-Control": "no-store", "Content-Type": textPlainUtf8 });
  if (error.status === 503) headers.set("Retry-After", "1");
  return new Response(error.message, { status: error.status, headers });
}

function routeErrorResponse(request: Request, error: PasteError): Response {
  const pathname = new URL(request.url).pathname;
  if (/^\/(?:raw|html|md|file)(?:\/|$)/.test(pathname)) return directErrorResponse(error);
  return pathname === "/api" || pathname.startsWith("/api/") ? errorResponse(error) : browserErrorResponse(request, error);
}

function passwordBootstrap(request: Request, errorCode: null | "FORBIDDEN", status = 200): Response {
  return new Response(renderPasswordPage({
    locale: resolveServerLocale(request.headers.get("accept-language")),
    errorCode,
  }), { status, headers: applicationHeaders() });
}

type BrowserRepresentation = "main" | "raw" | "html" | "md" | "file";

function representationHeaders(representation: BrowserRepresentation, loaded: LoadedPaste): Headers {
  switch (representation) {
    case "main":
    case "md":
      return applicationHeaders();
    case "raw":
      return new Headers({ "Cache-Control": "no-store", "Content-Type": textPlainUtf8 });
    case "html":
      return new Headers({ "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
    case "file":
      return deriveDownloadHeaders(loaded.summary);
  }
}

function preparedRepresentation(representation: BrowserRepresentation, request: Request, loaded: LoadedPaste): Response {
  const locale = resolveServerLocale(request.headers.get("accept-language"));
  const headers = representationHeaders(representation, loaded);
  if (request.method === "HEAD") return new Response(null, { headers });
  try {
    switch (representation) {
      case "main":
        return new Response(renderPastePage({ locale, paste: loaded.summary, content: loaded.content }), { headers });
      case "raw":
      case "html":
      case "file":
        return new Response(loaded.content, { headers });
      case "md":
        return new Response(renderMarkdownDocument({ locale, paste: loaded.summary, content: loaded.content }), { headers });
    }
  } catch {
    throw new PasteError("RENDER_FAILED", 500);
  }
}

async function contentBearingResponse(
  service: PasteService,
  request: Request,
  loaded: LoadedPaste,
  representation: BrowserRepresentation,
): Promise<Response> {
  const response = preparedRepresentation(representation, request, loaded);
  if (request.method !== "HEAD" && loaded.summary.viewOnce) await service.consume(loaded);
  return response;
}

async function browserPasteResponse(
  service: PasteService,
  request: Request,
  id: string,
  representation: BrowserRepresentation,
): Promise<Response> {
  const queryPasswords = new URL(request.url).searchParams.getAll("password");
  try {
    const loaded = await loadWithPassword(service, id, {
      ...(queryPasswords.length === 1 ? { password: queryPasswords[0] } : {}),
      ambiguous: queryPasswords.length > 1,
    }, { cleanupExpired: request.method !== "HEAD" });
    return await contentBearingResponse(service, request, loaded, representation);
  } catch (error) {
    if (!isPasteError(error)) throw error;
    if (representation === "main" && error.code === "FORBIDDEN") {
      const supplied = queryPasswords.length === 1;
      return passwordBootstrap(request, supplied ? "FORBIDDEN" : null, supplied ? 403 : 200);
    }
    return representation === "main" ? browserErrorResponse(request, error) : directErrorResponse(error);
  }
}

function browserMethodNotAllowed(request: Request, allow: string, direct: boolean): Response {
  if (direct) {
    const response = directErrorResponse(new PasteError("BAD_REQUEST", 405));
    response.headers.set("Allow", allow);
    return response;
  }
  const response = new Response(renderErrorPage({
    locale: resolveServerLocale(request.headers.get("accept-language")),
    status: 405,
    errorCode: "METHOD_NOT_ALLOWED",
  }), { status: 405, headers: applicationHeaders() });
  response.headers.set("Allow", allow);
  return response;
}

function ipTraceResponse(request: Request): Promise<Response> {
  return request.clone().text().then((data) => {
    const value = {
      url: request.url,
      method: request.method,
      data,
      headers: Object.fromEntries(request.headers),
      cf: Object.fromEntries(Object.entries(request.cf ?? {})),
    };
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
      "Cache-Control": "no-store",
    };
    return request.method === "HEAD"
      ? new Response(null, { headers })
      : new Response(JSON.stringify(value, null, 2), { headers });
  });
}

export function createHttpApp(env: Env): Hono {
  const app = new Hono();

  app.use("*", async (context, next) => {
    const error = pastePathError(context.req.raw);
    if (error !== undefined) return routeErrorResponse(context.req.raw, error);
    await next();
    if (context.res.headers.get("Cache-Control") !== "no-store, no-transform") context.res.headers.set("Cache-Control", "no-store");
  });

  app.onError((error) => errorResponse(isPasteError(error) ? error : new PasteError("INTERNAL_ERROR", 500)));
  app.notFound(() => errorResponse(new PasteError("PASTE_NOT_FOUND", 404)));

  app.on(["GET", "HEAD"], "/", (context) => context.req.raw.method === "HEAD"
    ? new Response(null, { headers: applicationHeaders() })
    : new Response(renderCreatePage(resolveServerLocale(context.req.raw.headers.get("accept-language"))), { headers: applicationHeaders() }));
  app.all("/", (context) => browserMethodNotAllowed(context.req.raw, "GET,HEAD", false));

  app.on(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], "/ip-trace", (context) => ipTraceResponse(context.req.raw));
  app.all("/ip-trace", () => methodNotAllowed("GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS"));

  app.on(["GET", "HEAD"], "/assets/*", () => errorResponse(new PasteError("PASTE_NOT_FOUND", 404)));
  app.all("/assets/*", () => methodNotAllowed("GET,HEAD"));

  app.all("/api", () => errorResponse(new PasteError("PASTE_NOT_FOUND", 404)));

  app.post("/api/pastes", async (context) => {
    const country = context.req.raw.cf?.country;
    const paste = await new PasteService(env.PASTE_DB).create(
      await parseCreate(context.req.raw),
      typeof country === "string" ? { country } : {},
    );
    return jsonResponse(paste, 201, { ETag: `"${paste.version}"`, Location: `/${paste.id}` });
  });
  app.options("/api/pastes", () => new Response(null, { status: 204, headers: { Allow: "POST,OPTIONS" } }));
  app.all("/api/pastes", () => methodNotAllowed("POST,OPTIONS"));

  app.on(["GET", "HEAD"], "/api/pastes/:id", async (context) => {
    const request = context.req.raw;
    const service = new PasteService(env.PASTE_DB);
    const loaded = await loadWithPassword(service, context.req.param("id"), passwordSelection(request));
    return pasteResourceResponse(service, loaded, request, true, false);
  });

  app.put("/api/pastes/:id", async (context) => {
    const request = context.req.raw;
    const version = ifMatchVersion(request);
    const content = await parseTextContent(request);
    const selection = passwordSelection(request);
    const service = new PasteService(env.PASTE_DB);
    await rejectAmbiguousPasswordAfterLoad(service, context.req.param("id"), selection);
    const result = await service.updateContent(
      context.req.param("id"),
      contentUpdateInput(content, selection.password, version),
    );
    return jsonResponse(result, 200, { ETag: `"${result.paste.version}"` });
  });

  app.patch("/api/pastes/:id", async (context) => {
    const request = context.req.raw;
    const headerVersion = ifMatchVersion(request);
    const body = await parseContentPatch(request, headerVersion);
    const selection = passwordSelection(request, body.password);
    const service = new PasteService(env.PASTE_DB);
    await rejectAmbiguousPasswordAfterLoad(service, context.req.param("id"), selection);
    const result = await service.updateContent(
      context.req.param("id"),
      contentUpdateInput(body.content, selection.password, mutationVersion(body, headerVersion)),
    );
    return jsonResponse(result, 200, { ETag: `"${result.paste.version}"` });
  });

  app.delete("/api/pastes/:id", async (context) => {
    const request = context.req.raw;
    const headerVersion = ifMatchVersion(request);
    const body = await parseDeleteBody(request, headerVersion);
    const selection = passwordSelection(request, body.password);
    const service = new PasteService(env.PASTE_DB);
    await rejectAmbiguousPasswordAfterLoad(service, context.req.param("id"), selection);
    await service.delete(
      context.req.param("id"),
      selection.password,
      mutationVersion(body, headerVersion),
    );
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  });
  app.options("/api/pastes/:id", () => new Response(null, { status: 204, headers: { Allow: "GET,HEAD,PUT,PATCH,DELETE,OPTIONS" } }));
  app.all("/api/pastes/:id", () => methodNotAllowed("GET,HEAD,PUT,PATCH,DELETE,OPTIONS"));

  app.on(["GET", "HEAD"], "/api/pastes/:id/settings", async (context) => {
    const request = context.req.raw;
    const loaded = await loadWithPassword(new PasteService(env.PASTE_DB), context.req.param("id"), passwordSelection(request));
    const headers = jsonResponseHeaders({ ETag: `"${loaded.summary.version}"` });
    return request.method === "HEAD" ? new Response(null, { headers }) : new Response(JSON.stringify(loaded.summary), { headers });
  });
  app.patch("/api/pastes/:id/settings", async (context) => {
    const request = context.req.raw;
    const headerVersion = ifMatchVersion(request);
    const body = await parseSettingsBody(request, headerVersion);
    const selection = passwordSelection(request, body.password);
    const service = new PasteService(env.PASTE_DB);
    await rejectAmbiguousPasswordAfterLoad(service, context.req.param("id"), selection);
    const version = mutationVersion(body, headerVersion);
    const result = await service.updateSettings(context.req.param("id"), {
      ...body,
      ...(selection.password === undefined ? {} : { password: selection.password }),
      ...(version === undefined ? {} : { version }),
    });
    return jsonResponse(result, 200, { ETag: `"${result.paste.version}"` });
  });
  app.options("/api/pastes/:id/settings", () => new Response(null, { status: 204, headers: { Allow: "GET,HEAD,PATCH,OPTIONS" } }));
  app.all("/api/pastes/:id/settings", () => methodNotAllowed("GET,HEAD,PATCH,OPTIONS"));

  app.put("/api/pastes/:id/password", async (context) => {
    const request = context.req.raw;
    const headerVersion = ifMatchVersion(request);
    const body = await parsePasswordPutBody(request, headerVersion);
    const selection = passwordSelection(request, body.password);
    const service = new PasteService(env.PASTE_DB);
    await rejectAmbiguousPasswordAfterLoad(service, context.req.param("id"), selection);
    const version = mutationVersion(body, headerVersion);
    const result = await service.updatePassword(context.req.param("id"), {
      newPassword: body.newPassword,
      ...(selection.password === undefined ? {} : { password: selection.password }),
      ...(version === undefined ? {} : { version }),
    });
    return jsonResponse(result, 200, { ETag: `"${result.paste.version}"` });
  });
  app.delete("/api/pastes/:id/password", async (context) => {
    const request = context.req.raw;
    const headerVersion = ifMatchVersion(request);
    const body = await parseDeleteBody(request, headerVersion);
    const selection = passwordSelection(request, body.password);
    const service = new PasteService(env.PASTE_DB);
    await rejectAmbiguousPasswordAfterLoad(service, context.req.param("id"), selection);
    const version = mutationVersion(body, headerVersion);
    const result = await service.updatePassword(context.req.param("id"), {
      newPassword: "",
      ...(selection.password === undefined ? {} : { password: selection.password }),
      ...(version === undefined ? {} : { version }),
    });
    return jsonResponse(result, 200, { ETag: `"${result.paste.version}"` });
  });
  app.options("/api/pastes/:id/password", () => new Response(null, { status: 204, headers: { Allow: "PUT,DELETE,OPTIONS" } }));
  app.all("/api/pastes/:id/password", () => methodNotAllowed("PUT,DELETE,OPTIONS"));

  app.on(["GET", "HEAD"], "/api/pastes/:id/history", async (context) => {
    const request = context.req.raw;
    const selection = passwordSelection(request);
    const service = new PasteService(env.PASTE_DB);
    await rejectAmbiguousPasswordAfterLoad(service, context.req.param("id"), selection);
    const history = await service.listHistory(context.req.param("id"), currentPassword(selection));
    const headers = jsonResponseHeaders({ ETag: `"${history.currentVersion}"` });
    return request.method === "HEAD" ? new Response(null, { headers }) : new Response(JSON.stringify(history), { headers });
  });
  app.on(["GET", "HEAD"], "/api/pastes/:id/history/:revision", async (context) => {
    const request = context.req.raw;
    const selection = passwordSelection(request);
    const service = new PasteService(env.PASTE_DB);
    const loaded = await loadWithPassword(service, context.req.param("id"), selection);
    const revision = await service.getHistory(context.req.param("id"), context.req.param("revision"), currentPassword(selection));
    const headers = jsonResponseHeaders({ ETag: `"${loaded.summary.version}"` });
    return request.method === "HEAD" ? new Response(null, { headers }) : new Response(JSON.stringify(revision), { headers });
  });
  app.options("/api/pastes/:id/history", () => new Response(null, { status: 204, headers: { Allow: "GET,HEAD,OPTIONS" } }));
  app.options("/api/pastes/:id/history/:revision", () => new Response(null, { status: 204, headers: { Allow: "GET,HEAD,OPTIONS" } }));
  app.all("/api/pastes/:id/history", () => methodNotAllowed("GET,HEAD,OPTIONS"));
  app.all("/api/pastes/:id/history/:revision", () => methodNotAllowed("GET,HEAD,OPTIONS"));

  app.on(["GET", "HEAD", "POST"], "/api/pastes/:id/read", async (context) => {
    const request = context.req.raw;
    const body = request.method === "POST" ? await parseReadPostBody(request) : {};
    const service = new PasteService(env.PASTE_DB);
    const loaded = await loadWithPassword(service, context.req.param("id"), passwordSelection(request, body.password));
    return pasteResourceResponse(service, loaded, request, false, true);
  });
  app.options("/api/pastes/:id/read", () => new Response(null, { status: 204, headers: { Allow: "GET,HEAD,POST,OPTIONS" } }));
  app.all("/api/pastes/:id/read", () => methodNotAllowed("GET,HEAD,POST,OPTIONS"));

  for (const [route, representation] of [["/raw/:id", "raw"], ["/html/:id", "html"], ["/md/:id", "md"], ["/file/:id", "file"]] as const) {
    app.on(["GET", "HEAD"], route, (context) => browserPasteResponse(new PasteService(env.PASTE_DB), context.req.raw, context.req.param("id"), representation));
    app.all(route, (context) => browserMethodNotAllowed(context.req.raw, "GET,HEAD", true));
  }
  for (const route of ["/raw/*", "/html/*", "/md/*", "/file/*"]) {
    app.all(route, () => directErrorResponse(new PasteError("PASTE_NOT_FOUND", 404)));
  }

  app.on(["GET", "HEAD"], "/:id", (context) => browserPasteResponse(new PasteService(env.PASTE_DB), context.req.raw, context.req.param("id"), "main"));
  app.all("/:id/:ignored", (context) => browserErrorResponse(context.req.raw, new PasteError("PASTE_NOT_FOUND", 404)));
  app.post("/:id", async (context) => {
    const request = context.req.raw;
    try {
      const password = await parsePasswordForm(request);
      await loadWithPassword(new PasteService(env.PASTE_DB), context.req.param("id"), { ...(password === undefined ? {} : { password }), ambiguous: new URL(request.url).searchParams.getAll("password").length > 1 });
      const location = new URL(request.url);
      if (password !== undefined) location.searchParams.set("password", password);
      return new Response(null, { status: 302, headers: { Location: `${location.pathname}${location.search}`, "Cache-Control": "no-store" } });
    } catch (error) {
      if (!isPasteError(error)) throw error;
      if (error.code === "FORBIDDEN") return passwordBootstrap(request, "FORBIDDEN", 403);
      return browserErrorResponse(request, error);
    }
  });
  app.all("/:id", (context) => browserMethodNotAllowed(context.req.raw, "GET,HEAD,POST", false));

  return app;
}
