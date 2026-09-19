import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { act, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { InitialPage } from "./bootstrap";
import { App } from "./App";
import "./index.css";

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

function mount(node: ReactNode): HTMLDivElement {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  flushSync(() => root.render(node));
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
    flushSync(() => value.root.unmount());
    value.element.remove();
  }
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await page.viewport(1280, 720);
});

describe("App landmarks", () => {
  it.each(pages)("renders one main landmark and one heading for %s", (_name, initialPage) => {
    const rendered = mount(<App initialPage={initialPage} />);

    expect(rendered.querySelectorAll("main")).toHaveLength(1);
    expect(rendered.querySelectorAll("h1")).toHaveLength(1);
  });
});

describe("application motion", () => {
  it("keeps the sidebar trigger at least 44 CSS pixels at a 320 CSS pixel viewport", async () => {
    await page.viewport(320, 720);
    const rendered = mount(<App initialPage={pages[1]![1]} />);
    const trigger = rendered.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]');
    expect(trigger).not.toBeNull();

    const style = getComputedStyle(trigger!);
    expect(Number.parseFloat(style.width)).toBeGreaterThanOrEqual(44);
    expect(Number.parseFloat(style.height)).toBeGreaterThanOrEqual(44);
  });

  it("removes motion from the non-authorized sidebar trigger", () => {
    mount(<MotionFixture />);

    expectNoMotion(element('[data-slot="sidebar-trigger"]'));
  });

  it("caps Sheet motion at 120 milliseconds", () => {
    mount(<MotionFixture />);

    expectAllowedMotion(element('[data-slot="sheet-content"]'));
  });

  it("caps Dialog motion at 120 milliseconds", () => {
    mount(<MotionFixture />);

    expectAllowedMotion(element('[data-slot="dialog-content"]'));
  });

  it("removes all allowed motion when reduced motion is requested", async () => {
    mount(<MotionFixture />);
    await cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

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
      const rendered = mount(<App initialPage={initialPage} />);
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
    const rendered = mount(<App initialPage={ordinaryInitialPage("exact")} />);
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
  const rendered = mount(<App initialPage={ordinaryInitialPage(source, password)} />);
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

async function clickButton(root: any, label: string, occurrence = 0): Promise<void> {
  await act(async () => {
    button(root, label, occurrence).click();
    await Promise.resolve();
  });
}

async function selectTab(root: any, label: string): Promise<void> {
  await act(async () => {
    button(root, label).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
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
  flushSync(() => entry!.root.unmount());
  entry!.element.remove();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  history.replaceState(null, "", "/");
});

describe("Task 15 async lifecycle behavior", () => {
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    await selectTab(rendered, "Edit");
    expect(rendered.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("draft");
    expect(rendered.querySelector("[data-sync-candidate]")).not.toBeNull();
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
    await vi.waitFor(() => expect(rendered.querySelector("[data-plain-view]")?.textContent).toBe("remote"));
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
    for (const link of Array.from(rendered.querySelectorAll<HTMLAnchorElement>('a[href^="/raw/"]'))) {
      expect(new URL(link.href).searchParams.get("password")).toBe(password);
    }

    unmount(rendered);
    const remounted = await mountOrdinary("initial", password);
    for (const link of Array.from(remounted.querySelectorAll<HTMLAnchorElement>('a[href^="/raw/"]'))) {
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
    await setInput(rendered, "textarea", "draft");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { rejectSave!(new TypeError("offline")); await Promise.resolve(); });
    await selectTab(rendered, "Settings");
    await vi.waitFor(() => expect(button(rendered, "Reconcile")).toBeDefined());
    await clickButton(rendered, "Reconcile");
    await vi.waitFor(() => expect(rendered.querySelector('[aria-label="Consumed"]')).not.toBeNull());
    await clickButton(rendered, "Source");
    expect(rendered.querySelector("[data-local-source]")?.textContent).toBe("consumed");
    expect(rendered.querySelector("[data-operation-record=last-action]")?.textContent).toContain("Content reconciliation completed");
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
    await clickButton(deleting, "Settings");
    await clickButton(deleting, "Delete");
    await clickButton(document.querySelector<HTMLElement>("[role=dialog]")!, "Delete");
    await vi.waitFor(() => expect(deleting.querySelector('[aria-label="Delete uncertain"]')).not.toBeNull());
    await clickButton(deleting, "Source");
    expect(deleting.querySelector("[data-local-source]")?.textContent).toBe("draft");
    unmount(deleting);

    const deleted = vi.fn(async () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } }));
    vi.stubGlobal("fetch", deleted);
    const handoff = await mountOrdinary("draft", "secret");
    await clickButton(handoff, "Settings");
    await clickButton(handoff, "Delete");
    await clickButton(document.querySelector<HTMLElement>("[role=dialog]")!, "Delete");
    await vi.waitFor(() => expect(handoff.querySelector("#create-content")).not.toBeNull());
    expect(location.pathname).toBe("/");
    expect(new URL(location.href).search).toBe("");
    expect(handoff.querySelector("[data-server-controls]")).toBeNull();
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
});
