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

const englishLabels = {
  application: "Application",
  brand: "Pastebin",
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
  storedExactly: "Stored exactly as entered.",
  text: "Text",
  markdown: "Markdown",
  oneMinute: "1 minute",
  oneHour: "1 hour",
  oneDay: "1 day",
  oneWeek: "1 week",
  thirtyDays: "30 days",
  oneYear: "1 year",
  permanent: "Permanent",
  viewOnceDescription: "View-once reads use distributed storage and cannot guarantee globally exactly once.",
  pasteViews: "Paste views",
  view: "View",
  edit: "Edit",
  history: "History",
  settings: "Settings",
  localActions: "Local actions",
  copy: "Copy",
  wrap: "Wrap",
  source: "Source",
  preview: "Preview",
  download: "Download",
  openHtmlLocally: "Open HTML locally",
  representations: "Representations",
  raw: "Raw",
  html: "HTML",
  file: "File",
  delete: "Delete",
  consumed: "This view-once paste has been consumed. These actions use only the content already loaded in this page.",
  passwordRequired: "Password required",
  continue: "Continue",
  error: "Error",
  openSource: "Open source",
  paste: "Paste",
};

type Labels = { [Key in keyof typeof englishLabels]: string };

const chineseLabels: Labels = {
  application: "应用",
  brand: "Pastebin",
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
  storedExactly: "按输入内容原样保存。",
  text: "文本",
  markdown: "Markdown",
  oneMinute: "1 分钟",
  oneHour: "1 小时",
  oneDay: "1 天",
  oneWeek: "1 周",
  thirtyDays: "30 天",
  oneYear: "1 年",
  permanent: "永久",
  viewOnceDescription: "阅后即焚内容使用分布式存储，无法保证在所有位置都恰好只读取一次。",
  pasteViews: "粘贴内容视图",
  view: "查看",
  edit: "编辑",
  history: "历史记录",
  settings: "设置",
  localActions: "本地操作",
  copy: "复制",
  wrap: "自动换行",
  source: "源码",
  preview: "预览",
  download: "下载",
  openHtmlLocally: "在本地打开 HTML",
  representations: "表示形式",
  raw: "Raw",
  html: "HTML",
  file: "文件",
  delete: "删除",
  consumed: "此阅后即焚内容已被读取。这些操作只使用当前页面已加载的内容。",
  passwordRequired: "需要密码",
  continue: "继续",
  error: "错误",
  openSource: "打开源内容",
  paste: "粘贴内容",
};

export const dictionaries: Record<Locale, Labels> = {
  en: englishLabels,
  "zh-CN": chineseLabels,
};

function labels(locale: Locale): Labels {
  return dictionaries[locale];
}

