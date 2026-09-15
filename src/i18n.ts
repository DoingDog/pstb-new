import type { ActionKey, AutosaveStatus, AutosyncStatus, LastAction, NetworkStatus, TerminalOutcomeKey } from "./client/contracts";
import type { AppLocale, ErrorCode } from "./types";

export type Locale = AppLocale;

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
  languageEnglish: "English",
  languageChinese: "Chinese",
  themeSystem: "System",
  themeLight: "Light",
  themeDark: "Dark",
  text: "Text",
  markdown: "Markdown",
  oneMinute: "1 minute",
  oneHour: "1 hour",
  oneDay: "1 day",
  oneWeek: "1 week",
  thirtyDays: "30 days",
  oneYear: "1 year",
  permanent: "Permanent",
  pasteViews: "Paste views",
  view: "View",
  edit: "Edit",
  history: "History",
  settings: "Settings",
  localActions: "Local actions",
  copy: "Copy",
  wrap: "Wrap",
  unwrap: "Unwrap",
  source: "Source",
  preview: "Preview",
  download: "Download",
  openHtmlLocally: "Open HTML locally",
  representations: "Representations",
  raw: "Raw",
  html: "HTML",
  file: "File",
  delete: "Delete",
  consumed: "Consumed",
  passwordRequired: "Password required",
  continue: "Continue",
  error: "Error",
  openSource: "Open source",
  paste: "Paste",
  documentStatus: "Document status",
  operationStatus: "Operation status",
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
  help: "Help",
  toggleSidebar: "Toggle sidebar",
  autosave: "Autosave",
  autosync: "Autosync",
  network: "Network",
  lastAction: "Last action",
} as const;

export type LabelKey = keyof typeof englishLabels;
export type Labels = { readonly [Key in LabelKey]: string };

const chineseLabels: Labels = {
  application: "应用",
  brand: "Pastebin",
  create: "创建剪贴板",
  content: "内容",
  title: "标题",
  format: "格式",
  expiration: "过期时间",
  password: "密码",
  viewOnce: "阅后即焚",
  customId: "自定义 ID",
  submit: "创建剪贴板",
  reveal: "显示密码",
  theme: "主题",
  locale: "语言",
  languageEnglish: "English",
  languageChinese: "中文",
  themeSystem: "跟随系统",
  themeLight: "浅色",
  themeDark: "深色",
  text: "文本",
  markdown: "Markdown",
  oneMinute: "1 分钟",
  oneHour: "1 小时",
  oneDay: "1 天",
  oneWeek: "1 周",
  thirtyDays: "30 天",
  oneYear: "1 年",
  permanent: "永久",
  pasteViews: "剪贴板视图",
  view: "查看",
  edit: "编辑",
  history: "历史记录",
  settings: "设置",
  localActions: "本地操作",
  copy: "复制",
  wrap: "自动换行",
  unwrap: "取消自动换行",
  source: "源码",
  preview: "预览",
  download: "下载",
  openHtmlLocally: "在本地打开 HTML",
  representations: "表示形式",
  raw: "Raw",
  html: "HTML",
  file: "文件",
  delete: "删除剪贴板",
  consumed: "已读取",
  passwordRequired: "需要密码",
  continue: "继续",
  error: "错误",
  openSource: "打开源内容",
  paste: "剪贴板",
  documentStatus: "文档状态",
  operationStatus: "操作状态",
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
  help: "帮助",
  toggleSidebar: "切换侧边栏",
  autosave: "自动保存",
  autosync: "自动同步",
  network: "网络",
  lastAction: "最近操作",
};

const englishValidation = {
  deleteDescription: "Delete this paste permanently.",
} as const;

export type ValidationKey = keyof typeof englishValidation;
export type ValidationMessages = { readonly [Key in ValidationKey]: string };

const chineseValidation: ValidationMessages = {
  deleteDescription: "永久删除此剪贴板。",
};

export type ClientErrorCode = "NETWORK_ERROR" | "MALFORMED_RESPONSE" | "UNKNOWN_ERROR";
export type ErrorMessageCode = ErrorCode | "METHOD_NOT_ALLOWED" | ClientErrorCode;
export type ErrorMessages = { readonly [Code in ErrorMessageCode]: string };

