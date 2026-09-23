import type { PasteResource } from "../types";
import type {
  ErrorCode,
  ExpirationInput,
  HistoryList,
  MutationResult,
  PasteSummary,
  RemoteSnapshot,
  RevisionResource,
} from "./contracts";

const jsonMediaType = "application/json; charset=utf-8";
const noStore = "no-store";
const createJsonLimit = 62_914_560;

const errorCodes = new Set<ErrorCode>([
  "BAD_REQUEST",
  "AMBIGUOUS_PASSWORD",
  "AMBIGUOUS_VERSION",
  "FORBIDDEN",
  "PASTE_NOT_FOUND",
  "REVISION_NOT_FOUND",
  "ID_CONFLICT",
  "VERSION_CONFLICT",
  "VIEW_ONCE_HISTORY_FORBIDDEN",
  "CONTENT_TOO_LARGE",
  "REQUEST_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "VALIDATION_FAILED",
  "RENDER_FAILED",
  "INTERNAL_ERROR",
  "STORAGE_READ_FAILED",
  "STORAGE_WRITE_FAILED",
  "STORAGE_INCONSISTENT",
  "CONSUME_FAILED",
  "ID_GENERATION_FAILED",
]);

export type ApiFailure =
  | {
      kind: "http";
      status: number;
      code: ErrorCode;
      details?: Record<string, unknown>;
      mutationMayHaveApplied: boolean | null;
    }
  | {
      kind: "network";
      status: null;
      code: "NETWORK_ERROR";
      mutationMayHaveApplied: boolean;
    }
  | {
      kind: "malformed";
      status: number | null;
      code: "MALFORMED_RESPONSE";
      mutationMayHaveApplied: boolean;
    };

export type ApiResult<T> =
  | { ok: true; status: number; value: T; etag: string | null }
  | { ok: false; failure: ApiFailure };

export type ResourceReadResult =
  | { kind: "snapshot"; snapshot: RemoteSnapshot }
  | { kind: "not-modified"; etag: `"sha256-${string}"` }
  | { kind: "failure"; failure: ApiFailure };

export interface CreateRequest {
  content: string;
  title: string;
  format: "text" | "markdown";
  expiration: ExpirationInput;
  password: string;
  viewOnce: boolean;
  customId?: string;
}

export type SettingsChange =
  | { field: "title"; value: string }
  | { field: "format"; value: "text" | "markdown" }
  | { field: "expiration"; value: ExpirationInput }
  | { field: "viewOnce"; value: boolean };

export interface PasteApi {
  create(input: CreateRequest, signal: AbortSignal): Promise<ApiResult<PasteSummary>>;
  readResource(input: { id: string; password: string | null; ifNoneMatch: `"sha256-${string}"` | null; signal: AbortSignal }): Promise<ResourceReadResult>;
  saveContent(input: { id: string; content: string; password: string | null; version: string | null; signal: AbortSignal }): Promise<ApiResult<MutationResult>>;
  getSettings(input: { id: string; password: string | null; signal: AbortSignal }): Promise<ApiResult<PasteSummary>>;
  updateSettings(input: { id: string; change: SettingsChange; password: string | null; version: string; signal: AbortSignal }): Promise<ApiResult<MutationResult>>;
  updatePassword(input: { id: string; password: string | null; newPassword: string; version: string; signal: AbortSignal }): Promise<ApiResult<MutationResult>>;
  clearPassword(input: { id: string; password: string | null; version: string; signal: AbortSignal }): Promise<ApiResult<MutationResult>>;
  deletePaste(input: { id: string; password: string | null; version: string; signal: AbortSignal }): Promise<ApiResult<null>>;
  listHistory(input: { id: string; password: string | null; signal: AbortSignal }): Promise<ApiResult<HistoryList>>;
  getHistory(input: { id: string; revision: number; password: string | null; signal: AbortSignal }): Promise<ApiResult<RevisionResource>>;
}

export interface ApiDependencies {
  fetch: typeof globalThis.fetch;
  crypto: Pick<Crypto, "subtle">;
}

export function selectCreateEncoding(jsonWireBytes: number): "json" | "multipart" {
  return jsonWireBytes <= createJsonLimit ? "json" : "multipart";
}

