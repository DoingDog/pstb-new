import type {
  ContentMarkerV2,
  Expiration,
  ExpirationInput,
  HistoryDescriptor,
  HistoryList,
  LoadedPaste,
  PasteMetadataV2,
  PasteSummary,
  RevisionMarkerV2,
  RevisionResource,
} from "./types";
import { PasteError } from "./types";
import { impossibleOpaqueMatch, parseStrictJsonObject } from "./json";

const MAX_CONTENT_BYTES = 10_485_760;
const MAX_RELATIVE_EXPIRATION = Date.parse("9999-12-31T23:59:59.999Z");
const RESERVED_IDS = new Set([
  "api",
  "raw",
  "html",
  "md",
  "file",
  "delete",
  "mcp",
  "ip-trace",
  "assets",
  "favicon",
  "favicon.ico",
  "robots",
  "robots.txt",
]);

export type NormalizedExpiration = {
  expiration: Expiration;
  expiresAt: string | null;
  physicalExpiration: number | null;
};

export type CreateInput = {
  content: string;
  title?: string;
  format?: "text" | "markdown";
  expiration?: ExpirationInput;
  password?: string;
  viewOnce?: boolean;
  customId?: string;
};

export type RequestMeta = { country?: string | null };

type OpaqueMatch = string | typeof impossibleOpaqueMatch;
type CurrentCredential = string | null | typeof impossibleOpaqueMatch;

export type UpdateContentInput = {
  content: string;
  password?: CurrentCredential;
  version?: OpaqueMatch;
};

export type UpdateSettingsInput = {
  password?: CurrentCredential;
  version?: OpaqueMatch;
  title?: string;
  format?: "text" | "markdown";
  expiration?: ExpirationInput;
  viewOnce?: boolean;
};

export type UpdatePasswordInput = {
  password?: CurrentCredential;
  version?: OpaqueMatch;
  newPassword: string;
};

type LegacyMigrationInput = {
  content: string;
  contentChanged: boolean;
  title: string;
  format: "text" | "markdown";
  password: string | null;
  viewOnce: boolean;
  expiresAt: string | null;
  expiration: Expiration;
};

function validationError(field: string, message: string): PasteError {
  return new PasteError("VALIDATION_FAILED", 422, undefined, { fields: [{ field, message }] });
}

function storageError(code: "STORAGE_READ_FAILED" | "STORAGE_WRITE_FAILED", mutationMayHaveApplied = false): PasteError {
  return new PasteError(
    code,
    503,
    undefined,
    code === "STORAGE_READ_FAILED" ? { retryable: true } : { retryable: true, mutationMayHaveApplied },
  );
}

function inconsistent(): PasteError {
  return new PasteError("STORAGE_INCONSISTENT", 503, undefined, { retryable: true });
}

function countScalars(value: string): number {
  let count = 0;
  for (const scalar of value) {
    const first = scalar.charCodeAt(0);
    if (scalar.length === 1 && first >= 0xd800 && first <= 0xdfff) {
      throw validationError("content", "Must contain only Unicode scalar values.");
    }
    count += 1;
  }
  return count;
}

function assertScalarSequence(value: string, field: string): number {
  try {
    return countScalars(value);
  } catch (error) {
    if (error instanceof PasteError) {
      throw validationError(field, "Must contain only Unicode scalar values.");
    }
    throw error;
  }
}

function canonicalDate(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function physicalExpiration(expiresAt: string | null, now: Date): number | null {
  if (expiresAt === null) return null;
  return Math.ceil(Math.max(new Date(expiresAt).getTime(), now.getTime() + 60_000) / 1000);
}

function sameExpiration(left: Expiration, right: Expiration): boolean {
  return left.kind === right.kind && (left.kind !== "relative" || (right.kind === "relative" && left.seconds === right.seconds));
}

export function contentKey(id: string): string {
  return id;
}

export function metaKey(id: string): string {
  return `__cfpb:meta:${id}`;
}

export function revisionKey(id: string, slot: number): string {
  return `__cfpb:rev:${id}:${slot}`;
}

export function validateId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw validationError("id", "Must be 1 to 64 ASCII letters, digits, underscores, or hyphens.");
  }
  const lower = value.toLowerCase();
  if (lower.startsWith("__cfpb") || RESERVED_IDS.has(lower)) {
    throw validationError("id", "Is reserved.");
  }
  return value;
}

export function validateContent(value: unknown): string {
  if (typeof value !== "string") throw validationError("content", "Must be a string.");
  assertScalarSequence(value, "content");
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes === 0) throw validationError("content", "Must not be empty.");
  if (bytes > MAX_CONTENT_BYTES) {
    throw new PasteError("CONTENT_TOO_LARGE", 413, undefined, { maxBytes: MAX_CONTENT_BYTES });
  }
  return value;
}

export function validateTitle(value: unknown): string {
  if (typeof value !== "string") throw validationError("title", "Must be a string.");
  if (assertScalarSequence(value, "title") > 200) throw validationError("title", "Must contain at most 200 Unicode scalars.");
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) throw validationError("title", "Must not contain control characters.");
  }
  return value;
}

export function validatePassword(value: unknown): string {
  if (typeof value !== "string") throw validationError("password", "Must be a string.");
  let count = 0;
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint > 0x7e) {
      throw validationError("password", "Must be empty or 1 to 128 visible ASCII characters.");
    }
    count += 1;
  }
  if (count > 128) throw validationError("password", "Must be empty or 1 to 128 visible ASCII characters.");
  return value;
}

function parseAbsoluteExpiration(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  const zone = match[8]!;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;

  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, millisecond);
  if (
    wall.getUTCFullYear() !== year ||
    wall.getUTCMonth() !== month - 1 ||
    wall.getUTCDate() !== day ||
    wall.getUTCHours() !== hour ||
    wall.getUTCMinutes() !== minute ||
    wall.getUTCSeconds() !== second
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const sign = zone[0] === "+" ? 1 : -1;
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }
  const instant = new Date(wall.getTime() - offsetMinutes * 60_000);
  return Number.isFinite(instant.getTime()) && instant.getTime() <= MAX_RELATIVE_EXPIRATION ? instant.toISOString() : null;
}

