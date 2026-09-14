import { decodeSourceData, sourceDataEncoding } from "../source-data";
import type { AppBootstrap, PasteSummary } from "./contracts";
import type { Locale } from "../i18n";

export type TrustedMarkdownHtml = string & { readonly __trustedMarkdownHtml: unique symbol };

export type InitialPage =
  | { ok: true; bootstrap: Extract<AppBootstrap, { page: "create" | "password" | "error" }>; password: null }
  | {
      ok: true;
      bootstrap: Extract<AppBootstrap, { page: "paste" | "markdown" }>;
      exactSource: string;
      initialMarkdown: TrustedMarkdownHtml | null;
      password: string | null;
    }
  | { ok: false; locale: Locale; errorCode: "INTERNAL_ERROR" };

type TransportNode = Pick<Element, "getAttribute" | "remove" | "tagName" | "textContent"> & { innerHTML?: string };

function isScriptNode(node: TransportNode | undefined): node is TransportNode {
  return node?.tagName === "SCRIPT";
}

function isTemplateNode(node: TransportNode | undefined): node is TransportNode & { innerHTML: string } {
  return node?.tagName === "TEMPLATE" && typeof node.innerHTML === "string";
}

const summaryKeys = new Set([
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
]);
const linkKeys = new Set(["view", "raw", "html", "markdown", "file"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: ReadonlySet<string>): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key));
}

function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "zh-CN";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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

function isHttpErrorStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 400 && value <= 599;
}

function parseExpiration(value: unknown): PasteSummary["expiration"] | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "permanent" && hasExactKeys(value, new Set(["kind"]))) return { kind: "permanent" };
  if (value.kind === "absolute" && hasExactKeys(value, new Set(["kind"]))) return { kind: "absolute" };
  if (
    value.kind === "relative" &&
    hasExactKeys(value, new Set(["kind", "seconds"])) &&
    typeof value.seconds === "number" &&
    Number.isSafeInteger(value.seconds) &&
    value.seconds >= 60
  ) {
    return { kind: "relative", seconds: value.seconds };
  }
  return undefined;
}

function parseLinks(value: unknown): PasteSummary["links"] | undefined {
  if (!hasExactKeys(value, linkKeys)) return undefined;
  if (
    !isNonEmptyString(value.view) ||
    !isNonEmptyString(value.raw) ||
    !isNonEmptyString(value.html) ||
    !isNonEmptyString(value.markdown) ||
    !isNonEmptyString(value.file)
  ) {
    return undefined;
  }
  return { view: value.view, raw: value.raw, html: value.html, markdown: value.markdown, file: value.file };
}

function parseSummary(value: unknown): PasteSummary | undefined {
  if (!hasExactKeys(value, summaryKeys)) return undefined;
  const expiration = parseExpiration(value.expiration);
  const links = parseLinks(value.links);
  if (
    !isNonEmptyString(value.id) ||
    typeof value.title !== "string" ||
    (value.format !== "text" && value.format !== "markdown") ||
    typeof value.viewOnce !== "boolean" ||
    typeof value.protected !== "boolean" ||
    !isNullableTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isNullableTimestamp(value.expiresAt) ||
    !isMutationToken(value.version) ||
    !isByteLength(value.contentRevision) ||
    !isByteLength(value.contentBytes) ||
    (value.createdCountry !== null && typeof value.createdCountry !== "string") ||
    expiration === undefined ||
    links === undefined
  ) {
    return undefined;
  }
  return {
    id: value.id,
    title: value.title,
    format: value.format,
    viewOnce: value.viewOnce,
    protected: value.protected,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
    expiration,
    version: value.version,
    contentRevision: value.contentRevision,
    contentBytes: value.contentBytes,
    createdCountry: value.createdCountry,
    links,
  };
}

