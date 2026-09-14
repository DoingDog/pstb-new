import { afterEach, describe, expect, it, vi } from "vitest";

import * as app from "./app";
import { createHistoryDiff, formatHistoryDiffLine } from "./app";

const browser = app;

function localeFixture() {
  const element = (attributes: Record<string, string>, textContent: string) => {
    const values = new Map(Object.entries(attributes));
    const listeners: Array<() => void> = [];
    return {
      textContent,
      getAttribute(name: string): string | null {
        return values.get(name) ?? null;
      },
      setAttribute(name: string, value: string): void {
        values.set(name, value);
      },
      addEventListener(type: string, listener: () => void): void {
        if (type === "click") listeners.push(listener);
      },
      click(): void {
        for (const listener of listeners) listener();
      },
      listenerCount(): number {
        return listeners.length;
      },
    };
  };
  const create = element({ "data-i18n": "create" }, "Create a paste");
  const status = element({ "data-i18n": "saved" }, "Saved");
  const accessible = element({ "data-i18n-aria-label": "application", "aria-label": "Application" }, "");
  const date = element({ datetime: "2026-09-14T00:00:00.000Z", "data-i18n-date": "" }, "2026-09-14T00:00:00.000Z");
  const error = element({ "data-i18n-error": "METHOD_NOT_ALLOWED" }, "Method not allowed");
  const title = element({ "data-i18n-title": "create" }, "Create a paste");
  const locale = element({ "data-action": "locale" }, "Language");
  const theme = element({ "data-action": "theme", "data-theme-control": "", "aria-label": "Theme follows system. Switch theme." }, "");
  const themeText = element({ "data-i18n-theme": "" }, "Theme follows system. Switch theme.");
  const document = {
    documentElement: { lang: "en", dataset: {}, style: { colorScheme: "" } },
    title: "Create a paste",
    querySelector(): null {
      return null;
    },
    querySelectorAll(selector: string): unknown[] {
      if (selector === "[data-i18n]") return [create, status];
      if (selector === "[data-i18n-aria-label]") return [accessible];
      if (selector === "time[data-i18n-date]") return [date];
      if (selector === "[data-i18n-error]") return [error];
      if (selector === "[data-i18n-title]") return [title];
      if (selector === '[data-action="locale"]') return [locale];
      if (selector === '[data-action="theme"]') return [theme];
      if (selector === "[data-theme-control]") return [theme];
      if (selector === "[data-i18n-theme]") return [themeText];
      return [];
    },
  } as unknown as Document;
  return { accessible, create, date, document, error, locale, status, theme, themeText, title };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function themeMedia(initial: boolean) {
  let matches = initial;
  const listeners: Array<(event: { matches: boolean }) => void> = [];
  return {
    media: {
      get matches(): boolean {
        return matches;
      },
      addEventListener(_type: string, listener: (event: { matches: boolean }) => void): void {
        listeners.push(listener);
      },
      removeEventListener(_type: string, listener: (event: { matches: boolean }) => void): void {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    },
    emit(next: boolean): void {
      matches = next;
      for (const listener of [...listeners]) listener({ matches });
    },
    listenerCount(): number {
      return listeners.length;
    },
  };
}

describe("history diff", () => {
  it("formats diff prefixes as text without constructing HTML", () => {
    expect(formatHistoryDiffLine({ kind: "same", text: "unchanged\n" })).toBe(" unchanged\n");
    expect(formatHistoryDiffLine({ kind: "delete", text: "<script>old</script>\n" })).toBe("-<script>old</script>\n");
    expect(formatHistoryDiffLine({ kind: "add", text: "<img src=x>\n" })).toBe("+<img src=x>\n");
  });

  it("creates the diff worker only for a selected revision and ignores stale text responses", () => {
    const workers: Array<{
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
      onmessage: ((event: MessageEvent<unknown>) => void) | null;
      onerror: ((event: ErrorEvent) => void) | null;
    }> = [];
    const onLines = vi.fn();
    const history = createHistoryDiff({
      createWorker: () => {
        const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null };
        workers.push(worker);
        return worker;
      },
      onLines,
    });

    expect(history.selectRevision("1", "a\nb\n", "a\nc\n")).toBe("automatic");
    expect(workers).toHaveLength(1);
    expect(history.selectRevision("2", "old\n", "<img src=x>\n")).toBe("automatic");

    workers[0]!.onmessage?.({
      data: { type: "result", id: 1, lines: [{ kind: "same", text: "stale\n" }] },
    } as MessageEvent<unknown>);
    expect(onLines).not.toHaveBeenCalled();

    workers[0]!.onmessage?.({
      data: { type: "result", id: 2, lines: [{ kind: "add", text: "<img src=x>\n" }] },
    } as MessageEvent<unknown>);
    expect(onLines).toHaveBeenCalledWith([{ kind: "add", text: "<img src=x>\n" }]);

    history.destroy();
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("requires explicit diff calculation when either side exceeds the automatic policy", () => {
    const createWorker = vi.fn();
    const history = createHistoryDiff({ createWorker, onLines: vi.fn() });

    expect(history.selectRevision("1", "x".repeat(1_048_577), "current")).toBe("manual");
    expect(createWorker).not.toHaveBeenCalled();
  });
});

describe("browser document state", () => {
  it("corrects the server locale, updates current copy, and installs one locale toggle", () => {
    const fixture = localeFixture();
    vi.stubGlobal("document", fixture.document);
    vi.stubGlobal("navigator", { languages: ["zh-Hans", "en-US"] });
    vi.stubGlobal("location", { href: "https://paste.example/a" });

    browser.startApp();

    expect(fixture.document.documentElement.lang).toBe("zh-CN");
    expect(fixture.document.title).toBe("创建剪贴板");
    expect(fixture.create.textContent).toBe("创建剪贴板");
    expect(fixture.status.textContent).toBe("已保存");
    expect(fixture.accessible.getAttribute("aria-label")).toBe("应用");
    expect(fixture.error.textContent).toBe("请求方法不被允许。请返回创建页面。");
    expect(fixture.date.getAttribute("datetime")).toBe("2026-09-14T00:00:00.000Z");
    expect(fixture.date.textContent).toBe(new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date("2026-09-14T00:00:00.000Z")));

    browser.startApp();
    expect(fixture.locale.listenerCount()).toBe(1);
    fixture.locale.click();

    expect(fixture.document.documentElement.lang).toBe("en");
    expect(fixture.document.title).toBe("Create a paste");
    expect(fixture.create.textContent).toBe("Create a paste");
    expect(fixture.status.textContent).toBe("Saved");
    expect(fixture.accessible.getAttribute("aria-label")).toBe("Application");
    expect(fixture.error.textContent).toBe("Method not allowed. Return to the create page.");

    browser.startApp();
    expect(fixture.document.documentElement.lang).toBe("en");
    expect(fixture.locale.listenerCount()).toBe(1);
  });

  it("installs one theme control that follows system changes until its manual override", () => {
    const fixture = localeFixture();
    const media = themeMedia(true);
    vi.stubGlobal("document", fixture.document);
    vi.stubGlobal("navigator", { languages: ["en-US"] });
    vi.stubGlobal("location", { href: "https://paste.example/a" });
    vi.stubGlobal("matchMedia", vi.fn(() => media.media));

    browser.startApp();
    browser.startApp();

    expect(fixture.document.documentElement.dataset.theme).toBe("dark");
    expect(fixture.document.documentElement.style.colorScheme).toBe("dark");
    expect(fixture.themeText.textContent).toBe("Switch to light theme. Current theme: dark.");
    expect(fixture.theme.getAttribute("aria-label")).toBe("Switch to light theme. Current theme: dark.");
    expect(fixture.theme.listenerCount()).toBe(1);
    expect(media.listenerCount()).toBe(1);

    media.emit(false);
    expect(fixture.document.documentElement.dataset.theme).toBe("light");
    expect(fixture.themeText.textContent).toBe("Switch to dark theme. Current theme: light.");

    fixture.theme.click();
    expect(fixture.document.documentElement.dataset.theme).toBe("dark");
    media.emit(false);
    expect(fixture.document.documentElement.dataset.theme).toBe("dark");

    fixture.locale.click();
    expect(fixture.themeText.textContent).toBe("切换为浅色主题。当前主题：深色。");
    expect(fixture.theme.getAttribute("aria-label")).toBe("切换为浅色主题。当前主题：深色。");
  });

  it("rebuilds an untitled paste document title from its translation key and ID", () => {
    const title = {
      textContent: "Paste example",
      getAttribute(name: string): string | null {
        return name === "data-i18n-title" ? "paste" : name === "data-i18n-title-suffix" ? "example" : null;
      },
      setAttribute(): void {},
    };
    const document = {
      documentElement: { lang: "en" },
      title: "Paste example",
      querySelectorAll(selector: string) {
        return selector === "[data-i18n-title]" ? [title] : [];
      },
    };

    app.updateDocumentLocale(document, "zh-CN");

    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.title).toBe("剪贴板 example");
  });

});
