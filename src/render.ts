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
  documentStatus: "Document status",
  newDocument: "New document",
  exactText: "Exact text",
  encoding: "Encoding",
  limit: "Limit",
  protected: "Protected",
  notProtected: "Not protected",
  enabled: "Enabled",
  standard: "Standard",
  expires: "Expires",
  revision: "Revision",
  saveStatus: "Save status",
  saved: "Saved",
  size: "Size",
  bytes: "bytes",
  cancel: "Cancel",
  deleteDescription: "Delete this paste permanently.",
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
  documentStatus: "文档状态",
  newDocument: "新文档",
  exactText: "精确文本",
  encoding: "编码",
  limit: "限制",
  protected: "受密码保护",
  notProtected: "未受密码保护",
  enabled: "已启用",
  standard: "普通",
  expires: "过期时间",
  revision: "修订版本",
  saveStatus: "保存状态",
  saved: "已保存",
  size: "大小",
  bytes: "字节",
  cancel: "取消",
  deleteDescription: "永久删除此剪贴板。",
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
  return `<textarea id="source" class="editor-input" name="source" readonly spellcheck="false">${escapeText(content)}</textarea>`;
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

function siteHeader(copy: Labels, location: string, actions = "", rootLabel = copy.brand): string {
  return `<header class="site-header"><nav class="site-nav" aria-label="${copy.application}"><a href="/">${rootLabel}</a><p class="page-location">${location}</p><div class="utility-actions"><button type="button" data-action="locale">${copy.locale}</button><button type="button" data-action="theme">${copy.theme}</button>${actions}</div></nav></header>`;
}

function lifecycleItem(label: string, value: string): string {
  return `<div><dt>${label}</dt><dd>${value}</dd></div>`;
}

function createLifecycleRail(copy: Labels): string {
  return `<aside class="lifecycle-rail" aria-labelledby="lifecycle-title"><h2 id="lifecycle-title">${copy.newDocument}</h2><dl class="lifecycle-list">${lifecycleItem(copy.content, copy.exactText)}${lifecycleItem(copy.encoding, "UTF-8")}${lifecycleItem(copy.limit, "10 MiB")}</dl></aside>`;
}

function pasteLifecycleRail(copy: Labels, paste: PasteSummary): string {
  const expires = paste.expiresAt === null
    ? copy.permanent
    : `<time datetime="${escapeText(paste.expiresAt)}">${escapeText(paste.expiresAt)}</time>`;
  return `<aside class="lifecycle-rail" aria-labelledby="lifecycle-title"><h2 id="lifecycle-title">${copy.documentStatus}</h2><dl class="lifecycle-list">${lifecycleItem("ID", `<code>${escapeText(paste.id)}</code>`)}${lifecycleItem(copy.password, paste.protected ? copy.protected : copy.notProtected)}${lifecycleItem(copy.viewOnce, paste.viewOnce ? copy.enabled : copy.standard)}${lifecycleItem(copy.expires, expires)}${lifecycleItem(copy.revision, `<code>${paste.contentRevision}</code>`)}${lifecycleItem(copy.saveStatus, `<span data-save-status="saved" aria-live="polite">${copy.saved}</span>`)}${lifecycleItem(copy.size, `${paste.contentBytes} ${copy.bytes}`)}</dl></aside>`;
}

function statusLifecycleRail(copy: Labels, heading: string): string {
  return `<aside class="lifecycle-rail" aria-labelledby="lifecycle-title"><h2 id="lifecycle-title">${heading}</h2></aside>`;
}

