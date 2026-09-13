import { afterEach, describe, expect, it, vi } from "vitest";

const visual = vi.hoisted(() => {
  interface FakeDoc {
    markdown: string;
    eq(other: FakeDoc): boolean;
  }

  interface FakeEditorView {
    state: { doc: FakeDoc };
  }

  interface FakeDocumentPlugin {
    spec: {
      view?(view: FakeEditorView): { update?(view: FakeEditorView, previous: FakeEditorView["state"]): void };
    };
  }

  const fakeDocument = (markdown: string): FakeDoc => ({
    markdown,
    eq(other) {
      return markdown === other.markdown;
    },
  });

  const state = { failGetMarkdown: false, instances: [] as FakeCrepe[] };

  class FakeCrepe {
    markdown = "";
    getMarkdownCalls = 0;
    private doc = fakeDocument("");
    private documentPlugin: FakeDocumentPlugin | undefined;
    private documentView: ReturnType<NonNullable<FakeDocumentPlugin["spec"]["view"]>> | undefined;
    readonly editor = {
      config: (configure: (ctx: { update(key: unknown, update: (plugins: FakeDocumentPlugin[]) => FakeDocumentPlugin[]): void }) => void): void => {
        configure({
          update: (_key, update) => {
            this.documentPlugin = update([]).at(-1);
          },
        });
      },
    };

    constructor(options: { defaultValue?: string }) {
      this.markdown = options.defaultValue ?? "";
      this.doc = fakeDocument(this.markdown);
      state.instances.push(this);
    }

    async create(): Promise<void> {
      this.documentView = this.documentPlugin?.spec.view?.({ state: { doc: this.doc } });
    }
    async destroy(): Promise<void> {}
    getMarkdown(): string {
      this.getMarkdownCalls += 1;
      if (state.failGetMarkdown) throw new Error("Crepe failed to serialize");
      return this.markdown;
    }

    documentChanged(markdown: string): void {
      const previous = { doc: this.doc };
      this.markdown = markdown;
      this.doc = fakeDocument(markdown);
      this.documentView?.update?.({ state: { doc: this.doc } }, previous);
    }
  }

  return { state, Crepe: FakeCrepe };
});

vi.mock("@milkdown/crepe", () => ({ Crepe: visual.Crepe }));

