import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import type { PasteSummary } from "../contracts";
import { HelpProvider } from "../components/HelpTrigger";
import { CreatePage } from "./CreatePage";
import { ErrorPage } from "./ErrorPage";
import { LocalOnlyPastePage } from "./LocalOnlyPastePage";
import { MarkdownPage } from "./MarkdownPage";
import { PasswordPage } from "./PasswordPage";
import "../index.css";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary: PasteSummary = {
  id: "created-paste",
  title: "Created",
  format: "text",
  viewOnce: false,
  protected: false,
  createdAt: "2026-09-13T12:00:00.000Z",
  updatedAt: "2026-09-13T12:00:00.000Z",
  expiresAt: null,
  expiration: { kind: "permanent" },
  version: "g.1",
  contentRevision: 1,
  contentBytes: 5,
  createdCountry: null,
  links: {
    view: "/created-paste",
    raw: "/raw/created-paste",
    html: "/html/created-paste",
    markdown: "/md/created-paste",
    file: "/file/created-paste",
  },
};

type Fixture = {
  host: HTMLDivElement;
  input(name: string, value: string): Promise<void>;
  click(action: string): Promise<void>;
  drop(name: string, data: DataTransfer): Promise<void>;
};

const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];

async function mount(node: ReactNode): Promise<Fixture> {
  const host = document.createElement("div");
  const root = createRoot(host);
  document.body.appendChild(host);
  await act(async () => {
    root.render(<HelpProvider>{node}</HelpProvider>);
  });
  mounted.push({ root, host });

  const target = (selector: string): HTMLElement => {
    const element = host.querySelector<HTMLElement>(selector);
    expect(element).not.toBeNull();
    return element!;
  };

  return {
    host,
    async input(name, value) {
      const element = target(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const previous = element.value;
      element.value = value;
      (element as typeof element & { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(previous);
      await act(async () => {
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      });
    },
    async click(action) {
      await act(async () => {
        target(`[data-action="${action}"]`).click();
        await Promise.resolve();
      });
    },
    async drop(name, data) {
      await act(async () => {
        target(`[name="${name}"]`).dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
      });
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      });
    },
  };
}

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("create interaction", () => {
  it("renders labeled controlled fields and the seven fixed expiration values", async () => {
    const fixture = await mount(<CreatePage locale="en" create={vi.fn()} />);

    for (const name of ["content", "title", "format", "expiration", "password", "viewOnce", "customId"]) {
      expect(fixture.host.querySelector(`[name="${name}"]`)).not.toBeNull();
    }
    expect((Array.from(fixture.host.querySelectorAll('[name="expiration"] option')) as HTMLOptionElement[]).map((option) => option.value)).toEqual([
      "60",
      "3600",
      "86400",
      "604800",
      "2592000",
      "31104000",
      "permanent",
    ]);

    await fixture.input("content", "exact\n🙂");
    await fixture.input("title", "  title  ");
    expect((fixture.host.querySelector('[name="content"]') as HTMLTextAreaElement).value).toBe("exact\n🙂");
    expect((fixture.host.querySelector('[name="title"]') as HTMLInputElement).value).toBe("  title  ");
  });

  it("submits exact controlled create fields and stays on root", async () => {
    const create = vi.fn().mockResolvedValue({ ok: true, status: 201, value: summary, etag: '"g.1"' });
    const fixture = await mount(<CreatePage locale="en" create={create} />);
    await fixture.input("content", "exact\n🙂");
    await fixture.input("title", "  title  ");
    await fixture.click("viewOnce");
    await fixture.click("create");
    expect(create).toHaveBeenCalledWith({
      content: "exact\n🙂",
      title: "  title  ",
      format: "text",
      expiration: 86400,
      password: "",
      viewOnce: true,
    }, expect.any(AbortSignal));
    expect(location.pathname).toBe("/");
    expect(fixture.host.textContent).toContain(summary.id);
    expect(fixture.host.textContent).toContain(summary.title);
  });

  it("sends viewOnce false explicitly and disables repeat submits while pending", async () => {
    let resolve!: (result: { ok: true; status: 201; value: PasteSummary; etag: string }) => void;
    const create = vi.fn(() => new Promise<typeof summary extends never ? never : { ok: true; status: 201; value: PasteSummary; etag: string }>((done) => { resolve = done; }));
    const fixture = await mount(<CreatePage locale="en" create={create} />);
    await fixture.input("content", "pending");
    await fixture.click("create");
    await fixture.click("create");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ viewOnce: false }), expect.any(AbortSignal));
    expect((fixture.host.querySelector('[data-action="create"]') as HTMLButtonElement).disabled).toBe(true);

    await act(async () => resolve({ ok: true, status: 201, value: summary, etag: '"g.1"' }));
  });

  it("rejects invalid client values without calling create", async () => {
    const create = vi.fn().mockResolvedValue({ ok: true, status: 201, value: summary, etag: '"g.1"' });
    const fixture = await mount(<CreatePage locale="en" create={create} />);

    await fixture.input("content", "valid");
    await fixture.input("title", "x".repeat(201));
    expect((fixture.host.querySelector('[name="title"]') as HTMLInputElement).value).toHaveLength(201);
    expect(fixture.host.querySelector("form")?.checkValidity()).toBe(true);
    await fixture.click("create");
    expect(create).not.toHaveBeenCalled();
    expect(fixture.host.querySelector('[role="alert"]')?.textContent).toContain("Title is too long");

    await fixture.input("title", "valid");
    await fixture.input("password", "🙂");
    await fixture.click("create");
    expect(fixture.host.querySelector('[role="alert"]')?.textContent).toContain("Password must use");

    await fixture.input("password", "");
    await fixture.input("customId", "not valid");
    await fixture.click("create");
    expect(fixture.host.querySelector('[role="alert"]')?.textContent).toContain("Custom ID");
    expect(create).not.toHaveBeenCalled();
  });

  it("commits the first dropped text or file without normalizing its content", async () => {
    const create = vi.fn().mockResolvedValue({ ok: true, status: 201, value: summary, etag: '"g.1"' });
    const fixture = await mount(<CreatePage locale="en" create={create} />);
    const text = new DataTransfer();
    text.setData("text/plain", "first\r\n🙂");
    await fixture.drop("content", text);
    await fixture.click("create");
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ content: "first\r\n🙂" }), expect.any(AbortSignal));

    const files = new DataTransfer();
    files.items.add(new File(["file\r\n🙂"], "first-name.md", { type: "text/markdown" }));
    files.items.add(new File(["ignored"], "second-name.md", { type: "text/markdown" }));
    await fixture.drop("content", files);
    await fixture.click("create");
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ content: "file\r\n🙂", title: "first-name.md" }), expect.any(AbortSignal));
  });
});