const englishErrors: ErrorMessages = {
  BAD_REQUEST: "The request is malformed. Review the input and try again.",
  AMBIGUOUS_PASSWORD: "The password is ambiguous. Enter one password and try again.",
  AMBIGUOUS_VERSION: "The version is ambiguous. Reload the page and try again.",
  FORBIDDEN: "Password is missing or incorrect. Enter the password and try again.",
  PASTE_NOT_FOUND: "The paste was not found. Return to the create page.",
  REVISION_NOT_FOUND: "The revision was not found. Reload the history and choose another revision.",
  ID_CONFLICT: "That ID is already in use. Choose a different ID and try again.",
  VERSION_CONFLICT: "The paste changed after this page loaded. Reload the page before saving again.",
  VIEW_ONCE_HISTORY_FORBIDDEN: "History is unavailable for a view-once paste. Return to the paste.",
  CONTENT_TOO_LARGE: "The content exceeds the maximum size. Reduce it and try again.",
  REQUEST_TOO_LARGE: "The request exceeds the maximum size. Reduce it and try again.",
  UNSUPPORTED_MEDIA_TYPE: "The media type is not supported. Use a supported media type and try again.",
  VALIDATION_FAILED: "One or more fields are invalid. Correct the fields and try again.",
  RENDER_FAILED: "The paste could not be rendered. Download the source and try another format.",
  INTERNAL_ERROR: "An internal error occurred. Retry the request.",
  STORAGE_READ_FAILED: "Storage could not be read. Retry the request.",
  STORAGE_WRITE_FAILED: "Storage could not be written. Retry the request.",
  STORAGE_INCONSISTENT: "Storage state is inconsistent. Reload the page and retry.",
  CONSUME_FAILED: "The view-once paste could not be consumed. Retry the request.",
  ID_GENERATION_FAILED: "A paste ID could not be generated. Retry creating the paste.",
  METHOD_NOT_ALLOWED: "Method not allowed. Return to the create page.",
  NETWORK_ERROR: "The network request failed. Check the connection and try again.",
  MALFORMED_RESPONSE: "The response could not be read. Retry the request.",
  UNKNOWN_ERROR: "An unexpected error occurred. Retry the request.",
};

const chineseErrors: ErrorMessages = {
  BAD_REQUEST: "请求格式不正确。请检查输入后重试。",
  AMBIGUOUS_PASSWORD: "密码参数不明确。请输入一个密码后重试。",
  AMBIGUOUS_VERSION: "version 参数不明确。请重新加载页面后重试。",
  FORBIDDEN: "缺少密码或密码不正确。请输入密码后重试。",
  PASTE_NOT_FOUND: "未找到剪贴板。请返回创建页面。",
  REVISION_NOT_FOUND: "未找到修订版本。请重新加载历史记录并选择其他修订版本。",
  ID_CONFLICT: "该 ID 已被使用。请选择其他 ID 后重试。",
  VERSION_CONFLICT: "此页面加载后剪贴板已发生变化。请重新加载页面后再保存。",
  VIEW_ONCE_HISTORY_FORBIDDEN: "阅后即焚剪贴板无法查看历史记录。请返回剪贴板。",
  CONTENT_TOO_LARGE: "内容超过最大大小。请缩短内容后重试。",
  REQUEST_TOO_LARGE: "请求超过最大大小。请缩短请求后重试。",
  UNSUPPORTED_MEDIA_TYPE: "不支持该媒体类型。请使用受支持的媒体类型后重试。",
  VALIDATION_FAILED: "一个或多个字段无效。请更正后重试。",
  RENDER_FAILED: "无法渲染剪贴板。请下载源内容后尝试其他格式。",
  INTERNAL_ERROR: "发生内部错误。请重试。",
  STORAGE_READ_FAILED: "无法读取存储。请重试。",
  STORAGE_WRITE_FAILED: "无法写入存储。请重试。",
  STORAGE_INCONSISTENT: "存储状态不一致。请重新加载页面后重试。",
  CONSUME_FAILED: "无法读取阅后即焚剪贴板。请重试。",
  ID_GENERATION_FAILED: "无法生成剪贴板 ID。请重新创建剪贴板。",
  METHOD_NOT_ALLOWED: "请求方法不被允许。请返回创建页面。",
  NETWORK_ERROR: "网络请求失败。请检查连接后重试。",
  MALFORMED_RESPONSE: "无法读取响应。请重试。",
  UNKNOWN_ERROR: "发生未知错误。请重试。",
};

