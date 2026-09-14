import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { validateTitle } from "./pastes";
import { assetPaths } from "./generated/assets";
import { labels, type Locale } from "./i18n";
import { encodeSourceData, sourceDataEncoding } from "./source-data";
import type { AppBootstrap, PasteSummary } from "./types";

export { dictionaries } from "./i18n";
export type { Locale } from "./i18n";

export interface PastePageModel {
  locale: Locale;
  paste: PasteSummary;
  content: string;
  consumed?: boolean;
}

export interface PasswordPageModel {
  locale: Locale;
  errorCode: null | "FORBIDDEN";
}

export interface ErrorPageModel {
  locale: Locale;
  status: number;
  errorCode: string;
}

export interface MarkdownDocumentModel {
  locale: Locale;
  paste: PasteSummary;
  content: string;
}

type ApplicationDocument = {
  locale: Locale;
  title: string;
  bootstrap: AppBootstrap;
  source?: string;
  initialMarkdownSource?: string;
};

const applicationCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const textEscapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => textEscapes[character]!);
}

function publicSummary(paste: PasteSummary): PasteSummary {
  return {
    id: paste.id,
    title: paste.title,
    format: paste.format,
    viewOnce: paste.viewOnce,
    protected: paste.protected,
    createdAt: paste.createdAt,
    updatedAt: paste.updatedAt,
    expiresAt: paste.expiresAt,
    expiration: paste.expiration,
    version: paste.version,
    contentRevision: paste.contentRevision,
    contentBytes: paste.contentBytes,
    createdCountry: paste.createdCountry,
    links: {
      view: paste.links.view,
      raw: paste.links.raw,
      html: paste.links.html,
      markdown: paste.links.markdown,
      file: paste.links.file,
    },
  };
}

function documentTitle(locale: Locale, paste: PasteSummary): string {
  return paste.title === "" ? `${labels(locale).paste} ${paste.id}` : paste.title;
}

function sourceData(content: string): string {
  return `<script id="source-data" type="application/octet-stream" data-source-encoding="${sourceDataEncoding}">${encodeSourceData(content)}</script>`;
}

export function renderMarkdown(source: string): string {
  return micromark(source, {
    allowDangerousHtml: false,
    allowDangerousProtocol: false,
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });
}

export function escapeBootstrapJson(value: unknown): string {
  return (JSON.stringify(value) ?? "null")
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp("\\u2028", "g"), "\\u2028")
    .replace(new RegExp("\\u2029", "g"), "\\u2029");
}

function renderApplicationDocument(model: ApplicationDocument): string {
  const source = model.source === undefined ? "" : sourceData(model.source);
  const preview = model.initialMarkdownSource === undefined
    ? ""
    : `<template id="initial-markdown-preview">${renderMarkdown(model.initialMarkdownSource)}</template>`;
  return `<!doctype html>
<html lang="${model.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(model.title)}</title>
<link rel="stylesheet" href="${escapeText(assetPaths.appCss)}">
</head>
<body data-page="${model.bootstrap.page}">
<div id="app"></div>
${source}${preview}
<script id="bootstrap" type="application/json">${escapeBootstrapJson(model.bootstrap)}</script>
<script type="module" src="${escapeText(assetPaths.appJs)}"></script>
</body>
</html>`;
}

export function applicationHeaders(): Headers {
  return new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": applicationCsp,
  });
}

export function renderCreatePage(locale: Locale): string {
  return renderApplicationDocument({
    locale,
    title: labels(locale).create,
    bootstrap: { page: "create", locale },
  });
}

export function renderPastePage(model: PastePageModel): string {
  const paste = publicSummary(model.paste);
  const consumed = paste.viewOnce || model.consumed === true;
  const hasInitialMarkdownPreview = paste.format === "markdown";
  const bootstrap: AppBootstrap = consumed
    ? { page: "paste", locale: model.locale, consumed: true, hasInitialMarkdownPreview }
    : { page: "paste", locale: model.locale, paste, consumed: false };
  return renderApplicationDocument({
    locale: model.locale,
    title: documentTitle(model.locale, paste),
    bootstrap,
    source: model.content,
    ...(hasInitialMarkdownPreview ? { initialMarkdownSource: model.content } : {}),
  });
}

export function renderPasswordPage(model: PasswordPageModel): string {
  return renderApplicationDocument({
    locale: model.locale,
    title: labels(model.locale).passwordRequired,
    bootstrap: { page: "password", locale: model.locale, errorCode: model.errorCode },
  });
}

export function renderErrorPage(model: ErrorPageModel): string {
  return renderApplicationDocument({
    locale: model.locale,
    title: labels(model.locale).error,
    bootstrap: { page: "error", locale: model.locale, status: model.status, errorCode: model.errorCode },
  });
}

export function renderMarkdownDocument(model: MarkdownDocumentModel): string {
  const paste = publicSummary(model.paste);
  return renderApplicationDocument({
    locale: model.locale,
    title: documentTitle(model.locale, paste),
    bootstrap: {
      page: "markdown",
      locale: model.locale,
      id: paste.id,
      title: paste.title,
      hasInitialMarkdownPreview: true,
    },
    source: model.content,
    initialMarkdownSource: model.content,
  });
}

function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function deriveDownloadFileName(summary: PasteSummary): string {
  const fallback = `paste-${summary.id}.txt`;
  return validateTitle(summary.title).replace(/[\\/]/g, "_").replace(/[ .]+$/u, "") || fallback;
}

export function deriveDownloadHeaders(summary: PasteSummary): Headers {
  const fallback = `paste-${summary.id}.txt`;
  const filename = deriveDownloadFileName(summary);
  return new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987(filename)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
}
