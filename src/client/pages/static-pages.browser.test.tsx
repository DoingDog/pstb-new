import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import type { PasteSummary } from "../contracts";
import type { MarkdownModes, MarkdownModesOptions } from "../markdown";
import { createPasteApi } from "../api";
import { HelpProvider } from "../components/HelpTrigger";
import { CreatePage } from "./CreatePage";
import { ErrorPage } from "./ErrorPage";
import { LocalOnlyPastePage } from "./LocalOnlyPastePage";
import { MarkdownPage } from "./MarkdownPage";
import { PasswordPage } from "./PasswordPage";
import "../index.css";

const markdownHarness = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("../markdown", () => ({ createMarkdownModes: markdownHarness.create }));

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
  paste(name: string, value: string): Promise<void>;
  click(action: string): Promise<void>;
  drop(name: string, data: DataTransfer): Promise<void>;
  rerender(node: ReactNode): Promise<void>;
  unmount(): Promise<void>;
};

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
};

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];
let consoleErrors: Array<unknown[]> = [];

beforeEach(() => {
  consoleErrors = vi.spyOn(console, "error").mock.calls;
});

async function mount(node: ReactNode): Promise<Fixture> {
  const host = document.createElement("div");
  const root = createRoot(host);
  const entry = { root, host };
  document.body.appendChild(host);
  await act(async () => {
    root.render(<HelpProvider>{node}</HelpProvider>);
  });
  mounted.push(entry);

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
    async paste(name, value) {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      await act(async () => {
        target(`[name="${name}"]`).dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
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
    async rerender(next) {
      await act(async () => {
        root.render(<HelpProvider>{next}</HelpProvider>);
      });
    },
    async unmount() {
      const index = mounted.indexOf(entry);
      if (index >= 0) mounted.splice(index, 1);
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  markdownHarness.create.mockReset();
  const actWarnings = consoleErrors.filter(
    ([message]) => typeof message === "string" && message.includes("not wrapped in act"),
  );
  vi.restoreAllMocks();
  expect(actWarnings).toHaveLength(0);
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

  it("submits pasted CRLF source unchanged and stays on root", async () => {
    const create = vi.fn().mockResolvedValue({ ok: true, status: 201, value: summary, etag: '"g.1"' });
    const fixture = await mount(<CreatePage locale="en" create={create} />);
    await fixture.paste("content", "exact\r\n🙂");
    await fixture.input("title", "  title  ");
    await fixture.click("viewOnce");
    await fixture.click("create");
    expect(create).toHaveBeenCalledWith({
      content: "exact\r\n🙂",
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

  it("excludes two same-turn submits while the first request is pending", async () => {
    const pending = deferred<{ ok: true; status: 201; value: PasteSummary; etag: string }>();
    const create = vi.fn(() => pending.promise);
    const fixture = await mount(<CreatePage locale="en" create={create} />);
    await fixture.input("content", "pending");
    const form = fixture.host.querySelector("form")!;

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ viewOnce: false }), expect.any(AbortSignal));
    expect((fixture.host.querySelector('[data-action="create"]') as HTMLButtonElement).disabled).toBe(true);

    await act(async () => pending.resolve({ ok: true, status: 201, value: summary, etag: '"g.1"' }));
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

  it("ignores a delayed file read after newer create fields", async () => {
    const read = deferred<string>();
    const firstFile = new File(["placeholder"], "first.md", { type: "text/markdown" });
    Object.defineProperty(firstFile, "text", { value: () => read.promise });
    const dropped = new DataTransfer();
    dropped.items.add(firstFile);
    const create = vi.fn().mockResolvedValue({ ok: true, status: 201, value: summary, etag: '"g.1"' });
    const fixture = await mount(<CreatePage locale="en" create={create} />);

    await fixture.drop("content", dropped);
    await fixture.input("content", "new source");
    await fixture.input("title", "new title");
    await fixture.input("format", "markdown");
    await fixture.input("expiration", "permanent");
    await fixture.input("password", "secret");
    await fixture.input("customId", "new-id");
    await fixture.click("viewOnce");
    await act(async () => read.resolve("stale file source"));

    expect((fixture.host.querySelector('[name="content"]') as HTMLTextAreaElement).value).toBe("new source");
    expect((fixture.host.querySelector('[name="title"]') as HTMLInputElement).value).toBe("new title");
    expect((fixture.host.querySelector('[name="format"]') as unknown as HTMLSelectElement).value).toBe("markdown");
    expect((fixture.host.querySelector('[name="expiration"]') as unknown as HTMLSelectElement).value).toBe("permanent");
    expect((fixture.host.querySelector('[name="password"]') as HTMLInputElement).value).toBe("secret");
    expect((fixture.host.querySelector('[name="customId"]') as HTMLInputElement).value).toBe("new-id");
    expect((fixture.host.querySelector('[name="viewOnce"]') as HTMLInputElement).checked).toBe(true);
    await fixture.click("create");
    expect(create).toHaveBeenLastCalledWith({
      content: "new source",
      title: "new title",
      format: "markdown",
      expiration: "permanent",
      password: "secret",
      viewOnce: true,
      customId: "new-id",
    }, expect.any(AbortSignal));
  });

  it("uses generic localized validation copy for title control characters", async () => {
    const fixture = await mount(<CreatePage locale="en" create={vi.fn()} />);
    await fixture.input("content", "valid");
    await fixture.input("title", "a\u0001b");
    await fixture.click("create");
    expect(fixture.host.querySelector('[role="alert"]')?.textContent).toContain("One or more fields are invalid");
  });

  it("reports every validation family through only its failed control", async () => {
    const create = vi.fn().mockResolvedValue({ ok: true, status: 201, value: summary, etag: '"g.1"' });
    const fixture = await mount(<CreatePage locale="en" create={create} />);
    const fields = ["content", "title", "password", "customId"] as const;

    const expectFailure = (field: typeof fields[number], message: string) => {
      const error = fixture.host.querySelector<HTMLElement>("#create-validation-error");
      expect(error?.textContent).toContain(message);
      for (const name of fields) {
        const control = fixture.host.querySelector<HTMLElement>(`[name="${name}"]`)!;
        expect(control.getAttribute("aria-invalid")).toBe(name === field ? "true" : null);
        expect(control.getAttribute("aria-errormessage")).toBe(name === field ? "create-validation-error" : null);
      }
    };

    await fixture.click("create");
    expectFailure("content", "Content is required");

    await fixture.input("content", "x".repeat(10 * 1024 * 1024 + 1));
    await fixture.click("create");
    expectFailure("content", "Content exceeds the 10 MiB limit");

    await fixture.input("content", "\ud800");
    await fixture.click("create");
    expectFailure("content", "Content contains an invalid Unicode scalar value");

    await fixture.input("content", "valid");
    await fixture.input("title", "\ud800");
    await fixture.click("create");
    expectFailure("title", "Title contains an invalid Unicode scalar value");

    await fixture.input("title", "a\u0001b");
    await fixture.click("create");
    expectFailure("title", "One or more fields are invalid");

    await fixture.input("title", "x".repeat(201));
    await fixture.click("create");
    expectFailure("title", "Title is too long");

    await fixture.input("title", "valid");
    await fixture.input("password", "🙂");
    await fixture.click("create");
    expectFailure("password", "Password must use 1 to 128 visible ASCII characters");

    await fixture.input("password", "");
    await fixture.input("customId", "__cfpb-reserved");
    await fixture.click("create");
    expectFailure("customId", "Custom ID must use the allowed characters");

    await fixture.input("customId", "not valid");
    await fixture.click("create");
    expectFailure("customId", "Custom ID must use the allowed characters");
    expect(create).not.toHaveBeenCalled();
  });

  it("gives every create and password form interaction a 44 px target at desktop and 320 px", async () => {
    const create = await mount(<CreatePage locale="en" create={vi.fn()} />);
    const password = await mount(<PasswordPage locale="en" errorCode={null} />);
    const target = (element: Element | null) => {
      expect(element).not.toBeNull();
      const { height, width } = element!.getBoundingClientRect();
      expect(height).toBeGreaterThanOrEqual(44);
      expect(width).toBeGreaterThanOrEqual(44);
    };

    for (const width of ["", "320px"]) {
      create.host.style.width = width;
      password.host.style.width = width;
      for (const selector of [
        '[name="content"]',
        '[name="title"]',
        '[name="format"]',
        '[name="expiration"]',
        '[name="password"]',
        '[name="customId"]',
        'label[for="create-view-once"]',
        '[data-action="reveal"]',
        '[data-action="create"]',
      ]) target(create.host.querySelector(selector));
      for (const selector of ['[name="password"]', '[data-action="reveal"]', '[data-action="submit-password"]']) {
        target(password.host.querySelector(selector));
      }
    }
  });

  it("routes ordinary create requests through the JSON adapter", async () => {
    const requests: Array<{ url: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const api = createPasteApi({
      fetch: async (url, init) => {
        requests.push({ url, init });
        return new Response(JSON.stringify(summary), {
          status: 201,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
            etag: '"g.1"',
          },
        });
      },
      crypto: globalThis.crypto,
    });
    const fixture = await mount(<CreatePage locale="en" create={api.create} />);
    await fixture.input("content", "adapter source");
    await fixture.click("create");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/api/pastes");
    expect(requests[0]?.init?.body).toBeTypeOf("string");
    expect(JSON.parse(requests[0]?.init?.body as string)).toEqual({
      content: "adapter source",
      title: "",
      format: "text",
      expiration: 86400,
      password: "",
      viewOnce: false,
    });
    expect(new Headers(requests[0]?.init?.headers).get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("does not attach a generic create failure to a field", async () => {
    const create = vi.fn().mockResolvedValue({
      ok: false,
      failure: {
        kind: "network",
        status: null,
        code: "NETWORK_ERROR",
        mutationMayHaveApplied: true,
      },
    });
    const fixture = await mount(<CreatePage locale="en" create={create} />);
    await fixture.input("content", "valid");
    await fixture.click("create");

    expect(fixture.host.querySelector("#create-validation-error")?.textContent).toContain("network request failed");
    for (const name of ["content", "title", "password", "customId"]) {
      expect(fixture.host.querySelector(`[name="${name}"]`)?.getAttribute("aria-invalid")).toBeNull();
      expect(fixture.host.querySelector(`[name="${name}"]`)?.getAttribute("aria-errormessage")).toBeNull();
    }
  });

  it("derives protected links only after create without prefetching them", async () => {
    const create = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      value: { ...summary, protected: true },
      etag: '"g.1"',
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const fixture = await mount(<CreatePage locale="en" create={create} />);
    await fixture.input("content", "protected source");
    await fixture.input("password", "secret");
    expect(fixture.host.querySelector('[href*="password="]')).toBeNull();
    await fixture.click("create");

    for (const link of Array.from(fixture.host.querySelectorAll<HTMLAnchorElement>("section a"))) {
      expect(link.href).toContain("password=secret");
    }
    expect(document.querySelector('[rel="prefetch"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
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
        if (phase === "not-found" || phase === "delete-uncertain") {
          expect(fixture.host.querySelector('[data-action="full-refresh"]')).not.toBeNull();
        } else {
          expect(fixture.host.querySelector('[data-action="full-refresh"]')).toBeNull();
        }
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
    expect(Array.from(new Uint8Array(await downloads[0]!.arrayBuffer()))).toEqual(Array.from(new TextEncoder().encode(source)));
    expect(downloads[0]?.type).toBe("application/octet-stream");
    expect(download.dispatchDownload).toHaveBeenCalledWith("blob:download", "paste.md");
    expect(Array.from(new Uint8Array(await downloads[1]!.arrayBuffer()))).toEqual(Array.from(new TextEncoder().encode(source)));
    expect(downloads[1]?.type).toBe("text/html");
    expect(navigated).toEqual(["blob:html"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps recompute preview publication and failures owned by the current source attempt", async () => {
    const attempts: Array<{ options: MarkdownModesOptions; render: Deferred<string>; destroyed: number }> = [];
    markdownHarness.create.mockImplementation((options: MarkdownModesOptions): MarkdownModes => {
      const attempt = { options, render: deferred<string>(), destroyed: 0 };
      attempts.push(attempt);
      return {
        enterSource: async () => undefined,
        enterVisual: async () => undefined,
        enterPreview: async () => {
          const html = await attempt.render.promise;
          options.onPreview?.({ source: options.source.value, html });
        },
        leaveVisual: async () => undefined,
        destroy: async () => { attempt.destroyed += 1; },
      };
    });
    const fixture = await mount(
      <LocalOnlyPastePage locale="en" phase="consumed" source="source A" initialMarkdown={safePreview} />,
    );
    expect(markdownHarness.create).not.toHaveBeenCalled();

    await fixture.click("recompute-preview");
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    await fixture.click("recompute-preview");
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    await act(async () => attempts[1]!.render.resolve("<p>latest A</p>"));
    await vi.waitFor(() => expect(fixture.host.querySelector("[data-safe-markdown]")?.textContent).toContain("latest A"));
    await act(async () => attempts[0]!.render.resolve("<p>stale A</p>"));
    await vi.waitFor(() => expect(attempts[0]?.destroyed).toBe(1));
    expect(attempts[1]?.destroyed).toBe(1);
    expect(fixture.host.querySelector("[data-safe-markdown]")?.textContent).toContain("latest A");

    await fixture.click("recompute-preview");
    await vi.waitFor(() => expect(attempts).toHaveLength(3));
    await fixture.rerender(
      <LocalOnlyPastePage locale="en" phase="consumed" source="source B" initialMarkdown={"<p>initial B</p>" as import("../bootstrap").TrustedMarkdownHtml} />,
    );
    await act(async () => attempts[2]!.render.resolve("<p>stale B</p>"));
    await vi.waitFor(() => expect(attempts[2]?.destroyed).toBe(1));
    expect(fixture.host.querySelector("[data-safe-markdown]")?.textContent).toContain("initial B");

    await fixture.click("recompute-preview");
    await vi.waitFor(() => expect(attempts).toHaveLength(4));
    await act(async () => attempts[3]!.render.reject(new Error("render failed")));
    await vi.waitFor(() => expect(fixture.host.querySelector('[role="alert"]')?.textContent).toContain("could not be rendered"));
    expect(attempts[3]?.destroyed).toBe(1);

    await fixture.click("recompute-preview");
    await vi.waitFor(() => expect(attempts).toHaveLength(5));
    await fixture.unmount();
    await act(async () => attempts[4]!.render.resolve("<p>after unmount</p>"));
    await vi.waitFor(() => expect(attempts[4]?.destroyed).toBe(1));
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

  it("executes MarkdownPage local copy, wrap, source, and UTF-8 download actions", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const copies: string[] = [];
    const downloads: Blob[] = [];
    const download = {
      createObjectURL: vi.fn((blob: Blob) => {
        downloads.push(blob);
        return "blob:markdown";
      }),
      revokeObjectURL: vi.fn(),
      dispatchDownload: vi.fn(),
    };
    const fixture = await mount(
      <MarkdownPage
        locale="en"
        title="Read-only title"
        source={source}
        initialMarkdown={safePreview}
        clipboard={{ writeText: async (value) => { copies.push(value); } }}
        download={download}
      />,
    );
    const button = (label: string) => Array.from(fixture.host.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === label)!;

    await act(async () => { button("Copy").click(); await Promise.resolve(); });
    await act(async () => { button("Wrap").click(); });
    await act(async () => { button("Source").click(); });
    await act(async () => { button("Download").click(); await Promise.resolve(); });

    expect(copies).toEqual([source]);
    expect(fixture.host.querySelector("[data-local-source]")?.textContent).toBe(source);
    expect(Array.from(new Uint8Array(await downloads[0]!.arrayBuffer()))).toEqual(Array.from(new TextEncoder().encode(source)));
    expect(download.dispatchDownload).toHaveBeenCalledWith("blob:markdown", "Read-only title");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