describe("password page", () => {
  it("uses a labeled native form and exposes forbidden inline", async () => {
    const fixture = await mount(<PasswordPage locale="en" errorCode="FORBIDDEN" />);
    const form = fixture.host.querySelector("form");
    expect(form?.method.toLowerCase()).toBe("post");
    expect(form?.enctype).toBe("application/x-www-form-urlencoded");
    expect(fixture.host.querySelector('[name="password"]')).not.toBeNull();
    expect(fixture.host.querySelector('[role="alert"]')?.textContent).toContain("Password is missing or incorrect");
    expect(fixture.host.textContent).not.toContain(summary.title);
  });
});

describe("error page", () => {
  it("renders only local normalized error copy and create recovery", async () => {
    const fixture = await mount(<ErrorPage locale="en" status={500} errorCode="unknown-server-stack" />);
    expect(fixture.host.querySelector('[role="alert"]')?.textContent).toContain("unexpected error");
    const recovery = fixture.host.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(recovery?.textContent).toContain("Create a paste");
    expect(fixture.host.textContent).not.toContain("unknown-server-stack");
  });
});

const safePreview = "<p>safe preview</p>" as import("../bootstrap").TrustedMarkdownHtml;
const source = "exact\r\n🙂";
const phases = ["armed-view-once", "consumed", "not-found", "delete-uncertain"] as const;

