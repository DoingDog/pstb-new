import type { ErrorCode } from "./types";

export type Locale = "en" | "zh-CN";

const englishLabels = {
  application: "Application",
  brand: "Pastebin",
  create: "Create a paste",
  content: "Content",
  title: "Title",
  titleDescription: "Optional. Up to 200 characters.",
  format: "Format",
  formatDescription: "Select the default view for this paste.",
  expiration: "Expiration",
  expirationDescription: "Choose when this paste expires.",
  password: "Password",
  passwordDescription: "Optional. Use 1 to 128 visible ASCII characters.",
  viewOnce: "View once",
  customId: "Custom ID",
  customIdDescription: "Optional. Start with an ASCII letter or number; use up to 64 ASCII letters, numbers, underscores, or hyphens.",
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
} as const;

export type LabelKey = keyof typeof englishLabels;
export type Labels = { readonly [Key in LabelKey]: string };

const chineseLabels: Labels = {
  application: "应用",
  brand: "Pastebin",
  create: "创建粘贴内容",
  content: "内容",
  title: "标题",
  titleDescription: "可选。最多 200 个字符。",
  format: "格式",
  formatDescription: "选择此剪贴板默认打开的视图。",
  expiration: "过期时间",
  expirationDescription: "选择剪贴板何时过期。",
  password: "密码",
  passwordDescription: "可选。使用 1 到 128 个可见 ASCII 字符。",
  viewOnce: "阅后即焚",
  customId: "自定义 ID",
  customIdDescription: "可选。以 ASCII 字母或数字开头，最多 64 个 ASCII 字母、数字、下划线或连字符。",
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

export type ErrorMessageCode = ErrorCode | "METHOD_NOT_ALLOWED";
export type ErrorMessages = { readonly [Code in ErrorMessageCode]: string };

const englishErrors: ErrorMessages = {
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
  METHOD_NOT_ALLOWED: "Method not allowed",
};

const chineseErrors: ErrorMessages = {
  BAD_REQUEST: "请求格式不正确。",
  AMBIGUOUS_PASSWORD: "密码参数不明确。",
  AMBIGUOUS_VERSION: "version 参数不明确。",
  FORBIDDEN: "缺少密码或密码不正确。",
  PASTE_NOT_FOUND: "未找到粘贴内容。",
  REVISION_NOT_FOUND: "未找到修订版本。",
  ID_CONFLICT: "该 ID 已被使用。",
  VERSION_CONFLICT: "此页面加载后粘贴内容已发生变化。",
  VIEW_ONCE_HISTORY_FORBIDDEN: "阅后即焚粘贴内容无法查看历史记录。",
  CONTENT_TOO_LARGE: "内容超过最大大小。",
  REQUEST_TOO_LARGE: "请求超过最大大小。",
  UNSUPPORTED_MEDIA_TYPE: "不支持该媒体类型。",
  VALIDATION_FAILED: "一个或多个字段无效。",
  RENDER_FAILED: "无法渲染粘贴内容。",
  INTERNAL_ERROR: "发生内部错误。",
  STORAGE_READ_FAILED: "无法读取存储。",
  STORAGE_WRITE_FAILED: "无法写入存储。",
  STORAGE_INCONSISTENT: "存储状态不一致。",
  CONSUME_FAILED: "无法读取阅后即焚粘贴内容。",
  ID_GENERATION_FAILED: "无法生成粘贴内容 ID。",
  METHOD_NOT_ALLOWED: "请求方法不被允许",
};

export interface Dictionary {
  readonly labels: Labels;
  readonly errors: ErrorMessages;
}

export const dictionaries: Record<Locale, Dictionary> = {
  en: { labels: englishLabels, errors: englishErrors },
  "zh-CN": { labels: chineseLabels, errors: chineseErrors },
};

function matchingKeys(left: unknown, right: unknown): boolean {
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
}

export function assertDictionaryParity(source: Record<Locale, { labels: Record<string, string>; errors: Record<string, string> }> = dictionaries): void {
  if (!matchingKeys(source.en?.labels, source["zh-CN"]?.labels) || !matchingKeys(source.en?.errors, source["zh-CN"]?.errors)) {
    throw new Error("dictionary keys do not match");
  }
}

assertDictionaryParity();

export function labels(locale: Locale): Labels {
  return dictionaries[locale].labels;
}

export function errorMessage(locale: Locale, code: ErrorMessageCode): string {
  return dictionaries[locale].errors[code];
}

function localeForLanguageRange(value: unknown): Locale | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const canonical = Intl.getCanonicalLocales(value)[0];
    const language = canonical?.split("-", 1)[0]?.toLowerCase();
    return language === "zh" ? "zh-CN" : language === "en" ? "en" : undefined;
  } catch {
    return undefined;
  }
}

export function resolveServerLocale(acceptLanguage: string | null): Locale {
  const range = acceptLanguage?.split(",", 1)[0]?.trim().split(";", 1)[0]?.trim();
  return localeForLanguageRange(range) === "zh-CN" ? "zh-CN" : "en";
}

export function resolveBrowserLocale(languages: readonly string[] | undefined, documentLocale: string | null | undefined): Locale {
  for (const language of languages ?? []) {
    const locale = localeForLanguageRange(language);
    if (locale !== undefined) return locale;
  }
  return documentLocale === "zh-CN" || documentLocale === "en" ? documentLocale : "en";
}

export function formatDate(locale: Locale, datetime: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(datetime));
}