export function normalizeExpiration(value: ExpirationInput, now: Date): NormalizedExpiration {
  if (!Number.isFinite(now.getTime())) throw validationError("expiration", "Cannot normalize against an invalid clock.");
  if (value === null || value === "permanent") {
    return { expiration: { kind: "permanent" }, expiresAt: null, physicalExpiration: null };
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 60) {
      throw validationError("expiration", "Must be permanent, at least 60 seconds, or a timezone-bearing RFC3339 timestamp.");
    }
    if (value > Math.floor((MAX_RELATIVE_EXPIRATION - now.getTime()) / 1000)) {
      throw validationError("expiration", "Is outside the supported timestamp range.");
    }
    const expiresAt = new Date(now.getTime() + value * 1000).toISOString();
    return {
      expiration: { kind: "relative", seconds: value },
      expiresAt,
      physicalExpiration: physicalExpiration(expiresAt, now),
    };
  }
  if (typeof value === "string") {
    const expiresAt = parseAbsoluteExpiration(value);
    if (expiresAt !== null && new Date(expiresAt).getTime() - now.getTime() >= 60_000) {
      return { expiration: { kind: "absolute" }, expiresAt, physicalExpiration: physicalExpiration(expiresAt, now) };
    }
  }
  throw validationError("expiration", "Must be permanent, at least 60 seconds, or a timezone-bearing RFC3339 timestamp.");
}

function links(id: string) {
  return {
    view: `/${id}`,
    raw: `/raw/${id}`,
    html: `/html/${id}`,
    markdown: `/md/${id}`,
    file: `/file/${id}`,
  };
}

function summary(metadata: PasteMetadataV2): PasteSummary {
  return {
    id: metadata.id,
    title: metadata.title,
    format: metadata.format,
    viewOnce: metadata.viewOnce,
    protected: metadata.password !== null,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    expiresAt: metadata.expiresAt,
    expiration: metadata.expiration,
    version: `${metadata.generation}.${metadata.versionCounter}`,
    contentRevision: metadata.contentRevision,
    contentBytes: metadata.contentBytes,
    createdCountry: metadata.createdCountry,
    links: links(metadata.id),
  };
}

const MARKER_FIELDS = new Set(["kind", "schemaVersion", "generation", "contentRevision", "savedAt", "byteLength", "commit"]);
const MARKER_KEYS = new Set(["kind", "schemaVersion", "generation", "contentRevision", "savedAt", "byteLength", "commit"]);
const METADATA_KEYS = new Set([
  "schemaVersion",
  "generation",
  "id",
  "title",
  "format",
  "password",
  "viewOnce",
  "createdAt",
  "updatedAt",
  "currentSavedAt",
  "expiresAt",
  "expiration",
  "physicalExpiration",
  "versionCounter",
  "contentRevision",
  "contentBytes",
  "createdCountry",
  "history",
]);
const HISTORY_KEYS = new Set(["nextSlot", "entries"]);
const DESCRIPTOR_KEYS = new Set(["revision", "slot", "savedAt", "supersededAt", "byteLength"]);
const COMMIT_KEYS = new Set(["versionCounter", "previous"]);
const REVISION_MARKER_KEYS = new Set(["kind", "schemaVersion", "generation", "revision", "savedAt", "supersededAt", "byteLength"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactObject(value: unknown, expected: ReadonlySet<string>): Record<string, unknown> {
  if (!isPlainObject(value)) throw inconsistent();
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) throw inconsistent();
  return value;
}

function isV4Uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRingSlot(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2;
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && canonicalDate(value);
}

function parseDescriptor(value: unknown): HistoryDescriptor {
  const descriptor = exactObject(value, DESCRIPTOR_KEYS);
  const revision = descriptor.revision;
  const slot = descriptor.slot;
  const savedAt = descriptor.savedAt;
  const supersededAt = descriptor.supersededAt;
  const byteLength = descriptor.byteLength;
  if (
    !isPositiveSafeInteger(revision) ||
    !isRingSlot(slot) ||
    !isCanonicalTimestamp(savedAt) ||
    !isCanonicalTimestamp(supersededAt) ||
    !isPositiveSafeInteger(byteLength) ||
    byteLength > MAX_CONTENT_BYTES ||
    new Date(supersededAt).getTime() < new Date(savedAt).getTime()
  ) {
    throw inconsistent();
  }
  return { revision, slot, savedAt, supersededAt, byteLength };
}

function parseExpirationState(value: unknown): Expiration {
  if (!isPlainObject(value) || typeof value.kind !== "string") throw inconsistent();
  if (value.kind === "permanent") {
    exactObject(value, new Set(["kind"]));
    return { kind: "permanent" };
  }
  if (value.kind === "relative") {
    const relative = exactObject(value, new Set(["kind", "seconds"]));
    if (!isPositiveSafeInteger(relative.seconds) || relative.seconds < 60) throw inconsistent();
    return { kind: "relative", seconds: relative.seconds };
  }
  if (value.kind === "absolute") {
    exactObject(value, new Set(["kind"]));
    return { kind: "absolute" };
  }
  throw inconsistent();
}

function parseContentMarker(value: unknown): ContentMarkerV2 {
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw inconsistent();
  }
  if (size > 1024) throw inconsistent();
  const marker = exactObject(value, MARKER_KEYS);
  if (
    marker.kind !== "cfpb/content" ||
    marker.schemaVersion !== 2 ||
    !isV4Uuid(marker.generation) ||
    !isPositiveSafeInteger(marker.contentRevision) ||
    !isCanonicalTimestamp(marker.savedAt) ||
    !isPositiveSafeInteger(marker.byteLength) ||
    marker.byteLength > MAX_CONTENT_BYTES
  ) {
    throw inconsistent();
  }
  let commit: ContentMarkerV2["commit"];
  if (marker.commit === null) {
    commit = null;
  } else {
    const parsedCommit = exactObject(marker.commit, COMMIT_KEYS);
    if (!isPositiveSafeInteger(parsedCommit.versionCounter)) throw inconsistent();
    commit = { versionCounter: parsedCommit.versionCounter, previous: parseDescriptor(parsedCommit.previous) };
  }
  return {
    kind: "cfpb/content",
    schemaVersion: 2,
    generation: marker.generation,
    contentRevision: marker.contentRevision,
    savedAt: marker.savedAt,
    byteLength: marker.byteLength,
    commit,
  };
}