function documentTitle(locale: Locale, paste: PasteSummary): string {
  return paste.title === "" ? `${labels(locale).paste} ${paste.id}` : paste.title;
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

function localActions(copy: Labels): string {
  return `<div class="actions" aria-label="${copy.localActions}">
<button type="button" data-action="copy">${copy.copy}</button>
<button type="button" data-action="wrap">${copy.wrap}</button>
<button type="button" data-action="toggle-source">${copy.source}</button>
<button type="button" data-action="preview">${copy.preview}</button>
<button type="button" data-action="download">${copy.download}</button>
<button type="button" data-action="open-html">${copy.openHtmlLocally}</button>
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

function pasteContentView(content: string, format: PasteSummary["format"]): string {
  return format === "markdown"
    ? `<article class="paste-content">${renderMarkdown(content)}</article>`
    : `<pre class="paste-content">${escapeText(content)}</pre>`;
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
    ["60", copy.oneMinute],
    ["3600", copy.oneHour],
    ["86400", copy.oneDay],
    ["604800", copy.oneWeek],
    ["2592000", copy.thirtyDays],
    ["31104000", copy.oneYear],
    ["permanent", copy.permanent],
  ] as const;
  const options = expiration.map(([value, label]) => `<option value="${value}"${value === "86400" ? " selected" : ""}>${label}</option>`).join("");
  const body = `<header><nav aria-label="${copy.application}"><a href="/">${copy.brand}</a><button type="button" data-action="locale">${copy.locale}</button><button type="button" data-action="theme">${copy.theme}</button></nav></header>
<main>
<h1>${copy.create}</h1>
<form id="create-form" method="post" action="/api/pastes">
<label for="content">${copy.content}</label>
<textarea id="content" name="content" required spellcheck="false" aria-describedby="content-description"></textarea>
<p id="content-description">${copy.storedExactly}</p>
<label for="title">${copy.title}</label>
<input id="title" name="title" type="text" maxlength="200">
<label for="format">${copy.format}</label>
<select id="format" name="format"><option value="text">${copy.text}</option><option value="markdown">${copy.markdown}</option></select>
<label for="expiration">${copy.expiration}</label>
<select id="expiration" name="expiration">${options}</select>
<label for="password">${copy.password}</label>
<div><input id="password" name="password" type="password" autocomplete="new-password"><button type="button" data-action="reveal-password" aria-label="${copy.reveal}">${copy.reveal}</button></div>
<label><input id="view-once" name="viewOnce" type="checkbox" value="true">${copy.viewOnce}</label>
<p id="view-once-description">${copy.viewOnceDescription}</p>
<label for="custom-id">${copy.customId}</label>
<input id="custom-id" name="customId" type="text">
<button type="submit">${copy.submit}</button>
</form>
</main>`;
  return pageDocument(locale, "create", copy.create, body, { page: "create", locale });
}

export function renderPastePage(model: PastePageModel): string {
  const paste = publicSummary(model.paste);
  const copy = labels(model.locale);
  const restricted = paste.viewOnce || model.consumed === true;
  const title = documentTitle(model.locale, paste);
  const contentView = pasteContentView(model.content, paste.format);
  const source = `<section data-panel="source" hidden>${sourceTextarea(model.content)}</section>`;
  const header = restricted
    ? `<header><nav aria-label="${copy.application}"><a href="/">${copy.create}</a></nav></header>`
    : `<header><nav aria-label="${copy.application}"><a href="/">${copy.brand}</a><a href="${escapeText(paste.links.view)}">${escapeText(title)}</a></nav></header>`;
  const common = `${header}
<main data-consumed="${restricted}">
<h1>${escapeText(title)}</h1>`;
  const body = restricted
    ? `${common}<p role="status">${copy.consumed}</p><section data-panel="view">${contentView}</section>${source}${localActions(copy)}<p aria-live="polite"></p></main>`
    : `${common}<nav aria-label="${copy.pasteViews}"><div role="tablist" aria-label="${copy.pasteViews}"><button type="button" role="tab" aria-selected="true" data-tab="view">${copy.view}</button><button type="button" role="tab" aria-selected="false" data-tab="edit">${copy.edit}</button><button type="button" role="tab" aria-selected="false" data-tab="markdown">${copy.markdown}</button><button type="button" role="tab" aria-selected="false" data-tab="history">${copy.history}</button><button type="button" role="tab" aria-selected="false" data-tab="settings">${copy.settings}</button></div></nav><section role="tabpanel" data-panel="view">${contentView}</section>${source}${localActions(copy)}<div class="representations" aria-label="${copy.representations}"><a data-action="raw" href="${escapeText(paste.links.raw)}">${copy.raw}</a><a data-action="html" href="${escapeText(paste.links.html)}">${copy.html}</a><a data-action="markdown-document" href="${escapeText(paste.links.markdown)}">${copy.markdown}</a><a data-action="file" href="${escapeText(paste.links.file)}">${copy.file}</a></div><button type="button" data-action="delete">${copy.delete}</button><p aria-live="polite"></p></main>`;
  const bootstrap = restricted
    ? { page: "paste", locale: model.locale, content: model.content, consumed: true }
    : { page: "paste", paste, content: model.content, consumed: false };
  return pageDocument(model.locale, "paste", title, body, bootstrap);
}

export function renderPasswordPage(model: PasswordPageModel): string {
  const copy = labels(model.locale);
  const message = model.error === undefined ? "" : `<p role="alert">${escapeText(model.error)}</p>`;
  const body = `<main><h1>${copy.passwordRequired}</h1><form method="post"><label for="password">${copy.password}</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">${copy.continue}</button>${message}</form></main>`;
  return pageDocument(model.locale, "password", copy.passwordRequired, body, { page: "password", locale: model.locale });
}

export function renderErrorPage(model: ErrorPageModel): string {
  const copy = labels(model.locale);
  const body = `<main><h1>${copy.error}</h1><p role="alert">${escapeText(model.error)}</p><p><a href="/">${copy.create}</a></p></main>`;
  return pageDocument(model.locale, "error", copy.error, body, { page: "error", locale: model.locale });
}

export function renderMarkdownDocument(model: MarkdownDocumentModel): string {
  const paste = publicSummary(model.paste);
  const copy = labels(model.locale);
  const title = documentTitle(model.locale, paste);
  const body = `<header><nav aria-label="${copy.application}"><a href="/">${copy.brand}</a><a href="${escapeText(paste.links.view)}">${copy.openSource}</a><button type="button" data-action="copy">${copy.copy}</button></nav></header><main><article><h1>${escapeText(title)}</h1>${renderMarkdown(model.content)}</article></main>`;
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
