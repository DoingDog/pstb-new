import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import * as React from "react";
import type { ReactNode } from "react";
import type { TrustedMarkdownHtml } from "../bootstrap";
import type { SourceEvent } from "../contracts";
import type { PasteLinks } from "../../types";
import { OrdinaryPastePage } from "./OrdinaryPastePage";
import { ContentModes } from "./ContentModes";
import { MarkdownWorkbench } from "./MarkdownWorkbench";
import { PlaintextEditor } from "./PlaintextEditor";
import { LocalActions } from "./LocalActions";
import { useAutosave } from "../hooks/use-autosave";
import { AutosaveController, type AutosaveControllerApi, type AutosaveSaveRequest } from "../autosave";
import { prepareMarkdownVisual } from "../markdown";
import "../index.css";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const markdownModes = vi.hoisted(() => {
  type Options = {
    autosave: { input(content: string, eventAt: number): void };
    source: Pick<HTMLTextAreaElement, "value">;
    onCrepeChange(content: string, eventAt: number): void;
    onModeChange?(mode: "source" | "visual" | "preview"): void;
    onPreview?(preview: { source: string; html: string }): void;
    onVisualError?(error: { message: string; retry(): Promise<void> }): void;
  };
  type Deferred = { promise: Promise<void>; resolve(): void; reject(reason?: unknown): void };
  const instances: Array<{
    options: Options;
    enterVisual: ReturnType<typeof vi.fn>;
    enterPreview: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    retryVisual: ReturnType<typeof vi.fn>;
    emitChange(content: string, eventAt?: number): void;
    emitError(): void;
  }> = [];
  let nextVisual: Deferred | null = null;
  let nextDestroy: Deferred | null = null;
  const state = { useActual: false };

  const createDeferred = (): Deferred => {
    let resolve!: () => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<void>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    return { promise, resolve, reject };
  };

  const create = vi.fn((options: Options) => {
    const destroyWait = nextDestroy;
    nextDestroy = null;
    const retryVisual = vi.fn(async () => undefined);
    const instance = {
      options,
      enterSource: vi.fn(async () => { options.onModeChange?.("source"); }),
      enterVisual: vi.fn(async () => {
        const visualWait = nextVisual;
        nextVisual = null;
        await visualWait?.promise;
        options.onModeChange?.("visual");
      }),
      enterPreview: vi.fn(async () => {
        options.onPreview?.({ source: options.source.value, html: "<p>preview</p>" });
        options.onModeChange?.("preview");
      }),
      leaveVisual: vi.fn(async () => { options.onModeChange?.("source"); }),
      destroy: vi.fn(async () => { await destroyWait?.promise; }),
      retryVisual,
      emitChange(content: string, eventAt = 100): void {
        options.onCrepeChange(content, eventAt);
        options.autosave.input(content, eventAt);
      },
      emitError(): void {
        options.onVisualError?.({ message: "serialize failed", retry: retryVisual });
      },
    };
    instances.push(instance);
    return instance;
  });

  return {
    instances,
    state,
    create,
    deferVisual(): Deferred {
      nextVisual = createDeferred();
      return nextVisual;
    },
    deferDestroy(): Deferred {
      nextDestroy = createDeferred();
      return nextDestroy;
    },
    reset(): void {
      instances.splice(0);
      create.mockClear();
      state.useActual = false;
      nextVisual = null;
      nextDestroy = null;
    },
  };
});

vi.mock("../autosave", async (importOriginal) => {
  const original = await importOriginal<typeof import("../autosave")>();
  return {
    ...original,
    createAutosaveMarkdownModes: (...args: Parameters<typeof original.createAutosaveMarkdownModes>) =>
      markdownModes.state.useActual
        ? original.createAutosaveMarkdownModes(...args)
        : markdownModes.create(...args),
  };
});

type CrepeMethod = "create" | "destroy" | "getMarkdown";
type CrepeMethodFunction = () => unknown;
type CrepeControls = {
  active: Crepe | null;
  failGetMarkdown: boolean;
  getMarkdownCalls: number;
  destroyCalls: number;
  rejectCreate: boolean;
  rejectDestroy: boolean;
  restore(): void;
};

const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];
let crepeControls: CrepeControls | null = null;
let consoleErrors: Array<unknown[]> = [];

function mount(node: ReactNode): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  React.act(() => root.render(node));
  mounted.push({ root, host });
  return host;
}

function rerender(host: HTMLDivElement, node: ReactNode): void {
  const entry = mounted.find((value) => value.host === host);  if (entry === undefined) throw new Error("missing root");
  React.act(() => entry.root.render(node));
}

function unmount(host: HTMLDivElement): void {
  const index = mounted.findIndex((value) => value.host === host);
  if (index < 0) throw new Error("missing root");
  const [entry] = mounted.splice(index, 1);
  React.act(() => entry!.root.unmount());
  entry!.host.remove();
}