function pasteLocation(copy: Labels, paste: PasteSummary): string {
  return `${copy.paste} / <code>${escapeText(paste.id)}</code>`;
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
  const body = `${siteHeader(copy, copy.create)}
<main class="workbench" data-workbench="create">
${createLifecycleRail(copy)}
<section class="workbench-surface" aria-labelledby="page-title">
<h1 id="page-title">${copy.create}</h1>
<form id="create-form" class="workbench-form" method="post" action="/api/pastes">
<div class="form-section editor-surface"><label for="content">${copy.content}</label><textarea id="content" name="content" required spellcheck="false" aria-describedby="content-description content-error"></textarea><p id="content-description">${copy.storedExactly}</p><p id="content-error" class="field-error" hidden></p></div>
<div class="form-section"><label for="title">${copy.title}</label><input id="title" name="title" type="text" maxlength="200" aria-describedby="title-error"><p id="title-error" class="field-error" hidden></p></div>
<div class="form-section"><label for="format">${copy.format}</label><select id="format" name="format" aria-describedby="format-error"><option value="text">${copy.text}</option><option value="markdown">${copy.markdown}</option></select><p id="format-error" class="field-error" hidden></p></div>
<div class="form-section"><label for="expiration">${copy.expiration}</label><select id="expiration" name="expiration" aria-describedby="expiration-error">${options}</select><p id="expiration-error" class="field-error" hidden></p></div>
<div class="form-section"><label for="password">${copy.password}</label><div class="password-control"><input id="password" name="password" type="password" autocomplete="new-password" aria-describedby="password-error"><button type="button" data-action="reveal-password" aria-label="${copy.reveal}">${copy.reveal}</button></div><p id="password-error" class="field-error" hidden></p></div>
<div class="form-section"><label class="checkbox-label"><input id="view-once" name="viewOnce" type="checkbox" value="true" aria-describedby="view-once-description view-once-error">${copy.viewOnce}</label><p id="view-once-description">${copy.viewOnceDescription}</p><p id="view-once-error" class="field-error" hidden></p></div>
<div class="form-section"><label for="custom-id">${copy.customId}</label><input id="custom-id" name="customId" type="text" aria-describedby="custom-id-error"><p id="custom-id-error" class="field-error" hidden></p></div>
<div class="form-actions"><button class="primary-action" type="submit">${copy.submit}</button><p id="create-status" aria-live="polite"></p></div>
</form>
</section>
</main>`;
  return pageDocument(locale, "create", copy.create, body, { page: "create", locale });
}

export function renderPastePage(model: PastePageModel): string {
  const paste = publicSummary(model.paste);
  const copy = labels(model.locale);
  const restricted = paste.viewOnce || model.consumed === true;
  const title = documentTitle(model.locale, paste);
  const contentView = pasteContentView(model.content, paste.format);
  const headerActions = restricted
    ? `<button type="button" data-action="copy">${copy.copy}</button>`
    : `<button type="button" data-action="copy">${copy.copy}</button><a data-action="raw" href="${escapeText(paste.links.raw)}">${copy.raw}</a><a data-action="file" href="${escapeText(paste.links.file)}">${copy.file}</a>`;
  const header = siteHeader(copy, pasteLocation(copy, paste), headerActions, restricted ? copy.create : copy.brand);
  const source = `<div data-panel="source" hidden>${sourceTextarea(model.content)}</div>`;
  const panels = `<nav class="tab-navigation" aria-label="${copy.pasteViews}"><div role="tablist" aria-label="${copy.pasteViews}"><button id="tab-view" type="button" role="tab" aria-selected="true" aria-controls="panel-view" tabindex="0" data-tab="view">${copy.view}</button><button id="tab-edit" type="button" role="tab" aria-selected="false" aria-controls="panel-edit" tabindex="-1" data-tab="edit">${copy.edit}</button><button id="tab-markdown" type="button" role="tab" aria-selected="false" aria-controls="panel-markdown" tabindex="-1" data-tab="markdown">${copy.markdown}</button><button id="tab-history" type="button" role="tab" aria-selected="false" aria-controls="panel-history" tabindex="-1" data-tab="history">${copy.history}</button><button id="tab-settings" type="button" role="tab" aria-selected="false" aria-controls="panel-settings" tabindex="-1" data-tab="settings">${copy.settings}</button></div></nav><section id="panel-view" role="tabpanel" tabindex="0" aria-labelledby="tab-view" data-panel="view">${contentView}</section><section id="panel-edit" role="tabpanel" tabindex="0" aria-labelledby="tab-edit" data-panel="edit" hidden>${source}</section><section id="panel-markdown" role="tabpanel" tabindex="0" aria-labelledby="tab-markdown" data-panel="markdown" hidden></section><section id="panel-history" role="tabpanel" tabindex="0" aria-labelledby="tab-history" data-panel="history" hidden><div class="history-workbench"><div class="history-list" data-history-list></div><div class="history-detail" data-history-detail></div></div></section><section id="panel-settings" role="tabpanel" tabindex="0" aria-labelledby="tab-settings" data-panel="settings" hidden></section>`;
  const restrictedBody = `<p class="consumed-notice" role="status">${copy.consumed}</p><section data-panel="view">${contentView}</section>${source}${localActions(copy)}`;
  const ordinaryBody = `${panels}<div class="context-actions">${localActions(copy)}<div class="representations" aria-label="${copy.representations}"><a data-action="raw" href="${escapeText(paste.links.raw)}">${copy.raw}</a><a data-action="html" href="${escapeText(paste.links.html)}">${copy.html}</a><a data-action="markdown-document" href="${escapeText(paste.links.markdown)}">${copy.markdown}</a><a data-action="file" href="${escapeText(paste.links.file)}">${copy.file}</a></div><button class="danger-action" type="button" data-action="delete">${copy.delete}</button></div><dialog id="delete-dialog" class="delete-dialog" aria-labelledby="delete-dialog-title"><form method="dialog"><h2 id="delete-dialog-title">${copy.delete}</h2><p>${copy.deleteDescription}</p><div class="dialog-actions"><button type="submit" data-action="cancel-delete">${copy.cancel}</button><button class="danger-action" type="button" data-action="confirm-delete">${copy.delete}</button></div></form></dialog>`;
  const body = `${header}
<main class="workbench" data-workbench="paste" data-consumed="${restricted}">
${pasteLifecycleRail(copy, paste)}
<section class="workbench-surface" aria-labelledby="page-title"><h1 id="page-title">${escapeText(title)}</h1>${restricted ? restrictedBody : ordinaryBody}<p id="paste-status" aria-live="polite"></p></section>
</main>`;
  const bootstrap = restricted
    ? { page: "paste", locale: model.locale, content: model.content, consumed: true }
    : { page: "paste", paste, content: model.content, consumed: false };
  return pageDocument(model.locale, "paste", title, body, bootstrap);
}