export type HelpKey =
  | "contentStorage"
  | "contentLimit"
  | "format"
  | "expiration"
  | "relativeExpiration"
  | "password"
  | "passwordUrl"
  | "viewOnce"
  | "activeHtml"
  | "markdownNormalization"
  | "autosave"
  | "autosync"
  | "largeDiff";

export type HelpMessages = { readonly [Key in HelpKey]: string };

const englishHelp: HelpMessages = {
  contentStorage: "Content is stored exactly as entered.",
  contentLimit: "A paste can contain up to 10 MiB of UTF-8 text.",
  format: "Choose the default representation for this paste.",
  expiration: "Choose when this paste expires.",
  relativeExpiration: "Relative expiration starts when the paste is created.",
  password: "Use 1 to 128 visible ASCII characters.",
  passwordUrl: "Password-protected links include the password in the URL.",
  viewOnce: "View-once reads use distributed storage and cannot guarantee globally exactly once.",
  activeHtml: "HTML opens in a separate local document.",
  markdownNormalization: "Markdown preview normalizes rendered output; the source remains exact.",
  autosave: "Changes save after editing pauses.",
  autosync: "The current paste checks for remote changes while it is active.",
  largeDiff: "Large differences are computed separately from the editor.",
};

const chineseHelp: HelpMessages = {
  contentStorage: "内容会按输入内容原样保存。",
  contentLimit: "单个剪贴板最多包含 10 MiB UTF-8 文本。",
  format: "选择此剪贴板的默认表示形式。",
  expiration: "选择剪贴板何时过期。",
  relativeExpiration: "相对过期时间从创建剪贴板时开始计算。",
  password: "使用 1 到 128 个可见 ASCII 字符。",
  passwordUrl: "受密码保护的链接会在 URL 中包含密码。",
  viewOnce: "阅后即焚剪贴板使用分布式存储，无法保证在所有位置都恰好只读取一次。",
  activeHtml: "HTML 会在单独的本地文档中打开。",
  markdownNormalization: "Markdown 预览会规范化渲染结果，源内容保持精确不变。",
  autosave: "停止编辑后会自动保存更改。",
  autosync: "当前剪贴板处于活动状态时会检查远程更改。",
  largeDiff: "较大的差异会在编辑器之外计算。",
};

export interface StatusMessages {
  readonly autosave: Readonly<Record<AutosaveStatus, string>>;
  readonly autosync: Readonly<Record<AutosyncStatus, string>>;
  readonly network: Readonly<Record<NetworkStatus, string>>;
  readonly lastAction: Readonly<Record<LastAction["state"], string>>;
}

const englishStatus: StatusMessages = {
  autosave: {
    clean: "Clean",
    waiting: "Waiting",
    saving: "Saving",
    saved: "Saved",
    error: "Error",
    "password-required": "Password required",
    "not-found": "Not found",
    conflict: "Conflict",
  },
  autosync: {
    waiting: "Waiting",
    checking: "Checking",
    unchanged: "Unchanged",
    "remote-applied": "Remote changes applied",
    "paused-local": "Paused for local changes",
    "paused-offline": "Paused offline",
    error: "Error",
    forbidden: "Password required",
    "not-found": "Not found",
    conflict: "Conflict",
    inactive: "Inactive",
  },
  network: {
    online: "Online",
    offline: "Offline",
    degraded: "Degraded",
  },
  lastAction: {
    idle: "Idle",
    pending: "In progress",
    succeeded: "Completed",
    failed: "Failed",
  },
};

const chineseStatus: StatusMessages = {
  autosave: {
    clean: "无更改",
    waiting: "等待中",
    saving: "保存中",
    saved: "已保存",
    error: "错误",
    "password-required": "需要密码",
    "not-found": "未找到",
    conflict: "冲突",
  },
  autosync: {
    waiting: "等待中",
    checking: "检查中",
    unchanged: "无变化",
    "remote-applied": "已应用远程更改",
    "paused-local": "因本地更改暂停",
    "paused-offline": "离线暂停",
    error: "错误",
    forbidden: "需要密码",
    "not-found": "未找到",
    conflict: "冲突",
    inactive: "未激活",
  },
  network: {
    online: "在线",
    offline: "离线",
    degraded: "网络不稳定",
  },
  lastAction: {
    idle: "空闲",
    pending: "进行中",
    succeeded: "已完成",
    failed: "失败",
  },
};

