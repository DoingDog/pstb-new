import "./styles.css";
import { dictionaries, formatDate, resolveBrowserLocale, type ErrorMessageCode, type LabelKey, type Locale } from "../i18n";
import { decodeSourceData, sourceDataEncoding } from "../source-data";
import type { DiffId, DiffLine, DiffRequest, DiffResponse } from "./diff";

declare const __DIFF_WORKER_URL__: string;

export const AUTOMATIC_DIFF_MAX_BYTES = 1_048_576;
export const AUTOMATIC_DIFF_MAX_LINES = 50_000;

export function formatHistoryDiffLine(line: DiffLine): string {
  return `${line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}${line.text}`;
}

interface DiffWorker {
  postMessage(message: DiffRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

interface SelectedDiff {
  revision: DiffId;
  previous: string;
  current: string;
}

export interface HistoryDiffOptions {
  onLines(lines: DiffLine[]): void;
  onError?(message: string): void;
  createWorker?(): DiffWorker;
}

export interface HistoryDiffController {
  selectRevision(revision: DiffId, previous: string, current: string): "automatic" | "manual";
  computeDiff(): boolean;
  clearSelection(): void;
  destroy(): void;
}

function automaticDiffAllowed(previous: string, current: string): boolean {
  const encoder = new TextEncoder();
  return (
    encoder.encode(previous).byteLength <= AUTOMATIC_DIFF_MAX_BYTES &&
    encoder.encode(current).byteLength <= AUTOMATIC_DIFF_MAX_BYTES &&
    lineCount(previous) <= AUTOMATIC_DIFF_MAX_LINES &&
    lineCount(current) <= AUTOMATIC_DIFF_MAX_LINES
  );
}

function lineCount(source: string): number {
  if (source === "") return 0;
  let newlines = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") newlines += 1;
  }
  return source.endsWith("\n") ? newlines : newlines + 1;
}

function defaultDiffWorker(): DiffWorker {
  return new Worker(__DIFF_WORKER_URL__, { type: "module" });
}

function isDiffResponse(value: unknown): value is DiffResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as { type?: unknown; id?: unknown; lines?: unknown; message?: unknown };
  if (typeof response.id !== "string" && typeof response.id !== "number") return false;
  if (response.type === "result") return Array.isArray(response.lines);
  return response.type === "error" && typeof response.message === "string";
}

export function createHistoryDiff(options: HistoryDiffOptions): HistoryDiffController {
  let worker: DiffWorker | undefined;
  let selected: SelectedDiff | undefined;
  let latestId = 0;

  const startDiff = (): boolean => {
    if (selected === undefined) return false;

    if (worker === undefined) {
      try {
        worker = (options.createWorker ?? defaultDiffWorker)();
        worker.onmessage = (event) => {
          if (!isDiffResponse(event.data) || event.data.id !== latestId) return;
          if (event.data.type === "result") options.onLines(event.data.lines);
          else options.onError?.(event.data.message);
        };
        worker.onerror = () => options.onError?.("Unable to calculate diff");
      } catch (error) {
        options.onError?.(error instanceof Error ? error.message : "Unable to calculate diff");
        return false;
      }
    }

    latestId += 1;
    worker.postMessage({ type: "diff", id: latestId, previous: selected.previous, current: selected.current });
    return true;
  };

  return {
    selectRevision(revision, previous, current) {
      selected = { revision, previous, current };
      if (automaticDiffAllowed(previous, current)) {
        startDiff();
        return "automatic";
      }
      latestId += 1;
      return "manual";
    },
    computeDiff: startDiff,
    clearSelection() {
      selected = undefined;
      latestId += 1;
    },
    destroy() {
      selected = undefined;
      latestId += 1;
      worker?.terminate();
      worker = undefined;
    },
  };
}

let pastePassword: string | null = null;
let pasteContent: string | null = null;

export interface SourceAdapter {
  value: string;
}

export function currentPasteContent(): string | null {
  return pasteContent;
}

