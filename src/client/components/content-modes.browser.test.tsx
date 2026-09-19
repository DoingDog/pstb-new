import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import * as React from "react";
import type { ReactNode } from "react";
import type { TrustedMarkdownHtml } from "../bootstrap";
import type { PasteLinks } from "../../types";
import { OrdinaryPastePage } from "./OrdinaryPastePage";
import { MarkdownWorkbench } from "./MarkdownWorkbench";
import { PlaintextEditor } from "./PlaintextEditor";
import { useAutosave } from "../hooks/use-autosave";
import type { AutosaveSaveRequest } from "../autosave";

const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];

function mount(node: ReactNode): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  mounted.push({ root, host });
  return host;
}

function rerender(host: HTMLDivElement, node: ReactNode): void {
  const entry = mounted.find((value) => value.host === host);  if (entry === undefined) throw new Error("missing root");
  flushSync(() => entry.root.render(node));
}

function unmount(host: HTMLDivElement): void {
  const index = mounted.findIndex((value) => value.host === host);
  if (index < 0) throw new Error("missing root");
  const [entry] = mounted.splice(index, 1);
  flushSync(() => entry!.root.unmount());
  entry!.host.remove();
}

function key(target: EventTarget, value: string): void {
  flushSync(() => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: value, key: value })));
}