export type ActionOutcomeMessages = Readonly<Record<ActionKey, Readonly<Record<"pending" | "succeeded" | "failed", string>>>>;

const englishActions: ActionOutcomeMessages = {
  create: { pending: "Creating", succeeded: "Created", failed: "Create failed" },
  autosave: { pending: "Saving", succeeded: "Saved", failed: "Save failed" },
  "manual-save": { pending: "Saving", succeeded: "Saved", failed: "Save failed" },
  "save-retry": { pending: "Retrying save", succeeded: "Saved", failed: "Save failed" },
  overwrite: { pending: "Overwriting", succeeded: "Overwritten", failed: "Overwrite failed" },
  "content-reconcile": { pending: "Reconciling content", succeeded: "Content reconciled", failed: "Content reconcile failed" },
  "reload-server": { pending: "Reloading", succeeded: "Reloaded", failed: "Reload failed" },
  "use-remote": { pending: "Using remote content", succeeded: "Remote content applied", failed: "Remote content failed" },
  "use-consumed-response": { pending: "Using consumed response", succeeded: "Consumed response displayed", failed: "Consumed response failed" },
  "retry-sync": { pending: "Retrying sync", succeeded: "Sync scheduled", failed: "Sync retry failed" },
  copy: { pending: "Copying", succeeded: "Copied", failed: "Copy failed" },
  download: { pending: "Preparing download", succeeded: "Download ready", failed: "Download failed" },
  "history-list": { pending: "Loading history", succeeded: "History loaded", failed: "History failed" },
  "history-snapshot": { pending: "Loading revision", succeeded: "Revision loaded", failed: "Revision failed" },
  "settings-title": { pending: "Saving title", succeeded: "Title saved", failed: "Title failed" },
  "settings-format": { pending: "Saving format", succeeded: "Format saved", failed: "Format failed" },
  "settings-expiration": { pending: "Saving expiration", succeeded: "Expiration saved", failed: "Expiration failed" },
  "settings-view-once": { pending: "Saving view once", succeeded: "View once saved", failed: "View once failed" },
  "settings-reconcile": { pending: "Reconciling settings", succeeded: "Settings reconciled", failed: "Settings reconcile failed" },
  "password-set": { pending: "Saving password", succeeded: "Password saved", failed: "Password failed" },
  "password-clear": { pending: "Clearing password", succeeded: "Password cleared", failed: "Password clear failed" },
  "password-reconcile": { pending: "Reconciling password", succeeded: "Password reconciled", failed: "Password reconcile failed" },
  delete: { pending: "Deleting", succeeded: "Deleted", failed: "Delete failed" },
};

const chineseActions: ActionOutcomeMessages = {
  create: { pending: "正在创建", succeeded: "已创建", failed: "创建失败" },
  autosave: { pending: "正在保存", succeeded: "已保存", failed: "保存失败" },
  "manual-save": { pending: "正在保存", succeeded: "已保存", failed: "保存失败" },
  "save-retry": { pending: "正在重试保存", succeeded: "已保存", failed: "保存失败" },
  overwrite: { pending: "正在覆盖", succeeded: "已覆盖", failed: "覆盖失败" },
  "content-reconcile": { pending: "正在核对内容", succeeded: "内容已核对", failed: "内容核对失败" },
  "reload-server": { pending: "正在重新加载", succeeded: "已重新加载", failed: "重新加载失败" },
  "use-remote": { pending: "正在使用远程内容", succeeded: "已应用远程内容", failed: "远程内容应用失败" },
  "use-consumed-response": { pending: "正在使用已读取响应", succeeded: "已显示已读取响应", failed: "已读取响应显示失败" },
  "retry-sync": { pending: "正在重试同步", succeeded: "已安排同步", failed: "同步重试失败" },
  copy: { pending: "正在复制", succeeded: "已复制", failed: "复制失败" },
  download: { pending: "正在准备下载", succeeded: "下载已准备", failed: "下载失败" },
  "history-list": { pending: "正在加载历史记录", succeeded: "历史记录已加载", failed: "历史记录加载失败" },
  "history-snapshot": { pending: "正在加载修订版本", succeeded: "修订版本已加载", failed: "修订版本加载失败" },
  "settings-title": { pending: "正在保存标题", succeeded: "标题已保存", failed: "标题保存失败" },
  "settings-format": { pending: "正在保存格式", succeeded: "格式已保存", failed: "格式保存失败" },
  "settings-expiration": { pending: "正在保存过期时间", succeeded: "过期时间已保存", failed: "过期时间保存失败" },
  "settings-view-once": { pending: "正在保存阅后即焚", succeeded: "阅后即焚已保存", failed: "阅后即焚保存失败" },
  "settings-reconcile": { pending: "正在核对设置", succeeded: "设置已核对", failed: "设置核对失败" },
  "password-set": { pending: "正在保存密码", succeeded: "密码已保存", failed: "密码保存失败" },
  "password-clear": { pending: "正在清除密码", succeeded: "密码已清除", failed: "密码清除失败" },
  "password-reconcile": { pending: "正在核对密码", succeeded: "密码已核对", failed: "密码核对失败" },
  delete: { pending: "正在删除", succeeded: "已删除", failed: "删除失败" },
};

