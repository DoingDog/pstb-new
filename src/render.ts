import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { validateTitle } from "./pastes";
import { assetPaths } from "./generated/assets";
import { errorMessage, formatDate, labels, normalizeErrorMessageCode, type ErrorMessageCode, type LabelKey, type Labels, type Locale } from "./i18n";
import { encodeSourceData, sourceDataEncoding } from "./source-data";
import type { PasteSummary } from "./types";

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
  errorCode?: ErrorMessageCode;
}

export interface ErrorPageModel {
  locale: Locale;
  errorCode: ErrorMessageCode;
}

export interface MarkdownDocumentModel {
  locale: Locale;
  paste: PasteSummary;
  content: string;
}

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

function translated(copy: Labels, key: LabelKey): string {
  return `<span data-i18n="${key}">${copy[key]}</span>`;
}

function i18nAttribute(key: LabelKey): string {
  return ` data-i18n="${key}"`;
}

function translatedError(locale: Locale, code: string | undefined): string {
  return escapeText(errorMessage(locale, code));
}

function documentTitle(locale: Locale, paste: PasteSummary): string {
  return paste.title === "" ? `${labels(locale).paste} ${paste.id}` : paste.title;
}

function sourceData(content: string): string {
  return `<script id="source-data" type="application/octet-stream" data-source-encoding="${sourceDataEncoding}">${encodeSourceData(content)}</script>`;
}