export function renderPasswordPage(model: PasswordPageModel): string {
  const copy = labels(model.locale);
  const message = model.error === undefined
    ? `<p id="password-error" class="field-error" hidden></p>`
    : `<p id="password-error" class="field-error" role="alert">${escapeText(model.error)}</p>`;
  const body = `${siteHeader(copy, copy.passwordRequired)}
<main class="workbench" data-workbench="password">
${statusLifecycleRail(copy, copy.passwordRequired)}
<section class="workbench-surface" aria-labelledby="page-title"><h1 id="page-title">${copy.passwordRequired}</h1><form class="workbench-form" method="post"><div class="form-section"><label for="password">${copy.password}</label><input id="password" name="password" type="password" autocomplete="current-password" required aria-describedby="password-error">${message}</div><div class="form-actions"><button class="primary-action" type="submit">${copy.continue}</button></div></form></section>
</main>`;
  return pageDocument(model.locale, "password", copy.passwordRequired, body, { page: "password", locale: model.locale });
}

export function renderErrorPage(model: ErrorPageModel): string {
  const copy = labels(model.locale);
  const body = `${siteHeader(copy, copy.error)}
<main class="workbench" data-workbench="error">
${statusLifecycleRail(copy, copy.error)}
<section class="workbench-surface" aria-labelledby="page-title"><h1 id="page-title">${copy.error}</h1><p role="alert">${escapeText(model.error)}</p><p><a href="/">${copy.create}</a></p></section>
</main>`;
  return pageDocument(model.locale, "error", copy.error, body, { page: "error", locale: model.locale });
}

export function renderMarkdownDocument(model: MarkdownDocumentModel): string {
  const paste = publicSummary(model.paste);
  const copy = labels(model.locale);
  const restricted = paste.viewOnce;
  const title = documentTitle(model.locale, paste);
  const actions = restricted
    ? `<button type="button" data-action="copy">${copy.copy}</button>`
    : `<a data-action="open-source" href="${escapeText(paste.links.view)}">${copy.openSource}</a><button type="button" data-action="copy">${copy.copy}</button>`;
  const body = `${siteHeader(copy, pasteLocation(copy, paste), actions, restricted ? copy.create : copy.brand)}
<main class="workbench" data-workbench="markdown" data-consumed="${restricted}">
${pasteLifecycleRail(copy, paste)}
<section class="workbench-surface markdown-document" aria-labelledby="page-title"><article><h1 id="page-title">${escapeText(title)}</h1>${renderMarkdown(model.content)}</article></section>
</main>`;
  const bootstrap = restricted
    ? { page: "markdown", locale: model.locale, content: model.content, consumed: true }
    : { page: "markdown", paste, content: model.content, consumed: false };
  return pageDocument(model.locale, "markdown", title, body, bootstrap);
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
