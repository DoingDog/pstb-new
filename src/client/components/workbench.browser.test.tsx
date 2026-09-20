import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import * as React from "react";
import type { ReactNode } from "react";
import { dictionaries } from "../../i18n";
import type { TrustedMarkdownHtml } from "../bootstrap";
import type { OperationRecords } from "../contracts";
import { App } from "../App";
import { HelpProvider, HelpTrigger } from "./HelpTrigger";
import { LocalActions, type LocalActionCapabilities, type LocalActionsProps } from "./LocalActions";
import { OperationStatus } from "./OperationStatus";
import { SafeMarkdown } from "./SafeMarkdown";
import { WorkbenchShell } from "./WorkbenchShell";
import "../index.css";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; element: HTMLDivElement }> = [];
let consoleErrors: Array<unknown[]> = [];

beforeEach(() => {
  consoleErrors = vi.spyOn(console, "error").mock.calls;
});

function mount(node: ReactNode): HTMLDivElement {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  React.act(() => root.render(node));
  mounted.push({ root, element });
  return element;
}

async function mountApp(node: ReactNode): Promise<HTMLDivElement> {
  const element = mount(node);
  await React.act(async () => {
    await vi.dynamicImportSettled();
  });
  return element;
}

function records(overrides: Partial<OperationRecords> = {}): OperationRecords {
  return {
    autosave: { state: "clean", confirmedAt: null, failedAt: null },
    autosync: { state: "waiting", stateChangedAt: null, checkedAt: null, appliedAt: null },
    network: { state: "online", changedAt: "2026-09-13T10:00:00.000Z" },
    lastAction: { state: "idle" },
    ...overrides,
  };
}

function click(button: Element): void {
  React.act(() => (button as HTMLButtonElement).click());
}

function pointer(target: EventTarget, type: string, pointerType = "mouse"): void {
  React.act(() => target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, pointerId: 1, isPrimary: true })));
}

function pointerClick(target: Element, pointerType: "mouse" | "touch"): void {
  pointer(target, "pointerdown", pointerType);
  pointer(target, "pointerup", pointerType);
  click(target);
}

function rerender(element: HTMLDivElement, node: ReactNode): void {
  const mountedRoot = mounted.find((value) => value.element === element);
  if (mountedRoot === undefined) throw new Error("missing mounted root");
  React.act(() => mountedRoot.root.render(node));
}

function unmount(element: HTMLDivElement): void {
  const index = mounted.findIndex((value) => value.element === element);
  if (index === -1) throw new Error("missing mounted root");
  const [mountedRoot] = mounted.splice(index, 1);
  React.act(() => mountedRoot!.root.unmount());
  mountedRoot!.element.remove();
}

function key(target: EventTarget, value: string): void {
  React.act(() => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: value })));
}

async function nextFrame(): Promise<void> {
  await React.act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

function tooltip(descriptionId: string): HTMLElement {
  const value = document.getElementById(descriptionId);
  expect(value).not.toBeNull();
  return value!;
}

function openTooltips(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="tooltip"]')).filter((value) => value.dataset.state !== "closed");
}

afterEach(() => {
  for (const value of mounted.splice(0)) {
    React.act(() => value.root.unmount());
    value.element.remove();
  }
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
  const actWarnings = consoleErrors.filter(
    ([message]) => typeof message === "string" && message.includes("not wrapped in act"),
  );
  vi.restoreAllMocks();
  expect(actWarnings).toHaveLength(0);
});