function key(target: EventTarget, value: string): void {
  React.act(() => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: value, key: value })));
}

function input(target: HTMLTextAreaElement, value: string): void {
  React.act(() => {
    target.value = value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function interceptCrepeMethod(
  method: CrepeMethod,
  wrap: (editor: Crepe, original: CrepeMethodFunction) => CrepeMethodFunction,
): () => void {
  const prototype = Crepe.prototype as unknown as object;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
  Object.defineProperty(prototype, method, {
    configurable: true,
    set(this: Crepe, original: CrepeMethodFunction) {
      Object.defineProperty(this, method, {
        configurable: true,
        writable: true,
        value: wrap(this, original),
      });
    },
  });
  return () => {
    if (descriptor === undefined) delete (prototype as Record<string, unknown>)[method];
    else Object.defineProperty(prototype, method, descriptor);
  };
}

function controlCrepe(): CrepeControls {
  const controls: CrepeControls = {
    active: null,
    failGetMarkdown: false,
    getMarkdownCalls: 0,
    destroyCalls: 0,
    rejectCreate: false,
    rejectDestroy: false,
    restore: () => undefined,
  };
  const restore = [
    interceptCrepeMethod("create", (editor, original) => async () => {
      controls.active = editor;
      if (controls.rejectCreate) throw new Error("create failed");
      return await original();
    }),
    interceptCrepeMethod("getMarkdown", (_editor, original) => () => {
      controls.getMarkdownCalls += 1;
      if (controls.failGetMarkdown) throw new Error("serialize failed");
      return original();
    }),
    interceptCrepeMethod("destroy", (_editor, original) => async () => {
      controls.destroyCalls += 1;
      const result = await original();
      if (controls.rejectDestroy) throw new Error("destroy failed");
      return result;
    }),
  ];
  controls.restore = () => {
    for (const undo of restore.reverse()) undo();
  };
  return controls;
}

function replaceVisualDocument(value: string): void {
  const editor = crepeControls?.active;
  if (editor === null || editor === undefined) throw new Error("missing Crepe editor");
  React.act(() => {
    editor.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const paragraph = view.state.schema.nodes.paragraph;
      if (paragraph === undefined) throw new Error("missing paragraph node");
      const content = value === "" ? undefined : view.state.schema.text(value);
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, paragraph.create(null, content)));
    });
  });
}

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function clickRole(role: "button" | "tab", name: string): Promise<void> {
  await React.act(async () => {
    await page.getByRole(role, { name }).click();
  });
}

async function press(key: string): Promise<void> {
  await React.act(async () => {
    await userEvent.keyboard(key);
  });
}

async function advanceTab(): Promise<void> {
  await React.act(async () => {
    await userEvent.tab();
  });
}

async function waitForCrepe(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (crepeControls?.active !== null && crepeControls?.active !== undefined) return;
    await React.act(async () => {
      await nextTask();
    });
  }
  throw new Error("missing Crepe editor");
}

function currentMarkdownTab(host: HTMLDivElement): string | null {
  return Array.from(host.querySelectorAll('[role="tab"]')).find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent ?? null;
}

async function waitForMarkdownTab(host: HTMLDivElement, target: string): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (currentMarkdownTab(host) === target) return;
    await React.act(async () => {
      await vi.dynamicImportSettled();
    });
    if (currentMarkdownTab(host) === target) return;
    await nextTask();
  }
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

beforeEach(() => {
  consoleErrors = vi.spyOn(console, "error").mock.calls;
});

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await React.act(async () => {
      entry.root.unmount();
      await vi.dynamicImportSettled();
    });
    entry.host.remove();
  }
  crepeControls?.restore();
  crepeControls = null;
  document.body.replaceChildren();
  markdownModes.reset();
  const actWarnings = consoleErrors.filter(
    ([message]) => typeof message === "string" && message.includes("not wrapped in act"),
  );
  vi.restoreAllMocks();
  vi.useRealTimers();
  expect(actWarnings).toHaveLength(0);
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
    await clickRole("tab", "Edit");
    const edit = Array.from(first.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent === "Edit") as HTMLElement;
    expect(edit.getAttribute("aria-selected")).toBe("true");
    unmount(first);

    const second = mount(<OrdinaryPastePage {...ordinaryPageProps({ format: "markdown", initialMarkdown: trustedHtml("<p>exact</p>") })} />);
    expect(second.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("View");
  });

  it("uses initial trusted Markdown only for the immutable initial source", () => {
    const first = ordinaryPageProps({
      format: "markdown",
      source: "# initial",
      acceptedSource: "# initial",
      autosaveAcceptedSource: "# initial",
      lastSavedContent: "# initial",
      initialMarkdown: trustedHtml("<h1>initial</h1>"),
    });
    const host = mount(<OrdinaryPastePage {...first} />);
    expect(host.querySelector("h1")?.textContent).toBe("initial");

    rerender(host, <OrdinaryPastePage {...ordinaryPageProps({
      format: "markdown",
      source: "# accepted later",
      acceptedSource: "# accepted later",
      autosaveAcceptedSource: "# accepted later",
      lastSavedContent: "# accepted later",
      initialMarkdown: trustedHtml("<h1>initial</h1>"),
    })} />);

    expect(host.querySelector("h1")).toBeNull();
    expect(host.querySelector("pre")?.textContent).toBe("# accepted later");
  });
});

