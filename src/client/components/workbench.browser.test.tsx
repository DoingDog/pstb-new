import { afterEach, describe, expect, it } from "vitest";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { dictionaries } from "../../i18n";
import type { TrustedMarkdownHtml } from "../bootstrap";
import type { OperationRecords } from "../contracts";
import { App } from "../App";
import { HelpProvider, HelpTrigger } from "./HelpTrigger";
import { LocalActions } from "./LocalActions";
import { OperationStatus } from "./OperationStatus";
import { SafeMarkdown } from "./SafeMarkdown";
import { WorkbenchShell } from "./WorkbenchShell";
import "../index.css";

const mounted: Array<{ root: Root; element: HTMLDivElement }> = [];

function mount(node: ReactNode): HTMLDivElement {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  flushSync(() => root.render(node));
  mounted.push({ root, element });
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
  flushSync(() => (button as HTMLButtonElement).click());
}

function pointer(target: EventTarget, type: string): void {
  flushSync(() => target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse", pointerId: 1, isPrimary: true })));
}

function key(target: EventTarget, value: string): void {
  flushSync(() => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: value })));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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
    flushSync(() => value.root.unmount());
    value.element.remove();
  }
  document.body.replaceChildren();
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
    content.focus();
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
    expect(tooltip("content-help").closest('[role="tooltip"]')?.getAttribute("data-state")).toBe("closed");

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

  it("enforces visible copy policy", () => {
    const rendered = mount(
      <HelpProvider>
        <WorkbenchShell
          locale="en"
          breadcrumb={["Paste", "New"]}
          headingId="document-heading"
          destinations={[]}
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

    const initial = mount(<OperationStatus locale="en" ordinary records={records()} />);
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
    const rendered = mount(<OperationStatus locale="en" ordinary={false} records={terminal} />);
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
    const rendered = mount(
      <LocalActions
        locale="en"
        source="π"
        filename="document.txt"
        clipboard={{ writeText: async (value: string) => { copied.push(value); } }}
        download={{
          createObjectURL: (blob: Blob) => { urls.push(blob); return `blob:local-${urls.length}`; },
          revokeObjectURL: () => undefined,
          dispatchDownload: () => undefined,
        }}
        navigation={{ assign: (url: string) => { assigned.push(url); } }}
        onActionState={(value) => calls.push(value)}
      />,
    );

    click(Array.from(rendered.querySelectorAll("button")).find((button) => button.textContent === "Copy")!);
    await Promise.resolve();
    expect(copied).toEqual(["π"]);

    click(Array.from(rendered.querySelectorAll("button")).find((button) => button.textContent === "Download")!);
    await Promise.resolve();
    expect(await urls[0]!.text()).toBe("π");
    expect(urls[0]!.type).toBe("application/octet-stream");

    click(Array.from(rendered.querySelectorAll("button")).find((button) => button.textContent === "Open HTML locally")!);
    expect(await urls[1]!.text()).toBe("π");
    expect(urls[1]!.type).toBe("text/html");
    expect(assigned).toEqual(["blob:local-2"]);
    expect(calls.filter((value) => value.key === "copy")).toHaveLength(2);
    expect(calls.some((value) => value.key === "download")).toBe(true);
  });

  it("updates document-local locale and theme controls", () => {
    const rendered = mount(<App initialPage={{ ok: true, bootstrap: { page: "create", locale: "en" }, password: null }} />);
    const selects = Array.from(rendered.querySelectorAll("select")) as HTMLSelectElement[];
    expect(selects).toHaveLength(2);
    const language = selects[0]!;
    const theme = selects[1]!;

    flushSync(() => {
      language.value = "zh-CN";
      language.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.title).toContain("创建剪贴板");

    flushSync(() => {
      theme.value = "dark";
      theme.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
