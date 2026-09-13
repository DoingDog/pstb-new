import "./styles.css";
import { dictionaries, formatDate, resolveBrowserLocale, type ErrorMessageCode, type LabelKey, type Locale } from "../i18n";
import { decodeSourceData, sourceDataEncoding } from "../source-data";
import { createMarkdownModes, type MarkdownModes, type MarkdownModesOptions } from "./markdown";
import type { DiffId, DiffLine, DiffRequest, DiffResponse } from "./diff";

declare const __DIFF_WORKER_URL__: string;

export interface AutosaveSaveRequest {
  content: string;
  version?: string;
  password?: string;
}

export type AutosaveSaveResult =
  | { status: 200; changed: boolean; paste: { version: string } }
  | { status: number };

export type AutosaveState = "clean" | "waiting" | "saving" | "saved" | "error" | "conflict";

export interface AutosaveSnapshot {
  state: AutosaveState;
  draft: string;
  lastSavedContent: string;
  version: string;
  lastInputAt: number | null;
  dueAt: number | null;
  inFlightContent: string | null;
  dirtyWhileSaving: boolean;
  failureStatus: number | null;
}

export interface AutosaveOptions {
  content: string;
  version: string;
  now: () => number;
  setTimer: (callback: () => void, delay: number) => unknown;
  clearTimer: (timer: unknown) => void;
  save: (request: AutosaveSaveRequest) => Promise<AutosaveSaveResult>;
  getPassword?: () => string | null;
  onStateChange: (snapshot: AutosaveSnapshot) => void;
}

export class AutosaveController {
  private timer: unknown;
  private state: AutosaveState = "clean";
  private draft: string;
  private lastSavedContent: string;
  private version: string;
  private lastInputAt: number | null = null;
  private dueAt: number | null = null;
  private inFlightContent: string | null = null;
  private dirtyWhileSaving = false;
  private failureStatus: number | null = null;
  private composing = false;
  private disposed = false;
  private unloadRegistered = false;

  constructor(private readonly options: AutosaveOptions) {
    this.draft = options.content;
    this.lastSavedContent = options.content;
    this.version = options.version;
    this.emit();
  }

  input(content: string): void {
    if (this.disposed) return;

    this.draft = content;
    if (this.composing) {
      if (this.inFlightContent !== null) this.dirtyWhileSaving = true;
      else if (this.draft !== this.lastSavedContent && (this.state === "clean" || this.state === "saved")) this.state = "waiting";
      this.emit();
      return;
    }

    this.lastInputAt = this.options.now();
    this.dueAt = this.lastInputAt + 1_000;
    if (this.inFlightContent !== null) {
      this.dirtyWhileSaving = true;
      this.emit();
      return;
    }
    if (this.state === "conflict" || this.failureStatus === 403 || this.failureStatus === 404) {
      this.emit();
      return;
    }

    this.failureStatus = null;
    this.state = "waiting";
    this.schedule();
    this.emit();
  }

  compositionStart(): void {
    if (this.disposed) return;
    this.composing = true;
    this.cancelTimer();
    this.emit();
  }

  compositionEnd(content: string): void {
    if (this.disposed) return;
    this.composing = false;
    this.input(content);
  }

  retry(): void {
    if (
      this.disposed ||
      this.composing ||
      this.state !== "error" ||
      this.failureStatus === 404 ||
      this.inFlightContent !== null ||
      this.draft === this.lastSavedContent
    ) {
      return;
    }
    this.cancelTimer();
    this.dueAt = null;
    this.startSave(false);
  }

  overwrite(): void {
    if (
      this.disposed ||
      this.composing ||
      this.state !== "conflict" ||
      this.inFlightContent !== null
    ) {
      return;
    }
    this.cancelTimer();
    this.dueAt = null;
    this.startSave(true);
  }

  reload(content: string, version: string): void {
    if (this.disposed || this.state !== "conflict" || this.inFlightContent !== null) return;

    this.cancelTimer();
    this.draft = content;
    this.lastSavedContent = content;
    this.version = version;
    this.lastInputAt = null;
    this.dueAt = null;
    this.dirtyWhileSaving = false;
    this.failureStatus = null;
    this.state = "clean";
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer();
    this.removeBeforeUnloadWarning();
  }

  private schedule(): void {
    if (this.disposed || this.composing || this.state === "conflict" || this.failureStatus === 403 || this.failureStatus === 404) {
      return;
    }

    this.cancelTimer();
    if (this.dueAt === null) return;

    let timer: unknown;
    timer = this.options.setTimer(() => {
      if (this.disposed || this.timer !== timer) return;
      this.timer = undefined;
      this.dueAt = null;
      this.startSave(false);
    }, Math.max(0, this.dueAt - this.options.now()));
    this.timer = timer;
  }