it("keeps canonical draft editors separate from the committed derived view", () => {
  const props = {
    format: "text" as const,
    source: "draft",
    initialMarkdown: null,
    wrap: "off" as const,
    autosave: { input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() },
    onSourceEvent: vi.fn(),
    displaySource: "accepted",
    derivedGeneration: 4,
  };
  const host = mount(React.createElement(ContentModes, {
    ...props,
    mode: "view",
  } as unknown as React.ComponentProps<typeof ContentModes>));

  expect(host.querySelector("[data-plain-view]")?.textContent).toBe("accepted");

  rerender(host, React.createElement(ContentModes, {
    ...props,
    mode: "edit",
  } as unknown as React.ComponentProps<typeof ContentModes>));
  expect(host.querySelector("textarea")?.value).toBe("draft");
});

describe("Tabs keyboard", () => {
  it("uses automatic activation, roving focus, wrapping, Home, End, and normal Tab exit", async () => {
    const host = mount(<OrdinaryPastePage {...ordinaryPageProps()} />);
    const tab = (name: string) => Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]')).find((value) => value.textContent === name)!;

    await clickRole("tab", "View");
    await press("{ArrowRight}");
    expect(tab("Edit").getAttribute("aria-selected")).toBe("true");

    await press("{End}");
    expect(tab("Settings").getAttribute("aria-selected")).toBe("true");

    await press("{ArrowRight}");
    expect(tab("View").getAttribute("aria-selected")).toBe("true");
    await press("{Home}");
    expect(tab("View").tabIndex).toBe(0);
    await advanceTab();
    expect(document.activeElement).not.toBe(tab("View"));
  });
});
describe("plaintext autosave", () => {
  it("reports exact composition variants before matching autosave calls and suppresses duplicate input", () => {
    const events: Array<{ type: string; content: string; eventAt: number }> = [];
    const autosave = { input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() };
    const host = mount(<PlaintextEditor value="a" wrap="off" autosave={autosave} onSourceEvent={(event) => events.push(event)} />);
    const textarea = host.querySelector("textarea")!;

    React.act(() => textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    input(textarea, "中");
    React.act(() => textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    input(textarea, "中");

    expect(events.map((event) => event.type)).toEqual(["composition-start", "composition-input", "composition-end"]);
    expect(autosave.compositionStart).toHaveBeenCalledOnce();
    expect(autosave.input).toHaveBeenCalledOnce();
    expect(autosave.compositionEnd).toHaveBeenCalledOnce();
    expect(events.every((event) => Number.isFinite(event.eventAt))).toBe(true);
    expect(textarea.spellcheck).toBe(false);
    expect(textarea.wrap).toBe("off");
  });

  it("preserves exact CR, CRLF, and mixed-newline input and composition events", () => {
    const events: Array<{ type: string; content: string }> = [];
    const autosave = { input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() };
    const host = mount(<PlaintextEditor value="first" wrap="off" autosave={autosave} onSourceEvent={(event) => events.push(event)} />);
    const textarea = host.querySelector("textarea")!;
    let rawValue = "first";
    Object.defineProperty(textarea, "value", {
      configurable: true,
      get: () => rawValue,
      set: (value: string) => { rawValue = value; },
    });

    rawValue = "a\rb\r\nc";
    React.act(() => textarea.dispatchEvent(new Event("input", { bubbles: true })));
    rawValue = "a\rb\r\nc";
    React.act(() => textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    rawValue = "中\r\n文\r字";
    React.act(() => textarea.dispatchEvent(new Event("input", { bubbles: true })));
    rawValue = "中\r\n文\r字";
    React.act(() => textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));

    expect(events.map(({ type, content }) => [type, content])).toEqual([
      ["input", "a\rb\r\nc"],
      ["composition-start", "a\rb\r\nc"],
      ["composition-input", "中\r\n文\r字"],
      ["composition-end", "中\r\n文\r字"],
    ]);
    expect(autosave.input).toHaveBeenLastCalledWith("中\r\n文\r字", expect.any(Number));
    expect(autosave.compositionEnd).toHaveBeenLastCalledWith("中\r\n文\r字", expect.any(Number));
  });

  it("waits exactly 1,000 ms after ordinary and composition input", () => {
    vi.useFakeTimers();
    const requests: AutosaveSaveRequest[] = [];
    let ordinaryController: AutosaveControllerApi | null = null;
    const ordinary = mount(<AutosaveHarness identity="ordinary-debounce" requests={requests} onController={(controller) => { ordinaryController = controller; }} />);
    React.act(() => ordinaryController!.input("ordinary", performance.now()));
    React.act(() => vi.advanceTimersByTime(999));
    expect(requests).toEqual([]);
    React.act(() => vi.advanceTimersByTime(1));
    expect(requests).toEqual([{ action: "autosave", content: "ordinary", version: "g.1" }]);
    unmount(ordinary);

    let composedController: AutosaveControllerApi | null = null;
    mount(<AutosaveHarness identity="composition-debounce" requests={requests} onController={(controller) => { composedController = controller; }} />);
    React.act(() => {
      composedController!.compositionStart();
      composedController!.compositionEnd("composed input", performance.now());
    });
    React.act(() => vi.advanceTimersByTime(999));
    expect(requests).toHaveLength(1);
    React.act(() => vi.advanceTimersByTime(1));
    expect(requests).toEqual([
      { action: "autosave", content: "ordinary", version: "g.1" },
      { action: "autosave", content: "composed input", version: "g.1" },
    ]);
  });

  it("uses one controller for a paste identity, schedules once, and disposes before a remount", () => {
    vi.useFakeTimers();
    const requests: AutosaveSaveRequest[] = [];
    let firstController: AutosaveControllerApi | null = null;
    const first = mount(<AutosaveHarness identity="demo" requests={requests} onController={(controller) => { firstController = controller; }} />);
    React.act(() => firstController!.input("second", performance.now()));
    React.act(() => vi.advanceTimersByTime(999));
    expect(requests).toEqual([]);    unmount(first);
    React.act(() => vi.advanceTimersByTime(1_000));
    expect(requests).toEqual([]);

    let secondController: AutosaveControllerApi | null = null;
    mount(<AutosaveHarness identity="demo" requests={requests} onController={(controller) => { secondController = controller; }} />);
    React.act(() => secondController!.input("third", performance.now()));
    React.act(() => vi.advanceTimersByTime(1_000));
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
    await clickRole("button", "Edit draft");
    expect(host.querySelector("output")?.textContent).toBe("local draft");

    rerender(host, <MetadataAutosaveHarness source="first" version="g.2" />);
    await nextTask();

    expect(host.querySelector("output")?.textContent).toBe("local draft");
  });

  it("replaces a local draft when the authoritative source and version change", async () => {
    const host = mount(<MetadataAutosaveHarness source="first" version="g.1" />);
    await clickRole("button", "Edit draft");
    expect(host.querySelector("output")?.textContent).toBe("local draft");

    rerender(host, <MetadataAutosaveHarness source="server replacement" version="g.2" />);
    await nextTask();

    expect(host.querySelector("output")?.textContent).toBe("server replacement");
  });

  it("keeps the committed controller live through StrictMode effect replay", async () => {
    vi.useFakeTimers();
    const requests: AutosaveSaveRequest[] = [];
    let controller: AutosaveControllerApi | null = null;
    mount(<React.StrictMode><AutosaveHarness identity="strict" requests={requests} onController={(next) => { controller = next; }} /></React.StrictMode>);

    expect(controller).not.toBeNull();
    React.act(() => controller!.input("after replay", performance.now()));
    React.act(() => vi.advanceTimersByTime(1_000));

    expect(requests).toEqual([{ action: "autosave", content: "after replay", version: "g.1" }]);
  });

  it("does not dispose the committed controller from an abandoned identity render", async () => {
    const dispose = vi.spyOn(AutosaveController.prototype, "dispose");
    const blocked = new Promise<void>(() => undefined);
    const host = mount(<React.Suspense fallback={<output>loading</output>}><SuspendingAutosaveHarness identity="first" blocked={null} /></React.Suspense>);
    const entry = mounted.find((value) => value.host === host)!;

    React.act(() => {
      React.startTransition(() => entry.root.render(<React.Suspense fallback={<output>loading</output>}><SuspendingAutosaveHarness identity="second" blocked={blocked} /></React.Suspense>));
    });
    await nextTask();

    expect(host.querySelector("output")?.textContent).toBe("first");
    expect(dispose).not.toHaveBeenCalled();
  });
});

describe("Markdown lifecycle", () => {
  it("adopts a committed detached visual host", async () => {
    markdownModes.state.useActual = true;
    const prepared = await prepareMarkdownVisual("# target", document);
    const host = mount(React.createElement(MarkdownWorkbench, {
      source: "# target",
      initialMarkdown: null,
      wrap: "off",
      autosave: { input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() },
      onSourceEvent: vi.fn(),
      preparedVisual: prepared,
    } as unknown as React.ComponentProps<typeof MarkdownWorkbench>));

    try {
      await nextTask();
      expect(host.querySelector("[data-markdown-visual-host]")?.contains(prepared.root)).toBe(true);
    } finally {
      unmount(host);
      await prepared.dispose();
    }
  });

  it("keeps the later Preview request selected when a delayed Visual style load completes", async () => {
    let resolveStyle!: (value: unknown) => void;
    const style = new Promise<unknown>((resolve) => { resolveStyle = resolve; });
    const host = mount(<MarkdownWorkbench
      source="# source"
      initialSource="# source"
      initialMarkdown={null}
      wrap="off"
      autosave={{ input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() }}
      onSourceEvent={vi.fn()}
      loadCrepeStyle={() => style}
    />);

    await clickRole("tab", "Visual");
    await clickRole("tab", "Preview");
    resolveStyle({});
    await nextTask();
    await nextTask();

    expect(Array.from(host.querySelectorAll('[role="tab"]')).find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent).toBe("Preview");
  });

  it("does not create an editor after an unmounted style request resolves", async () => {
    let resolveStyle!: (value: unknown) => void;
    const style = new Promise<unknown>((resolve) => { resolveStyle = resolve; });
    const host = mount(<MarkdownWorkbench
      source="# source"
      initialSource="# source"
      initialMarkdown={null}
      wrap="off"
      autosave={{ input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() }}
      onSourceEvent={vi.fn()}
      loadCrepeStyle={() => style}
    />);

    await clickRole("tab", "Visual");
    const controller = markdownModes.instances[0]!;
    unmount(host);
    resolveStyle({});
    await nextTask();

    expect(controller.enterVisual).not.toHaveBeenCalled();
  });

  it("does not save when tabs change without a document transaction", async () => {
    const autosave = { input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() };
    const host = mount(<MarkdownWorkbench
      source="# source"
      initialSource="# source"
      initialMarkdown={null}
      wrap="off"
      autosave={autosave}
      onSourceEvent={vi.fn()}
      loadCrepeStyle={async () => undefined}
    />);

    await clickRole("tab", "Visual");
    await nextTask();
    await clickRole("tab", "Source");
    await nextTask();
    await clickRole("tab", "Preview");
    await nextTask();

    expect(host.querySelector("p")?.textContent).toBe("preview");
    expect(autosave.input).not.toHaveBeenCalled();
  });

  it("waits exactly 1,000 ms after an accepted visual transaction", async () => {
    const requests: AutosaveSaveRequest[] = [];
    mount(<VisualAutosaveHarness requests={requests} />);

    await clickRole("tab", "Visual");
    await nextTask();
    vi.useFakeTimers();
    React.act(() => markdownModes.instances[0]!.emitChange("visual transaction", performance.now()));
    React.act(() => vi.advanceTimersByTime(999));
    expect(requests).toEqual([]);
    React.act(() => vi.advanceTimersByTime(1));

    expect(requests).toEqual([{ action: "autosave", content: "visual transaction", version: "g.1" }]);
  });

  it("retries current CSS, editor initialization, and serialization failures", async () => {
    let failStyle = true;
    const initialization = markdownModes.deferVisual();
    const host = mount(<MarkdownWorkbench
      source="# source"
      initialSource="# source"
      initialMarkdown={null}
      wrap="off"
      autosave={{ input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() }}
      onSourceEvent={vi.fn()}
      loadCrepeStyle={() => failStyle ? Promise.reject(new Error("css failed")) : Promise.resolve()}
    />);

    await clickRole("tab", "Visual");
    await nextTask();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();

    failStyle = false;
    await clickRole("button", "Retry");
    await nextTask();
    await React.act(async () => {
      initialization.reject(new Error("editor failed"));
      await Promise.resolve();
    });
    await nextTask();
    await nextTask();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();

    await clickRole("button", "Retry");
    await nextTask();
    expect(markdownModes.instances[0]!.enterVisual).toHaveBeenCalledTimes(2);
  });

  it("retries a current visual serialization failure once", async () => {
    const host = mount(<MarkdownWorkbench
      source="# source"
      initialSource="# source"
      initialMarkdown={null}
      wrap="off"
      autosave={{ input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() }}
      onSourceEvent={vi.fn()}
      loadCrepeStyle={async () => undefined}
    />);

    await clickRole("tab", "Visual");
    await nextTask();
    const current = markdownModes.instances[0]!;
    React.act(() => current.emitError());
    expect(host.querySelector('[role="alert"]')).not.toBeNull();

    await clickRole("button", "Retry");
    await nextTask();
    expect(current.retryVisual).toHaveBeenCalledOnce();
  });

  it("accepts a newer visual serialization transaction after the current request fails", async () => {
    const autosave = { input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() };
    const events: string[] = [];
    mount(<MarkdownWorkbench
      source="# source"
      initialSource="# source"
      initialMarkdown={null}
      wrap="off"
      autosave={autosave}
      onSourceEvent={(event) => events.push(event.content)}
      loadCrepeStyle={async () => undefined}
    />);

    await clickRole("tab", "Visual");
    await nextTask();
    const current = markdownModes.instances[0]!;
    React.act(() => {
      current.emitError();
      current.emitChange("newer serializer", 102);
    });

    expect(events).toEqual(["newer serializer"]);
    expect(autosave.input).toHaveBeenCalledWith("newer serializer", 102);
  });

  it("retires an authoritative source owner and rejects its later transactions", async () => {
    const autosave = { input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() };
    const events: string[] = [];
    const props = (source: string) => <MarkdownWorkbench
      source={source}
      initialSource="first"
      initialMarkdown={null}
      wrap="off"
      autosave={autosave}
      onSourceEvent={(event) => events.push(event.content)}
      loadCrepeStyle={async () => undefined}
    />;
    const host = mount(props("first"));
    await nextTask();
    await clickRole("tab", "Visual");
    await nextTask();
    await nextTask();
    expect(markdownModes.instances).toHaveLength(1);
    const original = markdownModes.instances[0]!;
    expect(original.enterVisual).toHaveBeenCalledOnce();
    expect(Array.from(host.querySelectorAll('[role="tab"]')).find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent).toBe("Visual");

    React.act(() => original.emitChange("local", 101));
    rerender(host, props("local"));
    await React.act(async () => {
      await Promise.resolve();
    });
    expect(original.destroy).not.toHaveBeenCalled();

    rerender(host, props("server replacement"));
    await React.act(async () => {
      await Promise.resolve();
    });
    expect(original.destroy).toHaveBeenCalledOnce();
    expect(markdownModes.instances).toHaveLength(2);

    React.act(() => {
      original.emitChange("stale serializer", 102);
      original.emitError();
    });
    expect(events).toEqual(["local"]);
    expect(autosave.input).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("contains retired destroy failures without letting the retired owner publish", async () => {
    const teardown = markdownModes.deferDestroy();
    const events: string[] = [];
    const props = (source: string) => <MarkdownWorkbench
      source={source}
      initialSource="first"
      initialMarkdown={null}
      wrap="off"
      autosave={{ input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() }}
      onSourceEvent={(event) => events.push(event.content)}
      loadCrepeStyle={async () => undefined}
    />;
    const host = mount(props("first"));
    await clickRole("tab", "Visual");
    await nextTask();
    const retired = markdownModes.instances[0]!;

    rerender(host, props("server"));
    await nextTask();
    expect(retired.destroy).toHaveBeenCalledOnce();
    teardown.reject(new Error("destroy failed"));
    await nextTask();
    retired.emitChange("retired", 103);

    expect(events).toEqual([]);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(markdownModes.instances).toHaveLength(2);
  });

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
    await clickRole("tab", "Preview");
    expect(host.querySelector("h1")?.textContent).toBe("exact");
  });
});

describe("MarkdownWorkbench real Crepe ownership", () => {
  it("accepts a newer live-editor transaction after serializer failure and ignores its stale Retry", async () => {
    markdownModes.state.useActual = true;
    crepeControls = controlCrepe();
    const autosave = { input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() };
    const events: string[] = [];
    let staleRetry: HTMLButtonElement | null = null;
    let invokeStaleRetry = false;
    const host = mount(<RealMarkdownHarness
      autosave={autosave}
      onSourceEvent={(event) => {
        events.push(event.content);
        if (invokeStaleRetry) staleRetry?.click();
      }}
    />);

    await clickRole("tab", "Visual");
    await waitForCrepe();
    expect(crepeControls.active).not.toBeNull();

    crepeControls.failGetMarkdown = true;
    replaceVisualDocument("failed");
    await nextTask();
    await nextTask();
    staleRetry = host.querySelector<HTMLButtonElement>('[role="alert"] button');
    expect(staleRetry).not.toBeNull();
    expect(currentMarkdownTab(host)).toBe("Source");

    crepeControls.failGetMarkdown = false;
    invokeStaleRetry = true;
    replaceVisualDocument("newer");
    await waitForMarkdownTab(host, "Visual");

    expect(events).toEqual(["newer\n"]);
    expect(autosave.input).toHaveBeenCalledOnce();
    expect(autosave.input).toHaveBeenCalledWith("newer\n", expect.any(Number));
    expect(crepeControls.getMarkdownCalls).toBe(2);
    expect(currentMarkdownTab(host)).toBe("Visual");
  });

  it("publishes a recovered serializer once during a current Preview teardown", async () => {
    markdownModes.state.useActual = true;
    crepeControls = controlCrepe();
    const autosave = { input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() };
    const events: SourceEvent[] = [];
    const host = mount(<RealMarkdownHarness autosave={autosave} onSourceEvent={(event) => events.push(event)} />);

    await clickRole("tab", "Visual");
    await waitForCrepe();
    crepeControls.failGetMarkdown = true;
    replaceVisualDocument("recovered");
    await nextTask();
    await nextTask();
    expect(currentMarkdownTab(host)).toBe("Source");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();

    crepeControls.failGetMarkdown = false;
    await clickRole("tab", "Preview");
    await waitForMarkdownTab(host, "Preview");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "crepe-change", content: "recovered\n" });
    expect(autosave.input).toHaveBeenCalledTimes(1);
    expect(autosave.input).toHaveBeenCalledWith("recovered\n", events[0]!.eventAt);
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("recovered\n");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(currentMarkdownTab(host)).toBe("Preview");
  });

  it("falls back to Source when real Crepe create rejects and retries startup", async () => {
    markdownModes.state.useActual = true;
    crepeControls = controlCrepe();
    crepeControls.rejectCreate = true;
    const host = mount(<RealMarkdownHarness
      autosave={{ input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() }}
      onSourceEvent={() => undefined}
    />);

    await clickRole("tab", "Visual");
    await waitForCrepe();
    const failedEditor = crepeControls.active;
    await React.act(async () => {
      await nextTask();
      await nextTask();
    });

    expect(currentMarkdownTab(host)).toBe("Source");
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();

    crepeControls.rejectCreate = false;
    await clickRole("button", "Retry");
    for (let attempt = 0; attempt < 5 && crepeControls.active === failedEditor; attempt += 1) {
      await React.act(async () => {
        await nextTask();
      });
    }
    await waitForMarkdownTab(host, "Visual");

    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(crepeControls.active).not.toBe(failedEditor);
    expect(currentMarkdownTab(host)).toBe("Visual");
  });

  it.each(["Source", "Preview"] as const)("keeps the current %s teardown request recoverable", async (target) => {
    markdownModes.state.useActual = true;
    crepeControls = controlCrepe();
    const autosave = { input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() };
    const host = mount(<RealMarkdownHarness autosave={autosave} onSourceEvent={() => undefined} />);

    await clickRole("tab", "Visual");
    await waitForCrepe();
    replaceVisualDocument("visual");
    await nextTask();
    expect(autosave.input).toHaveBeenCalledOnce();

    crepeControls.failGetMarkdown = true;
    await clickRole("tab", target);
    await nextTask();
    await nextTask();

    expect(currentMarkdownTab(host)).toBe("Source");
    expect(crepeControls.getMarkdownCalls).toBe(2);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("visual\n");
    expect(crepeControls.destroyCalls).toBe(1);

    crepeControls.failGetMarkdown = false;
    await clickRole("button", "Retry");
    await waitForMarkdownTab(host, target);

    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(currentMarkdownTab(host)).toBe(target);
    expect(crepeControls.destroyCalls).toBe(1);
  });

  it("destroys the current editor once when teardown cleanup rejects", async () => {
    markdownModes.state.useActual = true;
    crepeControls = controlCrepe();
    const autosave = { input: vi.fn(), compositionStart: vi.fn(), compositionEnd: vi.fn() };
    const host = mount(<RealMarkdownHarness autosave={autosave} onSourceEvent={() => undefined} />);

    await clickRole("tab", "Visual");
    await waitForCrepe();
    replaceVisualDocument("visual");
    await nextTask();

    crepeControls.rejectDestroy = true;
    await clickRole("tab", "Source");
    await waitForMarkdownTab(host, "Source");

    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(crepeControls.destroyCalls).toBe(1);
  });
});