export type TerminalMessages = Readonly<Record<TerminalOutcomeKey, string>>;

const englishTerminal: TerminalMessages = {
  "content-reconcile-terminal-current-kept": "Content reconcile completed. The paste was consumed and current content was kept.",
  "reload-terminal-response-displayed": "Reload completed. The consumed response is displayed.",
  "reload-terminal-response-display-failed": "The paste was consumed. The response could not be displayed and current content was kept.",
  "reload-terminal-current-unchanged": "Reload completed. The paste was consumed and current content is unchanged.",
  "reload-terminal-current-kept-choice": "Reload completed. The paste was consumed; current content was kept and the consumed response is available.",
  "use-consumed-response-displayed": "The consumed response is displayed.",
  "use-consumed-response-display-failed": "The consumed response could not be displayed.",
};

const chineseTerminal: TerminalMessages = {
  "content-reconcile-terminal-current-kept": "内容核对已完成。剪贴板已被读取，保留当前内容。",
  "reload-terminal-response-displayed": "重新加载已完成。已显示读取到的响应。",
  "reload-terminal-response-display-failed": "剪贴板已被读取，无法显示响应，保留当前内容。",
  "reload-terminal-current-unchanged": "重新加载已完成。剪贴板已被读取，当前内容未变化。",
  "reload-terminal-current-kept-choice": "重新加载已完成。剪贴板已被读取，保留当前内容，可选择读取到的响应。",
  "use-consumed-response-displayed": "已显示读取到的响应。",
  "use-consumed-response-display-failed": "无法显示读取到的响应。",
};

export interface Dictionary {
  readonly labels: Labels;
  readonly validation: ValidationMessages;
  readonly errors: ErrorMessages;
  readonly help: HelpMessages;
  readonly status: StatusMessages;
  readonly actions: ActionOutcomeMessages;
  readonly terminal: TerminalMessages;
}

export const dictionaries: Record<Locale, Dictionary> = {
  en: {
    labels: englishLabels,
    validation: englishValidation,
    errors: englishErrors,
    help: englishHelp,
    status: englishStatus,
    actions: englishActions,
    terminal: englishTerminal,
  },
  "zh-CN": {
    labels: chineseLabels,
    validation: chineseValidation,
    errors: chineseErrors,
    help: chineseHelp,
    status: chineseStatus,
    actions: chineseActions,
    terminal: chineseTerminal,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertMatchingLeaves(left: unknown, right: unknown, path: string): void {
  const leftRecord = isRecord(left);
  const rightRecord = isRecord(right);
  if (leftRecord !== rightRecord) throw new Error(`dictionary keys do not match at ${path}`);
  if (!leftRecord || !rightRecord) return;

  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const nextPath = path === "" ? key : `${path}.${key}`;
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
      throw new Error(`dictionary keys do not match at ${nextPath}`);
    }
    assertMatchingLeaves(left[key], right[key], nextPath);
  }
}

export function assertDictionaryParity(source: Record<Locale, unknown> = dictionaries): void {
  assertMatchingLeaves(source.en, source["zh-CN"], "");
}

assertDictionaryParity();

export function labels(locale: Locale): Labels {
  return dictionaries[locale].labels;
}

export function normalizeErrorMessageCode(code: string | undefined): ErrorMessageCode {
  return code !== undefined && Object.hasOwn(dictionaries.en.errors, code) ? code as ErrorMessageCode : "UNKNOWN_ERROR";
}

export function errorMessage(locale: Locale, code: string | undefined): string {
  return dictionaries[locale].errors[normalizeErrorMessageCode(code)];
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