function parseRevisionMarker(value: unknown): RevisionMarkerV2 {
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw inconsistent();
  }
  if (size > 1024) throw inconsistent();
  const marker = exactObject(value, REVISION_MARKER_KEYS);
  if (
    marker.kind !== "cfpb/revision" ||
    marker.schemaVersion !== 2 ||
    !isV4Uuid(marker.generation) ||
    !isPositiveSafeInteger(marker.revision) ||
    !isCanonicalTimestamp(marker.savedAt) ||
    !isCanonicalTimestamp(marker.supersededAt) ||
    !isPositiveSafeInteger(marker.byteLength) ||
    marker.byteLength > MAX_CONTENT_BYTES ||
    new Date(marker.supersededAt).getTime() < new Date(marker.savedAt).getTime()
  ) {
    throw inconsistent();
  }
  return {
    kind: "cfpb/revision",
    schemaVersion: 2,
    generation: marker.generation,
    revision: marker.revision,
    savedAt: marker.savedAt,
    supersededAt: marker.supersededAt,
    byteLength: marker.byteLength,
  };
}

function parseMetadataShape(value: unknown, expectedId: string): PasteMetadataV2 {
  const metadata = exactObject(value, METADATA_KEYS);
  const generation = metadata.generation;
  const id = metadata.id;
  const title = metadata.title;
  const format = metadata.format;
  const password = metadata.password;
  const viewOnce = metadata.viewOnce;
  const createdAt = metadata.createdAt;
  const updatedAt = metadata.updatedAt;
  const currentSavedAt = metadata.currentSavedAt;
  const versionCounter = metadata.versionCounter;
  const contentRevision = metadata.contentRevision;
  const contentBytes = metadata.contentBytes;
  const createdCountry = metadata.createdCountry;
  if (
    metadata.schemaVersion !== 2 ||
    !isV4Uuid(generation) ||
    typeof id !== "string" ||
    id !== expectedId ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) ||
    typeof title !== "string" ||
    (format !== "text" && format !== "markdown") ||
    (password !== null && (typeof password !== "string" || password === "")) ||
    typeof viewOnce !== "boolean" ||
    !isCanonicalTimestamp(createdAt) ||
    !isCanonicalTimestamp(updatedAt) ||
    !isCanonicalTimestamp(currentSavedAt) ||
    !isPositiveSafeInteger(versionCounter) ||
    !isPositiveSafeInteger(contentRevision) ||
    !isPositiveSafeInteger(contentBytes) ||
    contentBytes > MAX_CONTENT_BYTES ||
    (createdCountry !== null && typeof createdCountry !== "string")
  ) {
    throw inconsistent();
  }
  try {
    validateTitle(title);
    if (password !== null) validatePassword(password);
  } catch {
    throw inconsistent();
  }

  const expiration = parseExpirationState(metadata.expiration);
  const expiresAt = metadata.expiresAt;
  const physical = metadata.physicalExpiration;
  let normalizedExpiresAt: string | null;
  let normalizedPhysical: number | null;
  if (expiration.kind === "permanent") {
    if (expiresAt !== null || physical !== null) throw inconsistent();
    normalizedExpiresAt = null;
    normalizedPhysical = null;
  } else {
    if (
      !isCanonicalTimestamp(expiresAt) ||
      !isPositiveSafeInteger(physical) ||
      physical < Math.ceil(new Date(expiresAt).getTime() / 1000)
    ) {
      throw inconsistent();
    }
    normalizedExpiresAt = expiresAt;
    normalizedPhysical = physical;
  }

  const history = exactObject(metadata.history, HISTORY_KEYS);
  const nextSlot = history.nextSlot;
  const rawEntries = history.entries;
  if (!isRingSlot(nextSlot) || !Array.isArray(rawEntries) || rawEntries.length > 3) throw inconsistent();
  const entries = rawEntries.map(parseDescriptor);
  if (
    new Set(entries.map((entry) => entry.slot)).size !== entries.length ||
    entries.some((entry, index) => (index > 0 && entries[index - 1]!.revision <= entry.revision) || entry.revision >= contentRevision)
  ) {
    throw inconsistent();
  }

  return {
    schemaVersion: 2,
    generation,
    id,
    title,
    format,
    password,
    viewOnce,
    createdAt,
    updatedAt,
    currentSavedAt,
    expiresAt: normalizedExpiresAt,
    expiration,
    physicalExpiration: normalizedPhysical,
    versionCounter,
    contentRevision,
    contentBytes,
    createdCountry,
    history: { nextSlot, entries },
  };
}

async function parseMetadata(value: string, expectedId: string): Promise<PasteMetadataV2> {
  if (new TextEncoder().encode(value).byteLength > 16 * 1024) throw inconsistent();
  let parsed: unknown;
  try {
    parsed = await parseStrictJsonObject(new Request("https://metadata.invalid", { method: "POST", body: value }), METADATA_KEYS);
  } catch {
    throw inconsistent();
  }
  return parseMetadataShape(parsed, expectedId);
}

function hasMarkerField(metadata: unknown): boolean {
  return isPlainObject(metadata) && Object.keys(metadata).some((key) => MARKER_FIELDS.has(key));
}