import * as app from "./app";
import {
  AutosaveController,
  createAutosaveMarkdownModes,
  createHistoryDiff,
  createThemeController,
  formatHistoryDiffLine,
  withPastePassword,
  type AutosaveSaveRequest,
  type AutosaveSaveResult,
  type AutosaveSnapshot,
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

class FakeClock {
  private time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.time;

  setTimer = (callback: () => void, delay: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  };

  clearTimer = (timer: unknown): void => {
    this.timers.delete(timer as number);
  };

  advance(milliseconds: number): void {
    const end = this.time + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.time = timer.at;
      timer.callback();
    }
    this.time = end;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function saveFake() {
  const calls: AutosaveSaveRequest[] = [];
  const pending: Deferred<AutosaveSaveResult>[] = [];
  let active = 0;
  let maxActive = 0;

  return {
    calls,
    pending,
    get active(): number {
      return active;
    },
    get maxActive(): number {
      return maxActive;
    },
    save(request: AutosaveSaveRequest): Promise<AutosaveSaveResult> {
      calls.push(request);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const next = deferred<AutosaveSaveResult>();
      pending.push(next);
      return next.promise.finally(() => {
        active -= 1;
      });
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

function setup(getPassword?: () => string | null) {
  const clock = new FakeClock();
  const save = saveFake();
  const states: AutosaveSnapshot[] = [];
  const controller = new AutosaveController({
    content: "first",
    version: "g.1",
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    save: save.save,
    ...(getPassword === undefined ? {} : { getPassword }),
    onStateChange: (snapshot) => states.push(snapshot),
  });
  return { clock, controller, save, states };
}

function lastState(states: AutosaveSnapshot[]): AutosaveSnapshot {
  const state = states.at(-1);
  if (!state) throw new Error("expected an autosave state");
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
  browser.setPastePassword?.(null);
  visual.state.failGetMarkdown = false;
  visual.state.instances.length = 0;
});

describe("AutosaveController", () => {
  it("replaces the timer and waits exactly 1,000 ms for the latest input", () => {
    const { clock, controller, save } = setup();

    controller.input("second");
    clock.advance(999);
    expect(save.calls).toEqual([]);

    controller.input("third");
    clock.advance(999);
    expect(save.calls).toEqual([]);
    clock.advance(1);
    expect(save.calls).toEqual([{ content: "third", version: "g.1" }]);
  });

  it("suppresses intermediate IME input until 1,000 ms after composition ends", () => {
    const { clock, controller, save } = setup();

    controller.input("pending");
    clock.advance(500);
    controller.compositionStart();
    controller.input("zhong");
    clock.advance(1_000);
    expect(save.calls).toEqual([]);

    controller.compositionEnd("最终");
    clock.advance(999);
    expect(save.calls).toEqual([]);
    clock.advance(1);
    expect(save.calls).toEqual([{ content: "最终", version: "g.1" }]);
  });

  it("reports a composition edit as waiting until its post-composition debounce completes", () => {
    const { clock, controller, save, states } = setup();

    controller.compositionStart();
    controller.input("zhong");
    expect(lastState(states)).toMatchObject({
      state: "waiting",
      draft: "zhong",
      lastSavedContent: "first",
      lastInputAt: null,
      dueAt: null,
      inFlightContent: null,
    });

    clock.advance(500);
    expect(save.calls).toEqual([]);
    controller.compositionEnd("最终");
    clock.advance(999);
    expect(save.calls).toEqual([]);
    clock.advance(1);
    expect(save.calls).toEqual([{ content: "最终", version: "g.1" }]);
  });

  it("keeps one request in flight and coalesces to the latest overdue draft", async () => {
    const { clock, controller, save } = setup();

    controller.input("second");
    clock.advance(1_000);
    controller.input("third");
    clock.advance(1_000);
    expect(save.calls).toEqual([{ content: "second", version: "g.1" }]);
    expect(save.maxActive).toBe(1);

    save.pending[0]!.resolve({ status: 200, changed: true, paste: { version: "g.2" } });
    await settle();
    clock.advance(0);
    expect(save.calls).toEqual([
      { content: "second", version: "g.1" },
      { content: "third", version: "g.2" },
    ]);
    expect(save.maxActive).toBe(1);
  });

  it("avoids client-known no-ops and accepts both changed and server no-op 200 responses", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("first");
    clock.advance(1_000);
    expect(save.calls).toEqual([]);
    expect(lastState(states)).toMatchObject({
      state: "saved",
      draft: "first",
      lastSavedContent: "first",
      version: "g.1",
    });

    controller.input("second");
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 200, changed: false, paste: { version: "g.2" } });
    await settle();
    expect(lastState(states)).toMatchObject({
      state: "saved",
      draft: "second",
      lastSavedContent: "second",
      version: "g.2",
    });
  });

  it.each([413, 422, 500, 503])("preserves the exact draft and confirmed version after HTTP %i", async (status) => {
    const { clock, controller, save, states } = setup();

    controller.input("exact draft\nwith whitespace  ");
    clock.advance(1_000);
    save.pending[0]!.resolve({ status });
    await settle();

    expect(lastState(states)).toMatchObject({
      state: "error",
      failureStatus: status,
      draft: "exact draft\nwith whitespace  ",
      lastSavedContent: "first",
      version: "g.1",
    });
    clock.advance(10_000);
    expect(save.calls).toHaveLength(1);
  });

  it("preserves the exact draft and confirmed version after a network failure", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("exact draft\nwith whitespace  ");
    clock.advance(1_000);
    save.pending[0]!.reject(new TypeError("network"));
    await settle();

    expect(lastState(states)).toMatchObject({
      state: "error",
      failureStatus: null,
      draft: "exact draft\nwith whitespace  ",
      lastSavedContent: "first",
      version: "g.1",
    });
  });

  it("retries a network failure only after an explicit retry", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("exact draft");
    clock.advance(1_000);
    save.pending[0]!.reject(new TypeError("network"));
    await settle();
    controller.retry();
    expect(save.calls).toEqual([
      { content: "exact draft", version: "g.1" },
      { content: "exact draft", version: "g.1" },
    ]);

    save.pending[1]!.resolve({ status: 200, changed: true, paste: { version: "g.2" } });
    await settle();
    expect(lastState(states)).toMatchObject({ state: "saved", draft: "exact draft", lastSavedContent: "exact draft", version: "g.2" });
  });

  it("requires explicit retry after 403 and reads the re-entered password", async () => {
    let password: string | null = "old password";
    const { clock, controller, save, states } = setup(() => password);

    controller.input("exact draft");
    clock.advance(1_000);
    expect(save.calls).toEqual([{ content: "exact draft", version: "g.1", password: "old password" }]);
    save.pending[0]!.resolve({ status: 403 });
    await settle();
    expect(lastState(states)).toMatchObject({
      state: "error",
      failureStatus: 403,
      draft: "exact draft",
      lastSavedContent: "first",
      version: "g.1",
    });

    controller.input("latest draft");
    clock.advance(1_000);
    expect(save.calls).toHaveLength(1);

    password = "new password";
    controller.retry();
    expect(save.calls).toEqual([
      { content: "exact draft", version: "g.1", password: "old password" },
      { content: "latest draft", version: "g.1", password: "new password" },
    ]);
  });

  it("keeps the local draft terminal after 404", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("exact draft");
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 404 });
    await settle();
    controller.input("later local edit");
    controller.retry();
    clock.advance(10_000);

    expect(save.calls).toHaveLength(1);
    expect(lastState(states)).toMatchObject({
      state: "error",
      failureStatus: 404,
      draft: "later local edit",
      lastSavedContent: "first",
      version: "g.1",
    });
  });

  it("enters conflict without changing the draft or confirmed version", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("stale draft");
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 409 });
    await settle();
    controller.input("newer local draft");
    clock.advance(10_000);

    expect(save.calls).toHaveLength(1);
    expect(lastState(states)).toMatchObject({
      state: "conflict",
      failureStatus: 409,
      draft: "newer local draft",
      lastSavedContent: "first",
      version: "g.1",
    });
  });

  it("overwrites a conflict with the latest draft and omits version", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("stale draft");
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 409 });
    await settle();
    controller.input("newer local draft");
    controller.overwrite();
    expect(save.calls).toEqual([
      { content: "stale draft", version: "g.1" },
      { content: "newer local draft" },
    ]);

    save.pending[1]!.resolve({ status: 200, changed: true, paste: { version: "g.3" } });
    await settle();
    expect(lastState(states)).toMatchObject({
      state: "saved",
      draft: "newer local draft",
      lastSavedContent: "newer local draft",
      version: "g.3",
    });
  });

  it("overwrites a conflicted in-flight edit after reverting to confirmed content", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("in-flight draft B");
    clock.advance(1_000);
    controller.input("first");
    save.pending[0]!.resolve({ status: 409 });
    await settle();
    expect(lastState(states)).toMatchObject({
      state: "conflict",
      draft: "first",
      lastSavedContent: "first",
      inFlightContent: null,
    });

    controller.overwrite();

    expect(save.calls).toEqual([
      { content: "in-flight draft B", version: "g.1" },
      { content: "first" },
    ]);
  });

  it("reloads confirmed server content only from an explicit conflict action", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("stale draft");
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 409 });
    await settle();
    controller.reload("server content", "g.9");

    expect(lastState(states)).toMatchObject({
      state: "clean",
      draft: "server content",
      lastSavedContent: "server content",
      version: "g.9",
      inFlightContent: null,
      dirtyWhileSaving: false,
    });
    clock.advance(10_000);
    expect(save.calls).toHaveLength(1);
  });

  it("removes the pending timer and ignores later work after dispose", () => {
    const { clock, controller, save } = setup();

    controller.input("second");
    controller.dispose();
    clock.advance(1_000);
    controller.input("third");
    clock.advance(1_000);

    expect(save.calls).toEqual([]);
  });

  it("registers beforeunload only while dirty or saving", async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("document", {});
    vi.stubGlobal("addEventListener", addEventListener);
    vi.stubGlobal("removeEventListener", removeEventListener);
    const { clock, controller, save } = setup();

    expect(addEventListener).not.toHaveBeenCalled();
    controller.input("second");
    expect(addEventListener).toHaveBeenCalledTimes(1);
    clock.advance(1_000);
    expect(addEventListener).toHaveBeenCalledTimes(1);

    save.pending[0]!.resolve({ status: 200, changed: true, paste: { version: "g.2" } });
    await settle();
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("never exceeds one active request across 200 generated inputs and saves the final draft", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("0");
    clock.advance(1_000);
    for (let index = 1; index < 200; index += 1) {
      controller.input(String(index));
      clock.advance(1);
    }
    expect(save.maxActive).toBe(1);
    expect(save.calls).toHaveLength(1);

    save.pending[0]!.resolve({ status: 200, changed: true, paste: { version: "g.2" } });
    await settle();
    clock.advance(1_000);
    expect(save.calls.at(-1)).toEqual({ content: "199", version: "g.2" });
    expect(save.maxActive).toBe(1);

    save.pending[1]!.resolve({ status: 200, changed: true, paste: { version: "g.3" } });
    await settle();
    expect(save.active).toBe(0);
    expect(lastState(states)).toMatchObject({ state: "saved", draft: "199", lastSavedContent: "199", version: "g.3" });
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

describe("Markdown and history integration", () => {
  it("queues one autosave when a recovered serialization retry succeeds once", async () => {
    const { clock, controller, save } = setup();
    const input = vi.spyOn(controller, "input");
    const source = { value: "first" } as HTMLTextAreaElement;
    const onVisualError = vi.fn();
    const modes = createAutosaveMarkdownModes({
      autosave: controller,
      source,
      visualRoot: { childNodes: [], removeChild: vi.fn() } as unknown as Node,
      onVisualError,
    });

    await modes.enterVisual();
    const editor = visual.state.instances.at(-1)!;
    visual.state.failGetMarkdown = true;
    editor.documentChanged("second");
    const retry = onVisualError.mock.calls[0]![0].retry;

    visual.state.failGetMarkdown = false;
    await retry();

    expect(input).toHaveBeenCalledTimes(1);
    expect(input).toHaveBeenCalledWith("second");
    expect(editor.getMarkdownCalls).toBe(2);
    clock.advance(999);
    expect(save.calls).toEqual([]);

    await retry();

    expect(input).toHaveBeenCalledTimes(1);
    expect(editor.getMarkdownCalls).toBe(2);
    clock.advance(1);
    expect(save.calls).toEqual([{ content: "second", version: "g.1" }]);
    await modes.destroy();
  });

  it("keeps an autosave retry stale after a newer visual transaction succeeds", async () => {
    const { clock, controller, save } = setup();
    const input = vi.spyOn(controller, "input");
    const source = { value: "first" } as HTMLTextAreaElement;
    const onVisualError = vi.fn();
    const modes = createAutosaveMarkdownModes({
      autosave: controller,
      source,
      visualRoot: { childNodes: [], removeChild: vi.fn() } as unknown as Node,
      onVisualError,
    });

    await modes.enterVisual();
    const editor = visual.state.instances.at(-1)!;
    visual.state.failGetMarkdown = true;
    editor.documentChanged("failed");
    const retry = onVisualError.mock.calls[0]![0].retry;

    visual.state.failGetMarkdown = false;
    editor.documentChanged("newer");

    expect(input).toHaveBeenCalledTimes(1);
    expect(input).toHaveBeenCalledWith("newer");
    expect(editor.getMarkdownCalls).toBe(2);
    clock.advance(999);
    expect(save.calls).toEqual([]);

    await retry();

    expect(input).toHaveBeenCalledTimes(1);
    expect(editor.getMarkdownCalls).toBe(2);
    clock.advance(1);
    expect(save.calls).toEqual([{ content: "newer", version: "g.1" }]);
    await modes.destroy();
  });

  it("does not autosave a visual mode switch but saves one serialized document edit after 1,000 ms", () => {
    const { clock, controller, save } = setup();
    visual.state.instances.length = 0;
    const source = { value: "first" } as HTMLTextAreaElement;
    const modes = createAutosaveMarkdownModes({
      autosave: controller,
      source,
      visualRoot: { childNodes: [], removeChild: vi.fn() } as unknown as Node,
    });

    return modes.enterVisual().then(async () => {
      await modes.enterSource();
      clock.advance(1_000);
      expect(save.calls).toEqual([]);

      await modes.enterVisual();
      visual.state.instances.at(-1)!.documentChanged("second");
      clock.advance(999);
      expect(save.calls).toEqual([]);
      clock.advance(1);
      expect(save.calls).toEqual([{ content: "second", version: "g.1" }]);
      await modes.destroy();
    });
  });

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