describe("local-only capability", () => {
  it("keeps every terminal phase local with exact source actions", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const copies: string[] = [];
    const downloads: Blob[] = [];
    const navigated: string[] = [];
    const download = {
      createObjectURL: vi.fn((blob: Blob) => {
        downloads.push(blob);
        return blob.type === "text/html" ? "blob:html" : "blob:download";
      }),
      revokeObjectURL: vi.fn(),
      dispatchDownload: vi.fn(),
    };

    for (const phase of phases) {
      for (const initialMarkdown of [null, safePreview]) {
        const fixture = await mount(
          <LocalOnlyPastePage
            locale="en"
            phase={phase}
            source={source}
            initialMarkdown={initialMarkdown}
            clipboard={{ writeText: async (value) => { copies.push(value); } }}
            download={download}
            navigation={{ assign: (url) => { navigated.push(url); } }}
          />,
        );
        expect(fixture.host.textContent).not.toMatch(/Edit|History|Settings|Delete(?! uncertain)/);
        expect(fixture.host.querySelector('[href*="/raw/"], [href*="/html/"], [href*="/md/"], [href*="/file/"]')).toBeNull();
        expect(fixture.host.querySelector('[data-action="full-refresh"]')).not.toBeNull();
        expect(fixture.host.querySelector('[data-action="create-new"]')).not.toBeNull();
        if (phase === "armed-view-once") {
          expect(fixture.host.textContent).toContain("Armed view-once");
          expect(fixture.host.textContent).not.toContain("Consumed");
        }
        if (phase === "consumed") expect(fixture.host.textContent).toContain("Consumed");
        if (phase === "not-found") expect(fixture.host.textContent).toContain("Not found");
        if (phase === "delete-uncertain") {
          expect(fixture.host.textContent).toContain("Delete uncertain");
          expect(fixture.host.textContent).not.toContain("Retry");
        }
        if (initialMarkdown !== null) expect(fixture.host.querySelector("[data-safe-markdown]")?.textContent).toContain("safe preview");
      }
    }

    const actions = await mount(
      <LocalOnlyPastePage
        locale="en"
        phase="consumed"
        source={source}
        initialMarkdown={safePreview}
        clipboard={{ writeText: async (value) => { copies.push(value); } }}
        download={download}
        navigation={{ assign: (url) => { navigated.push(url); } }}
      />,
    );
    const button = (label: string) => Array.from(actions.host.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === label)!;
    await act(async () => { button("Copy").click(); await Promise.resolve(); });
    await act(async () => { button("Wrap").click(); });
    await act(async () => { button("Source").click(); });
    await act(async () => { button("Download").click(); await Promise.resolve(); });
    await act(async () => { button("Open HTML locally").click(); });
    expect(copies).toEqual([source]);
    expect(actions.host.querySelector("[data-local-source]")?.textContent).toBe(source);
    expect(new TextDecoder().decode(await downloads[0]!.arrayBuffer())).toBe(source);
    expect(downloads[0]?.type).toBe("application/octet-stream");
    expect(navigated).toEqual(["blob:html"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("read-only Markdown", () => {
  it("shows only its trusted article and local source actions", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const fixture = await mount(<MarkdownPage locale="en" title="Read-only title" source={source} initialMarkdown={safePreview} />);
    expect(fixture.host.textContent).toContain("Read-only title");
    expect(fixture.host.querySelector("[data-safe-markdown]")?.textContent).toContain("safe preview");
    expect(fixture.host.textContent).not.toMatch(/Edit|History|Settings|Delete|Autosave|Autosync/);
    expect(fixture.host.querySelector('[href*="/raw/"], [href*="/html/"], [href*="/md/"], [href*="/file/"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