function legacyTimestamp(value: unknown): { milliseconds: number; iso: string } | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return { milliseconds: date.getTime(), iso: date.toISOString() };
}

function projectLegacy(id: string, content: string, attachedMetadata: unknown): LoadedPaste {
  const attached = isPlainObject(attachedMetadata) ? attachedMetadata : {};
  let title = "";
  if (typeof attached.title === "string") {
    try {
      title = validateTitle(attached.title);
    } catch {
      title = "";
    }
  }
  const created = legacyTimestamp(attached.createdAt);
  const legacyExpiration = typeof attached.expiration === "number" && Number.isFinite(attached.expiration) && attached.expiration >= 0
    ? attached.expiration
    : null;
  let expiresAt: string | null = null;
  if (created !== null && legacyExpiration !== null) {
    const expires = new Date(created.milliseconds + legacyExpiration * 1000);
    if (Number.isFinite(expires.getTime())) expiresAt = expires.toISOString();
  }
  const createdCountry = typeof attached.country === "string" && /^[A-Za-z]{2}$/.test(attached.country) ? attached.country : null;
  const expiration: Expiration = expiresAt === null || legacyExpiration === null
    ? { kind: "permanent" }
    : { kind: "relative", seconds: legacyExpiration };
  const metadata = {
    createdAt: created?.iso ?? null,
    expiresAt,
    createdCountry,
    expiration: legacyExpiration,
  };
  const pasteSummary: PasteSummary = {
    id,
    title,
    format: "text",
    viewOnce: false,
    protected: false,
    createdAt: metadata.createdAt,
    updatedAt: metadata.createdAt ?? new Date(0).toISOString(),
    expiresAt,
    expiration,
    version: "legacy",
    contentRevision: 1,
    contentBytes: new TextEncoder().encode(content).byteLength,
    createdCountry,
    links: links(id),
  };
  return { content, metadata, summary: pasteSummary, legacy: true, marker: null };
}

export class PasteService {
  constructor(
    private readonly db: KVNamespace,
    private readonly clock: () => Date = () => new Date(),
    private readonly uuid: () => string = () => crypto.randomUUID(),
  ) {}

  async create(input: CreateInput, requestMeta: RequestMeta): Promise<PasteSummary> {
    const content = validateContent(input.content);
    const title = input.title === undefined ? "" : validateTitle(input.title);
    const format = input.format === undefined ? "text" : input.format;
    if (format !== "text" && format !== "markdown") throw validationError("format", "Must be text or markdown.");
    const password = input.password === undefined ? "" : validatePassword(input.password);
    const viewOnce = input.viewOnce === undefined ? false : input.viewOnce;
    if (typeof viewOnce !== "boolean") throw validationError("viewOnce", "Must be a boolean.");
    const capturedNow = this.clock();
    const expiration = normalizeExpiration(input.expiration === undefined ? 86_400 : input.expiration, capturedNow);

    const id = input.customId === undefined ? await this.createAutomaticId() : validateId(input.customId);
    if (input.customId !== undefined && !(await this.isVacant(id))) {
      throw new PasteError("ID_CONFLICT", 409, undefined, { id });
    }

    const generation = this.uuid();
    const createdAt = capturedNow.toISOString();
    const contentBytes = new TextEncoder().encode(content).byteLength;
    const metadata: PasteMetadataV2 = {
      schemaVersion: 2,
      generation,
      id,
      title,
      format,
      password: password === "" ? null : password,
      viewOnce,
      createdAt,
      updatedAt: createdAt,
      currentSavedAt: createdAt,
      expiresAt: expiration.expiresAt,
      expiration: expiration.expiration,
      physicalExpiration: expiration.physicalExpiration,
      versionCounter: 1,
      contentRevision: 1,
      contentBytes,
      createdCountry: requestMeta.country ?? null,
      history: { nextSlot: 0, entries: [] },
    };
    const marker: ContentMarkerV2 = {
      kind: "cfpb/content",
      schemaVersion: 2,
      generation,
      contentRevision: 1,
      savedAt: createdAt,
      byteLength: contentBytes,
      commit: null,
    };
    const options = expiration.physicalExpiration === null ? {} : { expiration: expiration.physicalExpiration };

    try {
      await this.db.put(metaKey(id), JSON.stringify(metadata), options);
    } catch {
      throw storageError("STORAGE_WRITE_FAILED");
    }
    try {
      await this.db.put(contentKey(id), content, { ...options, metadata: marker });
    } catch {
      const cleanup = await Promise.allSettled([
        this.db.delete(metaKey(id)),
        this.db.delete(revisionKey(id, 0)),
        this.db.delete(revisionKey(id, 1)),
        this.db.delete(revisionKey(id, 2)),
      ]);
      throw storageError("STORAGE_WRITE_FAILED", cleanup.some((result) => result.status === "rejected"));
    }
    return summary(metadata);
  }