export function createSourceAdapter(source: Pick<HTMLTextAreaElement, "value">): SourceAdapter {
  return {
    get value(): string {
      return pasteContent ?? source.value;
    },
    set value(content: string) {
      pasteContent = content;
      source.value = content;
    },
  };
}

function hydratePasteSource(): void {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return;

  const transport = document.querySelector<HTMLScriptElement>("script#source-data[data-source-encoding]");
  if (transport === null || transport.getAttribute("data-source-encoding") !== sourceDataEncoding) return;

  let content: string;
  try {
    content = decodeSourceData(transport.textContent ?? "");
  } catch {
    transport.remove();
    return;
  }

  pasteContent = content;
  const sourceView = document.querySelector<HTMLPreElement>("pre[data-source-view]");
  if (sourceView !== null) sourceView.textContent = content;
  const source = document.querySelector<HTMLTextAreaElement>("textarea#source");
  if (source !== null) {
    source.value = content;
    source.addEventListener("input", () => {
      pasteContent = source.value;
    });
  }
  transport.remove();
}

export type Theme = "light" | "dark";

export interface ThemeRoot {
  dataset: { theme?: string };
  style: { colorScheme: string };
}

export interface ThemeMediaQueryList {
  readonly matches: boolean;
  addEventListener?(type: "change", listener: (event: { matches: boolean }) => void): void;
  removeEventListener?(type: "change", listener: (event: { matches: boolean }) => void): void;
  addListener?(listener: (event: { matches: boolean }) => void): void;
  removeListener?(listener: (event: { matches: boolean }) => void): void;
}

export interface ThemeController {
  readonly theme: Theme;
  toggle(): void;
  dispose(): void;
}

export interface ThemeControllerOptions {
  root: ThemeRoot;
  media: ThemeMediaQueryList;
  onThemeChange?(theme: Theme): void;
}

export function createThemeController(options: ThemeControllerOptions): ThemeController {
  let theme: Theme = options.media.matches ? "dark" : "light";
  let override: Theme | undefined;
  let disposed = false;
  let removeListener: (() => void) | undefined;

  const apply = (next: Theme): void => {
    theme = next;
    options.root.dataset.theme = next;
    options.root.style.colorScheme = next;
    options.onThemeChange?.(next);
  };
  const change = (event: { matches: boolean }): void => {
    if (disposed || override !== undefined) return;
    apply(event.matches ? "dark" : "light");
  };

  if (options.media.addEventListener !== undefined) {
    options.media.addEventListener("change", change);
    removeListener = () => options.media.removeEventListener?.("change", change);
  } else if (options.media.addListener !== undefined) {
    options.media.addListener(change);
    removeListener = () => options.media.removeListener?.(change);
  }
  apply(theme);

  return {
    get theme(): Theme {
      return theme;
    },
    toggle(): void {
      if (disposed) return;
      override = theme === "dark" ? "light" : "dark";
      apply(override);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      removeListener?.();
      removeListener = undefined;
    },
  };
}

