export interface Env {
  PASTE_DB: KVNamespace;
}

export type ErrorCode =
  | "BAD_REQUEST"
  | "AMBIGUOUS_PASSWORD"
  | "AMBIGUOUS_VERSION"
  | "FORBIDDEN"
  | "PASTE_NOT_FOUND"
  | "REVISION_NOT_FOUND"
  | "ID_CONFLICT"
  | "VERSION_CONFLICT"
  | "VIEW_ONCE_HISTORY_FORBIDDEN"
  | "CONTENT_TOO_LARGE"
  | "REQUEST_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "VALIDATION_FAILED"
  | "RENDER_FAILED"
  | "INTERNAL_ERROR"
  | "STORAGE_READ_FAILED"
  | "STORAGE_WRITE_FAILED"
  | "STORAGE_INCONSISTENT"
  | "CONSUME_FAILED"
  | "ID_GENERATION_FAILED";

const errorMessages: Record<ErrorCode, string> = {
  BAD_REQUEST: "The request is malformed.",
  AMBIGUOUS_PASSWORD: "The password is ambiguous.",
  AMBIGUOUS_VERSION: "The version is ambiguous.",
  FORBIDDEN: "Password is missing or incorrect.",
  PASTE_NOT_FOUND: "The paste was not found.",
  REVISION_NOT_FOUND: "The revision was not found.",
  ID_CONFLICT: "That ID is already in use.",
  VERSION_CONFLICT: "The paste changed after this page loaded.",
  VIEW_ONCE_HISTORY_FORBIDDEN: "History is unavailable for a view-once paste.",
  CONTENT_TOO_LARGE: "The content exceeds the maximum size.",
  REQUEST_TOO_LARGE: "The request exceeds the maximum size.",
  UNSUPPORTED_MEDIA_TYPE: "The media type is not supported.",
  VALIDATION_FAILED: "One or more fields are invalid.",
  RENDER_FAILED: "The paste could not be rendered.",
  INTERNAL_ERROR: "An internal error occurred.",
  STORAGE_READ_FAILED: "Storage could not be read.",
  STORAGE_WRITE_FAILED: "Storage could not be written.",
  STORAGE_INCONSISTENT: "Storage state is inconsistent.",
  CONSUME_FAILED: "The view-once paste could not be consumed.",
  ID_GENERATION_FAILED: "A paste ID could not be generated.",
};

export class PasteError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, status: number, message = errorMessages[code], details?: Record<string, unknown>) {
    super(message);
    this.name = "PasteError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isPasteError(value: unknown): value is PasteError {
  return value instanceof PasteError;
}

export type ExpirationInput = number | null | string;

export type Expiration =
  | { kind: "permanent" }
  | { kind: "relative"; seconds: number }
  | { kind: "absolute" };

export interface PasteLinks {
  view: string;
  raw: string;
  html: string;
  markdown: string;
  file: string;
}

export interface PasteSummary {
  id: string;
  title: string;
  format: "text" | "markdown";
  viewOnce: boolean;
  protected: boolean;
  createdAt: string | null;
  updatedAt: string;
  expiresAt: string | null;
  expiration: Expiration;
  version: string;
  contentRevision: number;
  contentBytes: number;
  createdCountry: string | null;
  links: PasteLinks;
}

export interface PasteResource extends PasteSummary {
  content: string;
}

export interface MutationResult {
  changed: boolean;
  paste: PasteSummary;
}

export interface HistoryDescriptor {
  revision: number;
  slot: number;
  savedAt: string;
  supersededAt: string;
  byteLength: number;
}

export interface HistoryList {
  id: string;
  currentRevision: number;
  currentVersion: string;
  revisions: Array<Omit<HistoryDescriptor, "slot">>;
}

export interface RevisionResource {
  id: string;
  revision: number;
  savedAt: string;
  supersededAt: string;
  byteLength: number;
  content: string;
}

export interface ContentMarkerV2 {
  kind: "cfpb/content";
  schemaVersion: 2;
  generation: string;
  contentRevision: number;
  savedAt: string;
  byteLength: number;
  commit: {
    versionCounter: number;
    previous: HistoryDescriptor;
  } | null;
}

export interface RevisionMarkerV2 {
  kind: "cfpb/revision";
  schemaVersion: 2;
  generation: string;
  revision: number;
  savedAt: string;
  supersededAt: string;
  byteLength: number;
}

export interface PasteMetadataV2 {
  schemaVersion: 2;
  generation: string;
  id: string;
  title: string;
  format: "text" | "markdown";
  password: string | null;
  viewOnce: boolean;
  createdAt: string;
  updatedAt: string;
  currentSavedAt: string;
  expiresAt: string | null;
  expiration: Expiration;
  physicalExpiration: number | null;
  versionCounter: number;
  contentRevision: number;
  contentBytes: number;
  createdCountry: string | null;
  history: {
    nextSlot: number;
    entries: HistoryDescriptor[];
  };
}

type LegacyMetadata = {
  createdAt: string | null;
  expiresAt: string | null;
  createdCountry: string | null;
  expiration: number | null;
};

export type LoadedPaste =
  | {
      content: string;
      metadata: PasteMetadataV2;
      summary: PasteSummary;
      legacy: false;
      marker: ContentMarkerV2;
    }
  | {
      content: string;
      metadata: LegacyMetadata;
      summary: PasteSummary;
      legacy: true;
      marker: null;
    };