  async loadContent(id: string, password?: CurrentCredential, options: { cleanupExpired?: boolean } = {}): Promise<LoadedPaste> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
      throw validationError("id", "Must be 1 to 64 ASCII letters, digits, underscores, or hyphens.");
    }

    let main: { value: string | null; metadata: unknown };
    let sibling: string | null;
    try {
      [main, sibling] = await Promise.all([
        this.db.getWithMetadata<unknown>(contentKey(id), "text"),
        this.db.get(metaKey(id), "text"),
      ]);
    } catch {
      throw storageError("STORAGE_READ_FAILED");
    }
    if (main.value === null) throw new PasteError("PASTE_NOT_FOUND", 404);
    try {
      assertScalarSequence(main.value, "content");
    } catch {
      throw inconsistent();
    }

    if (hasMarkerField(main.metadata)) {
      const marker = parseContentMarker(main.metadata);
      if (sibling === null) throw inconsistent();
      let metadata = await parseMetadata(sibling, id);
      const bytes = new TextEncoder().encode(main.value).byteLength;
      if (
        marker.generation !== metadata.generation ||
        marker.contentRevision !== metadata.contentRevision ||
        marker.savedAt !== metadata.currentSavedAt ||
        marker.byteLength !== bytes ||
        metadata.contentBytes !== bytes
      ) {
        metadata = await this.reconcileMetadataLast(id, main.value, marker, metadata, bytes);
      }
      await this.throwIfExpired(id, metadata.expiresAt, options.cleanupExpired !== false);
      this.authorize(metadata.password, password);
      return { content: main.value, metadata, summary: summary(metadata), legacy: false, marker };
    }

    if (sibling !== null) throw inconsistent();
    const legacy = projectLegacy(id, main.value, main.metadata);
    await this.throwIfExpired(id, legacy.summary.expiresAt, options.cleanupExpired !== false);
    return legacy;
  }

  async getSettings(id: string, password?: string | null): Promise<PasteSummary> {
    return (await this.loadContent(id, password)).summary;
  }

  async updateContent(id: string, input: UpdateContentInput) {
    const content = validateContent(input.content);
    const loaded = await this.loadContent(id, input.password);
    if (loaded.legacy) {
      this.assertLegacyVersion(loaded.summary, input.version);
      if (content === loaded.content) return { changed: false, paste: loaded.summary };
      return {
        changed: true,
        paste: await this.migrateLegacy(id, loaded, {
          content,
          contentChanged: true,
          title: loaded.summary.title,
          format: "text",
          password: null,
          viewOnce: false,
          expiresAt: loaded.summary.expiresAt,
          expiration: loaded.summary.expiration,
        }),
      };
    }
    this.assertVersion(loaded.metadata, input.version);
    if (content === loaded.content) return { changed: false, paste: loaded.summary };

    const now = this.mutationNow();
    const savedAt = now.toISOString();
    const physical = physicalExpiration(loaded.metadata.expiresAt, now);
    const options = physical === null ? {} : { expiration: physical };
    const previous: HistoryDescriptor = {
      revision: loaded.metadata.contentRevision,
      slot: loaded.metadata.history.nextSlot,
      savedAt: loaded.metadata.currentSavedAt,
      supersededAt: savedAt,
      byteLength: loaded.metadata.contentBytes,
    };
    const revisionMarker: RevisionMarkerV2 = {
      kind: "cfpb/revision",
      schemaVersion: 2,
      generation: loaded.metadata.generation,
      revision: previous.revision,
      savedAt: previous.savedAt,
      supersededAt: previous.supersededAt,
      byteLength: previous.byteLength,
    };

    try {
      await this.db.put(revisionKey(id, previous.slot), loaded.content, { ...options, metadata: revisionMarker });
    } catch {
      throw storageError("STORAGE_WRITE_FAILED");
    }
    if (physical !== loaded.metadata.physicalExpiration) {
      await this.rewriteActiveRevisions(id, loaded.metadata, previous.slot, options);
    }

    const contentRevision = loaded.metadata.contentRevision + 1;
    const versionCounter = loaded.metadata.versionCounter + 1;
    const contentBytes = new TextEncoder().encode(content).byteLength;
    const marker: ContentMarkerV2 = {
      kind: "cfpb/content",
      schemaVersion: 2,
      generation: loaded.metadata.generation,
      contentRevision,
      savedAt,
      byteLength: contentBytes,
      commit: { versionCounter, previous },
    };
    try {
      await this.db.put(contentKey(id), content, { ...options, metadata: marker });
    } catch {
      throw storageError("STORAGE_WRITE_FAILED");
    }

    const entries = [previous, ...loaded.metadata.history.entries.filter((entry) => entry.slot !== previous.slot)]
      .sort((left, right) => right.revision - left.revision)
      .slice(0, 3);
    const metadata: PasteMetadataV2 = {
      ...loaded.metadata,
      updatedAt: savedAt,
      currentSavedAt: savedAt,
      physicalExpiration: physical,
      versionCounter,
      contentRevision,
      contentBytes,
      history: { nextSlot: (previous.slot + 1) % 3, entries },
    };
    try {
      await this.db.put(metaKey(id), JSON.stringify(metadata), options);
    } catch {
      throw storageError("STORAGE_WRITE_FAILED", true);
    }
    return { changed: true, paste: summary(metadata) };
  }

  async updateSettings(id: string, input: UpdateSettingsInput) {
    const hasTitle = input.title !== undefined;
    const hasFormat = input.format !== undefined;
    const hasExpiration = input.expiration !== undefined;
    const hasViewOnce = input.viewOnce !== undefined;
    if (!hasTitle && !hasFormat && !hasExpiration && !hasViewOnce) {
      throw validationError("settings", "Must include at least one setting.");
    }

    const loaded = await this.loadContent(id, input.password);
    const now = this.mutationNow();
    if (loaded.legacy) {
      this.assertLegacyVersion(loaded.summary, input.version);
      const title = hasTitle ? validateTitle(input.title!) : loaded.summary.title;
      let format: "text" | "markdown" = "text";
      if (hasFormat) {
        if (input.format !== "text" && input.format !== "markdown") throw validationError("format", "Must be text or markdown.");
        format = input.format;
      }
      let viewOnce = false;
      if (hasViewOnce) {
        if (typeof input.viewOnce !== "boolean") throw validationError("viewOnce", "Must be a boolean.");
        viewOnce = input.viewOnce;
      }
      const normalized = hasExpiration ? normalizeExpiration(input.expiration!, now) : undefined;
      const expirationChanged = normalized !== undefined && (
        normalized.expiration.kind === "relative" ||
        normalized.expiresAt !== loaded.summary.expiresAt ||
        !sameExpiration(normalized.expiration, loaded.summary.expiration)
      );
      const changed = title !== loaded.summary.title || format !== "text" || viewOnce || expirationChanged;
      if (!changed) return { changed: false, paste: loaded.summary };
      return {
        changed: true,
        paste: await this.migrateLegacy(id, loaded, {
          content: loaded.content,
          contentChanged: false,
          title,
          format,
          password: null,
          viewOnce,
          expiresAt: hasExpiration ? normalized!.expiresAt : loaded.summary.expiresAt,
          expiration: hasExpiration ? normalized!.expiration : loaded.summary.expiration,
        }),
      };
    }
    this.assertVersion(loaded.metadata, input.version);
    const title = hasTitle ? validateTitle(input.title!) : loaded.metadata.title;
    let format = loaded.metadata.format;
    if (hasFormat) {
      if (input.format !== "text" && input.format !== "markdown") throw validationError("format", "Must be text or markdown.");
      format = input.format;
    }
    let viewOnce = loaded.metadata.viewOnce;
    if (hasViewOnce) {
      if (typeof input.viewOnce !== "boolean") throw validationError("viewOnce", "Must be a boolean.");
      viewOnce = input.viewOnce;
    }
    const normalized = hasExpiration ? normalizeExpiration(input.expiration!, now) : undefined;
    const expirationChanged = normalized !== undefined && (
      normalized.expiration.kind === "relative" ||
      normalized.expiresAt !== loaded.metadata.expiresAt ||
      !sameExpiration(normalized.expiration, loaded.metadata.expiration)
    );
    const changed = title !== loaded.metadata.title || format !== loaded.metadata.format || viewOnce !== loaded.metadata.viewOnce || expirationChanged;
    if (!changed) return { changed: false, paste: loaded.summary };

    const expiresAt = hasExpiration ? normalized!.expiresAt : loaded.metadata.expiresAt;
    const expiration = hasExpiration ? normalized!.expiration : loaded.metadata.expiration;
    const physical = physicalExpiration(expiresAt, now);
    const rewritesKeys = expirationChanged || physical !== loaded.metadata.physicalExpiration;
    const options = physical === null ? {} : { expiration: physical };
    if (rewritesKeys) {
      try {
        await this.db.put(contentKey(id), loaded.content, { ...options, metadata: loaded.marker });
      } catch {
        throw storageError("STORAGE_WRITE_FAILED");
      }
      await this.rewriteActiveRevisions(id, loaded.metadata, undefined, options);
    }

    const metadata: PasteMetadataV2 = {
      ...loaded.metadata,
      title,
      format,
      viewOnce,
      updatedAt: now.toISOString(),
      expiresAt,
      expiration,
      physicalExpiration: physical,
      versionCounter: loaded.metadata.versionCounter + 1,
    };
    try {
      await this.db.put(metaKey(id), JSON.stringify(metadata), options);
    } catch {
      throw storageError("STORAGE_WRITE_FAILED", rewritesKeys);
    }
    return { changed: true, paste: summary(metadata) };
  }

  async updatePassword(id: string, input: UpdatePasswordInput) {
    const password = validatePassword(input.newPassword);
    const loaded = await this.loadContent(id, input.password);
    const nextPassword = password === "" ? null : password;
    if (loaded.legacy) {
      this.assertLegacyVersion(loaded.summary, input.version);
      if (nextPassword === null) return { changed: false, paste: loaded.summary };
      return {
        changed: true,
        paste: await this.migrateLegacy(id, loaded, {
          content: loaded.content,
          contentChanged: false,
          title: loaded.summary.title,
          format: "text",
          password: nextPassword,
          viewOnce: false,
          expiresAt: loaded.summary.expiresAt,
          expiration: loaded.summary.expiration,
        }),
      };
    }
    this.assertVersion(loaded.metadata, input.version);
    if (nextPassword === loaded.metadata.password) return { changed: false, paste: loaded.summary };

    const now = this.mutationNow();
    const physical = physicalExpiration(loaded.metadata.expiresAt, now);
    const rewritesKeys = physical !== loaded.metadata.physicalExpiration;
    const options = physical === null ? {} : { expiration: physical };
    if (rewritesKeys) {
      try {
        await this.db.put(contentKey(id), loaded.content, { ...options, metadata: loaded.marker });
      } catch {
        throw storageError("STORAGE_WRITE_FAILED");
      }
      await this.rewriteActiveRevisions(id, loaded.metadata, undefined, options);
    }

    const metadata: PasteMetadataV2 = {
      ...loaded.metadata,
      password: nextPassword,
      updatedAt: now.toISOString(),
      physicalExpiration: physical,
      versionCounter: loaded.metadata.versionCounter + 1,
    };
    try {
      await this.db.put(metaKey(id), JSON.stringify(metadata), options);
    } catch {
      throw storageError("STORAGE_WRITE_FAILED", rewritesKeys);
    }
    return { changed: true, paste: summary(metadata) };
  }

  async delete(id: string, password?: CurrentCredential, version?: OpaqueMatch): Promise<void> {
    const loaded = await this.loadContent(id, password);
    if (!loaded.legacy) this.assertVersion(loaded.metadata, version);
    else if (version !== undefined && version !== "legacy") {
      throw new PasteError("VERSION_CONFLICT", 409, undefined, { currentVersion: "legacy", updatedAt: loaded.summary.updatedAt });
    }
    await this.deleteFive(id, "delete");
  }

  async listHistory(id: string, password?: string | null): Promise<HistoryList> {
    const loaded = await this.loadContent(id, password);
    if (loaded.summary.viewOnce) throw new PasteError("VIEW_ONCE_HISTORY_FORBIDDEN", 409);
    if (loaded.legacy) {
      return { id, currentRevision: 1, currentVersion: "legacy", revisions: [] };
    }
    return {
      id,
      currentRevision: loaded.metadata.contentRevision,
      currentVersion: `${loaded.metadata.generation}.${loaded.metadata.versionCounter}`,
      revisions: loaded.metadata.history.entries.map(({ slot: _slot, ...descriptor }) => descriptor),
    };
  }

  async getHistory(id: string, revision: string, password?: string | null): Promise<RevisionResource> {
    const revisionNumber = this.parseRevision(revision);
    const loaded = await this.loadContent(id, password);
    if (loaded.summary.viewOnce) throw new PasteError("VIEW_ONCE_HISTORY_FORBIDDEN", 409);
    if (loaded.legacy) throw new PasteError("REVISION_NOT_FOUND", 404);
    const descriptor = loaded.metadata.history.entries.find((entry) => entry.revision === revisionNumber);
    if (descriptor === undefined) throw new PasteError("REVISION_NOT_FOUND", 404);

    let stored: { value: string | null; metadata: unknown };
    try {
      stored = await this.db.getWithMetadata<unknown>(revisionKey(id, descriptor.slot), "text");
    } catch {
      throw storageError("STORAGE_READ_FAILED");
    }
    if (stored.value === null) throw inconsistent();
    try {
      assertScalarSequence(stored.value, "content");
    } catch {
      throw inconsistent();
    }
    const marker = parseRevisionMarker(stored.metadata);
    if (!this.revisionMatches(marker, descriptor, loaded.metadata.generation, stored.value)) throw inconsistent();
    return {
      id,
      revision: descriptor.revision,
      savedAt: descriptor.savedAt,
      supersededAt: descriptor.supersededAt,
      byteLength: descriptor.byteLength,
      content: stored.value,
    };
  }

  async consume(loaded: LoadedPaste): Promise<void> {
    await this.deleteFive(loaded.summary.id, "consume");
  }

  private assertLegacyVersion(summary: PasteSummary, version: OpaqueMatch | undefined): void {
    if (version !== undefined && version !== "legacy") {
      throw new PasteError("VERSION_CONFLICT", 409, undefined, { currentVersion: "legacy", updatedAt: summary.updatedAt });
    }
  }

  private async migrateLegacy(
    id: string,
    loaded: Extract<LoadedPaste, { legacy: true }>,
    input: LegacyMigrationInput,
  ): Promise<PasteSummary> {
    const now = this.mutationNow();
    const mutationAt = now.toISOString();
    const createdAt = loaded.summary.createdAt ?? mutationAt;
    const currentSavedAt = input.contentChanged ? mutationAt : createdAt;
    const physical = physicalExpiration(input.expiresAt, now);
    const options = physical === null ? {} : { expiration: physical };
    const generation = this.uuid();
    const oldBytes = new TextEncoder().encode(loaded.content).byteLength;
    const contentBytes = new TextEncoder().encode(input.content).byteLength;
    const previous = input.contentChanged
      ? {
          revision: 1,
          slot: 0,
          savedAt: createdAt,
          supersededAt: mutationAt,
          byteLength: oldBytes,
        }
      : undefined;
    const metadata: PasteMetadataV2 = {
      schemaVersion: 2,
      generation,
      id,
      title: input.title,
      format: input.format,
      password: input.password,
      viewOnce: input.viewOnce,
      createdAt,
      updatedAt: mutationAt,
      currentSavedAt,
      expiresAt: input.expiresAt,
      expiration: input.expiration,
      physicalExpiration: physical,
      versionCounter: 1,
      contentRevision: input.contentChanged ? 2 : 1,
      contentBytes,
      createdCountry: loaded.summary.createdCountry,
      history: previous === undefined ? { nextSlot: 0, entries: [] } : { nextSlot: 1, entries: [previous] },
    };
    try {
      await this.db.put(metaKey(id), JSON.stringify(metadata), options);
    } catch {
      throw storageError("STORAGE_WRITE_FAILED");
    }
    if (previous !== undefined) {
      const revisionMarker: RevisionMarkerV2 = {
        kind: "cfpb/revision",
        schemaVersion: 2,
        generation,
        revision: previous.revision,
        savedAt: previous.savedAt,
        supersededAt: previous.supersededAt,
        byteLength: previous.byteLength,
      };
      try {
        await this.db.put(revisionKey(id, 0), loaded.content, { ...options, metadata: revisionMarker });
      } catch {
        throw storageError("STORAGE_WRITE_FAILED", true);
      }
    }
    const marker: ContentMarkerV2 = {
      kind: "cfpb/content",
      schemaVersion: 2,
      generation,
      contentRevision: metadata.contentRevision,
      savedAt: currentSavedAt,
      byteLength: contentBytes,
      commit: null,
    };
    try {
      await this.db.put(contentKey(id), input.content, { ...options, metadata: marker });
    } catch {
      throw storageError("STORAGE_WRITE_FAILED", true);
    }
    return summary(metadata);
  }

  private parseRevision(value: string): number {
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw new PasteError("BAD_REQUEST", 400);
    const revision = Number(value);
    if (!Number.isSafeInteger(revision)) throw new PasteError("BAD_REQUEST", 400);
    return revision;
  }

  private mutationNow(): Date {
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) throw validationError("expiration", "Cannot normalize against an invalid clock.");
    return now;
  }

  private assertVersion(metadata: PasteMetadataV2, version: OpaqueMatch | undefined): void {
    const currentVersion = `${metadata.generation}.${metadata.versionCounter}`;
    if (version !== undefined && version !== currentVersion) {
      throw new PasteError("VERSION_CONFLICT", 409, undefined, { currentVersion, updatedAt: metadata.updatedAt });
    }
  }

  private revisionMatches(marker: RevisionMarkerV2, descriptor: HistoryDescriptor, generation: string, value: string): boolean {
    return (
      marker.generation === generation &&
      marker.revision === descriptor.revision &&
      marker.savedAt === descriptor.savedAt &&
      marker.supersededAt === descriptor.supersededAt &&
      marker.byteLength === descriptor.byteLength &&
      new TextEncoder().encode(value).byteLength === descriptor.byteLength
    );
  }

  private async rewriteActiveRevisions(
    id: string,
    metadata: PasteMetadataV2,
    excludedSlot: number | undefined,
    options: { expiration?: number },
  ): Promise<void> {
    for (const descriptor of metadata.history.entries) {
      if (descriptor.slot === excludedSlot) continue;
      let revision: { value: string | null; metadata: unknown };
      try {
        revision = await this.db.getWithMetadata<unknown>(revisionKey(id, descriptor.slot), "text");
      } catch {
        throw storageError("STORAGE_READ_FAILED");
      }
      if (revision.value === null) throw inconsistent();
      try {
        assertScalarSequence(revision.value, "content");
      } catch {
        throw inconsistent();
      }
      const marker = parseRevisionMarker(revision.metadata);
      if (!this.revisionMatches(marker, descriptor, metadata.generation, revision.value)) throw inconsistent();
      try {
        await this.db.put(revisionKey(id, descriptor.slot), revision.value, { ...options, metadata: marker });
      } catch {
        throw storageError("STORAGE_WRITE_FAILED");
      }
    }
  }

  private async reconcileMetadataLast(
    id: string,
    content: string,
    marker: ContentMarkerV2,
    metadata: PasteMetadataV2,
    bytes: number,
  ): Promise<PasteMetadataV2> {
    const previous = marker.commit?.previous;
    if (
      previous === undefined ||
      marker.generation !== metadata.generation ||
      marker.contentRevision !== metadata.contentRevision + 1 ||
      marker.byteLength !== bytes ||
      previous.revision !== metadata.contentRevision ||
      previous.slot !== metadata.history.nextSlot ||
      previous.savedAt !== metadata.currentSavedAt ||
      previous.byteLength !== metadata.contentBytes ||
      previous.supersededAt !== marker.savedAt
    ) {
      throw inconsistent();
    }

    let revision: { value: string | null; metadata: unknown };
    try {
      revision = await this.db.getWithMetadata<unknown>(revisionKey(id, previous.slot), "text");
    } catch {
      throw storageError("STORAGE_READ_FAILED");
    }
    if (revision.value === null) throw inconsistent();
    try {
      assertScalarSequence(revision.value, "content");
    } catch {
      throw inconsistent();
    }
    const revisionMarker = parseRevisionMarker(revision.metadata);
    if (!this.revisionMatches(revisionMarker, previous, marker.generation, revision.value)) throw inconsistent();

    const entries = [previous, ...metadata.history.entries.filter((entry) => entry.slot !== previous.slot)]
      .sort((left, right) => right.revision - left.revision)
      .slice(0, 3);
    const repairNow = this.mutationNow();
    const physical = physicalExpiration(metadata.expiresAt, repairNow);
    const reconciled: PasteMetadataV2 = {
      ...metadata,
      updatedAt: marker.savedAt,
      currentSavedAt: marker.savedAt,
      physicalExpiration: physical,
      versionCounter: Math.max(metadata.versionCounter, marker.commit!.versionCounter),
      contentRevision: marker.contentRevision,
      contentBytes: marker.byteLength,
      history: { nextSlot: (previous.slot + 1) % 3, entries },
    };
    const options = physical === null ? {} : { expiration: physical };
    try {
      await this.db.put(contentKey(id), content, { ...options, metadata: marker });
    } catch {
      throw storageError("STORAGE_WRITE_FAILED");
    }
    await this.rewriteActiveRevisions(id, reconciled, undefined, options);
    try {
      await this.db.put(metaKey(id), JSON.stringify(reconciled), options);
    } catch {
      throw storageError("STORAGE_WRITE_FAILED", true);
    }
    return reconciled;
  }

  private authorize(expected: string | null, supplied: CurrentCredential | undefined): void {
    if (expected !== null && supplied !== expected) throw new PasteError("FORBIDDEN", 403);
  }

  private async throwIfExpired(id: string, expiresAt: string | null, cleanup: boolean): Promise<void> {
    if (expiresAt !== null && this.clock().getTime() >= new Date(expiresAt).getTime()) {
      if (cleanup) await this.deleteFive(id, "expiry");
      throw new PasteError("PASTE_NOT_FOUND", 404);
    }
  }

  private async deleteFive(id: string, reason: "consume" | "delete" | "expiry"): Promise<void> {
    const outcomes: PromiseSettledResult<void>[] = [];
    outcomes.push(await Promise.resolve().then(() => this.db.delete(contentKey(id))).then(
      () => ({ status: "fulfilled", value: undefined }) as const,
      (reason) => ({ status: "rejected", reason }) as const,
    ));
    outcomes.push(
      ...(await Promise.allSettled([
        this.db.delete(revisionKey(id, 0)),
        this.db.delete(revisionKey(id, 1)),
        this.db.delete(revisionKey(id, 2)),
      ])),
    );
    outcomes.push(await Promise.resolve().then(() => this.db.delete(metaKey(id))).then(
      () => ({ status: "fulfilled", value: undefined }) as const,
      (reason) => ({ status: "rejected", reason }) as const,
    ));
    if (outcomes.some((outcome) => outcome.status === "rejected")) {
      if (reason === "consume") {
        throw new PasteError("CONSUME_FAILED", 503, undefined, { retryable: true, mutationMayHaveApplied: true });
      }
      throw storageError("STORAGE_WRITE_FAILED", true);
    }
  }

  private async createAutomaticId(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = this.uuid();
      if (await this.isVacant(id)) return id;
    }
    throw new PasteError("ID_GENERATION_FAILED", 503, undefined, { retryable: true });
  }

  private async isVacant(id: string): Promise<boolean> {
    for (const key of [contentKey(id), revisionKey(id, 0), revisionKey(id, 1), revisionKey(id, 2)]) {
      try {
        if ((await this.db.get(key)) !== null) return false;
      } catch {
        throw storageError("STORAGE_READ_FAILED");
      }
    }
    return true;
  }
}