describe("HelpTrigger", () => {
  it("opens one controlled help tooltip and closes it for Escape and outside interaction", async () => {
    const rendered = mount(
      <HelpProvider>
        <HelpTrigger label="Content help" content="Stored exactly as entered." descriptionId="content-help" />
        <HelpTrigger label="Format help" content="Choose a format." descriptionId="format-help" />
        <button type="button">Outside</button>
      </HelpProvider>,
    );
    const buttons = Array.from(rendered.querySelectorAll("button")) as HTMLButtonElement[];
    expect(buttons).toHaveLength(3);
    const content = buttons[0]!;
    const format = buttons[1]!;

    expect(content.getAttribute("aria-describedby")).toBe("content-help");
    React.act(() => content.focus());
    await nextFrame();
    expect(tooltip("content-help").textContent).toContain("Stored exactly as entered.");
    expect(openTooltips()).toHaveLength(1);
    const tooltipRoot = document.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(Number.parseFloat(getComputedStyle(tooltipRoot).maxWidth)).toBeLessThanOrEqual(352);

    click(content);
    pointer(content, "pointerout");
    expect(openTooltips()).toHaveLength(1);
    click(format);
    await nextFrame();
    expect(openTooltips()).toHaveLength(1);
    expect(document.getElementById("content-help")).toBeNull();

    key(format, "Escape");
    await nextFrame();
    expect(openTooltips()).toHaveLength(0);
    expect(document.activeElement).toBe(format);

    pointer(content, "pointerover");
    await nextFrame();
    expect(openTooltips()).toHaveLength(1);
    pointer(rendered.querySelector("button:last-child")!, "pointerdown");
    await nextFrame();
    expect(openTooltips()).toHaveLength(0);
  });

  it("closes a pinned tooltip on a second mouse click or touch tap", async () => {
    const rendered = mount(
      <HelpProvider>
        <HelpTrigger label="Content help" content="Stored exactly as entered." descriptionId="content-help" />
      </HelpProvider>,
    );
    const trigger = rendered.querySelector("button")!;

    pointerClick(trigger, "mouse");
    await nextFrame();
    expect(openTooltips()).toHaveLength(1);
    pointerClick(trigger, "mouse");
    await nextFrame();
    expect(openTooltips()).toHaveLength(0);

    pointerClick(trigger, "touch");
    await nextFrame();
    expect(openTooltips()).toHaveLength(1);
    pointerClick(trigger, "touch");
    await nextFrame();
    expect(openTooltips()).toHaveLength(0);
  });

  it("enforces visible copy policy", () => {
    const rendered = mount(
      <HelpProvider>
        <WorkbenchShell
          locale="en"
          breadcrumb={["Paste", "New"]}
          headingId="document-heading"
          destinationGroups={[]}
        >
          <h1 id="document-heading" tabIndex={-1}>New paste</h1>
          <HelpTrigger
            label="Content help"
            content={dictionaries.en.help.contentStorage}
            descriptionId="content-storage-help"
          />
        </WorkbenchShell>
      </HelpProvider>,
    );

    const visible = rendered.textContent ?? "";
    expect(visible).not.toContain(dictionaries.en.help.contentStorage);
    expect(visible).not.toMatch(/README\.md|Changes|Files|sample|workspace|dashboard|marketing/i);
    expect(openTooltips()).toHaveLength(0);
  });
});