describe("ordinary direct actions", () => {
  it("copies source, downloads the exact binary Blob, and toggles editor wrapping", async () => {
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const host = mount(<OrdinaryPastePage {...ordinaryPageProps()} />);

    await clickRole("button", "Copy");
    await nextTask();
    expect(copy).toHaveBeenCalledWith("exact\r\nsource");

    await clickRole("button", "Download");
    await nextTask();
    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("application/octet-stream");
    expect(new TextDecoder().decode(await blob.arrayBuffer())).toBe("exact\r\nsource");
    expect(click).toHaveBeenCalledOnce();

    await clickRole("tab", "Edit");
    await clickRole("button", "Wrap");
    expect(host.querySelector("textarea")?.wrap).toBe("soft");
  });

  it("applies the Wrap action to ordinary Edit and Markdown Source layout", async () => {
    const source = `${"unbroken".repeat(160)}\n${"multiline".repeat(160)}`;
    const host = mount(<OrdinaryPastePage {...ordinaryPageProps({ source })} />);
    host.style.width = "480px";

    await clickRole("tab", "Edit");
    const edit = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(edit.wrap).toBe("off");
    expect(getComputedStyle(edit).whiteSpace).toBe("pre");
    expect(edit.scrollWidth).toBeGreaterThan(edit.clientWidth);

    await clickRole("button", "Wrap");
    expect(edit.wrap).toBe("soft");
    expect(getComputedStyle(edit).whiteSpace).toBe("pre-wrap");
    expect(edit.scrollWidth).toBeLessThanOrEqual(edit.clientWidth);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);

    await clickRole("tab", "Markdown");
    const markdownSource = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(markdownSource.wrap).toBe("soft");
    expect(getComputedStyle(markdownSource).whiteSpace).toBe("pre-wrap");
    expect(markdownSource.scrollWidth).toBeLessThanOrEqual(markdownSource.clientWidth);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
  });

  it("opens local HTML through a text/html Blob", async () => {
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:html");
    const navigation = { assign: vi.fn() };
    const host = mount(<LocalActions
      actionScope="html"
      source="<main>exact</main>"
      locale="en"
      filename="exact.html"
      capabilities={{ html: "blob" }}
      download={{ createObjectURL, revokeObjectURL: vi.fn(), dispatchDownload: vi.fn() }}
      navigation={navigation}
    />);

    React.act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("text/html");
    expect(await blob.text()).toBe("<main>exact</main>");
    expect(navigation.assign).toHaveBeenCalledWith("blob:html");
  });

  it("regenerates every credential-bearing representation href without settling direct navigation", () => {
    const states: string[] = [];
    const host = mount(<OrdinaryPastePage {...ordinaryPageProps({
      password: " +%&#? ",
      onActionState: (state) => states.push(state.state),
    })} />);
    for (const label of ["Raw", "HTML", "Markdown", "File"]) {
      const anchor = Array.from(host.querySelectorAll<HTMLAnchorElement>("a")).find((value) => value.textContent === label)!;
      expect(anchor.href).toContain("password=+%2B%25%26%23%3F+");
      expect(anchor.getAttribute("role")).toBeNull();
    }

    rerender(host, <OrdinaryPastePage {...ordinaryPageProps({
      password: "next",
      onActionState: (state) => states.push(state.state),
    })} />);
    for (const label of ["Raw", "HTML", "Markdown", "File"]) {
      const anchor = Array.from(host.querySelectorAll<HTMLAnchorElement>("a")).find((value) => value.textContent === label)!;
      expect(anchor.href).toContain("password=next");
    }
    expect(states).toEqual([]);
  });
});
function AutosaveHarness({ identity, requests, onController }: { identity: string; requests: AutosaveSaveRequest[]; onController?(controller: AutosaveControllerApi): void }) {
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
  React.useLayoutEffect(() => { onController?.(controller); }, [controller, onController]);
  return <PlaintextEditor value={source} wrap="off" autosave={controller} onSourceEvent={(event) => setSource(event.content)} />;
}