interface LocalizedElement {
  textContent: string | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

export interface LocaleDocument {
  documentElement: { lang: string; dataset?: { theme?: string } };
  title: string;
  querySelectorAll(selector: string): Iterable<LocalizedElement>;
}

function themeLabel(locale: Locale, theme: Theme): string {
  return dictionaries[locale].labels[theme === "dark" ? "switchToLightTheme" : "switchToDarkTheme"];
}

function updateThemeControls(root: LocaleDocument, locale: Locale, theme: Theme): void {
  const label = themeLabel(locale, theme);
  for (const element of root.querySelectorAll("[data-i18n-theme]")) element.textContent = label;
  for (const element of root.querySelectorAll("[data-theme-control]")) element.setAttribute("aria-label", label);
}

function documentTheme(root: LocaleDocument): Theme | undefined {
  const theme = root.documentElement.dataset?.theme;
  return theme === "light" || theme === "dark" ? theme : undefined;
}

function isLabelKey(value: string | null): value is LabelKey {
  return value !== null && Object.hasOwn(dictionaries.en.labels, value);
}

function isErrorMessageCode(value: string | null): value is ErrorMessageCode {
  return value !== null && Object.hasOwn(dictionaries.en.errors, value);
}

export function updateDocumentLocale(root: LocaleDocument, locale: Locale): void {
  const dictionary = dictionaries[locale];
  root.documentElement.lang = locale;

  for (const element of root.querySelectorAll("[data-i18n-title]")) {
    const key = element.getAttribute("data-i18n-title");
    if (!isLabelKey(key)) continue;
    const suffix = element.getAttribute("data-i18n-title-suffix");
    root.title = `${dictionary.labels[key]}${suffix === null ? "" : ` ${suffix}`}`;
  }
  for (const element of root.querySelectorAll("[data-i18n]")) {
    const key = element.getAttribute("data-i18n");
    if (isLabelKey(key)) element.textContent = dictionary.labels[key];
  }
  for (const element of root.querySelectorAll("[data-i18n-aria-label]")) {
    const key = element.getAttribute("data-i18n-aria-label");
    if (isLabelKey(key)) element.setAttribute("aria-label", dictionary.labels[key]);
  }
  for (const element of root.querySelectorAll("time[data-i18n-date]")) {
    const datetime = element.getAttribute("datetime");
    if (datetime !== null) element.textContent = formatDate(locale, datetime);
  }
  for (const element of root.querySelectorAll("[data-i18n-error]")) {
    const code = element.getAttribute("data-i18n-error");
    if (isErrorMessageCode(code)) element.textContent = dictionary.errors[code];
  }
  const theme = documentTheme(root);
  if (theme !== undefined) updateThemeControls(root, locale, theme);
}

const localeDocuments = new WeakSet<Document>();
const themeDocuments = new WeakMap<Document, ThemeController>();

function initializeDocumentLocale(): void {
  if (typeof document === "undefined" || document.documentElement === undefined || localeDocuments.has(document)) return;
  updateDocumentLocale(document, resolveBrowserLocale(typeof navigator === "undefined" ? undefined : navigator.languages, document.documentElement.lang));

  for (const control of document.querySelectorAll('[data-action="locale"]')) {
    control.addEventListener("click", () => {
      updateDocumentLocale(document, document.documentElement.lang === "zh-CN" ? "en" : "zh-CN");
    });
  }
  localeDocuments.add(document);
}

function initializeDocumentTheme(): void {
  if (typeof document === "undefined" || document.documentElement === undefined || themeDocuments.has(document)) return;

  const media: ThemeMediaQueryList = typeof globalThis.matchMedia === "function"
    ? globalThis.matchMedia("(prefers-color-scheme: dark)")
    : { matches: false };
  const controller = createThemeController({
    root: document.documentElement,
    media,
    onThemeChange: (theme) => updateThemeControls(document, document.documentElement.lang === "zh-CN" ? "zh-CN" : "en", theme),
  });
  for (const control of document.querySelectorAll('[data-action="theme"]')) {
    control.addEventListener("click", () => controller.toggle());
  }
  themeDocuments.set(document, controller);
}

function currentDocumentUrl(): URL | null {
  if (typeof document === "undefined" || typeof location === "undefined") return null;
  return new URL(location.href);
}

export function withPastePassword(target: URL, password: string | null): URL {
  const url = new URL(target.href);
  url.searchParams.delete("password");
  if (password !== null) url.searchParams.append("password", password);
  return url;
}

export function currentPastePassword(): string | null {
  return pastePassword;
}

export function setPastePassword(password: string | null): void {
  pastePassword = password;
  const target = currentDocumentUrl();
  if (target === null || typeof history === "undefined") return;

  history.replaceState(history.state, "", withPastePassword(target, password).toString());
}

export function startApp(): void {
  initializeDocumentLocale();
  initializeDocumentTheme();
  const url = currentDocumentUrl();
  if (url !== null) {
    const passwords = url.searchParams.getAll("password");
    pastePassword = passwords.length === 1 ? passwords[0] ?? null : null;
  }
  hydratePasteSource();
}

if (typeof document !== "undefined") startApp();
