import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { act, StrictMode, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { InitialPage } from "./bootstrap";

const stagedMarkdown = vi.hoisted(() => ({
  prepareMarkdownPreview: vi.fn(async (source: string) => ({ source, html: `<p>${source}</p>` })),
  prepareMarkdownVisual: vi.fn(async (value: string) => {
    const root = document.createElement("div");
    const source = { value };
    return {
      root,
      source,
      modes: {
        enterSource: async () => undefined,
        enterVisual: async () => undefined,
        enterPreview: async () => undefined,
        leaveVisual: async () => undefined,
        destroy: async () => undefined,
      },
      bind: () => undefined,
      dispose: async () => undefined,
    };
  }),
}));

vi.mock("./markdown", async (importOriginal) => ({
  ...await importOriginal<typeof import("./markdown")>(),
  ...stagedMarkdown,
}));

import { App } from "./App";
import { usePastePage, type UsePastePageResult } from "./hooks/use-paste-page";
import "./index.css";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pages: ReadonlyArray<readonly [string, InitialPage]> = [
  ["shape failure", { ok: false, locale: "en", errorCode: "INTERNAL_ERROR" }],
  ["create", { ok: true, bootstrap: { page: "create", locale: "en" }, password: null }],
  ["password", { ok: true, bootstrap: { page: "password", locale: "en", errorCode: null }, password: null }],
  ["error", { ok: true, bootstrap: { page: "error", locale: "en", status: 500, errorCode: "INTERNAL_ERROR" }, password: null }],
  [
    "paste",
    {
      ok: true,
      bootstrap: { page: "paste", locale: "en", consumed: true, hasInitialMarkdownPreview: false },
      exactSource: "",
      initialMarkdown: null,
      password: null,
    },
  ],
  [
    "markdown",
    {
      ok: true,
      bootstrap: { page: "markdown", locale: "en", id: "example", title: "Example", hasInitialMarkdownPreview: true },
      exactSource: "",
      initialMarkdown: null,
      password: null,
    },
  ],
];

const mounted: Array<{ root: Root; element: HTMLDivElement }> = [];
let consoleErrors: Array<unknown[]> = [];

beforeEach(() => {
  consoleErrors = vi.spyOn(console, "error").mock.calls;
});

async function mount(node: ReactNode): Promise<HTMLDivElement> {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  act(() => {
    root.render(node);
  });
  await act(async () => {
    await vi.dynamicImportSettled();
    await Promise.resolve();
  });
  mounted.push({ root, element });
  return element;
}

function milliseconds(value: string): number {
  return Math.max(...value.split(",").map((duration) => {
    const numeric = Number.parseFloat(duration);
    return duration.trim().endsWith("ms") ? numeric : numeric * 1_000;
  }));
}

function element(selector: string): HTMLElement {
  const value = document.querySelector<HTMLElement>(selector);
  expect(value).not.toBeNull();
  return value!;
}

function expectNoMotion(value: HTMLElement): void {
  const style = getComputedStyle(value);
  expect(milliseconds(style.transitionDuration)).toBe(0);
  expect(milliseconds(style.transitionDelay)).toBe(0);
  expect(milliseconds(style.animationDuration)).toBe(0);
  expect(milliseconds(style.animationDelay)).toBe(0);
}

function expectAllowedMotion(value: HTMLElement): void {
  const style = getComputedStyle(value);
  expect(milliseconds(style.transitionDuration)).toBeLessThanOrEqual(120);
  expect(milliseconds(style.transitionDelay)).toBe(0);
  expect(milliseconds(style.animationDuration)).toBeLessThanOrEqual(120);
  expect(milliseconds(style.animationDelay)).toBe(0);
  expect(style.getPropertyValue("--tw-duration").trim()).toBe("120ms");
}

function MotionFixture() {
  return (
    <>
      <App initialPage={pages[1]![1]} />
      <Sheet open>
        <SheetContent showCloseButton={false}>
          <SheetTitle>Sheet</SheetTitle>
        </SheetContent>
      </Sheet>
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Dialog</DialogTitle>
        </DialogContent>
      </Dialog>
    </>
  );
}

afterEach(async () => {
  for (const value of mounted.splice(0)) {
    act(() => value.root.unmount());
    value.element.remove();
  }
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await page.viewport(1280, 720);
  const actWarnings = consoleErrors.filter(
    ([message]) => typeof message === "string" && message.includes("not wrapped in act"),
  );
  vi.restoreAllMocks();
  expect(actWarnings).toHaveLength(0);
});

describe("App landmarks", () => {
  it.each(pages)("renders one main landmark and one heading for %s", async (_name, initialPage) => {
    const rendered = await mount(<App initialPage={initialPage} />);

    expect(rendered.querySelectorAll("main")).toHaveLength(1);
    expect(rendered.querySelectorAll("h1")).toHaveLength(1);
  });
});

describe("application motion", () => {
  it("keeps the sidebar trigger at least 44 CSS pixels at a 320 CSS pixel viewport", async () => {
    await page.viewport(320, 720);
    const rendered = await mount(<App initialPage={pages[1]![1]} />);
    const trigger = rendered.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]');
    expect(trigger).not.toBeNull();

    const style = getComputedStyle(trigger!);
    expect(Number.parseFloat(style.width)).toBeGreaterThanOrEqual(44);
    expect(Number.parseFloat(style.height)).toBeGreaterThanOrEqual(44);
  });

  it("removes motion from the non-authorized sidebar trigger", async () => {
    await mount(<MotionFixture />);

    expectNoMotion(element('[data-slot="sidebar-trigger"]'));
  });

  it("caps Sheet motion at 120 milliseconds", async () => {
    await mount(<MotionFixture />);

    expectAllowedMotion(element('[data-slot="sheet-content"]'));
  });

  it("caps Dialog motion at 120 milliseconds", async () => {
    await mount(<MotionFixture />);

    expectAllowedMotion(element('[data-slot="dialog-content"]'));
  });

  it("removes all allowed motion when reduced motion is requested", async () => {
    await mount(<MotionFixture />);
    await act(async () => {
      await cdp().send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expectNoMotion(element('[data-slot="sidebar-trigger"]'));
    expectNoMotion(element('[data-slot="sheet-content"]'));
    expectNoMotion(element('[data-slot="dialog-content"]'));
  });
});

function ordinaryInitialPage(source = "initial", password: string | null = null): InitialPage {
  return {
    ok: true,
    bootstrap: {
      page: "paste",
      locale: "en",
      consumed: false,
      paste: {
        id: "example",
        title: "Example",
        format: "text",
        viewOnce: false,
        protected: false,
        createdAt: "2026-09-15T00:00:00.000Z",
        updatedAt: "2026-09-15T00:00:00.000Z",
        expiresAt: null,
        expiration: { kind: "permanent" },
        version: "generation.1",
        contentRevision: 1,
        contentBytes: source.length,
        createdCountry: null,
        links: { view: "/example", raw: "/raw/example", html: "/html/example", markdown: "/md/example", file: "/file/example" },
      },
    },
    exactSource: source,
    initialMarkdown: null,
    password,
  };
}

describe("Task 15 lifecycle integration", () => {
  it("mounts every branch", async () => {
    const cases: ReadonlyArray<readonly [InitialPage, string]> = [
      [pages[0]![1], '[role="alert"]'],
      [pages[1]![1], "#create-content"],
      [pages[2]![1], "#password"],
      [pages[3]![1], '[role="alert"]'],
      [pages[4]![1], "[data-local-view]"],
      [pages[5]![1], "h2"],
      [ordinaryInitialPage(), "[data-ordinary-paste-page]"],
    ];
    for (const [initialPage, selector] of cases) {
      const rendered = await mount(<App initialPage={initialPage} />);
      await vi.waitFor(() => {
        if (rendered.querySelector(selector) === null) throw new Error(`Missing ${selector}`);
      });
    }
  });

  it("no immediate GET", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mount(<App initialPage={ordinaryInitialPage("exact")} />);
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(rendered.querySelector("[data-ordinary-paste-page]")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_999); });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});

type ResourceOptions = Partial<{
  title: string;
  format: "text" | "markdown";
  viewOnce: boolean;
  protected: boolean;
  version: string;
  contentRevision: number;
  updatedAt: string;
}>;

function resourceBody(source: string, options: ResourceOptions = {}) {
  return {
    id: "example",
    title: options.title ?? "Example",
    format: options.format ?? "text",
    viewOnce: options.viewOnce ?? false,
    protected: options.protected ?? false,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-09-15T00:00:00.000Z",
    expiresAt: null,
    expiration: { kind: "permanent" },
    version: options.version ?? "generation.1",
    contentRevision: options.contentRevision ?? 1,
    contentBytes: new TextEncoder().encode(source).byteLength,
    createdCountry: null,
    links: { view: "/example", raw: "/raw/example", html: "/html/example", markdown: "/md/example", file: "/file/example" },
  };
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function errorResponse(status: number, code: string, mutationMayHaveApplied = false): Response {
  return jsonResponse({ error: { code, message: code, details: { mutationMayHaveApplied } } }, status);
}

function uncertainWriteResponse(status = 503): Response {
  return jsonResponse({ error: { code: "STORAGE_WRITE_FAILED", message: "STORAGE_WRITE_FAILED", details: {} } }, status);
}

async function resourceResponse(source: string, options: ResourceOptions = {}): Promise<Response> {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...resourceBody(source, options), content: source }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const encoded = btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return new Response(bytes, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-length": String(bytes.byteLength),
      "content-type": "application/json; charset=utf-8",
      etag: `"sha256-${encoded}"`,
    },
  });
}

function mutationResponse(source: string, options: ResourceOptions = {}): Response {
  const paste = resourceBody(source, options);
  return jsonResponse({ changed: true, paste }, 200, { etag: `"${paste.version}"` });
}