  private startSave(omitVersion: boolean): void {
    if (
      this.disposed ||
      this.composing ||
      this.inFlightContent !== null ||
      (!omitVersion && this.state === "conflict") ||
      this.failureStatus === 404
    ) {
      return;
    }
    if (!omitVersion && this.draft === this.lastSavedContent) {
      this.dueAt = null;
      this.dirtyWhileSaving = false;
      this.state = "saved";
      this.emit();
      return;
    }

    const content = this.draft;
    this.inFlightContent = content;
    this.dirtyWhileSaving = false;
    this.dueAt = null;
    this.failureStatus = null;
    this.state = "saving";
    this.emit();

    const password = this.options.getPassword?.() ?? null;
    const request: AutosaveSaveRequest = omitVersion
      ? { content, ...(password === null ? {} : { password }) }
      : { content, version: this.version, ...(password === null ? {} : { password }) };

    void this.options.save(request).then(
      (result) => this.completeSave(content, result),
      () => this.failSave(content, null),
    );
  }

  private completeSave(content: string, result: AutosaveSaveResult): void {
    if (this.disposed || this.inFlightContent !== content) return;
    if (result.status !== 200 || !("paste" in result)) {
      this.failSave(content, result.status);
      return;
    }

    this.lastSavedContent = content;
    this.version = result.paste.version;
    this.inFlightContent = null;
    this.dirtyWhileSaving = false;
    this.failureStatus = null;
    if (this.draft === this.lastSavedContent) {
      this.cancelTimer();
      this.dueAt = null;
      this.state = "saved";
    } else {
      this.state = "waiting";
      this.schedule();
    }
    this.emit();
  }

  private failSave(content: string, status: number | null): void {
    if (this.disposed || this.inFlightContent !== content) return;

    this.inFlightContent = null;
    this.dirtyWhileSaving = false;
    this.cancelTimer();
    this.dueAt = null;
    this.failureStatus = status;
    this.state = status === 409 ? "conflict" : "error";
    this.emit();
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.options.clearTimer(this.timer);
    this.timer = undefined;
  }

  private emit(): void {
    this.updateBeforeUnloadWarning();
    this.options.onStateChange({
      state: this.state,
      draft: this.draft,
      lastSavedContent: this.lastSavedContent,
      version: this.version,
      lastInputAt: this.lastInputAt,
      dueAt: this.dueAt,
      inFlightContent: this.inFlightContent,
      dirtyWhileSaving: this.dirtyWhileSaving,
      failureStatus: this.failureStatus,
    });
  }

  private updateBeforeUnloadWarning(): void {
    if (typeof document === "undefined") return;

    const needed = this.draft !== this.lastSavedContent || this.inFlightContent !== null;
    if (needed && !this.unloadRegistered) {
      globalThis.addEventListener("beforeunload", this.beforeUnload);
      this.unloadRegistered = true;
    } else if (!needed && this.unloadRegistered) {
      this.removeBeforeUnloadWarning();
    }
  }

  private removeBeforeUnloadWarning(): void {
    if (!this.unloadRegistered) return;
    globalThis.removeEventListener("beforeunload", this.beforeUnload);
    this.unloadRegistered = false;
  }

  private readonly beforeUnload = (event: Event): void => {
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = "";
  };
}

export interface AutosaveMarkdownModesOptions extends Omit<MarkdownModesOptions, "onDocumentChange"> {
  autosave: Pick<AutosaveController, "input">;
}

export function createAutosaveMarkdownModes(options: AutosaveMarkdownModesOptions): MarkdownModes {
  const { autosave, ...markdownOptions } = options;
  return createMarkdownModes({
    ...markdownOptions,
    onDocumentChange: (markdown) => autosave.input(markdown),
  });
}

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

interface LocalizedElement {
  textContent: string | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

export interface LocaleDocument {
  documentElement: { lang: string };
  querySelectorAll(selector: string): Iterable<LocalizedElement>;
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
}

const localeDocuments = new WeakSet<Document>();

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

function currentDocumentUrl(): URL | null {
  if (typeof document === "undefined" || typeof location === "undefined") return null;
  return new URL(location.href);
}

export function currentPastePassword(): string | null {
  return pastePassword;
}

export function setPastePassword(password: string | null): void {
  pastePassword = password;
  const url = currentDocumentUrl();
  if (url === null || typeof history === "undefined") return;

  url.searchParams.delete("password");
  if (password !== null) url.searchParams.set("password", password);
  history.replaceState(history.state, "", url.toString());
}

export function startApp(): void {
  initializeDocumentLocale();
  const url = currentDocumentUrl();
  if (url !== null) {
    const passwords = url.searchParams.getAll("password");
    pastePassword = passwords.length === 1 ? passwords[0] ?? null : null;
  }
  hydratePasteSource();
}

if (typeof document !== "undefined") startApp();
