import "./styles.css";
import { dictionaries, formatDate, resolveBrowserLocale, type ErrorMessageCode, type LabelKey, type Locale } from "../i18n";
import { createThemeController, type ResolvedTheme, type ThemeController } from "./theme";

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

function themeLabel(locale: Locale, theme: ResolvedTheme): string {
  return dictionaries[locale].labels[theme === "dark" ? "switchToLightTheme" : "switchToDarkTheme"];
}

function updateThemeControls(root: LocaleDocument, locale: Locale, theme: ResolvedTheme): void {
  const label = themeLabel(locale, theme);
  for (const element of root.querySelectorAll("[data-i18n-theme]")) element.textContent = label;
  for (const element of root.querySelectorAll("[data-theme-control]")) element.setAttribute("aria-label", label);
}

function documentTheme(root: LocaleDocument): ResolvedTheme | undefined {
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
  if (
    typeof document === "undefined" ||
    document.documentElement === undefined ||
    themeDocuments.has(document) ||
    typeof globalThis.matchMedia !== "function"
  ) return;

  const controller = createThemeController(
    document.documentElement,
    globalThis.matchMedia("(prefers-color-scheme: dark)"),
    (theme) => updateThemeControls(document, document.documentElement.lang === "zh-CN" ? "zh-CN" : "en", theme),
  );
  for (const control of document.querySelectorAll('[data-action="theme"]')) {
    control.addEventListener("click", () => controller.setPreference(controller.snapshot().resolved === "dark" ? "light" : "dark"));
  }
  themeDocuments.set(document, controller);
}

export function startApp(): void {
  initializeDocumentLocale();
  initializeDocumentTheme();
}

if (typeof document !== "undefined") startApp();