async function mountOrdinary(source = "initial", password: string | null = null): Promise<HTMLDivElement> {
  const rendered = await mount(<App initialPage={ordinaryInitialPage(source, password)} />);
  await act(async () => { await vi.dynamicImportSettled(); });
  await vi.waitFor(() => {
    if (rendered.querySelector("[data-ordinary-paste-page]") === null) throw new Error("ordinary page did not mount");
  });
  const locale = rendered.querySelector("#document-locale") as unknown as HTMLSelectElement | null;
  if (locale?.value !== "en") {
    await act(async () => {
      locale!.value = "en";
      locale!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
  }
  return rendered;
}

function button(root: any, label: string, occurrence = 0): HTMLButtonElement {
  const matches = Array.from(root.querySelectorAll("button") as ArrayLike<HTMLButtonElement>).filter((value) => value.textContent?.trim() === label);
  expect(matches.length).toBeGreaterThan(occurrence);
  return matches[occurrence]!;
}

function settingsButton(root: { querySelector(selector: string): unknown }, field: string): HTMLButtonElement {
  const value = root.querySelector(`button[data-settings-field="${field}"]`);
  if (!(value instanceof HTMLButtonElement)) throw new Error(`Missing settings ${field} button`);
  return value;
}

function settingsSelect(root: { querySelector(selector: string): unknown }): HTMLSelectElement {
  const value = root.querySelector('select[name="format"]');
  if (!(value instanceof HTMLSelectElement)) throw new Error("Missing format select");
  return value;
}

async function clickButton(root: any, label: string, occurrence = 0): Promise<void> {
  await act(async () => {
    button(root, label, occurrence).click();
    await vi.dynamicImportSettled();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function selectTab(root: any, label: string): Promise<void> {
  await act(async () => {
    button(root, label).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    await vi.dynamicImportSettled();
    await Promise.resolve();
  });
}

async function setInput(root: any, selector: string, value: string): Promise<void> {
  const input = root.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
  expect(input).not.toBeNull();
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  expect(setter).toBeDefined();
  await act(async () => {
    setter!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function setChecked(root: any, selector: string, checked: boolean): Promise<void> {
  const input = root.querySelector(selector) as HTMLInputElement | null;
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
  expect(setter).toBeDefined();
  await act(async () => {
    setter!.call(input, checked);
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

function unmount(rendered: HTMLDivElement): void {
  const index = mounted.findIndex((value) => value.element === rendered);
  expect(index).toBeGreaterThanOrEqual(0);
  const [entry] = mounted.splice(index, 1);
  act(() => entry!.root.unmount());
  entry!.element.remove();
}

afterEach(() => {
  vi.restoreAllMocks();
  stagedMarkdown.prepareMarkdownPreview.mockReset();
  stagedMarkdown.prepareMarkdownPreview.mockImplementation(async (source: string) => ({ source, html: `<p>${source}</p>` }));
  stagedMarkdown.prepareMarkdownVisual.mockReset();
  stagedMarkdown.prepareMarkdownVisual.mockImplementation(async (value: string) => {
    const root = document.createElement("div");
    const source = { value };
    return {
      root,
      source,
      modes: {
        enterSource: async () => undefined,
        enterVisual: async () => undefined,
        enterPreview: async () => undefined,
        leaveVisual: async () => undefined,
        destroy: async () => undefined,
      },
      bind: () => undefined,
      dispose: async () => undefined,
    };
  });
  vi.unstubAllGlobals();
  vi.useRealTimers();
  history.replaceState(null, "", "/");
});

describe("Task 15 async lifecycle behavior", () => {
  it("keeps locale and theme names accessible without visible header labels", async () => {
    const rendered = await mount(<App initialPage={pages[1]![1]} />);
    for (const [id, names] of [["document-locale", ["Language", "语言"]], ["document-theme", ["Theme", "主题"]]] as const) {
      const select = rendered.querySelector(`#${id}`)!;
      const label = rendered.querySelector<HTMLLabelElement>(`label[for="${id}"]`)!;
      expect(label.control).toBe(select);
      expect(names).toContain(label.querySelector("span")?.textContent);
      expect(label.querySelector("span")!.getBoundingClientRect().width).toBeLessThanOrEqual(1);
    }
  });

  it("settles a create attempt in OperationStatus", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(500, "INTERNAL_ERROR")));
    const rendered = await mount(<App initialPage={pages[1]![1]} />);

    await setInput(rendered, "#create-content", "draft");
    await act(async () => {
      const submit = rendered.querySelector<HTMLButtonElement>('button[data-action="create"]');
      expect(submit).not.toBeNull();
      submit!.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(rendered.querySelector('[data-operation-record="last-action"] time')).not.toBeNull());
  });
  it("settles a history-list attempt in OperationStatus", async () => {
    let page: UsePastePageResult | null = null;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      id: "example",
      currentRevision: 1,
      currentVersion: "generation.1",
      revisions: [],
    }, 200, { etag: '"generation.1"' })));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.openHistory();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "succeeded", key: "history-list" });
  });

  it("settles a history-snapshot attempt in OperationStatus", async () => {
    let page: UsePastePageResult | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/history/1")
        ? jsonResponse({ id: "example", revision: 1, savedAt: "2026-09-15T00:00:00.000Z", supersededAt: "2026-09-16T00:00:00.000Z", byteLength: 4, content: "past" }, 200, { etag: '"generation.1"' })
        : jsonResponse({ id: "example", currentRevision: 1, currentVersion: "generation.1", revisions: [{ revision: 1, savedAt: "2026-09-15T00:00:00.000Z", supersededAt: "2026-09-16T00:00:00.000Z", byteLength: 4 }] }, 200, { etag: '"generation.1"' })
    )));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.openHistory();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      page!.actions.selectRevision(1);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "succeeded", key: "history-snapshot" });
  });

  it("announces History loading through Last action and diff computation in its detail", async () => {
    let resolveList!: (response: Response) => void;
    let resolveSnapshot!: (response: Response) => void;
    const list = new Promise<Response>((resolve) => { resolveList = resolve; });
    const snapshot = new Promise<Response>((resolve) => { resolveSnapshot = resolve; });
    const workers: Array<{ postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; onmessage: ((event: MessageEvent<unknown>) => void) | null; onerror: ((event: ErrorEvent) => void) | null }> = [];
    vi.stubGlobal("Worker", class {
      postMessage = vi.fn();
      terminate = vi.fn();
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor() { workers.push(this); }
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => (
      String(input).endsWith("/history/1") ? snapshot : list
    )));
    const rendered = await mountOrdinary();
    const liveRegions = () => rendered.querySelectorAll('[role="status"], [aria-live="polite"]');

    await selectTab(rendered, "History");
    await vi.waitFor(() => expect(rendered.textContent).toContain("Loading history"));
    expect(liveRegions()).toHaveLength(1);

    await act(async () => {
      resolveList(jsonResponse({ id: "example", currentRevision: 1, currentVersion: "generation.1", revisions: [{ revision: 1, savedAt: "2026-09-15T00:00:00.000Z", supersededAt: "2026-09-16T00:00:00.000Z", byteLength: 4 }] }, 200, { etag: '"generation.1"' }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(button(rendered, "Revision 1")).toBeDefined());
    await clickButton(rendered, "Revision 1");
    await vi.waitFor(() => expect(rendered.textContent).toContain("Loading revision"));
    expect(liveRegions()).toHaveLength(1);

    await act(async () => {
      resolveSnapshot(jsonResponse({ id: "example", revision: 1, savedAt: "2026-09-15T00:00:00.000Z", supersededAt: "2026-09-16T00:00:00.000Z", byteLength: 4, content: "past" }, 200, { etag: '"generation.1"' }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    expect(rendered.querySelector("[data-history-detail] [role=status]")?.textContent).toContain("Compute diff");
    expect(liveRegions()).toHaveLength(2);
  });

  it("updates the selected History diff current side for local and accepted remote source changes", async () => {
    let page: UsePastePageResult | null = null;
    const workers: Array<{ postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; onmessage: ((event: MessageEvent<unknown>) => void) | null; onerror: ((event: ErrorEvent) => void) | null }> = [];
    vi.stubGlobal("Worker", class {
      postMessage = vi.fn();
      terminate = vi.fn();
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor() { workers.push(this); }
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/history/1")
        ? jsonResponse({ id: "example", revision: 1, savedAt: "2026-09-15T00:00:00.000Z", supersededAt: "2026-09-16T00:00:00.000Z", byteLength: 4, content: "past" }, 200, { etag: '"generation.1"' })
        : resourceResponse("remote", { version: "generation.1", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" })
    )));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("diff", true);
      page!.actions.selectRevision(1);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.postMessage).toHaveBeenLastCalledWith({ type: "diff", id: 1, previous: "past", current: "initial" });

    await act(async () => {
      page!.actions.sourceEvent({ type: "input", content: "local draft", eventAt: 1 });
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    expect(workers[0]!.postMessage).toHaveBeenLastCalledWith({ type: "diff", id: 3, previous: "past", current: "local draft" });

    await act(async () => {
      page!.actions.reload();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(workers[0]!.postMessage).toHaveBeenLastCalledWith({ type: "diff", id: 4, previous: "past", current: "remote" }));
    await act(async () => {
      workers[0]!.onmessage?.({ data: { type: "result", id: 4, lines: [{ kind: "add", text: "remote" }] } } as MessageEvent<unknown>);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.source).toBe("remote");
    expect(page!.snapshot.history.diff).toEqual({ state: "ready", lines: [{ kind: "add", text: "remote" }] });
  });

  it("uses the Reload source when an unmounted History diff later mounts", async () => {
    let page: UsePastePageResult | null = null;
    const workers: Array<{ postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; onmessage: ((event: MessageEvent<unknown>) => void) | null; onerror: ((event: ErrorEvent) => void) | null }> = [];
    vi.stubGlobal("Worker", class {
      postMessage = vi.fn();
      terminate = vi.fn();
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor() { workers.push(this); }
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/history/1")) return jsonResponse({ id: "example", revision: 1, savedAt: "2026-09-15T00:00:00.000Z", supersededAt: "2026-09-16T00:00:00.000Z", byteLength: 4, content: "past" }, 200, { etag: '"generation.1"' });
      if (url.endsWith("/history")) return jsonResponse({ id: "example", currentRevision: 1, currentVersion: "generation.1", revisions: [{ revision: 1, savedAt: "2026-09-15T00:00:00.000Z", supersededAt: "2026-09-16T00:00:00.000Z", byteLength: 4 }] }, 200, { etag: '"generation.1"' });
      return resourceResponse("remote", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" });
    }));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.openHistory();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      page!.actions.selectRevision(1);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      page!.actions.reload();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.source).toBe("remote");
    expect(workers).toHaveLength(0);

    await act(async () => {
      page!.actions.setSurfaceMounted("diff", true);
      await Promise.resolve();
    });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.postMessage).toHaveBeenLastCalledWith({ type: "diff", id: 1, previous: "past", current: "remote" });
  });

  it("uses the Reload source when manually computing an oversized History diff", async () => {
    let page: UsePastePageResult | null = null;
    const remote = "x".repeat(1_048_577);
    const workers: Array<{ postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; onmessage: ((event: MessageEvent<unknown>) => void) | null; onerror: ((event: ErrorEvent) => void) | null }> = [];
    vi.stubGlobal("Worker", class {
      postMessage = vi.fn();
      terminate = vi.fn();
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor() { workers.push(this); }
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/history/1")) return jsonResponse({ id: "example", revision: 1, savedAt: "2026-09-15T00:00:00.000Z", supersededAt: "2026-09-16T00:00:00.000Z", byteLength: 4, content: "past" }, 200, { etag: '"generation.1"' });
      if (url.endsWith("/history")) return jsonResponse({ id: "example", currentRevision: 1, currentVersion: "generation.1", revisions: [{ revision: 1, savedAt: "2026-09-15T00:00:00.000Z", supersededAt: "2026-09-16T00:00:00.000Z", byteLength: 4 }] }, 200, { etag: '"generation.1"' });
      return resourceResponse(remote, { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" });
    }));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("diff", true);
      page!.actions.openHistory();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      page!.actions.selectRevision(1);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      page!.actions.reload();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.history.diff).toEqual({ state: "manual", lines: [] });

    await act(async () => {
      page!.actions.computeDiff();
      await Promise.resolve();
    });
    expect(workers[0]!.postMessage).toHaveBeenLastCalledWith({ type: "diff", id: expect.any(Number), previous: "past", current: remote });
  });

  it("keeps the Reload source through a failed staged History diff and Retry", async () => {
    let page: UsePastePageResult | null = null;
    const workers: Array<{ postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; onmessage: ((event: MessageEvent<unknown>) => void) | null; onerror: ((event: ErrorEvent) => void) | null }> = [];
    vi.stubGlobal("Worker", class {
      postMessage = vi.fn();
      terminate = vi.fn();
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor() { workers.push(this); }
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/history/1")) return jsonResponse({ id: "example", revision: 1, savedAt: "2026-09-15T00:00:00.000Z", supersededAt: "2026-09-16T00:00:00.000Z", byteLength: 4, content: "past" }, 200, { etag: '"generation.1"' });
      if (url.endsWith("/history")) return jsonResponse({ id: "example", currentRevision: 1, currentVersion: "generation.1", revisions: [{ revision: 1, savedAt: "2026-09-15T00:00:00.000Z", supersededAt: "2026-09-16T00:00:00.000Z", byteLength: 4 }] }, 200, { etag: '"generation.1"' });
      return resourceResponse("remote", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" });
    }));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("diff", true);
      page!.actions.openHistory();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      page!.actions.selectRevision(1);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      page!.actions.reload();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    const staged = workers[0]!.postMessage.mock.calls.at(-1)![0] as { id: number; current: string };
    expect(staged.current).toBe("remote");

    await act(async () => {
      workers[0]!.onerror?.(new ErrorEvent("error"));
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });

    await act(async () => {
      page!.actions.retryDiff();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    const retry = workers[0]!.postMessage.mock.calls.at(-1)![0] as { id: number; current: string };
    expect(retry.current).toBe("remote");
    await act(async () => {
      workers[0]!.onmessage?.({ data: { type: "result", id: retry.id, lines: [{ kind: "add", text: "remote" }] } } as MessageEvent<unknown>);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.history.diff).toEqual({ state: "ready", lines: [{ kind: "add", text: "remote" }] });
  });

  it("resumes active Autosync three seconds after a dirty Reload commits content", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => resourceResponse("remote", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" }));
    vi.stubGlobal("fetch", fetchMock);

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.sourceEvent({ type: "input", content: "draft", eventAt: 0 });
      page!.actions.reload();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(2_999); });
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toHaveLength(2);
  });

  it("does not restart inactive Autosync after a dirty Reload commits content", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => resourceResponse("remote", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" }));
    vi.stubGlobal("fetch", fetchMock);

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.sourceEvent({ type: "input", content: "draft", eventAt: 0 });
      await vi.advanceTimersByTimeAsync(300_001);
    });
    expect(page!.snapshot.records.autosync.state).toBe("inactive");

    await act(async () => {
      page!.actions.reload();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toHaveLength(1);
  });

  it("keeps Settings and Password dirty after Reload until both owners settle", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => resourceResponse("remote", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" }));
    vi.stubGlobal("fetch", fetchMock);

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.sourceEvent({ type: "input", content: "draft", eventAt: 0 });
      page!.actions.draftState("settings", true, 0);
      page!.actions.draftState("password", true, 0);
      page!.actions.reload();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toHaveLength(1);

    await act(async () => {
      page!.actions.draftState("settings", false);
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toHaveLength(1);

    await act(async () => {
      page!.actions.draftState("password", false);
      await vi.advanceTimersByTimeAsync(2_999);
    });
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toHaveLength(2);
  });

  it("keeps Autosync paused until Settings and Password drafts both exactly revert", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => resourceResponse("initial"));
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");

    await setInput(rendered, 'input[name="title"]', "Changed");
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Paused for local changes");

    await setInput(rendered, 'input[name="newPassword"]', "replacement");
    await setInput(rendered, 'input[name="title"]', "Example");
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Paused for local changes");

    await setInput(rendered, 'input[name="newPassword"]', "");
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Waiting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_999);
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps a Password draft dirty after Settings accepts its exact submitted value", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mutationResponse("initial", { title: "Updated", version: "generation.2" })));
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");
    await setInput(rendered, 'input[name="title"]', "Updated");
    await setInput(rendered, 'input[name="newPassword"]', "replacement");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(rendered.querySelector('[data-settings-action-result="succeeded"]')).not.toBeNull());

    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Paused for local changes");
    await setInput(rendered, 'input[name="newPassword"]', "");
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Waiting");
  });

  it("clears the Settings draft owner after successful reconciliation so Autosync resumes", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return uncertainWriteResponse();
      return jsonResponse(resourceBody("initial", { title: "Reconciled title", version: "generation.2" }), 200, { etag: '"generation.2"' });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");

    await setInput(rendered, 'input[name="title"]', "Reconciled title");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(rendered.querySelector('[data-settings-result="reconciliation-required"]')).not.toBeNull());
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Paused for local changes");

    await clickButton(rendered, "Reconcile");
    await vi.waitFor(() => expect(button(rendered, "Settings reconciled")).toBeDefined());
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Waiting");

    const reads = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== "PATCH").length;
    expect(reads()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(reads()).toBe(2);
  });

  it.each(["Copy", "Download"] as const)("settles the originating Reconcile button and Settings draft after %s replaces Last action", async (localAction) => {
    let resolveReconcile: ((response: Response) => void) | undefined;
    vi.spyOn(document, "execCommand").mockReturnValue(true);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return Promise.resolve(uncertainWriteResponse());
      return new Promise<Response>((resolve) => { resolveReconcile = resolve; });
    }));
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");
    await setInput(rendered, 'input[name="title"]', "Reconciled title");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(button(rendered, "Reconcile")).toBeDefined());

    const reconcile = button(rendered, "Reconcile");
    await act(async () => {
      reconcile.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(reconcile.textContent).toBe("Reconciling settings"));
    await clickButton(rendered, localAction);
    await vi.waitFor(() => expect(rendered.querySelector('[data-operation-record="last-action"]')?.textContent).toContain(localAction === "Copy" ? "Copied" : "Download ready"));
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Paused for local changes");

    await act(async () => {
      resolveReconcile!(jsonResponse(resourceBody("initial", { title: "Reconciled title", version: "generation.2" }), 200, { etag: '"generation.2"' }));
      for (let step = 0; step < 30; step += 1) await Promise.resolve();
    });

    await vi.waitFor(() => expect(reconcile.textContent).toBe("Settings reconciled"));
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Waiting");
  });

  it("releases Settings after a relative expiration retry fails and is discarded", async () => {
    let writes = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") return jsonResponse(resourceBody("initial", { version: "generation.2" }), 200, { etag: '"generation.2"' });
      writes += 1;
      return uncertainWriteResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");
    const expiration = rendered.querySelector('select[name="expiration"]') as unknown as HTMLSelectElement;
    await act(async () => {
      expiration.value = "60";
      expiration.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await clickButton(rendered, "Save expiration");
    await vi.waitFor(() => expect(rendered.querySelector('[data-settings-result="reconciliation-required"]')).not.toBeNull());
    await act(async () => {
      rendered.querySelector<HTMLButtonElement>('button[data-settings-recovery-action="settings-reconcile"]')!.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(writes).toBe(2));
    await vi.waitFor(() => expect(rendered.querySelector('[data-settings-result="reconciliation-required"]')).not.toBeNull());
    await clickButton(rendered, "Discard");

    expect(settingsButton(rendered, "expiration").disabled).toBe(false);
    expect(settingsButton(rendered, "title").disabled).toBe(false);
    expect(expiration.value).toBe("permanent");
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Waiting");
  });

  it("removes a failed Reconcile Retry after Settings Discard", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "PATCH" ? uncertainWriteResponse() : errorResponse(500, "INTERNAL_ERROR")
    ));
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");
    await setInput(rendered, 'input[name="title"]', "Unsaved title");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(button(rendered, "Reconcile")).toBeDefined());
    await clickButton(rendered, "Reconcile");
    await vi.waitFor(() => expect(button(rendered, "Settings reconcile failed")).toBeDefined());
    await clickButton(rendered, "Discard");

    expect((rendered.querySelector('input[name="title"]') as HTMLInputElement).value).toBe("Example");
    expect(settingsButton(rendered, "title").disabled).toBe(false);
    expect(rendered.querySelector('[data-settings-result="retryable"]')).toBeNull();
    expect(rendered.querySelector('button[data-settings-recovery-action="settings-title"]')).toBeNull();
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Waiting");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["Copy", "Download"] as const)("saves a new Settings field after Reconcile succeeds and %s replaces Last action", async (localAction) => {
    let writes = 0;
    let resolveSave!: (response: Response) => void;
    const delayedSave = new Promise<Response>((resolve) => { resolveSave = resolve; });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") return jsonResponse(resourceBody("initial", { title: "Reconciled title", version: "generation.2" }), 200, { etag: '"generation.2"' });
      writes += 1;
      return writes === 1 ? uncertainWriteResponse() : delayedSave;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(document, "execCommand").mockReturnValue(true);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");
    await setInput(rendered, 'input[name="title"]', "Reconciled title");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(button(rendered, "Reconcile")).toBeDefined());
    await clickButton(rendered, "Reconcile");
    await vi.waitFor(() => expect(button(rendered, "Settings reconciled")).toBeDefined());
    await clickButton(rendered, localAction);
    await vi.waitFor(() => expect(rendered.querySelector('[data-operation-record="last-action"]')?.textContent).toContain(localAction === "Copy" ? "Copied" : "Download ready"));

    const format = settingsSelect(rendered);
    await act(async () => {
      format.value = "markdown";
      format.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Paused for local changes");
    await clickButton(rendered, "Save format");
    await vi.waitFor(() => expect(writes).toBe(2));
    expect(settingsButton(rendered, "format").dataset.settingsActionResult).toBe("pending");
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Paused for local changes");
    await act(async () => {
      resolveSave(mutationResponse("initial", { title: "Reconciled title", format: "markdown", version: "generation.3" }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(settingsButton(rendered, "format").dataset.settingsActionResult).toBe("succeeded"));
    expect(JSON.parse(String(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")[1]?.[1]?.body))).toMatchObject({ format: "markdown", version: "generation.2" });
    expect(button(rendered, "Settings reconciled")).toBeDefined();
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Waiting");
    expect(rendered.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });

  it("retains settled Settings outcomes through Settings, View, Settings", async () => {
    let writes = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") return resourceResponse("initial");
      writes += 1;
      return writes === 1
        ? mutationResponse("initial", { title: "Updated", version: "generation.2" })
        : mutationResponse("initial", { title: "Updated", format: "markdown", version: "generation.3" });
    }));
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");

    await setInput(rendered, 'input[name="title"]', "Updated");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(settingsButton(rendered, "title").dataset.settingsActionResult).toBe("succeeded"));

    const format = settingsSelect(rendered);
    await act(async () => {
      format.value = "markdown";
      format.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await clickButton(rendered, "Save format");
    await vi.waitFor(() => expect(settingsButton(rendered, "format").dataset.settingsActionResult).toBe("succeeded"));

    await selectTab(rendered, "View");
    await selectTab(rendered, "Settings");

    expect(settingsButton(rendered, "title").dataset.settingsActionResult).toBe("succeeded");
    expect(settingsButton(rendered, "title").textContent).toContain("Title saved");
    expect(settingsButton(rendered, "format").dataset.settingsActionResult).toBe("succeeded");
    expect(settingsButton(rendered, "format").textContent).toContain("Format saved");
  });

  it("keeps a Password draft dirty after Settings Discard clears only Settings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => uncertainWriteResponse()));
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");
    await setInput(rendered, 'input[name="title"]', "Changed");
    await setInput(rendered, 'input[name="newPassword"]', "replacement");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(rendered.querySelector('[data-settings-result="reconciliation-required"]')).not.toBeNull());
    await clickButton(rendered, "Discard");

    expect((rendered.querySelector('input[name="title"]') as HTMLInputElement).value).toBe("Example");
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Paused for local changes");
    await setInput(rendered, 'input[name="newPassword"]', "");
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Waiting");
  });

  it("settles a Reload attempt in OperationStatus", async () => {
    let page: UsePastePageResult | null = null;
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("remote", {
      version: "generation.2",
      contentRevision: 2,
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.reload();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "succeeded", key: "reload-server" });
  });

  it.each(["Copy", "Download"] as const)("commits Reload and settles its originating button after %s replaces Last action", async (localAction) => {
    let resolveReload: ((response: Response) => void) | undefined;
    vi.spyOn(document, "execCommand").mockReturnValue(true);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return Promise.resolve(errorResponse(409, "VERSION_CONFLICT"));
      return new Promise<Response>((resolve) => { resolveReload = resolve; });
    }));
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");
    await setInput(rendered, 'input[name="title"]', "Local title");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(button(rendered, "Reload")).toBeDefined());

    const reload = button(rendered, "Reload");
    await clickButton(rendered, "Reload");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]");
    expect(dialog).not.toBeNull();
    await clickButton(dialog!, "Reload");
    await vi.waitFor(() => expect(reload.textContent).toBe("Reloading"));
    await clickButton(rendered, localAction);
    await vi.waitFor(() => expect(rendered.querySelector('[data-operation-record="last-action"]')?.textContent).toContain(localAction === "Copy" ? "Copied" : "Download ready"));

    await act(async () => {
      resolveReload!(await resourceResponse("remote", { title: "Server title", version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" }));
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(reload.textContent).toBe("Reloaded"));
    expect(settingsButton(rendered, "title").disabled).toBe(false);
    expect((rendered.querySelector('input[name="title"]') as HTMLInputElement).value).toBe("Local title");
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Paused for local changes");
    await setInput(rendered, 'input[name="title"]', "Server title");
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Waiting");
    await selectTab(rendered, "Edit");
    await vi.waitFor(() => expect(rendered.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("remote"));
  });

  it.each(["Copy", "Download"] as const)("saves a new Settings title after Reload succeeds and %s replaces Last action", async (localAction) => {
    let writes = 0;
    let resolveSave!: (response: Response) => void;
    const delayedSave = new Promise<Response>((resolve) => { resolveSave = resolve; });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") return resourceResponse("remote", { title: "Server title", version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" });
      writes += 1;
      return writes === 1 ? errorResponse(409, "VERSION_CONFLICT") : delayedSave;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(document, "execCommand").mockReturnValue(true);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");
    await setInput(rendered, 'input[name="title"]', "Local title");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(button(rendered, "Reload")).toBeDefined());
    await clickButton(rendered, "Reload");
    await clickButton(document.querySelector<HTMLElement>("[role=dialog]")!, "Reload");
    await vi.waitFor(() => expect(button(rendered, "Reloaded")).toBeDefined());
    await clickButton(rendered, localAction);
    await vi.waitFor(() => expect(rendered.querySelector('[data-operation-record="last-action"]')?.textContent).toContain(localAction === "Copy" ? "Copied" : "Download ready"));

    await setInput(rendered, 'input[name="title"]', "Next title");
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Paused for local changes");
    await act(async () => {
      settingsButton(rendered, "title").click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(writes).toBe(2));
    expect(settingsButton(rendered, "title").dataset.settingsActionResult).toBe("pending");
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Paused for local changes");
    await act(async () => {
      resolveSave(mutationResponse("remote", { title: "Next title", version: "generation.3", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(settingsButton(rendered, "title").dataset.settingsActionResult).toBe("succeeded"));
    expect(JSON.parse(String(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")[1]?.[1]?.body))).toMatchObject({ title: "Next title", version: "generation.2" });
    expect(button(rendered, "Reloaded")).toBeDefined();
    expect(rendered.querySelector('[data-operation-record="autosync"]')?.textContent).toContain("Waiting");
    expect(rendered.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });

  it("does not let an older staged Reload settle a newer Reload attempt", async () => {
    let page: UsePastePageResult | null = null;
    let resolvePreview: ((value: unknown) => void) | undefined;
    const preview = new Promise<unknown>((resolve) => { resolvePreview = resolve; });
    stagedMarkdown.prepareMarkdownPreview.mockImplementationOnce(() => preview as never);
    let read = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      read += 1;
      return read === 1
        ? resourceResponse("older", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" })
        : new Promise<Response>(() => {});
    }));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("preview", true);
      page!.actions.reload();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(stagedMarkdown.prepareMarkdownPreview).toHaveBeenCalledOnce());

    await act(async () => {
      page!.actions.reload();
      resolvePreview!({ source: "older", html: "<p>older</p>" });
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });

    expect(page!.snapshot.settings.result).toMatchObject({ state: "pending", action: "reload-server", attempt: 2 });
    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "pending", key: "reload-server", attempt: 2 });
  });

  it("commits a newer Reload while an older Preview stage never settles", async () => {
    let page: UsePastePageResult | null = null;
    stagedMarkdown.prepareMarkdownPreview.mockImplementationOnce(() => new Promise<never>(() => {}));
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      reads += 1;
      return resourceResponse(reads === 1 ? "older" : "newer", {
        version: reads === 1 ? "generation.2" : "generation.3",
        contentRevision: reads === 1 ? 2 : 3,
        updatedAt: reads === 1 ? "2026-09-16T00:00:00.000Z" : "2026-09-17T00:00:00.000Z",
      });
    }));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("preview", true);
      page!.actions.reload();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(stagedMarkdown.prepareMarkdownPreview).toHaveBeenCalledOnce());

    await act(async () => {
      page!.actions.reload();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(reads).toBe(2));
    await vi.waitFor(() => expect(page!.snapshot.records.lastAction).toMatchObject({ key: "reload-server", state: "succeeded", attempt: 2 }));
    expect(page!.snapshot.source).toBe("newer");
    expect(page!.snapshot.derivedPreview?.source).toBe("newer");
    expect(stagedMarkdown.prepareMarkdownPreview).toHaveBeenCalledTimes(2);
  });

  it("aborts the older Reload GET when a newer Reload starts", async () => {
    let page: UsePastePageResult | null = null;
    let firstSignal: AbortSignal | undefined;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      reads += 1;
      if (reads === 2) return resourceResponse("newer", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" });
      firstSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        firstSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.reload();
      page!.actions.reload();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    expect(firstSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(page!.snapshot.records.lastAction).toMatchObject({ key: "reload-server", state: "succeeded", attempt: 2 }));
    expect(page!.snapshot.source).toBe("newer");
  });

  it("settles Reload only after its staged surface commits", async () => {
    let page: UsePastePageResult | null = null;
    let resolvePreview: ((value: unknown) => void) | undefined;
    const preview = new Promise<unknown>((resolve) => { resolvePreview = resolve; });
    stagedMarkdown.prepareMarkdownPreview.mockImplementationOnce(() => preview as never);
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("remote", {
      version: "generation.2",
      contentRevision: 2,
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("preview", true);
      page!.actions.reload();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(stagedMarkdown.prepareMarkdownPreview).toHaveBeenCalledOnce());
    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "pending", key: "reload-server" });

    await act(async () => {
      page!.actions.sourceEvent({ type: "input", content: "local draft", eventAt: 1 });
      resolvePreview!({ source: "remote", html: "<p>remote</p>" });
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "failed", key: "reload-server" });
    expect(page!.snapshot.candidate).toBeNull();
  });

  it("does not reopen the active deadline when programmatic draft settlement has no DOM timestamp", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.draftState("settings", true, 0);
      await vi.advanceTimersByTimeAsync(299_999);
      page!.actions.draftState("settings", false);
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(page!.snapshot.records.autosync.state).toBe("inactive");
  });

  it("settles Retry sync when its legal due is armed", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(403, "FORBIDDEN")));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.candidate).toEqual({ kind: "forbidden", source: "" });

    await act(async () => {
      page!.actions.retrySync("credential");
      await Promise.resolve();
    });

    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "succeeded", key: "retry-sync" });
  });

  it("does not let stale Retry sync create an action without a current candidate", async () => {
    let page: UsePastePageResult | null = null;

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
      page!.actions.retrySync(null);
      await Promise.resolve();
    });

    expect(page!.snapshot.records.lastAction).toEqual({ state: "idle" });
  });

  it("hands a settled Reload record to the terminal handoff", async () => {
    let page: UsePastePageResult | null = null;
    let terminal: unknown = null;
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("consumed", {
      viewOnce: true,
      version: "generation.2",
      contentRevision: 2,
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0], { onTerminal: (handoff) => { terminal = handoff; } });
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.reload();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });

    expect(terminal).toMatchObject({
      page: { phase: "consumed", source: "consumed", currentSource: "initial", responseSource: "consumed", choiceAvailable: false },
      records: { lastAction: { state: "succeeded", key: "reload-server", outcomeKey: "reload-terminal-response-displayed" } },
    });
  });

  it("keeps current when a mounted Preview cannot stage a newer consumed Reload response", async () => {
    let page: UsePastePageResult | null = null;
    let terminal: unknown = null;
    stagedMarkdown.prepareMarkdownPreview.mockRejectedValueOnce(new Error("preview unavailable"));
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("consumed", {
      viewOnce: true,
      version: "generation.2",
      contentRevision: 2,
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0], { onTerminal: (handoff) => { terminal = handoff; } });
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("preview", true);
      page!.actions.reload();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });

    expect(stagedMarkdown.prepareMarkdownPreview).not.toHaveBeenCalled();
    expect(terminal).toMatchObject({
      page: { phase: "consumed", source: "initial", currentSource: "initial", responseSource: "consumed", choiceAvailable: true, fallback: null },
      records: { lastAction: { state: "failed", key: "reload-server", outcomeKey: "reload-terminal-response-display-failed" } },
    });
  });

  it("terminalizes a view-once Reload invalidated by metadata mutation", async () => {
    let page: UsePastePageResult | null = null;
    let resolveReload: ((response: Response) => void) | undefined;
    const reload = new Promise<Response>((resolve) => { resolveReload = resolve; });
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "PATCH" ? mutationResponse("initial", { title: "updated", version: "generation.2" }) : reload
    )));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.reload();
      await Promise.resolve();
      page!.actions.saveTitle("updated");
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
      resolveReload!(await resourceResponse("consumed", { viewOnce: true, version: "generation.3", contentRevision: 3, updatedAt: "2026-09-17T00:00:00.000Z" }));
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.paste).toMatchObject({ phase: "consumed", serverCapabilities: false });
    expect(page!.snapshot.source).toBe("initial");
    expect(page!.snapshot.candidate).toEqual({ kind: "terminal", source: "consumed" });
  });

  it("terminalizes a validated view-once Reload after its GET was aborted", async () => {
    let page: UsePastePageResult | null = null;
    let terminal: unknown = null;
    const resolvers: Array<(response: Response) => void> = [];
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>((resolve) => { resolvers.push(resolve); });
    }));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0], { onTerminal: (handoff) => { terminal = handoff; } });
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.reload();
      page!.actions.reload();
      expect(signals[0]?.aborted).toBe(true);
      resolvers[0]!(await resourceResponse("consumed", { viewOnce: true, version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" }));
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(terminal).toMatchObject({ page: { phase: "consumed", source: "initial", responseSource: "consumed", choiceAvailable: true } });
    expect(page!.snapshot.paste).toMatchObject({ phase: "consumed", serverCapabilities: false });
    expect(page!.snapshot.source).toBe("initial");
    expect(page!.snapshot.candidate).toEqual({ kind: "terminal", source: "consumed" });
  });

  it("ignores a stale non-view-once Reload response", async () => {
    let page: UsePastePageResult | null = null;
    let resolveReload: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveReload = resolve; })));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.reload();
      await Promise.resolve();
      page!.actions.sourceEvent({ type: "input", content: "local draft", eventAt: 1 });
      resolveReload!(await resourceResponse("remote", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" }));
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.paste).toMatchObject({ phase: "ordinary", serverCapabilities: true });
    expect(page!.snapshot.source).toBe("local draft");
    expect(page!.snapshot.candidate).toBeNull();
    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "failed", key: "reload-server" });
  });

  it("recovers Network after a current view-once Reload response", async () => {
    let page: UsePastePageResult | null = null;
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("consumed", { viewOnce: true, version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" })));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
      await Promise.resolve();
    });
    expect(page!.snapshot.records.network.state).toBe("offline");
    await act(async () => {
      page!.actions.reload();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.records.network.state).toBe("online");
  });

  it("lets a pending Reload own its settlement across offline", async () => {
    let page: UsePastePageResult | null = null;
    let resolveReload: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveReload = resolve; })));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.reload();
      window.dispatchEvent(new Event("offline"));
      resolveReload!(await resourceResponse("remote", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" }));
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });

    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "succeeded", key: "reload-server" });
    expect(page!.snapshot.source).toBe("remote");
  });

  it("recovers Network after a current view-once sync response", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      reads += 1;
      if (reads === 1) throw new TypeError("offline");
      return resourceResponse("consumed", { viewOnce: true, version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" });
    }));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.records.network.state).toBe("degraded");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.paste).toMatchObject({ phase: "consumed", serverCapabilities: false });
    expect(page!.snapshot.records.network.state).toBe("online");
  });

  it("keeps current when a mounted Preview cannot stage a newer consumed sync response", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    let terminal: unknown = null;
    stagedMarkdown.prepareMarkdownPreview.mockRejectedValueOnce(new Error("preview unavailable"));
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("consumed", {
      viewOnce: true,
      version: "generation.2",
      contentRevision: 2,
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0], { onTerminal: (handoff) => { terminal = handoff; } });
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("preview", true);
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });

    expect(stagedMarkdown.prepareMarkdownPreview).not.toHaveBeenCalled();
    expect(terminal).toMatchObject({ page: { phase: "consumed", source: "initial", currentSource: "initial", responseSource: "consumed", choiceAvailable: true, fallback: null } });
  });

  it("publishes terminal capability removal before a mounted strict view-once stage resolves", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    let terminal: unknown = null;
    const preview = new Promise<unknown>(() => undefined);
    stagedMarkdown.prepareMarkdownPreview.mockImplementationOnce(() => preview as never);
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("consumed", {
      viewOnce: true,
      version: "generation.2",
      contentRevision: 2,
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0], { onTerminal: (handoff) => { terminal = handoff; } });
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("preview", true);
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });

    expect(page!.snapshot.paste).toMatchObject({ phase: "consumed", serverCapabilities: false });
    expect(terminal).toMatchObject({ page: { source: "initial", consumedSource: "consumed", fallback: null } });
    expect(stagedMarkdown.prepareMarkdownPreview).not.toHaveBeenCalled();
  });

  it("cleans a first mount before the remounted lifecycle reaches its sync due time", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await mountOrdinary();
    unmount(first);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetchMock).not.toHaveBeenCalled();

    await mountOrdinary();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps one sync lifecycle after a full App StrictMode replay", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => resourceResponse("initial"));
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mount(<StrictMode><App initialPage={ordinaryInitialPage()} /></StrictMode>);

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await vi.waitFor(() => expect(rendered.querySelector("[data-ordinary-paste-page]")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses one load instant for the initial active deadline and first sync ordering", async () => {
    vi.useFakeTimers();
    const base = Date.now();
    let reads = 0;
    vi.spyOn(performance, "now").mockImplementation(() => Date.now() - base + reads++);
    const remote = await resourceResponse("remote", {
      version: "generation.2",
      contentRevision: 2,
      updatedAt: "2026-09-16T00:00:00.000Z",
    });
    vi.stubGlobal("fetch", vi.fn(async () => remote));
    const rendered = await mountOrdinary();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });

    expect(rendered.querySelector("[data-plain-view]")?.textContent).toBe("remote");
  });

  it("does not partially apply an autosync stage invalidated by offline", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    let resolvePreview: ((value: unknown) => void) | undefined;
    const preview = new Promise<unknown>((resolve) => { resolvePreview = resolve; });
    stagedMarkdown.prepareMarkdownPreview.mockImplementationOnce(() => preview as never);
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("remote", {
      version: "generation.2",
      contentRevision: 2,
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("preview", true);
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(stagedMarkdown.prepareMarkdownPreview).toHaveBeenCalledWith("remote"));

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
      resolvePreview!({ source: "remote", html: "<p>remote</p>" });
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });

    expect(page!.snapshot.paste).toMatchObject({ acceptedSource: "initial", summary: { version: "generation.1" } });
    expect(page!.snapshot.autosaveAcceptedSource).toBe("initial");
    expect(page!.snapshot.records.autosync.state).toBe("paused-offline");
    expect(page!.snapshot.candidate).toBeNull();
  });

  it("does not partially apply a candidate stage invalidated by offline", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    let resolvePreview: ((value: unknown) => void) | undefined;
    const preview = new Promise<unknown>((resolve) => { resolvePreview = resolve; });
    stagedMarkdown.prepareMarkdownPreview.mockImplementationOnce(() => preview as never);
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("remote", {
      version: "other-generation.1",
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("preview", true);
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.candidate).toEqual({ kind: "remote", source: "remote" });

    await act(async () => {
      page!.actions.useRemote();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(stagedMarkdown.prepareMarkdownPreview).toHaveBeenCalledWith("remote"));

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
      resolvePreview!({ source: "remote", html: "<p>remote</p>" });
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });

    expect(page!.snapshot.paste).toMatchObject({ acceptedSource: "initial" });
    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "failed", key: "use-remote" });
    expect(page!.snapshot.records.autosync.state).toBe("paused-offline");
    expect(page!.snapshot.candidate).toBeNull();
  });

  it("settles a never-settling candidate apply on edit without accepting stale candidate actions", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    const preview = new Promise<unknown>(() => undefined);
    stagedMarkdown.prepareMarkdownPreview.mockImplementationOnce(() => preview as never);
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("remote", {
      version: "other-generation.1",
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("preview", true);
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(page!.snapshot.candidate).toEqual({ kind: "remote", source: "remote" }));
    await act(async () => {
      page!.actions.useRemote();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "pending", key: "use-remote" });

    await act(async () => {
      page!.actions.sourceEvent({ type: "input", content: "local draft", eventAt: 1 });
      await Promise.resolve();
    });
    expect(page!.snapshot.paste).toMatchObject({ acceptedSource: "initial", draft: "local draft" });
    expect(page!.snapshot.candidate).toBeNull();
    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "failed", key: "use-remote" });
    const action = page!.snapshot.records.lastAction;

    await act(async () => {
      page!.actions.keepCurrent();
      page!.actions.retrySync("stale");
      await Promise.resolve();
    });
    expect(page!.snapshot.records.lastAction).toEqual(action);
  });

  it("settles a pending candidate before retrying its visible Preview fallback", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    let resolveCandidatePreview: ((value: unknown) => void) | undefined;
    let resolveFallbackRetry: ((value: unknown) => void) | undefined;
    const candidatePreview = new Promise<unknown>((resolve) => { resolveCandidatePreview = resolve; });
    const fallbackRetry = new Promise<unknown>((resolve) => { resolveFallbackRetry = resolve; });
    let fallbackStages = 0;
    stagedMarkdown.prepareMarkdownPreview.mockImplementation((source) => {
      if (source === "fallback") {
        fallbackStages += 1;
        return fallbackStages === 1
          ? Promise.reject(new Error("initial fallback"))
          : fallbackRetry as never;
      }
      return candidatePreview as never;
    });
    let read = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      read += 1;
      return read === 1
        ? resourceResponse("fallback", {
          version: "generation.2",
          contentRevision: 2,
          updatedAt: "2026-09-16T00:00:00.000Z",
        })
        : resourceResponse("candidate", {
          version: "other-generation.1",
          updatedAt: "2026-09-17T00:00:00.000Z",
        });
    }));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("preview", true);
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(page!.snapshot.derivedFallback).toMatchObject({ surface: "preview", source: "fallback" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(page!.snapshot.candidate).toEqual({ kind: "remote", source: "candidate" }));

    await act(async () => {
      page!.actions.useRemote();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.records.lastAction).toMatchObject({ key: "use-remote", state: "pending" });

    await act(async () => {
      page!.actions.retryPreview();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.records.lastAction).toMatchObject({ key: "use-remote", state: "failed" });
    expect(page!.snapshot.candidate).toEqual({ kind: "remote", source: "candidate" });
    expect(page!.snapshot.derivedFallback).toMatchObject({ surface: "preview", source: "fallback" });

    await act(async () => {
      resolveFallbackRetry!({ source: "fallback", html: "<p>fallback</p>" });
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.acceptedSource).toBe("fallback");
    expect(page!.snapshot.derivedFallback).toBeNull();
    const settled = page!.snapshot;

    await act(async () => {
      resolveCandidatePreview!({ source: "candidate", html: "<p>candidate</p>" });
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot).toMatchObject({
      acceptedSource: settled.acceptedSource,
      candidate: settled.candidate,
      records: { lastAction: settled.records.lastAction },
    });
  });

  it("settles a pending candidate before retrying its visible Visual fallback", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    const candidateVisual = new Promise<unknown>(() => undefined);
    const fallbackRetry = new Promise<unknown>(() => undefined);
    let fallbackStages = 0;
    stagedMarkdown.prepareMarkdownVisual.mockImplementation((source) => {
      if (source === "fallback") {
        fallbackStages += 1;
        return fallbackStages === 1
          ? Promise.reject(new Error("initial fallback"))
          : fallbackRetry as never;
      }
      return candidateVisual as never;
    });
    let read = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      read += 1;
      return read === 1
        ? resourceResponse("fallback", {
          version: "generation.2",
          contentRevision: 2,
          updatedAt: "2026-09-16T00:00:00.000Z",
        })
        : resourceResponse("candidate", {
          version: "other-generation.1",
          updatedAt: "2026-09-17T00:00:00.000Z",
        });
    }));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("visual", true);
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(page!.snapshot.derivedFallback).toMatchObject({ surface: "visual", source: "fallback" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(page!.snapshot.candidate).toEqual({ kind: "remote", source: "candidate" }));
    await act(async () => {
      page!.actions.useRemote();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      page!.actions.retryVisual();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });

    expect(page!.snapshot.records.lastAction).toMatchObject({ key: "use-remote", state: "failed" });
    expect(page!.snapshot.candidate).toEqual({ kind: "remote", source: "candidate" });
    expect(page!.snapshot.derivedFallback).toMatchObject({ surface: "visual", source: "fallback" });
  });

  it("settles a pending candidate before retrying its visible diff fallback", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    const workers: Array<{
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
      onmessage: ((event: MessageEvent<unknown>) => void) | null;
      onerror: ((event: ErrorEvent) => void) | null;
    }> = [];
    vi.stubGlobal("Worker", class {
      postMessage = vi.fn();
      terminate = vi.fn();
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor() { workers.push(this); }
    });
    let resourceRead = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/history/1")) {
        return jsonResponse({ id: "example", revision: 1, savedAt: "2026-09-15T00:00:00.000Z", supersededAt: "2026-09-16T00:00:00.000Z", byteLength: 4, content: "past" }, 200, { etag: '"generation.1"' });
      }
      if (url.endsWith("/history")) {
        return jsonResponse({ id: "example", currentRevision: 1, currentVersion: "generation.1", revisions: [{ revision: 1, savedAt: "2026-09-15T00:00:00.000Z", supersededAt: "2026-09-16T00:00:00.000Z", byteLength: 4 }] }, 200, { etag: '"generation.1"' });
      }
      resourceRead += 1;
      return resourceRead === 1
        ? resourceResponse("fallback", {
          version: "generation.2",
          contentRevision: 2,
          updatedAt: "2026-09-16T00:00:00.000Z",
        })
        : resourceResponse("candidate", {
          version: "other-generation.1",
          updatedAt: "2026-09-17T00:00:00.000Z",
        });
    }));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("diff", true);
      page!.actions.openHistory();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
      page!.actions.selectRevision(1);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(workers).toHaveLength(1);
    const initialDiff = workers[0]!.postMessage.mock.calls.at(-1)![0] as { id: number };
    await act(async () => {
      workers[0]!.onmessage!({ data: { type: "result", id: initialDiff.id, lines: [] } } as MessageEvent<unknown>);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    const fallbackDiff = workers[0]!.postMessage.mock.calls.at(-1)![0] as { id: number };
    await act(async () => {
      workers[0]!.onerror!(new ErrorEvent("error"));
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(fallbackDiff.id).toBeGreaterThan(initialDiff.id);
    await vi.waitFor(() => expect(page!.snapshot.derivedFallback).toMatchObject({ surface: "diff", source: "fallback" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(page!.snapshot.candidate).toEqual({ kind: "remote", source: "candidate" }));
    await act(async () => {
      page!.actions.useRemote();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      page!.actions.retryDiff();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });

    expect(page!.snapshot.records.lastAction).toMatchObject({ key: "use-remote", state: "failed" });
    expect(page!.snapshot.candidate).toEqual({ kind: "remote", source: "candidate" });
    expect(page!.snapshot.derivedFallback).toMatchObject({ surface: "diff", source: "fallback" });
  });

  it("commits candidate canonical state when the active deadline crosses during surface publication", async () => {
    vi.useFakeTimers();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    let page: UsePastePageResult | null = null;
    let crossDeadline = false;
    const firstVisualRoot = document.createElement("div");
    const visual = (source: string, root: HTMLElement) => ({
      root,
      source: { value: source },
      modes: {
        enterSource: async () => undefined,
        enterVisual: async () => undefined,
        enterPreview: async () => undefined,
        leaveVisual: async () => undefined,
        destroy: async () => undefined,
      },
      bind: () => undefined,
      dispose: async () => undefined,
    });
    const firstVisual = visual("first", firstVisualRoot);
    firstVisual.dispose = async () => {
      if (crossDeadline) clock = 300_000;
    };
    stagedMarkdown.prepareMarkdownVisual
      .mockResolvedValueOnce(firstVisual as never)
      .mockResolvedValueOnce(visual("candidate", document.createElement("div")) as never);
    let read = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      read += 1;
      return read === 1
        ? resourceResponse("first", {
          version: "generation.2",
          contentRevision: 2,
          updatedAt: "2026-09-16T00:00:00.000Z",
        })
        : resourceResponse("candidate", {
          version: "other-generation.1",
          updatedAt: "2026-09-17T00:00:00.000Z",
        });
    }));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("visual", true);
      clock = 3_000;
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(page!.snapshot.acceptedSource).toBe("first"));
    await act(async () => {
      clock = 6_000;
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(page!.snapshot.candidate).toEqual({ kind: "remote", source: "candidate" }));

    crossDeadline = true;
    await act(async () => {
      page!.actions.useRemote();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });

    expect(page!.snapshot).toMatchObject({
      acceptedSource: "candidate",
      autosaveAcceptedSource: "candidate",
      lastSavedContent: "candidate",
      records: {
        autosync: { state: "remote-applied" },
        lastAction: { key: "use-remote", state: "succeeded" },
      },
    });
  });

  it("publishes a coherent remote apply before a throwing records callback remounts its surface", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    const dispose = vi.fn(async () => undefined);
    stagedMarkdown.prepareMarkdownVisual.mockResolvedValueOnce({
      root: document.createElement("div"),
      source: { value: "remote" },
      modes: {
        enterSource: async () => undefined,
        enterVisual: async () => undefined,
        enterPreview: async () => undefined,
        leaveVisual: async () => undefined,
        destroy: async () => undefined,
      },
      bind: () => undefined,
      dispose,
    } as never);
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("remote", {
      version: "generation.2",
      contentRevision: 2,
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));
    let callbackRuns = 0;

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0], {
        onRecordsChange(records) {
          if (records.autosync.state !== "remote-applied" || callbackRuns !== 0) return;
          callbackRuns += 1;
          page!.actions.setSurfaceMounted("visual", false);
          throw new Error("callback failed");
        },
      });
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("visual", true);
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(page!.snapshot.acceptedSource).toBe("remote"));

    expect(callbackRuns).toBe(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(page!.snapshot).toMatchObject({
      acceptedSource: "remote",
      autosaveAcceptedSource: "remote",
      lastSavedContent: "remote",
      records: { autosync: { state: "remote-applied" } },
    });
  });

  it("recovers a candidate after a never-settling Preview host remount and ignores its stale settlement", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    let resolvePreview: ((value: unknown) => void) | undefined;
    const preview = new Promise<unknown>((resolve) => { resolvePreview = resolve; });
    stagedMarkdown.prepareMarkdownPreview.mockImplementationOnce(() => preview as never);
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("remote", {
      version: "other-generation.1",
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("preview", true);
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(page!.snapshot.candidate).toEqual({ kind: "remote", source: "remote" }));
    await act(async () => {
      page!.actions.useRemote();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      page!.actions.setSurfaceMounted("preview", false);
      page!.actions.setSurfaceMounted("preview", true);
      await Promise.resolve();
    });
    expect(page!.snapshot.candidate).toEqual({ kind: "remote", source: "remote" });
    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "failed", key: "use-remote" });

    await act(async () => {
      page!.actions.useRemote();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.paste.acceptedSource).toBe("remote");
    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "succeeded", key: "use-remote" });

    await act(async () => {
      resolvePreview!({ source: "remote", html: "<p>stale remote</p>" });
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.paste.acceptedSource).toBe("remote");
    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "succeeded", key: "use-remote" });
  });

  it("settles a never-settling candidate apply at the active deadline", async () => {
    vi.useFakeTimers();
    let page: UsePastePageResult | null = null;
    let resolvePreview: ((value: unknown) => void) | undefined;
    const preview = new Promise<unknown>((resolve) => { resolvePreview = resolve; });
    stagedMarkdown.prepareMarkdownPreview.mockImplementationOnce(() => preview as never);
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("remote", {
      version: "other-generation.1",
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.setSurfaceMounted("preview", true);
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(page!.snapshot.candidate).toEqual({ kind: "remote", source: "remote" }));
    await act(async () => {
      page!.actions.useRemote();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(297_000);
    });
    expect(page!.snapshot.candidate).toBeNull();
    expect(page!.snapshot.records.lastAction).toMatchObject({ state: "failed", key: "use-remote" });
    expect(page!.snapshot.records.autosync.state).toBe("inactive");

    await act(async () => {
      resolvePreview!({ source: "remote", html: "<p>late remote</p>" });
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.paste.acceptedSource).toBe("initial");
  });

  it("renders an autosync candidate with remote, current, and retry ownership", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => resourceResponse("remote", {
      version: "generation.2",
      updatedAt: "2026-09-14T00:00:00.000Z",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await vi.waitFor(() => {
      if (rendered.querySelector("[data-sync-candidate]") === null) throw new Error("candidate did not render");
    });
    expect(button(rendered, "Use remote")).toBeDefined();
    expect(button(rendered, "Keep current")).toBeDefined();
    expect(button(rendered, "Retry")).toBeDefined();

    await clickButton(rendered, "Use remote");
    await vi.waitFor(() => {
      expect(rendered.querySelector("[data-plain-view]")?.textContent).toBe("remote");
    });
    expect(rendered.querySelector('[data-operation-record="last-action"] time')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders a forbidden sync credential recovery without changing the current URL", async () => {
    vi.useFakeTimers();
    const credential = "sync +%&#?";
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return calls.length === 1 ? errorResponse(403, "FORBIDDEN") : resourceResponse("initial");
    }));
    const rendered = await mountOrdinary();

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await vi.waitFor(() => expect(rendered.querySelector("[data-sync-candidate]")).not.toBeNull());
    expect(rendered.querySelector('input[name="syncRetryCredential"]')).not.toBeNull();
    expect(new URL(location.href).searchParams.get("password")).toBeNull();
    await setInput(rendered, 'input[name="syncRetryCredential"]', credential);
    expect(new URL(location.href).searchParams.get("password")).toBeNull();
    await clickButton(rendered, "Retry");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(new URL(calls[1]!.url, location.href).searchParams.get("password")).toBe(credential);
    await vi.waitFor(() => expect(new URL(location.href).searchParams.get("password")).toBe(credential));
    expect(rendered.querySelector('[data-operation-record="last-action"] time')).not.toBeNull();
  });

  it("clears a forbidden sync candidate after a content edit", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(403, "FORBIDDEN")));
    const rendered = await mountOrdinary();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(rendered.querySelector("[data-sync-candidate]")).not.toBeNull();
    await selectTab(rendered, "Edit");
    await setInput(rendered, "textarea", "local draft");
    expect(rendered.querySelector("[data-sync-candidate]")).toBeNull();
  });

  it("expires a forbidden sync candidate after the active window", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(403, "FORBIDDEN")));
    const rendered = await mountOrdinary();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(rendered.querySelector("[data-sync-candidate]")).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(rendered.querySelector("[data-sync-candidate]")).toBeNull();
  });

  it("clears a forbidden sync candidate when the browser goes offline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(403, "FORBIDDEN")));
    const rendered = await mountOrdinary();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(rendered.querySelector("[data-sync-candidate]")).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
      await Promise.resolve();
    });
    expect(rendered.querySelector("[data-sync-candidate]")).toBeNull();
  });

  it("clears a forbidden sync candidate after an authoritative metadata mutation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "PATCH"
        ? mutationResponse("initial", { title: "updated", version: "generation.2" })
        : errorResponse(403, "FORBIDDEN")
    )));
    const rendered = await mountOrdinary();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(rendered.querySelector("[data-sync-candidate]")).not.toBeNull();
    await selectTab(rendered, "Settings");
    await setInput(rendered, 'input[name="title"]', "updated");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(rendered.querySelector("[data-sync-candidate]")).toBeNull());
  });

  it("adopts a staged visual resource into an already mounted Visual host", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("remote", {
      format: "markdown",
      version: "generation.2",
      updatedAt: "2026-09-14T00:00:00.000Z",
    })));
    const rendered = await mountOrdinary();

    await selectTab(rendered, "Markdown");
    await vi.waitFor(() => expect(rendered.querySelector("[data-markdown-workbench]")).not.toBeNull());
    await selectTab(rendered, "Visual");
    await vi.waitFor(() => expect(rendered.querySelector("[data-markdown-visual-host]")).not.toBeNull());
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await vi.waitFor(() => expect(rendered.querySelector("[data-sync-candidate]")).not.toBeNull());
    await clickButton(rendered, "Use remote");
    await vi.waitFor(() => expect(rendered.querySelector("[data-markdown-visual-host] [data-staged-visual]")).not.toBeNull());
  });

  it("keeps or retries a sync candidate only through its selected action", async () => {
    vi.useFakeTimers();
    let request = 0;
    const fetchMock = vi.fn(async () => {
      request += 1;
      return request === 1
        ? resourceResponse("candidate", { version: "generation.2", updatedAt: "2026-09-14T00:00:00.000Z" })
        : resourceResponse("initial");
    });
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await vi.waitFor(() => expect(rendered.querySelector("[data-sync-candidate]")).not.toBeNull());
    await clickButton(rendered, "Keep current");
    expect(rendered.querySelector("[data-sync-candidate]")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_999); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders the current draft in View after a local edit", async () => {
    const rendered = await mountOrdinary("initial");

    await selectTab(rendered, "Edit");
    await setInput(rendered, "textarea", "draft");
    await act(async () => {
      for (let step = 0; step < 5; step += 1) await Promise.resolve();
    });
    await selectTab(rendered, "View");

    expect(rendered.querySelector("[data-plain-view]")?.textContent).toBe("draft");
  });

  it("retries the latest draft exactly once after a proven-not-applied 503", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") return resourceResponse("initial");
      writes.push(JSON.parse(String(init.body)).content as string);
      return writes.length === 1
        ? errorResponse(503, "STORAGE_WRITE_FAILED", false)
        : mutationResponse("latest", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" });
    }));
    const rendered = await mountOrdinary();

    await selectTab(rendered, "Edit");
    const textarea = rendered.querySelector<HTMLTextAreaElement>("textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    expect(textarea).not.toBeNull();
    expect(setter).toBeDefined();
    await act(async () => {
      setter!.call(textarea, "first");
      const event = new Event("input", { bubbles: true });
      Object.defineProperty(event, "timeStamp", { value: performance.now() });
      textarea!.dispatchEvent(event);
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await vi.waitFor(() => expect(button(rendered, "Retry")).toBeDefined());
    await setInput(rendered, "textarea", "latest");
    await clickButton(rendered, "Retry");
    await vi.waitFor(() => expect(writes).toEqual(["first", "latest"]));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(writes).toEqual(["first", "latest"]);
  });

  it("shows conflict recovery without an inert Retry action", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return errorResponse(409, "VERSION_CONFLICT");
      return resourceResponse("initial");
    }));
    const rendered = await mountOrdinary();

    await selectTab(rendered, "Edit");
    const textarea = rendered.querySelector<HTMLTextAreaElement>("textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    expect(textarea).not.toBeNull();
    expect(setter).toBeDefined();
    await act(async () => {
      setter!.call(textarea, "draft");
      const event = new Event("input", { bubbles: true });
      Object.defineProperty(event, "timeStamp", { value: performance.now() });
      textarea!.dispatchEvent(event);
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await vi.waitFor(() => expect(button(rendered, "Reload")).toBeDefined());

    expect(Array.from(rendered.querySelectorAll("button")).filter((value) => value.textContent?.trim() === "Retry")).toHaveLength(0);
    expect(button(rendered, "Overwriting")).toBeDefined();
    expect(button(rendered, "Copy")).toBeDefined();
    expect(button(rendered, "Download")).toBeDefined();
  });

  it("restarts the three-second sync cadence when source returns to its accepted value", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => resourceResponse("initial"));
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary("initial");

    await selectTab(rendered, "Edit");
    await setInput(rendered, "textarea", "draft");
    await setInput(rendered, "textarea", "initial");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_999); });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("restarts the three-second sync cadence when composition commits its accepted source", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => resourceResponse("initial"));
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary("initial");

    await selectTab(rendered, "Edit");
    const textarea = rendered.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    expect(setter).toBeDefined();
    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      setter!.call(textarea, "draft");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      setter!.call(textarea, "initial");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_999); });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opens a confirmation dialog before Reload and retains a dirty draft while staging remote content", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (init?.method === "PATCH") return errorResponse(409, "VERSION_CONFLICT");
      return resourceResponse("remote", { version: "generation.2", updatedAt: "2026-09-16T00:00:00.000Z" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();

    await selectTab(rendered, "Edit");
    await vi.waitFor(() => expect(rendered.querySelector("textarea")).not.toBeNull());
    await setInput(rendered, "textarea", "draft");
    await selectTab(rendered, "Settings");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(button(rendered, "Reload")).toBeDefined());

    await clickButton(rendered, "Reload");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]");
    expect(dialog).not.toBeNull();
    expect(calls.filter((call) => call.init?.method === "GET")).toHaveLength(0);
    await clickButton(dialog!, "Reload");
    await vi.waitFor(() => expect(calls.filter((call) => call.init?.method === "GET")).toHaveLength(1));
    expect(new Headers(calls.at(-1)!.init?.headers).has("If-None-Match")).toBe(false);
    await selectTab(rendered, "View");
    await vi.waitFor(() => expect(rendered.querySelector("[data-plain-view]")?.textContent).toBe("remote"));
    expect(rendered.querySelector("[data-sync-candidate]")).toBeNull();
  });

  it("allows a confirmed Reload after autosync has become inactive", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (init?.method === "PATCH") return errorResponse(409, "VERSION_CONFLICT");
      return resourceResponse("remote", { version: "generation.2", updatedAt: "2026-09-16T00:00:00.000Z" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();

    await selectTab(rendered, "Settings");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(button(rendered, "Reload")).toBeDefined());
    await act(async () => { await vi.advanceTimersByTimeAsync(300_001); });
    expect(calls.filter((call) => call.init?.method === "GET")).toHaveLength(0);

    await clickButton(rendered, "Reload");
    await clickButton(document.querySelector<HTMLElement>("[role=dialog]")!, "Reload");
    await vi.waitFor(() => expect(calls.filter((call) => call.init?.method === "GET")).toHaveLength(1));
    await selectTab(rendered, "View");
    await vi.waitFor(() => expect(rendered.querySelector("[data-plain-view]")?.textContent).toBe("remote"));
  });

  it("terminalizes a consumed Reload response after an edit retires its ordinary guards", async () => {
    vi.useFakeTimers();
    let resolveRead: ((response: Response) => void) | undefined;
    const read = new Promise<Response>((resolve) => { resolveRead = resolve; });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "PATCH" ? errorResponse(409, "VERSION_CONFLICT") : read
    ));
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();

    await selectTab(rendered, "Settings");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(button(rendered, "Reload")).toBeDefined());
    await clickButton(rendered, "Reload");
    await clickButton(document.querySelector<HTMLElement>("[role=dialog]")!, "Reload");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await selectTab(rendered, "Edit");
    await setInput(rendered, "textarea", "local draft");
    await act(async () => {
      resolveRead!(await resourceResponse("consumed", { viewOnce: true, version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" }));
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      await vi.dynamicImportSettled();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });

    await vi.waitFor(() => expect(rendered.querySelector('[aria-label="Consumed"]')).not.toBeNull());
    expect(rendered.querySelector("[data-server-controls]")).toBeNull();
  });

  it("commits the intended password only after a successful password change and preserves encoded links on remount", async () => {
    vi.useFakeTimers();
    const password = "  +%&#?  ";
    history.replaceState(null, "", "/example?keep=one&password=old&password=other#fragment");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      return mutationResponse("initial", { protected: true, version: "generation.2" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();

    await selectTab(rendered, "Settings");
    await setInput(rendered, 'input[name="newPassword"]', password);
    await clickButton(rendered, "Set password");
    await vi.waitFor(() => expect(new URL(location.href).searchParams.get("password")).toBe(password));
    const current = new URL(location.href);
    expect(current.searchParams.get("keep")).toBe("one");
    expect(current.searchParams.getAll("password")).toEqual([password]);
    expect(current.hash).toBe("#fragment");
    expect(rendered.textContent).not.toContain(password);
    const rawRepresentations = Array.from(rendered.querySelectorAll<HTMLAnchorElement>("a")).filter((link) => new URL(link.href).pathname.startsWith("/raw/"));
    expect(rawRepresentations.length).toBeGreaterThan(0);
    for (const link of rawRepresentations) {
      expect(new URL(link.href).searchParams.get("password")).toBe(password);
    }

    unmount(rendered);
    const remounted = await mountOrdinary("initial", password);
    const remountedRawRepresentations = Array.from(remounted.querySelectorAll<HTMLAnchorElement>("a")).filter((link) => new URL(link.href).pathname.startsWith("/raw/"));
    expect(remountedRawRepresentations.length).toBeGreaterThan(0);
    for (const link of remountedRawRepresentations) {
      expect(new URL(link.href).searchParams.getAll("password")).toEqual([password]);
    }
  });

  it("keeps a retry credential out of URLs until its authorized metadata request succeeds", async () => {
    const credential = "retry +%&#?";
    let writes = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      writes += 1;
      if (writes === 1) {
        expect(JSON.parse(String(init?.body))).not.toHaveProperty("password");
        return errorResponse(403, "FORBIDDEN");
      }
      expect(JSON.parse(String(init?.body)).password).toBe(credential);
      return mutationResponse("initial", { version: "generation.2" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();

    await selectTab(rendered, "Settings");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(rendered.querySelector("[data-settings-result=credential-required]")).not.toBeNull());
    expect(new URL(location.href).searchParams.get("password")).toBeNull();
    await setInput(rendered, 'input[name="retryCredential"]', credential);
    expect(new URL(location.href).searchParams.get("password")).toBeNull();
    await clickButton(rendered, "Retry");
    await vi.waitFor(() => expect(new URL(location.href).searchParams.get("password")).toBe(credential));
  });

  it.each([
    ["settings", async (root: HTMLDivElement) => { await selectTab(root, "Settings"); await clickButton(root, "Save title"); }, "[data-settings-result=reconciliation-required]"],
    ["password", async (root: HTMLDivElement) => { await selectTab(root, "Settings"); await setInput(root, 'input[name="newPassword"]', "replacement"); await clickButton(root, "Set password"); }, "[data-password-result=reconciliation-required]"],
  ] as const)("treats a missing mutation flag as uncertain for %s", async (_family, start, selector) => {
    vi.stubGlobal("fetch", vi.fn(async () => uncertainWriteResponse()));
    const rendered = await mountOrdinary();
    await start(rendered);
    await vi.waitFor(() => expect(rendered.querySelector(selector)).not.toBeNull());
    expect(rendered.querySelector("button")?.disabled).toBe(false);
  });

  it("retires a discarded settings intent without changing its frozen Last action", async () => {
    let page: UsePastePageResult | null = null;
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return calls.length === 1
        ? uncertainWriteResponse()
        : mutationResponse("initial", { title: "fresh", version: "generation.2" });
    }));

    function Probe() {
      page = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.saveTitle("discarded");
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.settings.result).toMatchObject({ field: "title", state: "reconciliation-required" });

    await act(async () => {
      page!.actions.discard();
      page!.actions.retry(null);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(page!.snapshot.settings.result).toMatchObject({ field: null, state: "idle" });
    expect(calls).toHaveLength(1);

    await act(async () => {
      page!.actions.saveTitle("fresh");
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1]!.body))).toMatchObject({ title: "fresh" });
  });

  it("settles a reconciled view-once response into its terminal local source", async () => {
    vi.useFakeTimers();
    let rejectSave: ((reason?: unknown) => void) | undefined;
    const save = new Promise<Response>((_resolve, reject) => { rejectSave = reject; });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return save;
      return resourceResponse("consumed", { viewOnce: true, version: "generation.2", updatedAt: "2026-09-16T00:00:00.000Z" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();

    await selectTab(rendered, "Edit");
    await vi.waitFor(() => expect(rendered.querySelector("textarea")).not.toBeNull());
    const textarea = rendered.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    expect(setter).toBeDefined();
    await act(async () => {
      setter!.call(textarea, "draft");
      const event = new Event("input", { bubbles: true });
      Object.defineProperty(event, "timeStamp", { value: performance.now() });
      textarea!.dispatchEvent(event);
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { rejectSave!(new TypeError("offline")); await Promise.resolve(); });
    await selectTab(rendered, "Settings");
    await vi.waitFor(() => expect(button(rendered, "Reconcile")).toBeDefined());
    const recovery = rendered.querySelector<HTMLElement>('[aria-label="Autosave"]');
    expect(recovery).not.toBeNull();
    await act(async () => {
      button(recovery!, "Reconcile").click();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.dynamicImportSettled();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(rendered.querySelector('[aria-label="Consumed"]')).not.toBeNull());
    await act(async () => {
      button(rendered, "Use remote").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(Array.from(rendered.querySelectorAll("button")).filter((button) => button.textContent?.trim() === "Use remote")).toHaveLength(0));
    await clickButton(rendered, "Source");
    expect(rendered.querySelector("[data-local-source]")?.textContent).toBe("consumed");
    expect(rendered.querySelector("[data-operation-record=last-action]")?.textContent).toContain("The consumed response is displayed.");
  });

  it("keeps the current draft when a late content reconcile consumes the paste", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "execCommand").mockReturnValue(true);
    let resolveRead: ((response: Response) => void) | undefined;
    const read = new Promise<Response>((resolve) => { resolveRead = resolve; });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "PATCH" ? uncertainWriteResponse() : read
    ));
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();

    await selectTab(rendered, "Edit");
    const textarea = rendered.querySelector<HTMLTextAreaElement>("textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    expect(textarea).not.toBeNull();
    expect(setter).toBeDefined();
    await act(async () => {
      setter!.call(textarea, "local draft");
      const event = new Event("input", { bubbles: true });
      Object.defineProperty(event, "timeStamp", { value: performance.now() });
      textarea!.dispatchEvent(event);
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const recovery = rendered.querySelector<HTMLElement>('[aria-label="Autosave"]');
    expect(recovery).not.toBeNull();
    await vi.waitFor(() => expect(button(recovery!, "Reconcile")).toBeDefined());
    await clickButton(recovery!, "Reconcile");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await clickButton(rendered, "Copy");
    expect(Array.from(rendered.querySelectorAll("button")).some((item) => item.textContent === "Discard")).toBe(false);
    await act(async () => {
      resolveRead!(await resourceResponse("consumed", { viewOnce: true, version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" }));
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      await vi.dynamicImportSettled();
    });

    await vi.waitFor(() => expect(rendered.querySelector('[aria-label="Consumed"]')).not.toBeNull());
    await clickButton(rendered, "Source");
    expect(rendered.querySelector("[data-local-source]")?.textContent).toBe("local draft");
    expect(rendered.querySelector("[data-server-controls]")).toBeNull();
  });

  it("terminalizes complete view-once responses for exact and retired sync tokens", async () => {
    vi.useFakeTimers();
    const exact = vi.fn(async () => resourceResponse("initial", { viewOnce: true }));
    vi.stubGlobal("fetch", exact);
    const exactPage = await mountOrdinary("initial");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await vi.waitFor(() => expect(exactPage.querySelector('[aria-label="Consumed"]')).not.toBeNull());
    expect(exactPage.querySelector("[data-server-controls]")).toBeNull();
    unmount(exactPage);

    let resolveRead: ((response: Response) => void) | undefined;
    const read = new Promise<Response>((resolve) => { resolveRead = resolve; });
    const retired = vi.fn(() => read);
    vi.stubGlobal("fetch", retired);
    const retiredPage = await mountOrdinary("initial");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await selectTab(retiredPage, "Edit");
    await setInput(retiredPage, "textarea", "local draft");
    await act(async () => {
      resolveRead!(await resourceResponse("consumed", { viewOnce: true, version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(retiredPage.querySelector('[aria-label="Consumed"]')).not.toBeNull());
    await clickButton(retiredPage, "Source");
    expect(retiredPage.querySelector("[data-local-source]")?.textContent).toBe("local draft");
    expect(retiredPage.querySelector("[data-server-controls]")).toBeNull();
  });

  it("commits the consumed terminal boundary before ordinary derived staging settles", async () => {
    vi.useFakeTimers();
    const preview = new Promise<unknown>(() => undefined);
    const visual = new Promise<unknown>(() => undefined);
    stagedMarkdown.prepareMarkdownPreview.mockImplementationOnce(() => preview as never);
    stagedMarkdown.prepareMarkdownVisual.mockImplementationOnce(() => visual as never);
    const consumed = await resourceResponse("consumed", {
      viewOnce: true,
      version: "generation.2",
      contentRevision: 2,
      updatedAt: "2026-09-16T00:00:00.000Z",
    });
    vi.stubGlobal("fetch", vi.fn(async () => consumed));
    const rendered = await mountOrdinary();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      await vi.dynamicImportSettled();
    });

    expect(rendered.querySelector('[aria-label="Consumed"]')).not.toBeNull();
    expect(rendered.querySelector("[data-ordinary-paste-page]")).toBeNull();
    expect(rendered.querySelector("[data-server-controls]")).toBeNull();
    expect(stagedMarkdown.prepareMarkdownPreview).not.toHaveBeenCalled();
    expect(stagedMarkdown.prepareMarkdownVisual).not.toHaveBeenCalled();
  });

  it("retains current and consumed terminal sources until a local source choice", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => resourceResponse("consumed", {
      viewOnce: true,
      version: "other-generation.1",
      contentRevision: 1,
      updatedAt: "2026-09-16T00:00:00.000Z",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary("current");

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await vi.waitFor(() => expect(rendered.querySelector('[aria-label="Consumed"]')).not.toBeNull());
    await clickButton(rendered, "Source");
    expect(rendered.querySelector("[data-local-source]")?.textContent).toBe("current");
    expect(button(rendered, "Use remote")).toBeDefined();
    expect(button(rendered, "Keep current")).toBeDefined();
    await clickButton(rendered, "Use remote");
    await vi.waitFor(() => expect(Array.from(rendered.querySelectorAll("button")).filter((value) => value.textContent?.trim() === "Use remote")).toHaveLength(0));
    await clickButton(rendered, "Source");
    expect(rendered.querySelector("[data-local-source]")?.textContent).toBe("consumed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stages the mounted terminal preview before settling Use remote", async () => {
    vi.useFakeTimers();
    let resolvePreview: ((value: { source: string; html: string }) => void) | undefined;
    const preview = new Promise<{ source: string; html: string }>((resolve) => { resolvePreview = resolve; });
    stagedMarkdown.prepareMarkdownPreview.mockImplementationOnce(() => preview as never);
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("consumed", {
      viewOnce: true,
      version: "other-generation.1",
      contentRevision: 1,
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));
    const rendered = await mountOrdinary("current");

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await vi.waitFor(() => expect(rendered.querySelector('[aria-label="Consumed"]')).not.toBeNull());
    await act(async () => {
      button(rendered, "Use remote").click();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    expect(stagedMarkdown.prepareMarkdownPreview).toHaveBeenCalledWith("consumed");
    expect(rendered.querySelector("[data-operation-record=last-action]")?.textContent).toContain("Using consumed response");

    await act(async () => {
      resolvePreview!({ source: "consumed", html: "<p>rendered consumed</p>" });
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
      await vi.dynamicImportSettled();
    });
    await vi.waitFor(() => expect(rendered.textContent).toContain("rendered consumed"));
    expect(rendered.querySelector("[data-operation-record=last-action]")?.textContent).toContain("The consumed response is displayed.");
  });

  it("retains the terminal choice when a mounted Use remote surface falls back", async () => {
    vi.useFakeTimers();
    stagedMarkdown.prepareMarkdownPreview.mockRejectedValueOnce(new Error("preview unavailable"));
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("consumed", {
      viewOnce: true,
      version: "other-generation.1",
      contentRevision: 1,
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));
    const rendered = await mountOrdinary("current");

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); await vi.dynamicImportSettled(); });
    await vi.waitFor(() => expect(rendered.querySelector('[aria-label="Consumed"]')).not.toBeNull());
    await clickButton(rendered, "Use remote");
    await vi.waitFor(() => expect(rendered.querySelector("[data-operation-record=last-action]")?.textContent).toContain("could not be displayed"));
    await clickButton(rendered, "Source");

    expect(rendered.querySelector("[data-local-source]")?.textContent).toBe("current");
    expect(button(rendered, "Use remote")).toBeDefined();
    expect(rendered.querySelector("[data-derived-fallback=preview]")).toBeNull();
  });

  it("does not expose a terminal Preview Retry for an unselected consumed source", async () => {
    vi.useFakeTimers();
    stagedMarkdown.prepareMarkdownPreview.mockRejectedValueOnce(new Error("preview unavailable"));
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("consumed", {
      viewOnce: true,
      version: "other-generation.1",
      contentRevision: 1,
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));
    const rendered = await mountOrdinary("current");

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); await vi.dynamicImportSettled(); });
    await vi.waitFor(() => expect(rendered.querySelector('[aria-label="Consumed"]')).not.toBeNull());
    await clickButton(rendered, "Use remote");
    await vi.waitFor(() => expect(rendered.querySelector("[data-operation-record=last-action]")?.textContent).toContain("could not be displayed"));

    expect(rendered.querySelector('[data-derived-fallback="preview"]')).toBeNull();
    expect(Array.from(rendered.querySelectorAll("button")).filter((item) => item.textContent?.trim() === "Retry")).toHaveLength(0);
    expect(button(rendered, "Use remote")).toBeDefined();
    await clickButton(rendered, "Source");
    expect(rendered.querySelector("[data-local-source]")?.textContent).toBe("current");
  });

  it("settles an invalidated consumed-response action as failed exactly once", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("consumed", {
      viewOnce: true,
      version: "other-generation.1",
      contentRevision: 1,
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));
    const rendered = await mountOrdinary("current");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.dynamicImportSettled();
    });
    await vi.waitFor(() => expect(rendered.querySelector('[aria-label="Consumed"]')).not.toBeNull());
    await act(async () => {
      button(rendered, "Use remote").click();
      button(rendered, "Keep current").click();
      for (let step = 0; step < 5; step += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(rendered.querySelector("[data-operation-record=last-action]")?.textContent).toContain("The consumed response could not be displayed."));
  });

  it("records terminal Copy in the shared OperationStatus", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "execCommand").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("consumed", {
      viewOnce: true,
      version: "generation.2",
      contentRevision: 2,
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));
    const rendered = await mountOrdinary();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      await vi.dynamicImportSettled();
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
    });
    expect(rendered.querySelector('[aria-label="Consumed"]')).not.toBeNull();
    await clickButton(rendered, "Copy");

    await vi.waitFor(() => expect(rendered.querySelector('[data-operation-record="last-action"]')?.textContent).toContain("Copied"));
  });

  it("records terminal Download in the shared OperationStatus", async () => {
    vi.useFakeTimers();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => resourceResponse("consumed", {
      viewOnce: true,
      version: "generation.2",
      contentRevision: 2,
      updatedAt: "2026-09-16T00:00:00.000Z",
    })));
    const rendered = await mountOrdinary();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      await vi.dynamicImportSettled();
    });
    await vi.waitFor(() => expect(rendered.querySelector('[aria-label="Consumed"]')).not.toBeNull());
    await clickButton(rendered, "Download");
    await vi.waitFor(() => expect(rendered.querySelector("[data-operation-record=last-action]")?.textContent).toContain("Download ready"));
  });

  it("uses the received view-once source once, then stops business requests", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => resourceResponse("consumed", {
      viewOnce: true,
      version: "generation.2",
      updatedAt: "2026-09-16T00:00:00.000Z",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary("initial");

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await vi.waitFor(() => expect(rendered.querySelector('[aria-label="Consumed"]')).not.toBeNull());
    await clickButton(rendered, "Source");
    expect(rendered.querySelector("[data-local-source]")?.textContent).toBe("consumed");
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("arms view-once settings immediately without issuing later requests", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => mutationResponse("initial", { viewOnce: true, version: "generation.2" }));
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();

    await selectTab(rendered, "Settings");
    await setChecked(rendered, 'input[name="viewOnce"]', true);
    await clickButton(rendered, "Save view once");
    await vi.waitFor(() => expect(rendered.querySelector('[aria-label="Armed view-once"]')).not.toBeNull());
    expect(rendered.querySelector("[data-server-controls]")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the latest draft when a pending view-once mutation arms the page", async () => {
    let resolveMutation: ((response: Response) => void) | undefined;
    const mutation = new Promise<Response>((resolve) => { resolveMutation = resolve; });
    const fetchMock = vi.fn(() => mutation);
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary("accepted");

    await selectTab(rendered, "Settings");
    await setChecked(rendered, 'input[name="viewOnce"]', true);
    await clickButton(rendered, "Save view once");
    await selectTab(rendered, "Edit");
    await setInput(rendered, "textarea", "latest draft");
    await act(async () => {
      resolveMutation!(mutationResponse("accepted", { viewOnce: true, version: "generation.2" }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(rendered.querySelector('[aria-label="Armed view-once"]')).not.toBeNull());
    await clickButton(rendered, "Source");
    expect(rendered.querySelector("[data-local-source]")?.textContent).toBe("latest draft");
  });

  it.each([
    ["malformed 204", () => new Response(null, { status: 204, headers: { "cache-control": "no-store", "content-type": "text/plain" } })],
    ["uncertain 403", () => errorResponse(403, "FORBIDDEN", true)],
  ] as const)("enters Delete uncertain for a %s response", async (_name, response) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");
    await clickButton(rendered, "Delete");
    await clickButton(document.querySelector<HTMLElement>("[role=dialog]")!, "Delete");
    await vi.waitFor(() => expect(rendered.querySelector('[aria-label="Delete uncertain"]')).not.toBeNull());
    expect(rendered.querySelector("[data-server-controls]")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pauses Autosync as forbidden after a definite Delete 403 and permits an explicit retry", async () => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    let deletes = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "DELETE") return resourceResponse("initial");
      deletes += 1;
      return deletes === 1 ? errorResponse(403, "FORBIDDEN") : new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => {
      paste!.actions.deletePaste(null);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.records.autosync.state).toBe("forbidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      paste!.actions.retry("replacement");
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(deletes).toBe(2);
    expect(paste!.snapshot.paste.resource).toBe("deleted-root-handoff");
  });

  it("does not let Autosave Retry reissue a failed Delete without Delete recovery", async () => {
    vi.useFakeTimers();
    let deletes = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deletes += 1;
        return errorResponse(403, "FORBIDDEN");
      }
      return resourceResponse("initial");
    }));
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");
    await clickButton(rendered, "Delete");
    await clickButton(document.querySelector<HTMLElement>("[role=dialog]")!, "Delete");
    await vi.waitFor(() => expect(rendered.querySelector('input[name="deleteCredential"]')).not.toBeNull());
    const autosaveRecovery = rendered.querySelector('section[aria-label="Autosave"]');
    if (autosaveRecovery !== null) await clickButton(autosaveRecovery, "Retry");
    expect(deletes).toBe(1);
    expect(rendered.querySelector('section[aria-label="Autosave"]')).toBeNull();
    expect(rendered.querySelector('section[aria-label="Delete"] input[name="deleteCredential"]')).not.toBeNull();
  });

  it("does not replay Delete from stale Settings Retry after failed Reconcile", async () => {
    vi.useFakeTimers();
    let deletes = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deletes += 1;
        return errorResponse(403, "FORBIDDEN");
      }
      if (init?.method === "PATCH") return uncertainWriteResponse();
      if (String(input).endsWith("/settings")) return jsonResponse(resourceBody("initial"), 200, { etag: '"generation.1"' });
      return resourceResponse("initial");
    }));
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");
    await setInput(rendered, 'input[name="title"]', "Changed");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(button(rendered, "Reconcile")).toBeDefined());
    await clickButton(rendered, "Reconcile");
    await vi.waitFor(() => expect(rendered.querySelector('button[data-settings-recovery-action="settings-title"]')).not.toBeNull());
    await clickButton(rendered, "Delete");
    await clickButton(document.querySelector<HTMLElement>("[role=dialog]")!, "Delete");
    await vi.waitFor(() => expect(rendered.querySelector('input[name="deleteCredential"]')).not.toBeNull());
    const staleRetry = rendered.querySelector<HTMLButtonElement>('button[data-settings-recovery-action="settings-title"]');
    if (staleRetry !== null && !staleRetry.disabled) await act(async () => { staleRetry.click(); await Promise.resolve(); });
    expect(deletes).toBe(1);
  });

  it("clears failed Settings recovery when a later content autosave starts", async () => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    let contentWrites = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH" && String(input).endsWith("/settings")) return uncertainWriteResponse();
      if (init?.method === "PATCH") {
        contentWrites += 1;
        return mutationResponse("unsaved draft", { version: "generation.2" });
      }
      if (String(input).endsWith("/settings")) return jsonResponse(resourceBody("initial"), 200, { etag: '"generation.1"' });
      return resourceResponse("initial");
    }));
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => {
      paste!.actions.saveTitle("Changed");
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.settings.result.state).toBe("reconciliation-required");
    await act(async () => {
      paste!.actions.reconcile();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.settings.result.state).toBe("retryable");
    await act(async () => {
      paste!.actions.autosaveInput("unsaved draft", 0);
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(contentWrites).toBe(1);
    expect(paste!.snapshot.settings.result.state).toBe("idle");
  });

  it("retains a successful Settings Reconcile outcome when queued content autosave begins", async () => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    let resolveSettings!: (response: Response) => void;
    const settings = new Promise<Response>((resolve) => { resolveSettings = resolve; });
    let contentWrites = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH" && String(input).endsWith("/settings")) return uncertainWriteResponse();
      if (init?.method === "PATCH") {
        contentWrites += 1;
        return mutationResponse("unsaved draft", { title: "Changed", version: "generation.3" });
      }
      if (String(input).endsWith("/settings")) return settings;
      return resourceResponse("initial");
    }));
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => {
      paste!.actions.saveTitle("Changed");
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.settings.result.state).toBe("reconciliation-required");
    await act(async () => {
      paste!.actions.reconcile();
      paste!.actions.autosaveInput("unsaved draft", 0);
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(contentWrites).toBe(0);
    await act(async () => {
      resolveSettings(jsonResponse(resourceBody("initial", { title: "Changed", version: "generation.2" }), 200, { etag: '"generation.2"' }));
      for (let step = 0; step < 30; step += 1) await Promise.resolve();
    });
    expect(contentWrites).toBe(1);
    expect(paste!.snapshot.settings.result.state).toBe("succeeded");
  });

  it("hides ContentRecovery while a relative-expiration Reconcile retry occupies the mutation slot", async () => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    let writes = 0;
    let reads = 0;
    let resolveRetry!: (response: Response) => void;
    const retry = new Promise<Response>((resolve) => { resolveRetry = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return ++writes === 1 ? uncertainWriteResponse() : retry;
      reads += 1;
      return reads === 1 ? errorResponse(403, "FORBIDDEN") : jsonResponse(resourceBody("initial"), 200, { etag: '"generation.1"' });
    }));
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => {
      paste!.actions.saveExpiration(60);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    await act(async () => {
      paste!.actions.reconcile();
      paste!.actions.sourceEvent({ type: "input", content: "local draft", eventAt: 0 });
      paste!.actions.autosaveInput("local draft", 0);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.paste.mutation.state).toBe("metadata-reconciliation");
    expect(paste!.snapshot.autosave.state).toBe("password-required");
    await act(async () => {
      paste!.actions.retry("replacement");
      for (let step = 0; step < 30; step += 1) await Promise.resolve();
    });
    expect(writes).toBe(2);
    expect(paste!.snapshot.paste.mutation.state).toBe("in-flight");
    expect(paste!.snapshot.contentRecoveryAllowed).toBe(false);
    resolveRetry(mutationResponse("initial", { version: "generation.2" }));
  });

  it("retains a dirty content Retry after Delete 403 without retrying Delete", async () => {
    vi.useFakeTimers();
    let deletes = 0;
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deletes += 1;
        return errorResponse(403, "FORBIDDEN");
      }
      if (init?.method === "PATCH") {
        writes.push(String(init.body));
        return mutationResponse("unsaved draft", { version: "generation.2" });
      }
      return resourceResponse("initial");
    }));
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Edit");
    await setInput(rendered, "textarea", "unsaved draft");
    await selectTab(rendered, "Settings");
    await clickButton(rendered, "Delete");
    await clickButton(document.querySelector<HTMLElement>("[role=dialog]")!, "Delete");
    await vi.waitFor(() => expect(rendered.querySelector('input[name="deleteCredential"]')).not.toBeNull());
    const recovery = rendered.querySelector('section[aria-label="Autosave"]');
    expect(recovery).not.toBeNull();
    await setInput(recovery, 'input[name="contentRetryCredential"]', "replacement");
    await clickButton(recovery, "Retry");
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(writes[0]!)).toMatchObject({ content: "unsaved draft", password: "replacement" });
    expect(deletes).toBe(1);
  });

  it("uses the ContentRecovery credential when retrying a forbidden content Reconcile", async () => {
    vi.useFakeTimers();
    const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return uncertainWriteResponse();
      reads.push(String(input));
      return reads.length === 1 ? errorResponse(403, "FORBIDDEN") : resourceResponse("initial");
    }));
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Edit");
    await act(async () => {
      const textarea = rendered.querySelector<HTMLTextAreaElement>("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "unsaved draft");
      const input = new Event("input", { bubbles: true });
      Object.defineProperty(input, "timeStamp", { value: 0 });
      textarea.dispatchEvent(input);
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    const recovery = rendered.querySelector('section[aria-label="Autosave"]');
    expect(recovery).not.toBeNull();
    await clickButton(recovery, "Reconcile");
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    await vi.waitFor(() => expect(recovery!.querySelector('input[name="contentRetryCredential"]')).not.toBeNull());
    await setInput(recovery, 'input[name="contentRetryCredential"]', "replacement");
    await clickButton(recovery, "Reconcile");
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    expect(new URL(reads[1]!, location.href).searchParams.get("password")).toBe("replacement");
  });

  it("keeps the replacement credential across an uncertain content Retry before Reconcile", async () => {
    vi.useFakeTimers();
    let writes = 0;
    const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return ++writes === 1 ? errorResponse(403, "FORBIDDEN") : uncertainWriteResponse();
      reads.push(String(input));
      return errorResponse(403, "FORBIDDEN");
    }));
    const rendered = await mountOrdinary("initial", "old");
    await selectTab(rendered, "Edit");
    await act(async () => {
      const textarea = rendered.querySelector<HTMLTextAreaElement>("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "unsaved draft");
      const input = new Event("input", { bubbles: true });
      Object.defineProperty(input, "timeStamp", { value: 0 });
      textarea.dispatchEvent(input);
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    const recovery = rendered.querySelector('section[aria-label="Autosave"]');
    await vi.waitFor(() => expect(recovery?.querySelector('input[name="contentRetryCredential"]')).not.toBeNull());
    await setInput(recovery, 'input[name="contentRetryCredential"]', "replacement");
    await clickButton(recovery, "Retry");
    await vi.waitFor(() => expect(writes).toBe(2));
    await vi.waitFor(() => expect(rendered.querySelector('section[aria-label="Autosave"] button')).not.toBeNull());
    await clickButton(rendered.querySelector('section[aria-label="Autosave"]'), "Reconcile");
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    expect(new URL(reads[0]!, location.href).searchParams.get("password")).toBe("replacement");
  });

  it("clears a rejected ContentRecovery credential before a blank Reconcile", async () => {
    vi.useFakeTimers();
    const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return uncertainWriteResponse();
      reads.push(String(input));
      return errorResponse(403, "FORBIDDEN");
    }));
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Edit");
    await act(async () => {
      const textarea = rendered.querySelector<HTMLTextAreaElement>("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "unsaved draft");
      const input = new Event("input", { bubbles: true });
      Object.defineProperty(input, "timeStamp", { value: 0 });
      textarea.dispatchEvent(input);
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    const recovery = rendered.querySelector('section[aria-label="Autosave"]');
    await clickButton(recovery, "Reconcile");
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    await setInput(recovery, 'input[name="contentRetryCredential"]', "wrong");
    await clickButton(recovery, "Reconcile");
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    await setInput(recovery, 'input[name="contentRetryCredential"]', "");
    await clickButton(recovery, "Reconcile");
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    expect(new URL(reads[1]!, location.href).searchParams.get("password")).toBe("wrong");
    expect(new URL(reads[2]!, location.href).searchParams.has("password")).toBe(false);
  });

  it("offers Settings credential recovery instead of a blocked content Retry during metadata Reconcile", async () => {
    vi.useFakeTimers();
    const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return uncertainWriteResponse();
      if (String(input).endsWith("/settings") || String(input).includes("/settings?")) {
        reads.push(String(input));
        return reads.length === 1 ? errorResponse(403, "FORBIDDEN") : jsonResponse(resourceBody("initial"), 200);
      }
      return resourceResponse("initial");
    }));
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");
    await setInput(rendered, 'input[name="title"]', "Changed");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(rendered.querySelector('[data-settings-result="reconciliation-required"]')).not.toBeNull());
    await selectTab(rendered, "Edit");
    await setInput(rendered, "textarea", "unsaved draft");
    await selectTab(rendered, "Settings");
    await clickButton(rendered, "Reconcile");
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    expect(rendered.querySelector('[data-settings-result="reconciliation-required"] input[name="retryCredential"]')).not.toBeNull();
    expect(rendered.querySelector('section[aria-label="Autosave"]')).toBeNull();
    await setInput(rendered, 'input[name="retryCredential"]', "replacement");
    const reconcile = rendered.querySelector<HTMLButtonElement>('button[data-settings-recovery-action="settings-reconcile"]');
    expect(reconcile?.disabled).toBe(false);
    await act(async () => { reconcile!.click(); await Promise.resolve(); });
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    expect(new URL(reads[1]!, location.href).searchParams.get("password")).toBe("replacement");
  });

  it("clears a rejected Settings Reconcile credential before a blank Reconcile", async () => {
    const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return uncertainWriteResponse();
      reads.push(String(input));
      return errorResponse(403, "FORBIDDEN");
    }));
    const rendered = await mountOrdinary();
    await selectTab(rendered, "Settings");
    await setInput(rendered, 'input[name="title"]', "Changed");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(rendered.querySelector('[data-settings-result="reconciliation-required"]')).not.toBeNull());
    const reconcile = async () => act(async () => {
      rendered.querySelector<HTMLButtonElement>('button[data-settings-recovery-action="settings-reconcile"]')!.click();
      await Promise.resolve();
    });
    await reconcile();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    await setInput(rendered, 'input[name="retryCredential"]', "wrong");
    await reconcile();
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    await setInput(rendered, 'input[name="retryCredential"]', "");
    await reconcile();
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    expect(new URL(reads[1]!, location.href).searchParams.get("password")).toBe("wrong");
    expect(new URL(reads[2]!, location.href).searchParams.has("password")).toBe(false);
  });

  it("resumes Autosync after a dirty content Retry resolves Delete 403", async () => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    let reads = 0;
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return errorResponse(403, "FORBIDDEN");
      if (init?.method === "PATCH") {
        writes.push(String(init.body));
        return mutationResponse("unsaved draft", { version: "generation.2" });
      }
      reads += 1;
      return resourceResponse("unsaved draft", { version: "generation.2" });
    }));
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => {
      paste!.actions.autosaveInput("unsaved draft", 0);
      paste!.actions.deletePaste(null);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.records.autosync.state).toBe("forbidden");
    await act(async () => {
      paste!.actions.retry("replacement", "content");
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toMatchObject({ content: "unsaved draft", password: "replacement" });
    expect(paste!.snapshot.records.autosync.state).toBe("waiting");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(reads).toBe(1);
  });

  it("resumes Autosync after an authorized save resolves a definite Delete 403", async () => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return errorResponse(403, "FORBIDDEN");
      if (init?.method === "PATCH") return mutationResponse("initial", { title: "saved", version: "generation.2" });
      reads += 1;
      return resourceResponse("initial", { title: "saved", version: "generation.2" });
    }));
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => {
      paste!.actions.deletePaste(null);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.records.autosync.state).toBe("forbidden");
    await act(async () => {
      paste!.actions.saveTitle("saved");
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
      paste!.actions.draftState("settings", false);
    });
    expect(paste!.snapshot.records.autosync.state).toBe("waiting");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(reads).toBe(1);
  });

  it("does not clear an earlier Autosync forbidden latch when Delete fails definitively", async () => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "DELETE" ? errorResponse(400, "BAD_REQUEST") : errorResponse(403, "FORBIDDEN")
    ));
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(paste!.snapshot.records.autosync.state).toBe("forbidden");
    await act(async () => {
      paste!.actions.deletePaste(null);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(paste!.snapshot.records.autosync.state).toBe("forbidden");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps Retry sync available after an earlier GET 403 and a definite Delete 400", async () => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    let reads = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return errorResponse(400, "BAD_REQUEST");
      reads += 1;
      return reads === 1 ? errorResponse(403, "FORBIDDEN") : resourceResponse("initial");
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(paste!.snapshot.candidate).toEqual({ kind: "forbidden", source: "" });
    await act(async () => {
      paste!.actions.deletePaste(null);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(paste!.snapshot.candidate).toEqual({ kind: "forbidden", source: "" });
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(reads).toBe(1);
    await act(async () => {
      paste!.actions.retrySync("replacement");
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(reads).toBe(2);
  });

  it.each(["deadline", "offline"] as const)("does not restore a forbidden Retry sync after Delete spans %s", async (boundary) => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    let resolveDelete: ((response: Response) => void) | undefined;
    const deletion = new Promise<Response>((resolve) => { resolveDelete = resolve; });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "DELETE" ? deletion : errorResponse(403, "FORBIDDEN")
    ));
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(paste!.snapshot.candidate?.kind).toBe("forbidden");
    await act(async () => {
      paste!.actions.deletePaste(null);
      await Promise.resolve();
    });
    expect(paste!.snapshot.candidate).toBeNull();
    if (boundary === "deadline") {
      await act(async () => { await vi.advanceTimersByTimeAsync(297_000); });
      expect(paste!.snapshot.records.autosync.state).toBe("inactive");
    } else {
      await act(async () => {
        window.dispatchEvent(new Event("offline"));
        await Promise.resolve();
      });
    }
    await act(async () => {
      resolveDelete!(errorResponse(400, "BAD_REQUEST"));
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.candidate).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    if (boundary === "offline") {
      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await Promise.resolve();
      });
      expect(paste!.snapshot.candidate?.kind).toBe("forbidden");
    }
  });

  it("restarts Autosync after a definite Delete validation failure releases its mutation slot", async () => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "DELETE" ? errorResponse(400, "BAD_REQUEST") : resourceResponse("initial")
    ));
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => {
      paste!.actions.deletePaste(null);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.records.autosync.state).toBe("waiting");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps Delete 409 in conflict until a confirmed Reload restores polling eligibility", async () => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "DELETE"
        ? errorResponse(409, "VERSION_CONFLICT")
        : resourceResponse("remote", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" })
    ));
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => {
      paste!.actions.deletePaste(null);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.records.autosync.state).toBe("conflict");
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      paste!.actions.reload();
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.records.autosync.state).toBe("waiting");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    [403, "FORBIDDEN", "forbidden"],
    [409, "VERSION_CONFLICT", "conflict"],
  ] as const)("retains Delete %s Autosync pause after an offline-online cycle", async (status, code, expected) => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    const fetchMock = vi.fn(async () => errorResponse(status, code));
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => {
      paste!.actions.deletePaste(null);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.records.autosync.state).toBe(expected);
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
      await Promise.resolve();
    });
    expect(paste!.snapshot.records.autosync.state).toBe("paused-offline");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
    });
    expect(paste!.snapshot.records.autosync.state).toBe(expected);
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, "FORBIDDEN", "forbidden"],
    [409, "VERSION_CONFLICT", "conflict"],
  ] as const)("keeps Autosync paused-offline when a pending Delete settles %s offline", async (status, code, expected) => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    let resolveDelete: ((response: Response) => void) | undefined;
    const deletion = new Promise<Response>((resolve) => { resolveDelete = resolve; });
    const fetchMock = vi.fn(async () => deletion);
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => {
      paste!.actions.deletePaste(null);
      window.dispatchEvent(new Event("offline"));
      await Promise.resolve();
    });
    expect(paste!.snapshot.records.autosync.state).toBe("paused-offline");
    await act(async () => {
      resolveDelete!(errorResponse(status, code));
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.records.autosync.state).toBe("paused-offline");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
    });
    expect(paste!.snapshot.records.autosync.state).toBe(expected);
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resumes Autosync after confirmed Reload resolves Delete 409 following GET 403", async () => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    let reads = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return errorResponse(409, "VERSION_CONFLICT");
      reads += 1;
      return reads === 1
        ? errorResponse(403, "FORBIDDEN")
        : resourceResponse("remote", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" });
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(paste!.snapshot.candidate?.kind).toBe("forbidden");
    await act(async () => {
      paste!.actions.deletePaste(null);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.paste.versionUsable).toBe(false);
    await act(async () => {
      paste!.actions.reload();
      for (let step = 0; step < 30; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.paste.versionUsable).toBe(true);
    expect(reads).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(reads).toBe(3);
  });

  it("restores Autosync when a confirmed Reload commits offline after GET 403 and Delete 409", async () => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    let resolveReload: ((response: Response) => void) | undefined;
    const reload = new Promise<Response>((resolve) => { resolveReload = resolve; });
    let reads = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return errorResponse(409, "VERSION_CONFLICT");
      reads += 1;
      if (reads === 1) return errorResponse(403, "FORBIDDEN");
      if (reads === 2) return reload;
      return resourceResponse("remote", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" });
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await act(async () => {
      paste!.actions.deletePaste(null);
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.paste.versionUsable).toBe(false);
    await act(async () => {
      paste!.actions.reload();
      await Promise.resolve();
      window.dispatchEvent(new Event("offline"));
      resolveReload!(await resourceResponse("remote", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" }));
      for (let step = 0; step < 30; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.paste.versionUsable).toBe(true);
    expect(paste!.snapshot.records.autosync.state).toBe("paused-offline");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(reads).toBe(3);
  });

  it("resumes Autosync after a successful same-identity Reload clears an earlier GET 403", async () => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    let reads = 0;
    const same = () => resourceResponse("initial", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-16T00:00:00.000Z" });
    const fetchMock = vi.fn(async () => {
      reads += 1;
      return reads === 2 ? errorResponse(403, "FORBIDDEN") : same();
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => {
      paste!.actions.reload();
      for (let step = 0; step < 30; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.paste.responseEtag).toMatch(/^"sha256-/);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(paste!.snapshot.records.autosync.state).toBe("forbidden");
    await act(async () => {
      paste!.actions.reload();
      for (let step = 0; step < 30; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.records.lastAction).toMatchObject({ key: "reload-server", state: "succeeded" });
    expect(reads).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(reads).toBe(4);
  });

  it("does not report Reload success from the same cached version after Delete 409", async () => {
    vi.useFakeTimers();
    let paste: UsePastePageResult | null = null;
    let reads = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return errorResponse(409, "VERSION_CONFLICT");
      reads += 1;
      return resourceResponse("remote", {
        version: reads === 3 ? "generation.3" : "generation.2",
        contentRevision: 2,
        updatedAt: reads === 3 ? "2026-09-16T00:00:01.000Z" : "2026-09-16T00:00:00.000Z",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      paste = usePastePage(ordinaryInitialPage() as Parameters<typeof usePastePage>[0]);
      return null;
    }
    await mount(<Probe />);
    await act(async () => {
      paste!.actions.reload();
      for (let step = 0; step < 25; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.paste.resource).toBe("active");
    expect(paste!.snapshot.paste.responseEtag).toMatch(/^"sha256-/);
    await act(async () => {
      paste!.actions.deletePaste(null);
      for (let step = 0; step < 50; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.paste.versionUsable).toBe(false);
    await act(async () => {
      paste!.actions.reload();
      for (let step = 0; step < 50; step += 1) await Promise.resolve();
    });
    expect(reads).toBe(2);
    expect(paste!.snapshot.paste.versionUsable).toBe(false);
    expect(paste!.snapshot.records.lastAction).toMatchObject({ key: "reload-server", state: "failed" });
    expect(paste!.snapshot.records.autosync.state).toBe("conflict");
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(reads).toBe(2);
    await act(async () => {
      paste!.actions.reload();
      for (let step = 0; step < 25; step += 1) await Promise.resolve();
    });
    expect(paste!.snapshot.paste.versionUsable).toBe(true);
    expect(paste!.snapshot.records.autosync.state).toBe("waiting");
  });

  it("preserves a not-found draft and terminates uncertain and successful deletes", async () => {
    vi.useFakeTimers();
    const notFound = vi.fn(async () => errorResponse(404, "PASTE_NOT_FOUND"));
    vi.stubGlobal("fetch", notFound);
    const missing = await mountOrdinary("draft");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await vi.waitFor(() => expect(missing.querySelector('[aria-label="Not found"]')).not.toBeNull());
    await clickButton(missing, "Source");
    expect(missing.querySelector("[data-local-source]")?.textContent).toBe("draft");
    unmount(missing);

    const uncertain = vi.fn(async () => { throw new TypeError("offline"); });
    vi.stubGlobal("fetch", uncertain);
    const deleting = await mountOrdinary("draft");
    await selectTab(deleting, "Settings");
    await clickButton(deleting, "Delete");
    await clickButton(document.querySelector<HTMLElement>("[role=dialog]")!, "Delete");
    await vi.waitFor(() => expect(deleting.querySelector('[aria-label="Delete uncertain"]')).not.toBeNull());
    await clickButton(deleting, "Source");
    expect(deleting.querySelector("[data-local-source]")?.textContent).toBe("draft");
    unmount(deleting);

    const deleted = vi.fn(async () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } }));
    vi.stubGlobal("fetch", deleted);
    const handoff = await mountOrdinary("draft", "secret");
    await selectTab(handoff, "Settings");
    await clickButton(handoff, "Delete");
    await clickButton(document.querySelector<HTMLElement>("[role=dialog]")!, "Delete");
    await vi.waitFor(() => expect(handoff.querySelector("#create-content")).not.toBeNull());
    expect(location.pathname).toBe("/");
    expect(new URL(location.href).search).toBe("");
    expect(handoff.querySelector("[data-server-controls]")).toBeNull();
  });

  it("acknowledges an in-flight save without publishing a mixed tuple or dropping a later draft", async () => {
    vi.useFakeTimers();
    let resolveSave: ((response: Response) => void) | undefined;
    const save = new Promise<Response>((resolve) => { resolveSave = resolve; });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return save;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);
    const records: Array<{ draft: string; acceptedSource: string; autosaveAcceptedSource: string; lastSavedContent: string; autosaveState: string }> = [];
    let page: UsePastePageResult | null = null;
    const initial = ordinaryInitialPage("initial") as Parameters<typeof usePastePage>[0];

    function Probe() {
      page = usePastePage(initial);
      const snapshot = page.snapshot;
      records.push({
        draft: snapshot.source,
        acceptedSource: snapshot.acceptedSource,
        autosaveAcceptedSource: snapshot.autosaveAcceptedSource,
        lastSavedContent: snapshot.lastSavedContent,
        autosaveState: snapshot.autosave.state,
      });
      return null;
    }

    await mount(<Probe />);
    await act(async () => { await Promise.resolve(); });
    expect(page).not.toBeNull();

    await act(async () => {
      page!.actions.sourceEvent({ type: "input", content: "A", eventAt: 0 });
      page!.actions.autosaveInput("A", 0);
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      page!.actions.sourceEvent({ type: "input", content: "B", eventAt: 1_001 });
      page!.actions.autosaveInput("B", 1_001);
      resolveSave!(mutationResponse("A", { version: "generation.2", contentRevision: 2, updatedAt: "2026-09-15T00:00:01.000Z" }));
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      if (!records.some((record) => record.draft === "B" && record.acceptedSource === "A")) throw new Error("acknowledged draft was not retained");
    });
    expect(records.every((record) => record.acceptedSource === record.autosaveAcceptedSource && record.acceptedSource === record.lastSavedContent)).toBe(true);
    expect(records.some((record) => record.draft === "A" && record.acceptedSource === "A")).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("publishes local copy completion through OperationStatus", async () => {
    let page: UsePastePageResult | null = null;
    const initial = ordinaryInitialPage("initial") as Parameters<typeof usePastePage>[0];
    function Probe() {
      page = usePastePage(initial);
      return null;
    }

    await mount(<Probe />);
    await act(async () => {
      page!.actions.localAction({ key: "copy", state: "pending", attempt: 1, startedAt: "2026-09-20T00:00:00.000Z" });
      page!.actions.localAction({ key: "copy", state: "succeeded", attempt: 1, startedAt: "2026-09-20T00:00:00.000Z", settledAt: "2026-09-20T00:00:01.000Z" });
      await Promise.resolve();
    });

    expect(page!.snapshot.records.lastAction).toEqual({ state: "succeeded", key: "copy", attempt: 1, startedAt: "2026-09-20T00:00:00.000Z", settledAt: "2026-09-20T00:00:01.000Z", outcomeKey: null });
  });

  it("routes the Copy control into OperationStatus", async () => {
    vi.spyOn(document, "execCommand").mockReturnValue(true);
    const rendered = await mountOrdinary("copy source");

    await clickButton(rendered, "Copy");

    await vi.waitFor(() => expect(rendered.querySelector('[data-operation-record="last-action"]')?.textContent).toContain("Copied"));
  });

  it("records post-load status instants and preserves the settled action across local controls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T00:00:00.000Z"));
    let reads = 0;
    let etag = "";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return mutationResponse("initial", { title: "Saved", version: "generation.2" });
      reads += 1;
      if (reads === 1) {
        const response = await resourceResponse("initial");
        etag = response.headers.get("etag")!;
        return response;
      }
      return new Response(null, { status: 304, headers: { "cache-control": "no-store", etag } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await mountOrdinary();
    vi.setSystemTime(new Date("2026-09-20T00:00:00.000Z"));
    expect(rendered.querySelector('[data-operation-record="autosave"] time')).toBeNull();
    expect(rendered.querySelector('[data-operation-record="autosync"] time')).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    const checkedAt = rendered.querySelector<HTMLTimeElement>('[data-operation-record="autosync"] time')?.dateTime;
    expect(checkedAt).toBe("2026-09-20T00:00:03.000Z");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(rendered.querySelector<HTMLTimeElement>('[data-operation-record="autosync"] time')?.dateTime).toBe("2026-09-20T00:00:06.000Z");

    await selectTab(rendered, "Settings");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(rendered.querySelector('[data-operation-record="last-action"] time')).not.toBeNull());
    const settled = rendered.querySelector('[data-operation-record="last-action"]')?.textContent;
    await selectTab(rendered, "View");
    await clickButton(rendered, "Wrap");
    const theme = rendered.querySelector("#document-theme") as unknown as HTMLSelectElement | null;
    expect(theme).not.toBeNull();
    await act(async () => {
      theme!.value = "dark";
      theme!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(rendered.querySelector('[data-operation-record="last-action"]')?.textContent).toBe(settled);
  });

  it("retains distinct Settings outcomes after a View remount", async () => {
    let patch = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") return resourceResponse("initial");
      patch += 1;
      return patch === 1
        ? mutationResponse("initial", { title: "Saved title", version: "generation.2" })
        : mutationResponse("initial", { title: "Saved title", format: "markdown", version: "generation.3" });
    }));
    const rendered = await mountOrdinary();

    await selectTab(rendered, "Settings");
    await setInput(rendered, 'input[name="title"]', "Saved title");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(button(rendered, "Title saved")).toBeDefined());
    const format = settingsSelect(rendered);
    await act(async () => {
      format.value = "markdown";
      format.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await clickButton(rendered, "Save format");
    await vi.waitFor(() => expect(button(rendered, "Format saved")).toBeDefined());

    await selectTab(rendered, "View");
    await selectTab(rendered, "Settings");

    expect(button(rendered, "Title saved")).toBeDefined();
    expect(button(rendered, "Format saved")).toBeDefined();
  });

  it("keeps the Settings recovery button mounted through its retry outcome", async () => {
    let resolveRetry: ((response: Response) => void) | undefined;
    let patch = 0;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") return resourceResponse("initial");
      patch += 1;
      if (patch === 1) return Promise.resolve(errorResponse(500, "INTERNAL_ERROR"));
      return new Promise<Response>((resolve) => { resolveRetry = resolve; });
    }));
    const rendered = await mountOrdinary();

    await selectTab(rendered, "Settings");
    await setInput(rendered, 'input[name="title"]', "Recovered title");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(button(rendered, "Retry")).toBeDefined());
    const retry = button(rendered, "Retry");
    await clickButton(rendered, "Retry");

    await vi.waitFor(() => expect(rendered.contains(retry)).toBe(true));
    expect(retry.textContent).toBe("Saving title");
    expect(retry.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(button(rendered, "Save title").querySelector('svg[aria-hidden="true"]')).toBeNull();

    await act(async () => {
      resolveRetry!(mutationResponse("initial", { title: "Recovered title", version: "generation.2" }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(retry.textContent).toBe("Title saved"));
    expect(retry.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it("binds reconciliation feedback to its recovery button without replacing field outcomes", async () => {
    let resolveReconcile: ((response: Response) => void) | undefined;
    let patch = 0;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patch += 1;
        return patch === 1
          ? Promise.resolve(mutationResponse("initial", { title: "Saved title", version: "generation.2" }))
          : Promise.resolve(uncertainWriteResponse());
      }
      if (init?.method === "GET") return new Promise<Response>((resolve) => { resolveReconcile = resolve; });
      return resourceResponse("initial");
    }));
    const rendered = await mountOrdinary();

    await selectTab(rendered, "Settings");
    await setInput(rendered, 'input[name="title"]', "Saved title");
    await clickButton(rendered, "Save title");
    await vi.waitFor(() => expect(button(rendered, "Title saved")).toBeDefined());
    const format = settingsSelect(rendered);
    await act(async () => {
      format.value = "markdown";
      format.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await clickButton(rendered, "Save format");
    await vi.waitFor(() => expect(rendered.querySelector('[data-settings-result="reconciliation-required"] button')).not.toBeNull());
    const reconcile = rendered.querySelector<HTMLButtonElement>('[data-settings-result="reconciliation-required"] button')!;
    expect(reconcile.textContent).toBe("Reconcile");
    await act(async () => {
      reconcile.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(reconcile.textContent).toBe("Reconciling settings"));
    expect(reconcile.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(button(rendered, "Title saved")).toBeDefined();
    expect(button(rendered, "Format failed")).toBeDefined();

    await act(async () => {
      resolveReconcile!(jsonResponse(resourceBody("initial", { title: "Saved title", format: "markdown", version: "generation.2" }), 200, { etag: '"generation.2"' }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(reconcile.textContent).toBe("Settings reconciled"));
    expect(reconcile.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(button(rendered, "Title saved")).toBeDefined();
    expect(button(rendered, "Format failed")).toBeDefined();
  });
});