function parseBootstrap(value: unknown): AppBootstrap | undefined {
  if (!isRecord(value) || !isLocale(value.locale) || typeof value.page !== "string") return undefined;

  switch (value.page) {
    case "create":
      return hasExactKeys(value, new Set(["page", "locale"])) ? { page: "create", locale: value.locale } : undefined;
    case "password":
      return hasExactKeys(value, new Set(["page", "locale", "errorCode"])) && (value.errorCode === null || value.errorCode === "FORBIDDEN")
        ? { page: "password", locale: value.locale, errorCode: value.errorCode }
        : undefined;
    case "error":
      return hasExactKeys(value, new Set(["page", "locale", "status", "errorCode"])) &&
        isHttpErrorStatus(value.status) &&
        typeof value.errorCode === "string"
        ? { page: "error", locale: value.locale, status: value.status, errorCode: value.errorCode }
        : undefined;
    case "paste": {
      if (hasExactKeys(value, new Set(["page", "locale", "paste", "consumed"])) && value.consumed === false) {
        const paste = parseSummary(value.paste);
        return paste === undefined ? undefined : { page: "paste", locale: value.locale, paste, consumed: false };
      }
      return hasExactKeys(value, new Set(["page", "locale", "consumed", "hasInitialMarkdownPreview"])) &&
        value.consumed === true &&
        typeof value.hasInitialMarkdownPreview === "boolean"
        ? { page: "paste", locale: value.locale, consumed: true, hasInitialMarkdownPreview: value.hasInitialMarkdownPreview }
        : undefined;
    }
    case "markdown":
      return hasExactKeys(value, new Set(["page", "locale", "id", "title", "hasInitialMarkdownPreview"])) &&
        isNonEmptyString(value.id) &&
        typeof value.title === "string" &&
        value.hasInitialMarkdownPreview === true
        ? { page: "markdown", locale: value.locale, id: value.id, title: value.title, hasInitialMarkdownPreview: true }
        : undefined;
    default:
      return undefined;
  }
}

function failureLocale(value: unknown): Locale {
  return isRecord(value) && isLocale(value.locale) ? value.locale : "en";
}

function failure(locale: Locale): InitialPage {
  return { ok: false, locale, errorCode: "INTERNAL_ERROR" };
}

function expectedPreview(bootstrap: Extract<AppBootstrap, { page: "paste" | "markdown" }>): boolean {
  return bootstrap.page === "markdown" ||
    (bootstrap.page === "paste" && (bootstrap.consumed ? bootstrap.hasInitialMarkdownPreview : bootstrap.paste.format === "markdown"));
}

function removeTransport(nodes: readonly TransportNode[]): void {
  for (const node of nodes) {
    try {
      node.remove();
    } catch {
      // Continue removing the remaining inert transport nodes.
    }
  }
}

export function extractInitialPage(document: Document, url: URL): InitialPage {
  const bootstraps = Array.from(document.querySelectorAll("#bootstrap")) as TransportNode[];
  const sources = Array.from(document.querySelectorAll("#source-data")) as TransportNode[];
  const previews = Array.from(document.querySelectorAll("#initial-markdown-preview")) as TransportNode[];
  const transport = [...bootstraps, ...sources, ...previews];
  let parsed: unknown;
  let locale: Locale = "en";

  try {
    if (bootstraps.length !== 1 || !isScriptNode(bootstraps[0]) || bootstraps[0].getAttribute("type") !== "application/json") return failure(locale);
    try {
      parsed = JSON.parse(bootstraps[0].textContent ?? "");
    } catch {
      return failure(locale);
    }
    locale = failureLocale(parsed);
    const bootstrap = parseBootstrap(parsed);
    if (bootstrap === undefined) return failure(locale);

    const passwords = url.searchParams.getAll("password");
    if (passwords.length > 1) return failure(locale);

    if (bootstrap.page === "create" || bootstrap.page === "password" || bootstrap.page === "error") {
      return sources.length === 0 && previews.length === 0
        ? { ok: true, bootstrap, password: null }
        : failure(locale);
    }

    if (
      sources.length !== 1 ||
      !isScriptNode(sources[0]) ||
      sources[0].getAttribute("type") !== "application/octet-stream" ||
      sources[0].getAttribute("data-source-encoding") !== sourceDataEncoding ||
      previews.length !== (expectedPreview(bootstrap) ? 1 : 0) ||
      (previews.length === 1 && !isTemplateNode(previews[0]))
    ) {
      return failure(locale);
    }

    let exactSource: string;
    try {
      exactSource = decodeSourceData(sources[0].textContent ?? "");
    } catch {
      return failure(locale);
    }
    const initialMarkdown = previews.length === 1 ? previews[0]?.innerHTML as TrustedMarkdownHtml : null;
    return { ok: true, bootstrap, exactSource, initialMarkdown, password: passwords[0] ?? null };
  } finally {
    removeTransport(transport);
  }
}

export function withPastePassword(target: URL, password: string | null): URL {
  const result = new URL(target.href);
  result.searchParams.delete("password");
  if (password !== null) result.searchParams.set("password", password);
  return result;
}

export function commitPastePassword(target: URL, password: string | null): void {
  const result = withPastePassword(target, password);
  history.replaceState(null, "", `${result.pathname}${result.search}${result.hash}`);
}