function pageDocument(locale: Locale, page: string, title: string, body: string, bootstrap: unknown, content?: string, titleKey?: LabelKey, titleSuffix?: string): string {
  const titleMetadata = titleKey === undefined
    ? ""
    : ` data-i18n-title="${titleKey}"${titleSuffix === undefined ? "" : ` data-i18n-title-suffix="${escapeText(titleSuffix)}"`}`;
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title${titleMetadata}>${escapeText(title)}</title>
<link rel="stylesheet" href="${escapeText(assetPaths.appCss)}">
</head>
<body data-page="${page}">
${body}
${content === undefined ? "" : sourceData(content)}
<script id="bootstrap" type="application/json">${escapeBootstrapJson(bootstrap)}</script>
<script type="module" src="${escapeText(assetPaths.appJs)}"></script>
</body>
</html>`;
}

function sourceTextarea(): string {
  return `<textarea id="source" class="editor-input" name="source" readonly spellcheck="false"></textarea>`;
}

function localActions(copy: Labels): string {
  return `<div class="actions" aria-label="${copy.localActions}" data-i18n-aria-label="localActions">
<button type="button" data-action="copy"${i18nAttribute("copy")}>${copy.copy}</button>
<button type="button" data-action="wrap"${i18nAttribute("wrap")}>${copy.wrap}</button>
<button type="button" data-action="toggle-source"${i18nAttribute("source")}>${copy.source}</button>
<button type="button" data-action="preview"${i18nAttribute("preview")}>${copy.preview}</button>
<button type="button" data-action="download"${i18nAttribute("download")}>${copy.download}</button>
<button type="button" data-action="open-html"${i18nAttribute("openHtmlLocally")}>${copy.openHtmlLocally}</button>
</div>`;
}

function siteHeader(copy: Labels, location: string, actions = "", rootLabel = translated(copy, "brand")): string {
  return `<header class="site-header"><nav class="site-nav" aria-label="${copy.application}" data-i18n-aria-label="application"><a href="/">${rootLabel}</a><p class="page-location">${location}</p><div class="utility-actions"><button type="button" data-action="locale"${i18nAttribute("locale")}>${copy.locale}</button><button type="button" data-action="theme"${i18nAttribute("theme")}>${copy.theme}</button>${actions}</div></nav></header>`;
}

function lifecycleItem(label: string, value: string): string {
  return `<div><dt>${label}</dt><dd>${value}</dd></div>`;
}

function createLifecycleRail(copy: Labels): string {
  return `<aside class="lifecycle-rail" aria-labelledby="lifecycle-title"><h2 id="lifecycle-title">${translated(copy, "newDocument")}</h2><dl class="lifecycle-list">${lifecycleItem(translated(copy, "content"), translated(copy, "exactText"))}${lifecycleItem(translated(copy, "encoding"), "UTF-8")}${lifecycleItem(translated(copy, "limit"), "10 MiB")}</dl></aside>`;
}

function pasteLifecycleRail(locale: Locale, copy: Labels, paste: PasteSummary): string {
  const expires = paste.expiresAt === null
    ? translated(copy, "permanent")
    : `<time datetime="${escapeText(paste.expiresAt)}" data-i18n-date>${escapeText(formatDate(locale, paste.expiresAt))}</time>`;
  return `<aside class="lifecycle-rail" aria-labelledby="lifecycle-title"><h2 id="lifecycle-title">${translated(copy, "documentStatus")}</h2><dl class="lifecycle-list">${lifecycleItem("ID", `<code>${escapeText(paste.id)}</code>`)}${lifecycleItem(translated(copy, "password"), paste.protected ? translated(copy, "protected") : translated(copy, "notProtected"))}${lifecycleItem(translated(copy, "viewOnce"), paste.viewOnce ? translated(copy, "enabled") : translated(copy, "standard"))}${lifecycleItem(translated(copy, "expires"), expires)}${lifecycleItem(translated(copy, "revision"), `<code>${paste.contentRevision}</code>`)}${lifecycleItem(translated(copy, "saveStatus"), `<span data-save-status="saved" aria-live="polite"${i18nAttribute("saved")}>${copy.saved}</span>`)}${lifecycleItem(translated(copy, "size"), `${paste.contentBytes} ${translated(copy, "bytes")}`)}</dl></aside>`;
}

function statusLifecycleRail(heading: string): string {
  return `<aside class="lifecycle-rail" aria-labelledby="lifecycle-title"><h2 id="lifecycle-title">${heading}</h2></aside>`;
}

function pasteLocation(copy: Labels, paste: PasteSummary): string {
  return `${translated(copy, "paste")} / <code>${escapeText(paste.id)}</code>`;
}

export function renderMarkdown(source: string): string {
  return micromark(source, {
    allowDangerousHtml: false,
    allowDangerousProtocol: false,
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });
}

function pasteContentView(content: string, format: PasteSummary["format"]): string {
  return format === "markdown"
    ? `<article class="paste-content">${renderMarkdown(content)}</article>`
    : `<pre class="paste-content" data-source-view></pre>`;
}

export function escapeBootstrapJson(value: unknown): string {
  return (JSON.stringify(value) ?? "null")
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp("\\u2028", "g"), "\\u2028")
    .replace(new RegExp("\\u2029", "g"), "\\u2029");
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
  const copy = labels(locale);
  const expiration = [
    ["60", "oneMinute"],
    ["3600", "oneHour"],
    ["86400", "oneDay"],
    ["604800", "oneWeek"],
    ["2592000", "thirtyDays"],
    ["31104000", "oneYear"],
    ["permanent", "permanent"],
  ] as const satisfies readonly (readonly [string, LabelKey])[];
  const options = expiration.map(([value, key]) => `<option value="${value}"${value === "86400" ? " selected" : ""}${i18nAttribute(key)}>${copy[key]}</option>`).join("");
  const body = `${siteHeader(copy, translated(copy, "create"))}
<main class="workbench" data-workbench="create">
${createLifecycleRail(copy)}
<section class="workbench-surface" aria-labelledby="page-title">
<h1 id="page-title">${translated(copy, "create")}</h1>
<form id="create-form" class="workbench-form" method="post" action="/api/pastes">
<div class="form-section" data-create-field="title"><label for="title">${translated(copy, "title")}</label><input id="title" name="title" type="text" aria-describedby="title-description title-error"><p id="title-description">${translated(copy, "titleDescription")}</p><p id="title-error" class="field-error" hidden></p></div>
<div class="form-section" data-create-field="format"><label for="format">${translated(copy, "format")}</label><select id="format" name="format" aria-describedby="format-description format-error"><option value="text"${i18nAttribute("text")}>${copy.text}</option><option value="markdown"${i18nAttribute("markdown")}>${copy.markdown}</option></select><p id="format-description">${translated(copy, "formatDescription")}</p><p id="format-error" class="field-error" hidden></p></div>
<div class="form-section" data-create-field="expiration"><label for="expiration">${translated(copy, "expiration")}</label><select id="expiration" name="expiration" aria-describedby="expiration-description expiration-error">${options}</select><p id="expiration-description">${translated(copy, "expirationDescription")}</p><p id="expiration-error" class="field-error" hidden></p></div>
<div class="form-section editor-surface" data-create-field="content"><label for="content">${translated(copy, "content")}</label><textarea id="content" name="content" required spellcheck="false" aria-describedby="content-description content-error"></textarea><p id="content-description">${translated(copy, "storedExactly")}</p><p id="content-error" class="field-error" hidden></p></div>
<div class="form-section" data-create-field="password"><label for="password">${translated(copy, "password")}</label><div class="password-control"><input id="password" name="password" type="password" autocomplete="new-password" aria-describedby="password-description password-error"><button type="button" data-action="reveal-password" aria-label="${copy.reveal}" data-i18n-aria-label="reveal"${i18nAttribute("reveal")}>${copy.reveal}</button></div><p id="password-description">${translated(copy, "passwordDescription")}</p><p id="password-error" class="field-error" hidden></p></div>
<div class="form-section" data-create-field="custom-id"><label for="custom-id">${translated(copy, "customId")}</label><input id="custom-id" name="customId" type="text" aria-describedby="custom-id-description custom-id-error"><p id="custom-id-description">${translated(copy, "customIdDescription")}</p><p id="custom-id-error" class="field-error" hidden></p></div>
<div class="form-section" data-create-field="view-once"><label class="checkbox-label"><input id="view-once" name="viewOnce" type="checkbox" value="true" aria-describedby="view-once-description view-once-error">${translated(copy, "viewOnce")}</label><p id="view-once-description">${translated(copy, "viewOnceDescription")}</p><p id="view-once-error" class="field-error" hidden></p></div>
<div class="form-actions"><button class="primary-action" type="submit"${i18nAttribute("submit")}>${copy.submit}</button><p id="create-status" aria-live="polite"></p></div>
</form>
</section>
</main>`;
  return pageDocument(locale, "create", copy.create, body, { page: "create", locale }, undefined, "create");
}

export function renderPastePage(model: PastePageModel): string {
  const paste = publicSummary(model.paste);
  const copy = labels(model.locale);
  const restricted = paste.viewOnce || model.consumed === true;
  const title = documentTitle(model.locale, paste);
  const untitled = paste.title === "";
  const heading = untitled ? `${translated(copy, "paste")} ${escapeText(paste.id)}` : escapeText(title);
  const contentView = pasteContentView(model.content, paste.format);
  const headerActions = restricted
    ? `<button type="button" data-action="copy"${i18nAttribute("copy")}>${copy.copy}</button>`
    : `<button type="button" data-action="copy"${i18nAttribute("copy")}>${copy.copy}</button><a data-action="raw" href="${escapeText(paste.links.raw)}"${i18nAttribute("raw")}>${copy.raw}</a><a data-action="file" href="${escapeText(paste.links.file)}"${i18nAttribute("file")}>${copy.file}</a>`;
  const header = siteHeader(copy, pasteLocation(copy, paste), headerActions, restricted ? translated(copy, "create") : translated(copy, "brand"));
  const source = `<div data-panel="source" hidden>${sourceTextarea()}</div>`;
  const panels = `<nav class="tab-navigation" aria-label="${copy.pasteViews}" data-i18n-aria-label="pasteViews"><div role="tablist" aria-label="${copy.pasteViews}" data-i18n-aria-label="pasteViews"><button id="tab-view" type="button" role="tab" aria-selected="true" aria-controls="panel-view" tabindex="0" data-tab="view"${i18nAttribute("view")}>${copy.view}</button><button id="tab-edit" type="button" role="tab" aria-selected="false" aria-controls="panel-edit" tabindex="-1" data-tab="edit"${i18nAttribute("edit")}>${copy.edit}</button><button id="tab-markdown" type="button" role="tab" aria-selected="false" aria-controls="panel-markdown" tabindex="-1" data-tab="markdown"${i18nAttribute("markdown")}>${copy.markdown}</button><button id="tab-history" type="button" role="tab" aria-selected="false" aria-controls="panel-history" tabindex="-1" data-tab="history"${i18nAttribute("history")}>${copy.history}</button><button id="tab-settings" type="button" role="tab" aria-selected="false" aria-controls="panel-settings" tabindex="-1" data-tab="settings"${i18nAttribute("settings")}>${copy.settings}</button></div></nav><section id="panel-view" role="tabpanel" tabindex="0" aria-labelledby="tab-view" data-panel="view">${contentView}</section><section id="panel-edit" role="tabpanel" tabindex="0" aria-labelledby="tab-edit" data-panel="edit" hidden>${source}</section><section id="panel-markdown" role="tabpanel" tabindex="0" aria-labelledby="tab-markdown" data-panel="markdown" hidden></section><section id="panel-history" role="tabpanel" tabindex="0" aria-labelledby="tab-history" data-panel="history" hidden><div class="history-workbench"><div class="history-list" data-history-list></div><div class="history-detail" data-history-detail></div></div></section><section id="panel-settings" role="tabpanel" tabindex="0" aria-labelledby="tab-settings" data-panel="settings" hidden></section>`;
  const restrictedBody = `<p class="consumed-notice" role="status"${i18nAttribute("consumed")}>${copy.consumed}</p><section data-panel="view">${contentView}</section>${source}${localActions(copy)}`;
  const ordinaryBody = `${panels}<div class="context-actions">${localActions(copy)}<div class="representations" aria-label="${copy.representations}" data-i18n-aria-label="representations"><a data-action="raw" href="${escapeText(paste.links.raw)}"${i18nAttribute("raw")}>${copy.raw}</a><a data-action="html" href="${escapeText(paste.links.html)}"${i18nAttribute("html")}>${copy.html}</a><a data-action="markdown-document" href="${escapeText(paste.links.markdown)}"${i18nAttribute("markdown")}>${copy.markdown}</a><a data-action="file" href="${escapeText(paste.links.file)}"${i18nAttribute("file")}>${copy.file}</a></div><button class="danger-action" type="button" data-action="delete"${i18nAttribute("delete")}>${copy.delete}</button></div><dialog id="delete-dialog" class="delete-dialog" aria-labelledby="delete-dialog-title"><form method="dialog"><h2 id="delete-dialog-title"${i18nAttribute("delete")}>${copy.delete}</h2><p${i18nAttribute("deleteDescription")}>${copy.deleteDescription}</p><div class="dialog-actions"><button type="submit" data-action="cancel-delete"${i18nAttribute("cancel")}>${copy.cancel}</button><button class="danger-action" type="button" data-action="confirm-delete"${i18nAttribute("delete")}>${copy.delete}</button></div></form></dialog>`;
  const body = `${header}
<main class="workbench" data-workbench="paste" data-consumed="${restricted}">
${pasteLifecycleRail(model.locale, copy, paste)}
<section class="workbench-surface" aria-labelledby="page-title"><h1 id="page-title">${heading}</h1>${restricted ? restrictedBody : ordinaryBody}<p id="paste-status" aria-live="polite"></p></section>
</main>`;
  const bootstrap = restricted
    ? { page: "paste", locale: model.locale, consumed: true }
    : { page: "paste", paste, consumed: false };
  return pageDocument(model.locale, "paste", title, body, bootstrap, model.content, untitled ? "paste" : undefined, untitled ? paste.id : undefined);
}

export function renderPasswordPage(model: PasswordPageModel): string {
  const copy = labels(model.locale);
  const errorCode = normalizeErrorMessageCode(model.errorCode);
  const message = model.errorCode === undefined
    ? `<p id="password-error" class="field-error" hidden></p>`
    : `<p id="password-error" class="field-error" role="alert" data-i18n-error="${errorCode}">${translatedError(model.locale, model.errorCode)}</p>`;
  const body = `${siteHeader(copy, translated(copy, "passwordRequired"))}
<main class="workbench" data-workbench="password">
${statusLifecycleRail(translated(copy, "passwordRequired"))}
<section class="workbench-surface" aria-labelledby="page-title"><h1 id="page-title">${translated(copy, "passwordRequired")}</h1><form class="workbench-form" method="post"><div class="form-section"><label for="password">${translated(copy, "password")}</label><input id="password" name="password" type="password" autocomplete="current-password" required aria-describedby="password-error">${message}</div><div class="form-actions"><button class="primary-action" type="submit"${i18nAttribute("continue")}>${copy.continue}</button></div></form></section>
</main>`;
  return pageDocument(model.locale, "password", copy.passwordRequired, body, { page: "password", locale: model.locale }, undefined, "passwordRequired");
}

export function renderErrorPage(model: ErrorPageModel): string {
  const copy = labels(model.locale);
  const errorCode = normalizeErrorMessageCode(model.errorCode);
  const body = `${siteHeader(copy, translated(copy, "error"))}
<main class="workbench" data-workbench="error">
${statusLifecycleRail(translated(copy, "error"))}
<section class="workbench-surface" aria-labelledby="page-title"><h1 id="page-title">${translated(copy, "error")}</h1><p role="alert" data-i18n-error="${errorCode}">${translatedError(model.locale, model.errorCode)}</p><p><a href="/"${i18nAttribute("create")}>${copy.create}</a></p></section>
</main>`;
  return pageDocument(model.locale, "error", copy.error, body, { page: "error", locale: model.locale }, undefined, "error");
}

export function renderMarkdownDocument(model: MarkdownDocumentModel): string {
  const paste = publicSummary(model.paste);
  const copy = labels(model.locale);
  const restricted = paste.viewOnce;
  const title = documentTitle(model.locale, paste);
  const untitled = paste.title === "";
  const heading = untitled ? `${translated(copy, "paste")} ${escapeText(paste.id)}` : escapeText(title);
  const actions = restricted
    ? `<button class="markdown-document-action" type="button" data-action="copy"${i18nAttribute("copy")}>${copy.copy}</button>`
    : `<a class="markdown-document-action" data-action="open-source" href="${escapeText(paste.links.view)}"${i18nAttribute("openSource")}>${copy.openSource}</a><button class="markdown-document-action" type="button" data-action="copy"${i18nAttribute("copy")}>${copy.copy}</button>`;
  const body = `${siteHeader(copy, pasteLocation(copy, paste), actions, restricted ? translated(copy, "create") : translated(copy, "brand"))}
<main class="workbench" data-workbench="markdown" data-consumed="${restricted}">
${pasteLifecycleRail(model.locale, copy, paste)}
<section class="workbench-surface markdown-document" aria-labelledby="page-title"><article><h1 id="page-title">${heading}</h1>${renderMarkdown(model.content)}</article></section>
</main>`;
  const bootstrap = restricted
    ? { page: "markdown", locale: model.locale, consumed: true }
    : { page: "markdown", paste, consumed: false };
  return pageDocument(model.locale, "markdown", title, body, bootstrap, model.content, untitled ? "paste" : undefined, untitled ? paste.id : undefined);
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