describe("OperationStatus", () => {
  it("uses only the timestamp selected by each record state", () => {
    const rendered = mount(
      <OperationStatus
        locale="en"
        pageIdentity="status-test"
        ordinary
        records={records({
          autosave: {
            state: "error",
            confirmedAt: "2026-09-13T08:00:00.000Z",
            failedAt: "2026-09-13T09:00:00.000Z",
          },
          autosync: {
            state: "remote-applied",
            stateChangedAt: "2026-09-13T08:00:00.000Z",
            checkedAt: "2026-09-13T09:00:00.000Z",
            appliedAt: "2026-09-13T10:00:00.000Z",
          },
          lastAction: {
            state: "succeeded",
            key: "copy",
            attempt: 1,
            startedAt: "2026-09-13T08:00:00.000Z",
            settledAt: "2026-09-13T11:00:00.000Z",
            outcomeKey: null,
          },
        })}
      />,
    );

    expect(rendered.querySelector('[data-operation-record="autosave"] time')?.getAttribute("datetime")).toBe("2026-09-13T09:00:00.000Z");
    expect(rendered.querySelector('[data-operation-record="autosync"] time')?.getAttribute("datetime")).toBe("2026-09-13T10:00:00.000Z");
    expect(rendered.querySelector('[data-operation-record="network"] time')?.getAttribute("datetime")).toBe("2026-09-13T10:00:00.000Z");
    expect(rendered.querySelector('[data-operation-record="last-action"] time')?.getAttribute("datetime")).toBe("2026-09-13T11:00:00.000Z");

    const initial = mount(<OperationStatus locale="en" pageIdentity="status-test" ordinary records={records()} />);
    expect(initial.querySelector('[data-operation-record="autosave"] time')).toBeNull();
    expect(initial.querySelector('[data-operation-record="autosync"] time')).toBeNull();
    expect(initial.querySelector('[data-operation-record="last-action"] time')).toBeNull();
  });

  it("uses terminal outcomes only with their supplied settled state", () => {
    const terminal = records({
      lastAction: {
        state: "succeeded",
        key: "reload-server",
        attempt: 2,
        startedAt: "2026-09-13T08:00:00.000Z",
        settledAt: "2026-09-13T09:00:00.000Z",
        outcomeKey: "reload-terminal-response-displayed",
      },
    });
    const rendered = mount(<OperationStatus locale="en" pageIdentity="status-test" ordinary={false} records={terminal} />);
    expect(rendered.textContent).toContain(dictionaries.en.terminal["reload-terminal-response-displayed"]);

  });
});