function input(target: HTMLTextAreaElement, value: string): void {
  flushSync(() => {
    target.value = value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function trustedHtml(value: string): TrustedMarkdownHtml {
  return value as TrustedMarkdownHtml;
}

const links: PasteLinks = {
  view: "/demo",
  raw: "/raw/demo?existing=1",  html: "/html/demo",
  markdown: "/md/demo",
  file: "/file/demo",
};

function ordinaryPageProps(overrides: Partial<React.ComponentProps<typeof OrdinaryPastePage>> = {}): React.ComponentProps<typeof OrdinaryPastePage> {
  const source = overrides.source ?? "exact\r\nsource";
  return {
    pasteIdentity: "demo",
    format: "text",
    source,
    acceptedSource: source,
    version: "g.1",
    autosaveAcceptedSource: source,
    lastSavedContent: source,
    autosaveState: "clean",
    initialMarkdown: null,
    links,
    password: null,
    locale: "en",
    autosave: { input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() },
    onSourceEvent: vi.fn(),
    historyPanel: <p>History panel</p>,
    settingsPanel: <p>Settings panel</p>,
    passwordPanel: null,
    deleteFlow: null,
    ...overrides,
  };
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {    flushSync(() => entry.root.unmount());
    entry.host.remove();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("default content mode", () => {
  it("uses format-defined default content mode without a client renderer", () => {
    const importBrowserMarkdown = vi.fn();
    const host = mount(<OrdinaryPastePage {...ordinaryPageProps({
      format: "markdown",
      source: "# exact",
      acceptedSource: "# exact",
      autosaveAcceptedSource: "# exact",
      lastSavedContent: "# exact",
      initialMarkdown: trustedHtml("<h1>exact</h1>"),
      importBrowserMarkdown,
    })} />);

    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("View");
    expect(host.querySelector("h1")?.textContent).toBe("exact");
    expect(importBrowserMarkdown).not.toHaveBeenCalled();
  });

  it("resets a hard remount to the format-defined view instead of the prior client tab", async () => {
    const first = mount(<OrdinaryPastePage {...ordinaryPageProps()} />);
    await page.getByRole("tab", { name: "Edit" }).click();
    const edit = Array.from(first.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent === "Edit") as HTMLElement;
    expect(edit.getAttribute("aria-selected")).toBe("true");
    unmount(first);

    const second = mount(<OrdinaryPastePage {...ordinaryPageProps({ format: "markdown", initialMarkdown: trustedHtml("<p>exact</p>") })} />);
    expect(second.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("View");
  });
});

describe("Tabs keyboard", () => {
  it("uses automatic activation, roving focus, wrapping, Home, End, and normal Tab exit", async () => {
    const host = mount(<OrdinaryPastePage {...ordinaryPageProps()} />);
    const tab = (name: string) => Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]')).find((value) => value.textContent === name)!;

    await page.getByRole("tab", { name: "View" }).click();
    await userEvent.keyboard("{ArrowRight}");
    expect(tab("Edit").getAttribute("aria-selected")).toBe("true");

    await userEvent.keyboard("{End}");
    expect(tab("Settings").getAttribute("aria-selected")).toBe("true");

    await userEvent.keyboard("{ArrowRight}");
    expect(tab("View").getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{Home}");
    expect(tab("View").tabIndex).toBe(0);
    await userEvent.tab();
    expect(document.activeElement).not.toBe(tab("View"));
  });
});
describe("plaintext autosave", () => {
  it("reports exact composition variants before matching autosave calls and suppresses duplicate input", () => {
    const events: Array<{ type: string; content: string; eventAt: number }> = [];
    const autosave = { input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() };
    const host = mount(<PlaintextEditor value="a" wrap="off" autosave={autosave} onSourceEvent={(event) => events.push(event)} />);
    const textarea = host.querySelector("textarea")!;

    flushSync(() => textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    input(textarea, "中");
    flushSync(() => textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    input(textarea, "中");

    expect(events.map((event) => event.type)).toEqual(["composition-start", "composition-input", "composition-end"]);
    expect(autosave.compositionStart).toHaveBeenCalledOnce();
    expect(autosave.input).toHaveBeenCalledOnce();
    expect(autosave.compositionEnd).toHaveBeenCalledOnce();
    expect(events.every((event) => Number.isFinite(event.eventAt))).toBe(true);
    expect(textarea.spellcheck).toBe(false);
    expect(textarea.wrap).toBe("off");
  });

  it("uses one controller for a paste identity, schedules once, and disposes before a remount", () => {
    vi.useFakeTimers();
    const requests: AutosaveSaveRequest[] = [];
    const first = mount(<AutosaveHarness identity="demo" requests={requests} />);
    input(first.querySelector("textarea")!, "second");
    vi.advanceTimersByTime(999);
    expect(requests).toEqual([]);    unmount(first);
    vi.advanceTimersByTime(1_000);
    expect(requests).toEqual([]);

    const second = mount(<AutosaveHarness identity="demo" requests={requests} />);
    input(second.querySelector("textarea")!, "third");
    vi.advanceTimersByTime(1_000);
    expect(requests).toEqual([{ action: "autosave", content: "third", version: "g.1" }]);
  });
});

describe("useAutosave authoritative state", () => {
  it("keeps the new identity snapshot after a hard remount render", () => {
    const host = mount(<AutosaveSnapshotHarness identity="one" source="first" version="g.1" />);
    expect(host.querySelector("output")?.textContent).toBe("first");

    rerender(host, <AutosaveSnapshotHarness identity="two" source="second" version="g.2" />);
    rerender(host, <AutosaveSnapshotHarness identity="two" source="second" version="g.2" />);

    expect(host.querySelector("output")?.textContent).toBe("second");
  });

  it("preserves a local draft when only authoritative metadata changes", async () => {
    const host = mount(<MetadataAutosaveHarness source="first" version="g.1" />);
    await page.getByRole("button", { name: "Edit draft" }).click();
    expect(host.querySelector("output")?.textContent).toBe("local draft");

    rerender(host, <MetadataAutosaveHarness source="first" version="g.2" />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.querySelector("output")?.textContent).toBe("local draft");
  });
});

describe("Markdown lifecycle", () => {
  it("keeps source mode available while visual and preview own separate mode surfaces", async () => {
    const host = mount(<MarkdownWorkbench
      source={"# exact\r\n"}
      initialSource={"# exact\r\n"}
      initialMarkdown={trustedHtml("<h1>exact</h1>")}
      wrap="off"
      autosave={{ input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() }}
      onSourceEvent={vi.fn()}
    />);

    expect(host.querySelector('[role="tab"]')?.textContent).toBe("Source");
    expect(host.querySelector('[role="tab"][aria-controls*="visual"]')).not.toBeNull();
    await page.getByRole("tab", { name: "Preview" }).click();
    expect(host.querySelector("h1")?.textContent).toBe("exact");
  });
});

describe("ordinary direct actions", () => {
  it("regenerates credential-bearing anchors without settling direct HTML navigation", () => {
    const states: string[] = [];
    const host = mount(<OrdinaryPastePage {...ordinaryPageProps({
      password: " +%&#? ",
      onActionState: (state) => states.push(state.state),
    })} />);
    const html = Array.from(host.querySelectorAll<HTMLAnchorElement>("a")).find((anchor) => anchor.textContent === "HTML")!;
    expect(html.href).toContain("password=+%2B%25%26%23%3F+");
    expect(html.getAttribute("role")).toBeNull();

    rerender(host, <OrdinaryPastePage {...ordinaryPageProps({
      password: "next",
      onActionState: (state) => states.push(state.state),
    })} />);
    const replaced = Array.from(host.querySelectorAll<HTMLAnchorElement>("a")).find((anchor) => anchor.textContent === "HTML")!;
    expect(replaced.href).toContain("password=next");
    expect(states).toEqual([]);
  });
});
function AutosaveHarness({ identity, requests }: { identity: string; requests: AutosaveSaveRequest[] }) {
  const [source, setSource] = React.useState("first");
  const { controller } = useAutosave({
    pasteIdentity: identity,
    acceptedSource: "first",
    version: "g.1",
    now: () => performance.now(),
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    tryDispatch: (request) => {
      requests.push(request);
      return { kind: "started", completion: new Promise(() => {}) };
    },
    onCoalescedIntent: () => undefined,
  });
  return <PlaintextEditor value={source} wrap="off" autosave={controller} onSourceEvent={(event) => setSource(event.content)} />;
}

function AutosaveSnapshotHarness({ identity, source, version }: { identity: string; source: string; version: string }) {
  const { snapshot } = useAutosave({
    pasteIdentity: identity,
    acceptedSource: source,
    version,
    now: () => performance.now(),
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    tryDispatch: () => ({ kind: "blocked" }),
    onCoalescedIntent: () => undefined,
  });
  return <output>{snapshot.acceptedSource}</output>;
}

function MetadataAutosaveHarness({ source, version }: { source: string; version: string }) {
  const { controller, snapshot } = useAutosave({
    pasteIdentity: "metadata",
    acceptedSource: source,
    version,
    now: () => performance.now(),
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    tryDispatch: () => ({ kind: "blocked" }),
    onCoalescedIntent: () => undefined,
  });
  return <><button type="button" onClick={() => controller.input("local draft", performance.now())}>Edit draft</button><output>{snapshot.draft}</output></>;
}
