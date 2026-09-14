import { afterEach, describe, expect, it, vi } from "vitest";

import * as app from "./app";
import {
  createHistoryDiff,
  createThemeController,
  formatHistoryDiffLine,
  withPastePassword,
} from "./app";

const browser = app as unknown as {
  createSourceAdapter(source: Pick<HTMLTextAreaElement, "value">): Pick<HTMLTextAreaElement, "value">;
  currentPasteContent(): string | null;
  currentPastePassword(): string | null;
  setPastePassword(password: string | null): void;
  startApp(): void;
};

function sourceFixture(encoded: string) {
  let input: (() => void) | undefined;
  let value = "";
  const source = {
    get value(): string {
      return value;
    },
    set value(next: string) {
      value = next.replace(/\r\n?|\n/g, "\n");
    },
    addEventListener(type: string, listener: () => void): void {
      if (type === "input") input = listener;
    },
    input(): void {
      input?.();
    },
  } as unknown as HTMLTextAreaElement & { input(): void };
  const node = {
    textContent: encoded,
    getAttribute(name: string): string | null {
      return name === "data-source-encoding" ? "utf-8-base64" : null;
    },
    remove: vi.fn(),
  };
  const view = { textContent: "" } as HTMLPreElement;
  const document = {
    querySelector(selector: string): unknown {
      if (selector.includes("source-data")) return node;
      if (selector.includes("source-view")) return view;
      if (selector.includes("#source")) return source;
      return null;
    },
  } as unknown as Document;
  return { document, node, source, view };
}

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
  browser.setPastePassword(null);
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
  it("follows the system theme until a manual override and removes its listener on dispose", () => {
    const root: { dataset: { theme?: string }; style: { colorScheme: string } } = { dataset: {}, style: { colorScheme: "" } };
    const media = themeMedia(true);
    const changes: string[] = [];
    const controller = createThemeController({
      root,
      media: media.media,
      onThemeChange: (theme) => changes.push(theme),
    });

    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(media.listenerCount()).toBe(1);
    media.emit(false);
    expect(root.dataset.theme).toBe("light");

    controller.toggle();
    expect(root.dataset.theme).toBe("dark");
    media.emit(false);
    expect(root.dataset.theme).toBe("dark");
    controller.toggle();
    expect(root.dataset.theme).toBe("light");
    expect(changes).toEqual(["dark", "light", "dark", "light"]);

    controller.dispose();
    expect(media.listenerCount()).toBe(0);
    media.emit(true);
    expect(root.dataset.theme).toBe("light");
  });

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

  it("rewrites passwords with URLSearchParams while preserving fragments and unrelated query values", () => {
    const target = new URL("https://paste.example/raw/example?keep=one&password=old&keep=two&password=other#source");
    const password = "  a+b %&#?  ";
    const withPassword = withPastePassword(target, password);

    expect(withPassword.searchParams.getAll("password")).toEqual([password]);
    expect([...withPassword.searchParams.entries()]).toEqual([
      ["keep", "one"],
      ["keep", "two"],
      ["password", password],
    ]);
    expect(withPassword.hash).toBe("#source");
    expect(target.searchParams.getAll("password")).toEqual(["old", "other"]);

    const cleared = withPastePassword(withPassword, null);
    expect(cleared.searchParams.getAll("password")).toEqual([]);
    expect([...cleared.searchParams.entries()]).toEqual([["keep", "one"], ["keep", "two"]]);
    expect(cleared.hash).toBe("#source");

    const clean = withPastePassword(new URL("https://paste.example/file/example#download"), null);
    expect(clean.search).toBe("");
    expect(clean.hash).toBe("#download");
  });

  it("accepts a startup password only when the query has exactly one value", () => {
    vi.stubGlobal("document", {});
    vi.stubGlobal("location", { href: "https://paste.example/a?password=one&password=two" });

    browser.startApp();

    expect(browser.currentPastePassword()).toBeNull();
  });

  it("keeps password only in the current document and rewrites its unique URL query", () => {
    const replaceState = vi.fn();
    const localStorage = { setItem: vi.fn() };
    const sessionStorage = { setItem: vi.fn() };
    vi.stubGlobal("document", {});
    vi.stubGlobal("location", { href: "https://paste.example/a?keep=yes&password=old+password#source" });
    vi.stubGlobal("history", { state: { current: true }, replaceState });
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("sessionStorage", sessionStorage);

    browser.startApp();
    expect(browser.currentPastePassword()).toBe("old password");

    browser.setPastePassword(" new +%&#? ");
    expect(browser.currentPastePassword()).toBe(" new +%&#? ");
    const withPassword = new URL(String(replaceState.mock.calls[0]![2]));
    expect(withPassword.searchParams.getAll("password")).toEqual([" new +%&#? "]);
    expect(withPassword.searchParams.get("keep")).toBe("yes");
    expect(withPassword.hash).toBe("#source");

    browser.setPastePassword(null);
    const withoutPassword = new URL(String(replaceState.mock.calls[1]![2]));
    expect(withoutPassword.searchParams.has("password")).toBe(false);
    expect(withoutPassword.searchParams.get("keep")).toBe("yes");
    expect(withoutPassword.hash).toBe("#source");
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it("hydrates source into views while retaining exact canonical text", async () => {
    const exact = "\nleading\rstandalone\r\ncrlf\0replacement:� <>&  ﻿ non-BMP:\u{1F642}";
    const { decodeSourceData, encodeSourceData } = await import("../source-data");
    const { document, node, source, view } = sourceFixture(encodeSourceData(exact));
    const autosave = { input: vi.fn() };
    vi.stubGlobal("document", document);
    vi.stubGlobal("location", { href: "https://paste.example/a" });

    browser.startApp();

    expect(view.textContent).toBe(exact);
    expect(source.value).toBe(exact.replace(/\r\n?|\n/g, "\n"));
    expect(browser.currentPasteContent()).toBe(exact);
    expect(node.remove).toHaveBeenCalledOnce();
    expect(autosave.input).not.toHaveBeenCalled();

    const adapter = browser.createSourceAdapter(source);
    const modeSource = adapter.value;
    expect(modeSource).toBe(exact);
    expect(autosave.input).not.toHaveBeenCalled();

    source.value = "textarea\r\ninput";
    source.input();
    expect(browser.currentPasteContent()).toBe("textarea\ninput");

    adapter.value = "programmatic\r\nmode";
    expect(adapter.value).toBe("programmatic\r\nmode");
    expect(source.value).toBe("programmatic\nmode");
    expect(autosave.input).not.toHaveBeenCalled();
    expect(decodeSourceData(node.textContent!)).toBe(exact);
  });

  it.each([
    ["malformed base64", "A=AA"],
    ["malformed UTF-8", "/w=="],
    ["malformed UTF-8 at the maximum encoded length", `/wAA${"AAAA".repeat(3_495_252)}AA==`],
    ["a transport at the maximum encoded length that decodes one byte over the limit", `${"A".repeat(13_981_015)}=`],
  ])("removes %s without replacing document state", (_name, encoded) => {
    const { document, node, source, view } = sourceFixture(encoded);
    vi.stubGlobal("document", document);
    vi.stubGlobal("location", { href: "https://paste.example/a" });
    const adapter = browser.createSourceAdapter(source);
    adapter.value = "existing\r\nsource";
    view.textContent = "existing view";

    browser.startApp();

    expect(adapter.value).toBe("existing\r\nsource");
    expect(source.value).toBe("existing\nsource");
    expect(view.textContent).toBe("existing view");
    expect(node.remove).toHaveBeenCalledOnce();
  });
});