describe("local workbench boundaries", () => {
  it("renders only trusted Markdown as HTML", () => {
    const rendered = mount(<SafeMarkdown html={"<strong>trusted</strong>" as TrustedMarkdownHtml} />);
    expect(rendered.querySelector("strong")?.textContent).toBe("trusted");
  });

  it("copies, downloads exact UTF-8 source, and navigates to local HTML without a request", async () => {
    const calls: Array<{ key: string; state: string }> = [];
    const urls: Blob[] = [];
    const assigned: string[] = [];
    const copied: string[] = [];
    const rendered = mount(localActions({
      locale: "en",
      source: "π",
      filename: "document.txt",
      clipboard: { writeText: async (value: string) => { copied.push(value); } },
      download: {
        createObjectURL: (blob: Blob) => { urls.push(blob); return `blob:local-${urls.length}`; },
        revokeObjectURL: () => undefined,
        dispatchDownload: () => undefined,
      },
      navigation: { assign: (url: string) => { assigned.push(url); } },
      capabilities: { copy: true, download: true, html: "blob" },
      onActionState: (value: { key: string; state: string }) => calls.push(value),
    }));

    click(Array.from(rendered.querySelectorAll("button")).find((button) => button.textContent === "Copy")!);
    await settle();
    expect(copied).toEqual(["π"]);

    click(Array.from(rendered.querySelectorAll("button")).find((button) => button.textContent === "Download")!);
    await settle();
    expect(await urls[0]!.text()).toBe("π");
    expect(urls[0]!.type).toBe("application/octet-stream");

    click(Array.from(rendered.querySelectorAll("button")).find((button) => button.textContent === "Open HTML locally")!);
    expect(await urls[1]!.text()).toBe("π");
    expect(urls[1]!.type).toBe("text/html");
    expect(assigned).toEqual(["blob:local-2"]);
    expect(calls.filter((value) => value.key === "copy")).toHaveLength(2);
    expect(calls.some((value) => value.key === "download")).toBe(true);
  });

  it("updates document-local locale and theme controls", async () => {
    const rendered = await mountApp(<App initialPage={{ ok: true, bootstrap: { page: "create", locale: "en" }, password: null }} />);
    const selects = Array.from(rendered.querySelectorAll("select")) as HTMLSelectElement[];
    expect(selects.length).toBeGreaterThanOrEqual(2);
    const language = selects[0]!;
    const theme = selects[1]!;
    const controlLabels = dictionaries[language.value as "en" | "zh-CN"].labels;
    expect(rendered.querySelector(`label[for="${language.id}"] > span`)?.textContent).toBe(controlLabels.locale);
    expect(rendered.querySelector(`label[for="${theme.id}"] > span`)?.textContent).toBe(controlLabels.theme);

    React.act(() => {
      language.value = "zh-CN";
      language.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.title).toContain("创建剪贴板");

    React.act(() => {
      theme.value = "dark";
      theme.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

function localActions(props: Record<string, unknown>): ReactNode {
  return React.createElement(LocalActions as unknown as React.ComponentType<Record<string, unknown>>, { actionScope: "test-page", ...props });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await React.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("LocalActions regressions", () => {
  it("renders only requested capabilities and delegates controlled source controls", () => {
    const wrapped: boolean[] = [];
    const sourceVisible: boolean[] = [];
    const rendered = mount(localActions({
      source: "exact source",
      locale: "en",
      filename: "document.txt",
      capabilities: {
        copy: true,
        wrap: { value: false, onChange: (value: boolean) => wrapped.push(value) },
        sourcePreview: {
          sourceVisible: false,
          onSourceVisibleChange: (value: boolean) => sourceVisible.push(value),
          preview: <article data-preview-surface="true">Preview surface</article>,
        },
      },
    }));

    expect(rendered.textContent).toContain("Copy");
    expect(rendered.textContent).not.toContain("Download");
    expect(rendered.textContent).not.toContain("Open HTML locally");
    expect(rendered.querySelector("[data-preview-surface]")).not.toBeNull();
    click(Array.from(rendered.querySelectorAll("button")).find((button) => button.textContent === "Wrap")!);
    click(Array.from(rendered.querySelectorAll("button")).find((button) => button.textContent === "Source")!);
    expect(wrapped).toEqual([true]);
    expect(sourceVisible).toEqual([true]);
  });

  it("renders a typed server HTML capability instead of a Blob HTML action", () => {
    const capabilities: LocalActionCapabilities = { html: { href: "/p/demo.html?password=p", label: "HTML representation" } };
    const noLegacyNavigation: LocalActionsProps = {
      actionScope: "test-page",
      source: "exact source",
      locale: "en",
      filename: "document.txt",
      capabilities,
      // @ts-expect-error HTML navigation is only available through capabilities.html.
      representationHref: "/p/demo/raw",
    };
    void noLegacyNavigation;
    const rendered = mount(
      <LocalActions
        actionScope="test-page"
        source="exact source"
        locale="en"
        filename="document.txt"
        capabilities={capabilities}
      />,
    );

    expect(rendered.querySelector('a[href="/p/demo.html?password=p"]')?.textContent).toBe("HTML representation");
    expect(rendered.textContent).not.toContain("Open HTML locally");
  });

  it("preserves CR and CRLF clipboard bytes and cleans fallback nodes after false or throw", async () => {
    const copied: string[] = [];
    vi.spyOn(document, "execCommand").mockImplementation(() => {
      const event = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { setData: (_type: string, value: string) => copied.push(value) } });
      document.dispatchEvent(event);
      return true;
    });
    const rendered = mount(localActions({
      source: "a\rb\r\nc",
      locale: "en",
      filename: "document.txt",
      clipboard: { writeText: async () => { throw new Error("clipboard unavailable"); } },
      capabilities: { copy: true },
    }));
    const copy = rendered.querySelector("button")!;
    copy.focus();
    click(copy);
    await settle();
    expect(copied).toEqual(["a\rb\r\nc"]);
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(copy);

    vi.spyOn(document, "execCommand").mockReturnValue(false);
    const falseResult = mount(localActions({
      source: "a\r\nb",
      locale: "en",
      filename: "document.txt",
      clipboard: { writeText: async () => { throw new Error("clipboard unavailable"); } },
      capabilities: { copy: true },
    }));
    click(falseResult.querySelector("button")!);
    await settle();
    expect(document.querySelector("textarea")).toBeNull();

    vi.spyOn(document, "execCommand").mockImplementation(() => { throw new Error("copy failed"); });
    const thrownResult = mount(localActions({
      source: "a\rb",
      locale: "en",
      filename: "document.txt",
      clipboard: { writeText: async () => { throw new Error("clipboard unavailable"); } },
      capabilities: { copy: true },
    }));
    click(thrownResult.querySelector("button")!);
    await settle();
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("serializes a pending action with the same key", () => {
    const copy = deferred<void>();
    const clipboard = vi.fn(() => copy.promise);
    const rendered = mount(localActions({
      source: "exact source",
      locale: "en",
      filename: "document.txt",
      clipboard: { writeText: clipboard },
      capabilities: { copy: true },
    }));
    const button = rendered.querySelector("button")!;
    click(button);
    click(button);
    expect(clipboard).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer cross-key action as the reported last action", async () => {
    const copy = deferred<void>();
    const calls: Array<{ key: string; state: string }> = [];
    const rendered = mount(localActions({
      source: "exact source",
      locale: "en",
      filename: "document.txt",
      clipboard: { writeText: () => copy.promise },
      download: { createObjectURL: () => "blob:download", revokeObjectURL: () => undefined, dispatchDownload: () => undefined },
      capabilities: { copy: true, download: true },
      onActionState: (value: { key: string; state: string }) => calls.push(value),
    }));
    click(Array.from(rendered.querySelectorAll("button")).find((button) => button.textContent === "Copy")!);
    click(Array.from(rendered.querySelectorAll("button")).find((button) => button.textContent === "Download")!);
    await settle();
    copy.reject(new Error("copy failed"));
    await settle();
    expect(calls.at(-1)).toMatchObject({ key: "download", state: "succeeded" });
  });

  it("does not report a local action settlement after unmount", async () => {
    const copy = deferred<void>();
    const calls: Array<{ key: string; state: string }> = [];
    const rendered = mount(localActions({
      source: "exact source",
      locale: "en",
      filename: "document.txt",
      clipboard: { writeText: () => copy.promise },
      capabilities: { copy: true },
      onActionState: (value: { key: string; state: string }) => calls.push(value),
    }));
    click(rendered.querySelector("button")!);
    unmount(rendered);
    copy.resolve();
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ key: "copy", state: "pending" });
  });

  it("invalidates pending actions when their action scope changes", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const firstStates: Array<{ state: string }> = [];
    const secondStates: Array<{ state: string }> = [];
    const firstClipboard = vi.fn(() => first.promise);
    const secondClipboard = vi.fn(() => second.promise);
    const rendered = mount(localActions({
      actionScope: "document-a",
      source: "first source",
      locale: "en",
      filename: "first.txt",
      clipboard: { writeText: firstClipboard },
      capabilities: { copy: true },
      onActionState: (value: { state: string }) => firstStates.push(value),
    }));
    click(rendered.querySelector("button")!);

    rerender(rendered, localActions({
      actionScope: "document-b",
      source: "second source",
      locale: "en",
      filename: "second.txt",
      clipboard: { writeText: secondClipboard },
      capabilities: { copy: true },
      onActionState: (value: { state: string }) => secondStates.push(value),
    }));
    click(rendered.querySelector("button")!);
    expect(secondClipboard).toHaveBeenCalledTimes(1);

    first.resolve();
    await settle();
    expect(firstStates).toHaveLength(1);
    expect(firstStates[0]).toMatchObject({ state: "pending" });
    expect(secondStates).toHaveLength(1);
    expect(secondStates[0]).toMatchObject({ state: "pending" });

    second.resolve();
    await settle();
    expect(secondStates.map((value) => value.state)).toEqual(["pending", "succeeded"]);
  });

  it("does not fall back to copying a rejected stale scope", async () => {
    const first = deferred<void>();
    const firstStates: Array<{ state: string }> = [];
    const secondStates: Array<{ state: string }> = [];
    const copied: string[] = [];
    const fallback = vi.spyOn(document, "execCommand").mockImplementation(() => {
      const event = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { setData: (_type: string, value: string) => copied.push(value) } });
      document.dispatchEvent(event);
      return true;
    });
    const rendered = mount(localActions({
      actionScope: "document-a",
      source: "first source",
      locale: "en",
      filename: "first.txt",
      clipboard: { writeText: () => first.promise },
      capabilities: { copy: true },
      onActionState: (value: { state: string }) => firstStates.push(value),
    }));
    click(rendered.querySelector("button")!);

    rerender(rendered, localActions({
      actionScope: "document-b",
      source: "second source",
      locale: "en",
      filename: "second.txt",
      clipboard: { writeText: async (value: string) => { copied.push(value); } },
      capabilities: { copy: true },
      onActionState: (value: { state: string }) => secondStates.push(value),
    }));
    click(rendered.querySelector("button")!);
    await settle();
    first.reject(new Error("clipboard unavailable"));
    await settle();

    expect(fallback).not.toHaveBeenCalled();
    expect(copied).toEqual(["second source"]);
    expect(secondStates.map((value) => value.state)).toEqual(["pending", "succeeded"]);
    expect(firstStates.map((value) => value.state)).toEqual(["pending"]);
  });

  it("releases download Blob URLs after dispatch and dispatch failure", async () => {
    const revoked: string[] = [];
    const success = mount(localActions({
      source: "exact source",
      locale: "en",
      filename: "document.txt",
      download: {
        createObjectURL: () => "blob:success",
        revokeObjectURL: (url: string) => revoked.push(url),
        dispatchDownload: () => undefined,
      },
      capabilities: { download: true },
    }));
    click(success.querySelector("button")!);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revoked).toEqual(["blob:success"]);

    const failure = mount(localActions({
      source: "exact source",
      locale: "en",
      filename: "document.txt",
      download: {
        createObjectURL: () => "blob:failure",
        revokeObjectURL: (url: string) => revoked.push(url),
        dispatchDownload: () => { throw new Error("dispatch failed"); },
      },
      capabilities: { download: true },
    }));
    click(failure.querySelector("button")!);
    await settle();
    expect(revoked).toEqual(["blob:success", "blob:failure"]);
  });

  it("contains delayed Blob cleanup errors after successful dispatch", async () => {
    const states: Array<{ state: string }> = [];
    const errors: ErrorEvent[] = [];
    const onError = (event: ErrorEvent) => {
      errors.push(event);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      const rendered = mount(localActions({
        source: "exact source",
        locale: "en",
        filename: "document.txt",
        download: {
          createObjectURL: () => "blob:success",
          revokeObjectURL: () => { throw new Error("revoke failed"); },
          dispatchDownload: () => undefined,
        },
        capabilities: { download: true },
        onActionState: (value: { state: string }) => states.push(value),
      }));
      click(rendered.querySelector("button")!);
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(states.map((value) => value.state)).toEqual(["pending", "succeeded"]);
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener("error", onError);
    }
  });
});

describe("AppSidebar regressions", () => {
  it("keeps real navigation, metadata, and action groups in collapsibles", () => {
    const rendered = mount(
      <WorkbenchShell
        locale="en"
        breadcrumb={["Paste"]}
        headingId="document-heading"
        destinationGroups={[{ id: "views", label: "Views", destinations: [{ id: "view", label: "View", selected: true }] }]}
        metadata={[{ label: "ID", value: "demo" }]}
        actionGroups={[{ id: "actions", label: "Actions", content: <button type="button">Copy</button> }]}
      >
        <h1 id="document-heading">Paste</h1>
      </WorkbenchShell>,
    );
    click(rendered.querySelector("[data-sidebar=trigger]")!);
    expect(document.querySelectorAll("[data-slot=collapsible]")).toHaveLength(3);
  });

  it("centers the 44 px rail and divider on the sidebar edge when expanded and collapsed", async () => {
    await page.viewport(1024, 768);
    const rendered = mount(
      <WorkbenchShell locale="en" breadcrumb={["Paste"]} headingId="document-heading" destinationGroups={[]}>
        <h1 id="document-heading">Paste</h1>
      </WorkbenchShell>,
    );
    const rail = rendered.querySelector<HTMLElement>("[data-sidebar=rail]")!;
    const container = rail.closest<HTMLElement>("[data-slot=sidebar-container]")!;
    const divider = getComputedStyle(rail, "::after");
    const expanded = rail.getBoundingClientRect();
    const expandedContainer = container.getBoundingClientRect();
    expect(expanded.width).toBe(44);
    expect(expanded.left + expanded.width / 2).toBeCloseTo(expandedContainer.right, 1);
    expect(expanded.left + Number.parseFloat(divider.left)).toBeCloseTo(expandedContainer.right, 1);
    expect(divider.width).toBe("2px");

    click(rendered.querySelector("[data-sidebar=trigger]")!);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const collapsed = rail.getBoundingClientRect();
    const collapsedContainer = container.getBoundingClientRect();
    expect(collapsed.width).toBe(44);
    expect(collapsed.left + collapsed.width / 2).toBeCloseTo(collapsedContainer.right, 1);
    expect(collapsed.left + Number.parseFloat(getComputedStyle(rail, "::after").left)).toBeCloseTo(collapsedContainer.right, 1);
  });
});

describe("OperationStatus regressions", () => {
  it("announces every changed raw record without locale or page-structure pseudo-events", async () => {
    const initial = records();
    const rendered = mount(<OperationStatus locale="en" pageIdentity="status-test" ordinary records={initial} />);
    await nextFrame();

    const changed = records({
      autosync: { state: "paused-offline", stateChangedAt: "2026-09-13T11:00:00.000Z", checkedAt: null, appliedAt: null },
      network: { state: "offline", changedAt: "2026-09-13T11:00:00.000Z" },
    });
    rerender(rendered, <OperationStatus locale="en" pageIdentity="status-test" ordinary records={changed} />);
    await nextFrame();
    const announcement = rendered.querySelector<HTMLElement>("[data-operation-announcement]")!;
    expect(announcement.textContent).toContain("Autosync: Paused offline");
    expect(announcement.textContent).toContain("Network: Offline");

    rerender(rendered, <OperationStatus locale="zh-CN" pageIdentity="status-test" ordinary records={changed} />);
    await nextFrame();
    expect(announcement.textContent).toBe("");

    rerender(rendered, <OperationStatus locale="zh-CN" pageIdentity="status-test" ordinary={false} records={changed} />);
    await nextFrame();
    expect(announcement.textContent).toBe("");
  });

  it("emits a DOM event for equal-text action attempts", async () => {
    const rendered = mount(<OperationStatus locale="en" pageIdentity="document" ordinary records={records()} />);
    await nextFrame();
    const first = records({
      lastAction: { state: "pending", key: "copy", attempt: 1, startedAt: "2026-09-13T10:00:00.000Z" },
    });
    rerender(rendered, <OperationStatus locale="en" pageIdentity="document" ordinary records={first} />);
    await nextFrame();
    const live = rendered.querySelector<HTMLElement>("[data-operation-announcement]")!;
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((entries) => mutations.push(...entries));
    observer.observe(live, { childList: true, characterData: true, subtree: true });

    const second = records({
      lastAction: { state: "pending", key: "copy", attempt: 2, startedAt: "2026-09-13T10:00:00.000Z" },
    });
    rerender(rendered, <OperationStatus locale="en" pageIdentity="document" ordinary records={second} />);
    await nextFrame();
    observer.disconnect();
    expect(mutations.length).toBeGreaterThan(0);
  });

  it("does not announce records with identical semantic values in a different property order", async () => {
    const timestamp = "2026-09-13T10:00:00.000Z";
    const rendered = mount(<OperationStatus locale="en" pageIdentity="document" ordinary={false} records={records({ network: { state: "online", changedAt: timestamp } })} />);
    await nextFrame();
    rerender(rendered, <OperationStatus locale="en" pageIdentity="document" ordinary={false} records={records({ network: { changedAt: timestamp, state: "online" } })} />);
    await nextFrame();
    expect(rendered.querySelector("[data-operation-announcement]")?.textContent).toBe("");
  });

  it("silently replaces page baselines with the same visible record shape", async () => {
    const first = records({ network: { state: "online", changedAt: "2026-09-13T10:00:00.000Z" } });
    const second = records({ network: { state: "online", changedAt: "2026-09-13T11:00:00.000Z" } });
    const nonordinary = mount(<OperationStatus locale="en" pageIdentity="nonordinary-a" ordinary={false} records={first} />);
    await nextFrame();
    rerender(nonordinary, <OperationStatus locale="en" pageIdentity="nonordinary-b" ordinary={false} records={second} />);
    await nextFrame();
    expect(nonordinary.querySelector("[data-operation-announcement]")?.textContent).toBe("");

    const ordinary = mount(<OperationStatus locale="en" pageIdentity="document-a" ordinary records={first} />);
    await nextFrame();
    rerender(ordinary, <OperationStatus locale="en" pageIdentity="document-b" ordinary records={second} />);
    await nextFrame();
    expect(ordinary.querySelector("[data-operation-announcement]")?.textContent).toBe("");
  });

  it("uses the visible 13 px status typography in light and dark themes", () => {
    const rendered = mount(<OperationStatus locale="en" pageIdentity="status-test" ordinary records={records()} />);
    const list = rendered.querySelector("dl")!;
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.theme = theme;
      const style = getComputedStyle(list);
      expect(style.fontSize).toBe("13px");
      expect(Number.parseFloat(style.lineHeight)).toBeCloseTo(18.85, 2);
    }
  });
});

describe("App metadata regression", () => {
  it("renders all ordinary lifecycle metadata from the bootstrap summary", async () => {
    const expiresAt = "2026-09-20T10:00:00.000Z";
    const rendered = await mountApp(<App initialPage={{
      ok: true,
      bootstrap: {
        page: "paste",
        locale: "en",
        consumed: false,
        paste: {
          id: "demo",
          title: "Demo",
          format: "text",
          viewOnce: true,
          protected: true,
          createdAt: null,
          updatedAt: "2026-09-13T10:00:00.000Z",
          expiresAt,
          expiration: { kind: "absolute" },
          version: "v1",
          contentRevision: 3,
          contentBytes: 42,
          createdCountry: null,
          links: { view: "/p/demo", raw: "/p/demo/raw", html: "/p/demo.html", markdown: "/p/demo.md", file: "/p/demo/file" },
        },
      },
      exactSource: "source",
      initialMarkdown: null,
      password: null,
    } as never} />);
    click(rendered.querySelector("[data-sidebar=trigger]")!);
    const locale = rendered.querySelector("select") as HTMLSelectElement;
    React.act(() => {
      locale.value = "en";
      locale.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("View once");
    expect(text).toContain("Enabled");
    expect(text).toContain("Expires");
    expect(text).toContain(new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(expiresAt)));
    expect(text).toContain("Size");
    expect(text).toContain("42 bytes");
  });
});