export function withPastePassword(path: string, password: string | null): string {
  return password === null ? path : `${path}?${new URLSearchParams({ password })}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isByteLength(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isMutationToken(value: unknown): value is string {
  return typeof value === "string" && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value);
}

function isStrongMutationEtag(value: string | null): value is `"${string}"` {
  return value !== null && /^"[\x21\x23-\x5b\x5d-\x7e]+"$/.test(value);
}

function isResourceEtag(value: string | null): value is `"sha256-${string}"` {
  return value !== null && /^"sha256-[A-Za-z0-9_-]{43}"$/.test(value);
}

function isExpiration(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "permanent" || value.kind === "absolute") return hasExactKeys(value, ["kind"]);
  return value.kind === "relative" && hasExactKeys(value, ["kind", "seconds"]) && typeof value.seconds === "number" && Number.isSafeInteger(value.seconds) && value.seconds >= 60;
}

function isLinks(value: unknown): boolean {
  return hasExactKeys(value, ["view", "raw", "html", "markdown", "file"])
    && Object.values(value).every((link) => typeof link === "string" && link.length > 0);
}

function isPasteSummary(value: unknown): value is PasteSummary {
  if (!hasExactKeys(value, [
    "id",
    "title",
    "format",
    "viewOnce",
    "protected",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "expiration",
    "version",
    "contentRevision",
    "contentBytes",
    "createdCountry",
    "links",
  ])) return false;

  return typeof value.id === "string"
    && value.id.length > 0
    && typeof value.title === "string"
    && (value.format === "text" || value.format === "markdown")
    && typeof value.viewOnce === "boolean"
    && typeof value.protected === "boolean"
    && isNullableTimestamp(value.createdAt)
    && isTimestamp(value.updatedAt)
    && isNullableTimestamp(value.expiresAt)
    && isExpiration(value.expiration)
    && isMutationToken(value.version)
    && isByteLength(value.contentRevision)
    && isByteLength(value.contentBytes)
    && (value.createdCountry === null || typeof value.createdCountry === "string")
    && isLinks(value.links);
}

function isPasteResource(value: unknown): value is PasteResource {
  if (!hasExactKeys(value, [
    "id",
    "title",
    "format",
    "viewOnce",
    "protected",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "expiration",
    "version",
    "contentRevision",
    "contentBytes",
    "createdCountry",
    "links",
    "content",
  ])) return false;
  const { content, ...summary } = value;
  return isPasteSummary(summary)
    && typeof content === "string"
    && new TextEncoder().encode(content).byteLength === value.contentBytes;
}

function isCanonicalResourceLinks(links: PasteSummary["links"], id: string): boolean {
  return links.view === `/${id}`
    && links.raw === `/raw/${id}`
    && links.html === `/html/${id}`
    && links.markdown === `/md/${id}`
    && links.file === `/file/${id}`;
}

function parseVersionIdentity(version: string): RemoteSnapshot["identity"] | undefined {
  if (version === "legacy") return { kind: "legacy" };

  const separator = version.lastIndexOf(".");
  const generation = version.slice(0, separator);
  const counter = version.slice(separator + 1);
  if (separator <= 0 || !/^[1-9]\d*$/.test(counter)) return undefined;

  const versionCounter = Number(counter);
  return Number.isSafeInteger(versionCounter) ? { kind: "v2", generation, versionCounter } : undefined;
}

function projectRemoteSnapshot(body: PasteResource, etag: `"sha256-${string}"`): RemoteSnapshot | undefined {
  const { content: source, ...summary } = body;
  const identity = parseVersionIdentity(summary.version);
  if (identity === undefined || summary.contentRevision <= 0 || !isCanonicalResourceLinks(summary.links, summary.id)) return undefined;

  return {
    etag,
    source,
    summary,
    identity,
    contentRevision: summary.contentRevision,
    updatedAtMs: Date.parse(summary.updatedAt),
  };
}

function isMutationResult(value: unknown): value is MutationResult {
  return hasExactKeys(value, ["changed", "paste"])
    && typeof value.changed === "boolean"
    && isPasteSummary(value.paste);
}

function isHistoryList(value: unknown): value is HistoryList {
  if (!hasExactKeys(value, ["id", "currentRevision", "currentVersion", "revisions"])
    || typeof value.id !== "string"
    || value.id.length === 0
    || !isByteLength(value.currentRevision)
    || !isMutationToken(value.currentVersion)
    || !Array.isArray(value.revisions)) return false;

  return value.revisions.every((revision) => hasExactKeys(revision, ["revision", "savedAt", "supersededAt", "byteLength"])
    && isByteLength(revision.revision)
    && isTimestamp(revision.savedAt)
    && isTimestamp(revision.supersededAt)
    && isByteLength(revision.byteLength));
}

function isRevisionResource(value: unknown): value is RevisionResource {
  return hasExactKeys(value, ["id", "revision", "savedAt", "supersededAt", "byteLength", "content"])
    && typeof value.id === "string"
    && value.id.length > 0
    && isByteLength(value.revision)
    && isTimestamp(value.savedAt)
    && isTimestamp(value.supersededAt)
    && isByteLength(value.byteLength)
    && typeof value.content === "string"
    && new TextEncoder().encode(value.content).byteLength === value.byteLength;
}

type ErrorResponse = { code: ErrorCode; details?: Record<string, unknown> };
type ErrorEnvelope = { error: ErrorResponse };

function isErrorResponse(value: unknown): value is ErrorEnvelope {
  if (!hasExactKeys(value, ["error"]) || !isRecord(value.error)) return false;
  const keys = Object.keys(value.error);
  if (!keys.every((key) => key === "code" || key === "message" || key === "details")
    || !Object.hasOwn(value.error, "code")
    || !Object.hasOwn(value.error, "message")
    || typeof value.error.code !== "string"
    || !errorCodes.has(value.error.code as ErrorCode)
    || typeof value.error.message !== "string") return false;
  return !Object.hasOwn(value.error, "details") || isRecord(value.error.details);
}

function malformed(status: number | null, mutationMayHaveApplied: boolean): ApiFailure {
  return { kind: "malformed", status, code: "MALFORMED_RESPONSE", mutationMayHaveApplied };
}

function network(mutationMayHaveApplied: boolean): ApiFailure {
  return { kind: "network", status: null, code: "NETWORK_ERROR", mutationMayHaveApplied };
}

function httpFailure(status: number, error: ErrorResponse): ApiFailure {
  const details = (error as ErrorResponse & { details?: Record<string, unknown> }).details;
  return {
    kind: "http",
    status,
    code: error.code,
    ...(details === undefined ? {} : { details }),
    mutationMayHaveApplied: typeof details?.mutationMayHaveApplied === "boolean" ? details.mutationMayHaveApplied : null,
  };
}

function jsonHeaders(): HeadersInit {
  return { Accept: jsonMediaType, "Content-Type": jsonMediaType };
}

function getHeaders(ifNoneMatch?: string | null): HeadersInit {
  return {
    Accept: jsonMediaType,
    ...(ifNoneMatch === null || ifNoneMatch === undefined ? {} : { "If-None-Match": ifNoneMatch }),
  };
}

function isOws(value: string | undefined): boolean {
  return value === " " || value === "\t";
}

function skipOws(value: string, index: number): number {
  while (isOws(value[index])) index += 1;
  return index;
}

function equalsAsciiIgnoreCase(value: string, expected: string): boolean {
  if (value.length !== expected.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    let code = value.charCodeAt(index);
    if (code >= 0x41 && code <= 0x5a) code += 0x20;
    if (code !== expected.charCodeAt(index)) return false;
  }
  return true;
}

const tokenCharacter = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]$/;

function readToken(value: string, index: number): [string, number] | undefined {
  const start = index;
  while (index < value.length && tokenCharacter.test(value[index]!)) index += 1;
  return index === start ? undefined : [value.slice(start, index), index];
}

function isQuotedTextCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code === 0x09 || code === 0x20 || code === 0x21 || (code >= 0x23 && code <= 0x5b) || (code >= 0x5d && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
}

function isQuotedPairCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code === 0x09 || code === 0x20 || (code >= 0x21 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
}

function readQuotedString(value: string, index: number): [string, number] | undefined {
  if (value[index] !== '"') return undefined;
  let result = "";
  for (index += 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"') return [result, index + 1];
    if (character === "\\") {
      const escaped = value[index + 1];
      if (escaped === undefined || !isQuotedPairCharacter(escaped)) return undefined;
      result += escaped;
      index += 1;
    } else {
      if (!isQuotedTextCharacter(character)) return undefined;
      result += character;
    }
  }
  return undefined;
}

function readCharset(value: string, index: number): [string, number] | undefined {
  return value[index] === '"' ? readQuotedString(value, index) : readToken(value, index);
}

function isJsonMediaType(value: string | null): boolean {
  if (value === null) return false;
  let index = skipOws(value, 0);
  const mediaType = "application/json";
  if (!equalsAsciiIgnoreCase(value.slice(index, index + mediaType.length), mediaType)) return false;
  index = skipOws(value, index + mediaType.length);
  if (index === value.length) return true;
  if (value[index] !== ";") return false;
  index = skipOws(value, index + 1);
  const parameter = readToken(value, index);
  if (parameter === undefined || !equalsAsciiIgnoreCase(parameter[0], "charset")) return false;
  index = skipOws(value, parameter[1]);
  if (value[index] !== "=") return false;
  const charset = readCharset(value, skipOws(value, index + 1));
  if (charset === undefined || !equalsAsciiIgnoreCase(charset[0], "utf-8")) return false;
  return skipOws(value, charset[1]) === value.length;
}

function isNoStore(value: string | null): boolean {
  if (value === null) return false;
  const start = skipOws(value, 0);
  let end = value.length;
  while (end > start && isOws(value[end - 1])) end -= 1;
  return equalsAsciiIgnoreCase(value.slice(start, end), noStore);
}

function hasJsonHeaders(response: Response): boolean {
  return isJsonMediaType(response.headers.get("content-type")) && isNoStore(response.headers.get("cache-control"));
}

async function webkitNormalizedNotModifiedEtag(response: Response, ifNoneMatch: string | null): Promise<`"sha256-${string}"` | null> {
  if (response.status !== 200
    || !isResourceEtag(ifNoneMatch)
    || response.headers.get("etag") !== ifNoneMatch
    || !isNoStore(response.headers.get("cache-control"))
    || response.headers.has("content-type")
    || response.headers.has("content-length")
    || response.headers.has("trailer")) return null;

  try {
    return (await response.arrayBuffer()).byteLength === 0 ? ifNoneMatch : null;
  } catch {
    return null;
  }
}

async function readJsonBytes(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  if (!hasJsonHeaders(response)) throw new Error("Unexpected response headers");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^(0|[1-9]\d*)$/.test(contentLength) || Number(contentLength) !== bytes.byteLength)) {
    throw new Error("Unexpected content length");
  }
  return bytes;
}

function parseJsonBytes(bytes: Uint8Array<ArrayBuffer>): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
}

async function readJson(response: Response): Promise<unknown> {
  return parseJsonBytes(await readJsonBytes(response));
}

async function readError(response: Response, mutationMayHaveApplied: boolean): Promise<ApiFailure> {
  try {
    const body = await readJson(response);
    return isErrorResponse(body) ? httpFailure(response.status, body.error) : malformed(response.status, mutationMayHaveApplied);
  } catch {
    return malformed(response.status, mutationMayHaveApplied);
  }
}

function expectedMutationEtag(value: PasteSummary): (etag: string | null) => boolean {
  return (etag) => etag === `"${value.version}"` && isStrongMutationEtag(etag);
}

type JsonRequest<T> = {
  url: string;
  init: RequestInit;
  status: number;
  mutationMayHaveApplied: boolean;
  parse: (body: unknown) => body is T;
  etag: (value: T, etag: string | null) => boolean;
};

async function requestJson<T>(fetch: typeof globalThis.fetch, request: JsonRequest<T>): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(request.url, request.init);
  } catch {
    return { ok: false, failure: network(request.mutationMayHaveApplied) };
  }

  if (response.status !== request.status) {
    if (response.status >= 200 && response.status < 300) {
      return { ok: false, failure: malformed(response.status, request.mutationMayHaveApplied) };
    }
    return { ok: false, failure: await readError(response, request.mutationMayHaveApplied) };
  }

  try {
    const body = await readJson(response);
    if (!request.parse(body)) return { ok: false, failure: malformed(response.status, request.mutationMayHaveApplied) };
    const etag = response.headers.get("etag");
    if (!request.etag(body, etag)) return { ok: false, failure: malformed(response.status, request.mutationMayHaveApplied) };
    return { ok: true, status: response.status, value: body, etag };
  } catch {
    return { ok: false, failure: malformed(response.status, request.mutationMayHaveApplied) };
  }
}

function createBody(input: CreateRequest): Record<string, unknown> {
  return {
    content: input.content,
    title: input.title,
    format: input.format,
    expiration: input.expiration,
    password: input.password,
    viewOnce: input.viewOnce,
    ...(input.customId === undefined ? {} : { customId: input.customId }),
  };
}

function mutationBody(body: Record<string, unknown>, password: string | null, version: string | null): string {
  return JSON.stringify({ ...body, ...(password === null ? {} : { password }), ...(version === null ? {} : { version }) });
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function createPasteApi({ fetch, crypto }: ApiDependencies): PasteApi {
  return {
    async create(input, signal) {
      const body = createBody(input);
      const json = JSON.stringify(body);
      const jsonWireBytes = new TextEncoder().encode(json).byteLength;
      const useJson = selectCreateEncoding(jsonWireBytes) === "json";
      const requestBody = useJson ? json : (() => {
        const form = new FormData();
        form.append("content", input.content);
        form.append("title", input.title);
        form.append("format", input.format);
        form.append("expiration", String(input.expiration));
        form.append("password", input.password);
        form.append("viewOnce", String(input.viewOnce));
        if (input.customId !== undefined) form.append("customId", input.customId);
        return form;
      })();
      return requestJson(fetch, {
        url: "/api/pastes",
        init: {
          method: "POST",
          headers: useJson ? jsonHeaders() : { Accept: jsonMediaType },
          body: requestBody,
          cache: "no-store",
          signal,
        },
        status: 201,
        mutationMayHaveApplied: true,
        parse: isPasteSummary,
        etag: (value, etag) => expectedMutationEtag(value)(etag),
      });
    },

    async readResource(input) {
      let response: Response;
      try {
        response = await fetch(withPastePassword(`/api/pastes/${encodeURIComponent(input.id)}`, input.password), {
          method: "GET",
          headers: getHeaders(input.ifNoneMatch),
          cache: "no-store",
          signal: input.signal,
        });
      } catch {
        return { kind: "failure", failure: network(false) };
      }

      if (response.status === 304) {
        const etag = response.headers.get("etag");
        if (!isResourceEtag(input.ifNoneMatch)
          || etag !== input.ifNoneMatch
          || !isNoStore(response.headers.get("cache-control"))
          || response.headers.has("content-type")
          || response.headers.has("content-length")
          || response.headers.has("trailer")
          || response.body !== null) {
          return { kind: "failure", failure: malformed(304, false) };
        }
        return { kind: "not-modified", etag };
      }

      if (response.status !== 200) {
        if (response.status >= 200 && response.status < 300) return { kind: "failure", failure: malformed(response.status, false) };
        return { kind: "failure", failure: await readError(response, false) };
      }

      const normalizedEtag = await webkitNormalizedNotModifiedEtag(response, input.ifNoneMatch);
      if (normalizedEtag !== null) return { kind: "not-modified", etag: normalizedEtag };

      try {
        const bytes = await readJsonBytes(response);
        const etag = response.headers.get("etag");
        if (!isResourceEtag(etag)) return { kind: "failure", failure: malformed(200, false) };
        const digest = base64Url(await crypto.subtle.digest("SHA-256", bytes));
        if (etag !== `"sha256-${digest}"`) return { kind: "failure", failure: malformed(200, false) };
        const body = parseJsonBytes(bytes);
        if (!isPasteResource(body) || body.id !== input.id) return { kind: "failure", failure: malformed(200, false) };
        const snapshot = projectRemoteSnapshot(body, etag);
        return snapshot === undefined
          ? { kind: "failure", failure: malformed(200, false) }
          : { kind: "snapshot", snapshot };
      } catch {
        return { kind: "failure", failure: malformed(200, false) };
      }
    },

    async saveContent(input) {
      return requestJson(fetch, {
        url: `/api/pastes/${encodeURIComponent(input.id)}`,
        init: {
          method: "PATCH",
          headers: jsonHeaders(),
          body: mutationBody({ content: input.content }, input.password, input.version),
          cache: "no-store",
          signal: input.signal,
        },
        status: 200,
        mutationMayHaveApplied: true,
        parse: (value): value is MutationResult => isMutationResult(value) && value.paste.id === input.id,
        etag: (value, etag) => expectedMutationEtag(value.paste)(etag),
      });
    },

    async getSettings(input) {
      return requestJson(fetch, {
        url: withPastePassword(`/api/pastes/${encodeURIComponent(input.id)}/settings`, input.password),
        init: { method: "GET", headers: getHeaders(), cache: "no-store", signal: input.signal },
        status: 200,
        mutationMayHaveApplied: false,
        parse: (value): value is PasteSummary => isPasteSummary(value) && value.id === input.id,
        etag: (value, etag) => expectedMutationEtag(value)(etag),
      });
    },

    async updateSettings(input) {
      return requestJson(fetch, {
        url: `/api/pastes/${encodeURIComponent(input.id)}/settings`,
        init: {
          method: "PATCH",
          headers: jsonHeaders(),
          body: mutationBody({ [input.change.field]: input.change.value }, input.password, input.version),
          cache: "no-store",
          signal: input.signal,
        },
        status: 200,
        mutationMayHaveApplied: true,
        parse: (value): value is MutationResult => isMutationResult(value) && value.paste.id === input.id,
        etag: (value, etag) => expectedMutationEtag(value.paste)(etag),
      });
    },

    async updatePassword(input) {
      return requestJson(fetch, {
        url: `/api/pastes/${encodeURIComponent(input.id)}/password`,
        init: {
          method: "PUT",
          headers: jsonHeaders(),
          body: mutationBody({ newPassword: input.newPassword }, input.password, input.version),
          cache: "no-store",
          signal: input.signal,
        },
        status: 200,
        mutationMayHaveApplied: true,
        parse: (value): value is MutationResult => isMutationResult(value) && value.paste.id === input.id,
        etag: (value, etag) => expectedMutationEtag(value.paste)(etag),
      });
    },

    async clearPassword(input) {
      return requestJson(fetch, {
        url: `/api/pastes/${encodeURIComponent(input.id)}/password`,
        init: {
          method: "DELETE",
          headers: jsonHeaders(),
          body: mutationBody({}, input.password, input.version),
          cache: "no-store",
          signal: input.signal,
        },
        status: 200,
        mutationMayHaveApplied: true,
        parse: (value): value is MutationResult => isMutationResult(value) && value.paste.id === input.id,
        etag: (value, etag) => expectedMutationEtag(value.paste)(etag),
      });
    },

    async deletePaste(input) {
      let response: Response;
      try {
        response = await fetch(`/api/pastes/${encodeURIComponent(input.id)}`, {
          method: "DELETE",
          headers: jsonHeaders(),
          body: mutationBody({}, input.password, input.version),
          cache: "no-store",
          signal: input.signal,
        });
      } catch {
        return { ok: false, failure: network(true) };
      }

      if (response.status !== 204) {
        if (response.status >= 200 && response.status < 300) return { ok: false, failure: malformed(response.status, true) };
        return { ok: false, failure: await readError(response, true) };
      }

      let emptyBody = response.body === null;
      if (!emptyBody && equalsAsciiIgnoreCase(response.headers.get("content-encoding") ?? "", "gzip")) {
        try { emptyBody = (await response.arrayBuffer()).byteLength === 0; } catch { emptyBody = false; }
      }
      if (!isNoStore(response.headers.get("cache-control"))
        || response.headers.has("content-type")
        || response.headers.has("content-length")
        || !emptyBody) {
        return { ok: false, failure: malformed(204, true) };
      }
      return { ok: true, status: 204, value: null, etag: null };
    },

    async listHistory(input) {
      return requestJson(fetch, {
        url: withPastePassword(`/api/pastes/${encodeURIComponent(input.id)}/history`, input.password),
        init: { method: "GET", headers: getHeaders(), cache: "no-store", signal: input.signal },
        status: 200,
        mutationMayHaveApplied: false,
        parse: (value): value is HistoryList => isHistoryList(value) && value.id === input.id,
        etag: (value, etag) => etag === `"${value.currentVersion}"` && isStrongMutationEtag(etag),
      });
    },

    async getHistory(input) {
      return requestJson(fetch, {
        url: withPastePassword(`/api/pastes/${encodeURIComponent(input.id)}/history/${input.revision}`, input.password),
        init: { method: "GET", headers: getHeaders(), cache: "no-store", signal: input.signal },
        status: 200,
        mutationMayHaveApplied: false,
        parse: (value): value is RevisionResource => isRevisionResource(value) && value.id === input.id && value.revision === input.revision,
        etag: (_value, etag) => isStrongMutationEtag(etag),
      });
    },
  };
}
