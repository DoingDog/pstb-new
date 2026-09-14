import { afterEach, describe, expect, it } from "vitest";
import { cdp, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
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