function VisualAutosaveHarness({ requests }: { requests: AutosaveSaveRequest[] }) {
  const [source, setSource] = React.useState("first");
  const { controller } = useAutosave({
    pasteIdentity: "visual-debounce",
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
  return <MarkdownWorkbench
    source={source}
    initialSource="first"
    initialMarkdown={null}
    wrap="off"
    autosave={controller}
    onSourceEvent={(event) => setSource(event.content)}
    loadCrepeStyle={async () => undefined}
  />;
}

function RealMarkdownHarness({
  autosave,
  onSourceEvent,
}: {
  autosave: { input(content: string, eventAt: number): void; compositionStart(): void; compositionEnd(): void };
  onSourceEvent(event: SourceEvent): void;
}) {
  const [source, setSource] = React.useState("first");
  return <MarkdownWorkbench
    source={source}
    initialSource="first"
    initialMarkdown={null}
    wrap="off"
    autosave={autosave}
    onSourceEvent={(event) => {
      onSourceEvent(event);
      setSource(event.content);
    }}
    loadCrepeStyle={async () => undefined}
  />;
}

function SuspendingAutosaveHarness({ identity, blocked }: { identity: string; blocked: Promise<void> | null }) {
  const { snapshot } = useAutosave({
    pasteIdentity: identity,
    acceptedSource: "first",
    version: "g.1",
    now: () => performance.now(),
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    tryDispatch: () => ({ kind: "blocked" }),
    onCoalescedIntent: () => undefined,
  });
  if (blocked !== null) throw blocked;
  return <output>{snapshot.acceptedSource}</output>;
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
