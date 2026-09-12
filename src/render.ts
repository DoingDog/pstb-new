import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { validateTitle } from "./pastes";
import { assetPaths } from "./generated/assets";
import type { PasteSummary } from "./types";

export type Locale = "en" | "zh-CN";

export interface PastePageModel {
  locale: Locale;
  paste: PasteSummary;
  content: string;
  consumed?: boolean;
}

export interface PasswordPageModel {
  locale: Locale;
  error?: string;
}

export interface ErrorPageModel {
  locale: Locale;
  error: string;
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

function labels(locale: Locale) {
  return locale === "zh-CN"
    ? {
        create: "创建粘贴内容",
        content: "内容",
        title: "标题",
        format: "格式",
        expiration: "过期时间",
        password: "密码",
        viewOnce: "阅后即焚",
        customId: "自定义 ID",
        submit: "创建",
        reveal: "显示密码",
        theme: "主题",
        locale: "语言",
      }
    : {
        create: "Create a paste",
        content: "Content",
        title: "Title",
        format: "Format",
        expiration: "Expiration",
        password: "Password",
        viewOnce: "View once",
        customId: "Custom ID",
        submit: "Create",
        reveal: "Show password",
        theme: "Theme",
        locale: "Language",
      };
}

function documentTitle(paste: PasteSummary): string {
  return paste.title === "" ? `Paste ${paste.id}` : paste.title;
}

function pageDocument(locale: Locale, page: string, title: string, body: string, bootstrap: unknown): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(title)}</title>
<link rel="stylesheet" href="${escapeText(assetPaths.appCss)}">
</head>
<body data-page="${page}">
${body}
<script id="bootstrap" type="application/json">${escapeBootstrapJson(bootstrap)}</script>
<script type="module" src="${escapeText(assetPaths.appJs)}"></script>
</body>
</html>`;
}

function sourceTextarea(content: string): string {
  return `<textarea id="source" name="source" readonly spellcheck="false">${escapeText(content)}</textarea>`;
}

function localActions(): string {
  return `<div class="actions" aria-label="Local actions">
<button type="button" data-action="copy">Copy</button>
<button type="button" data-action="wrap">Wrap</button>
<button type="button" data-action="toggle-source">Source</button>
<button type="button" data-action="preview">Preview</button>
<button type="button" data-action="download">Download</button>
<button type="button" data-action="open-html">Open HTML locally</button>
</div>`;
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
    ["permanent", "Permanent"],
    ["600", "10 minutes"],
    ["3600", "1 hour"],
    ["86400", "1 day"],
    ["604800", "1 week"],
    ["2592000", "30 days"],
    ["31536000", "1 year"],
  ] as const;
  const options = expiration.map(([value, label]) => `<option value="${value}"${value === "86400" ? " selected" : ""}>${label}</option>`).join("");
  const body = `<header><nav aria-label="Application"><a href="/">Pastebin</a><button type="button" data-action="locale">${copy.locale}</button><button type="button" data-action="theme">${copy.theme}</button></nav></header>
<main>
<h1>${copy.create}</h1>
<form id="create-form" method="post" action="/api/pastes">
<label for="content">${copy.content}</label>
<textarea id="content" name="content" required spellcheck="false" aria-describedby="content-description"></textarea>
<p id="content-description">Stored exactly as entered.</p>
<label for="title">${copy.title}</label>
<input id="title" name="title" type="text" maxlength="200">
<label for="format">${copy.format}</label>
<select id="format" name="format"><option value="text">Text</option><option value="markdown">Markdown</option></select>
<label for="expiration">${copy.expiration}</label>
<select id="expiration" name="expiration">${options}</select>
<label for="password">${copy.password}</label>
<div><input id="password" name="password" type="password" autocomplete="new-password"><button type="button" data-action="reveal-password" aria-label="${copy.reveal}">${copy.reveal}</button></div>
<label><input id="view-once" name="viewOnce" type="checkbox" value="true">${copy.viewOnce}</label>
<p id="view-once-description">View-once reads use distributed storage and cannot guarantee globally exactly once.</p>
<label for="custom-id">${copy.customId}</label>
<input id="custom-id" name="customId" type="text">
<button type="submit">${copy.submit}</button>
</form>
</main>`;
  return pageDocument(locale, "create", copy.create, body, { page: "create", locale });
}

export function renderPastePage(model: PastePageModel): string {
  const paste = publicSummary(model.paste);
  const restricted = paste.viewOnce || model.consumed === true;
  const title = documentTitle(paste);
  const common = `<header><nav aria-label="Application"><a href="/">Pastebin</a><a href="${escapeText(paste.links.view)}">${escapeText(title)}</a></nav></header>
<main data-consumed="${restricted}">
<h1>${escapeText(title)}</h1>`;
  const body = restricted
    ? `${common}<p role="status">This view-once paste has been consumed. These actions use only the content already loaded in this page.</p>${sourceTextarea(model.content)}${localActions()}<p aria-live="polite"></p></main>`
    : `${common}<nav aria-label="Paste views"><div role="tablist" aria-label="Paste views"><button type="button" role="tab" aria-selected="true" data-tab="view">View</button><button type="button" role="tab" aria-selected="false" data-tab="edit">Edit</button><button type="button" role="tab" aria-selected="false" data-tab="markdown">Markdown</button><button type="button" role="tab" aria-selected="false" data-tab="history">History</button><button type="button" role="tab" aria-selected="false" data-tab="settings">Settings</button></div></nav><section role="tabpanel" data-panel="view">${sourceTextarea(model.content)}</section>${localActions()}<div class="representations" aria-label="Representations"><a data-action="raw" href="${escapeText(paste.links.raw)}">Raw</a><a data-action="html" href="${escapeText(paste.links.html)}">HTML</a><a data-action="markdown-document" href="${escapeText(paste.links.markdown)}">Markdown</a><a data-action="file" href="${escapeText(paste.links.file)}">File</a></div><button type="button" data-action="delete">Delete</button><p aria-live="polite"></p></main>`;
  return pageDocument(model.locale, "paste", title, body, { page: "paste", paste, content: model.content, consumed: restricted });
}

export function renderPasswordPage(model: PasswordPageModel): string {
  const message = model.error === undefined ? "" : `<p role="alert">${escapeText(model.error)}</p>`;
  const body = `<main><h1>Password required</h1><form method="post"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Continue</button>${message}</form></main>`;
  return pageDocument(model.locale, "password", "Password required", body, { page: "password", locale: model.locale });
}

export function renderErrorPage(model: ErrorPageModel): string {
  const body = `<main><h1>Error</h1><p role="alert">${escapeText(model.error)}</p><p><a href="/">Create a paste</a></p></main>`;
  return pageDocument(model.locale, "error", "Error", body, { page: "error", locale: model.locale });
}

export function renderMarkdownDocument(model: MarkdownDocumentModel): string {
  const paste = publicSummary(model.paste);
  const title = documentTitle(paste);
  const body = `<header><nav aria-label="Application"><a href="/">Pastebin</a><a href="${escapeText(paste.links.view)}">Open source</a><button type="button" data-action="copy">Copy</button></nav></header><main><article><h1>${escapeText(title)}</h1>${renderMarkdown(model.content)}</article></main>`;
  return pageDocument(model.locale, "markdown", title, body, { page: "markdown", paste, content: model.content });
}

function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function deriveDownloadHeaders(summary: PasteSummary): Headers {
  const fallback = `paste-${summary.id}.txt`;
  const title = validateTitle(summary.title);
  const filename = title.replace(/[\\/]/g, "_").replace(/[ .]+$/u, "") || fallback;
  return new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987(filename)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
}
