import { describe, expect, it } from "vitest";
import { assetPaths } from "./generated/assets";
import { decodeSourceData, sourceDataEncoding } from "./source-data";
import {
  applicationHeaders,
  dictionaries,
  deriveDownloadFileName,
  deriveDownloadHeaders,
  escapeBootstrapJson,
  renderCreatePage,
  renderErrorPage,
  renderMarkdown,
  renderMarkdownDocument,
  renderPasswordPage,
  renderPastePage,
} from "./render";
import type { PasteSummary } from "./types";

const paste: PasteSummary = {
  id: "example",
  title: "Example paste",
  format: "markdown",
  viewOnce: false,
  protected: true,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  expiresAt: null,
  expiration: { kind: "permanent" },
  version: "00000000-0000-4000-8000-000000000001.1",
  contentRevision: 1,
  contentBytes: 7,
  createdCountry: null,
  links: {
    view: "/example",
    raw: "/raw/example",
    html: "/html/example",
    markdown: "/md/example",
    file: "/file/example",
  },
};

function executableScriptSources(document: string): string[] {
  return [...document.matchAll(/<script\b([^>]*)>/gi)]
    .filter((match) => !/\btype=(?:"application\/(?:json|octet-stream)"|'application\/(?:json|octet-stream)')/i.test(match[1] ?? ""))
    .map((match) => /\bsrc=(?:"([^"]+)"|'([^']+)')/i.exec(match[1] ?? "")?.[1] ?? "");
}

function sourceData(document: string): string {
  const match = document.match(new RegExp(`<script id="source-data" type="application/octet-stream" data-source-encoding="${sourceDataEncoding}">([A-Za-z0-9+/=]*)<\\/script>`));
  if (!match) throw new Error("expected source data node");
  return match[1]!;
}

async function parsedSourceData(document: string): Promise<string> {
  let encoded = "";
  const rewriter = new HTMLRewriter().on("script#source-data", {
    text(chunk) {
      encoded += chunk.text;
    },
  });
  await rewriter.transform(new Response(document)).text();
  return encoded;
}

function bootstrapData(document: string): Record<string, unknown> {
  const match = document.match(/<script id="bootstrap" type="application\/json">(.*?)<\/script>/);
  if (!match) throw new Error("expected bootstrap data");
  return JSON.parse(match[1]!);
}

describe("renderMarkdown", () => {
  it("renders the full GFM extension set", () => {
    const html = renderMarkdown("| left | right |\n| --- | --- |\n| a | b |\n\n- [x] done\n\n~~gone~~\n\nhttps://example.com");

    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox" disabled="" checked=""');
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
  });

  it("encodes raw HTML and omits dangerous URL protocols", () => {
    const html = renderMarkdown('<script>alert(1)</script> [javascript](javascript:alert(1)) [data](data:text/html,test)');

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
  });

  it("keeps micromark's default clobber prefix", () => {
    expect(renderMarkdown("Reference[^1]\n\n[^1]: note")).toContain("user-content-");
  });
});

describe("bootstrap and application headers", () => {
  it("escapes script-breaking JSON characters", () => {
    expect(escapeBootstrapJson({ value: "<>&  " })).toBe('{"value":"\\u003C\\u003E\\u0026\\u2028\\u2029"}');
  });

  it("uses the application-only CSP and no-store headers", () => {
    const headers = applicationHeaders();

    expect(headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Content-Security-Policy")).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
  });
});

describe("application documents", () => {
  it("uses the exact ordered expiration values with one day selected by default", () => {
    const html = renderCreatePage("en");
    const options = html.match(/<select id="expiration"[^>]*>(.*?)<\/select>/)?.[1];

    expect(options).toBeDefined();
    expect([...options!.matchAll(/<option value="([^"]+)"([^>]*)>/g)].map((match) => [match[1], (match[2] ?? "").includes("selected")])).toEqual([
      ["60", false],
      ["3600", false],
      ["86400", true],
      ["604800", false],
      ["2592000", false],
      ["31104000", false],
      ["permanent", false],
    ]);
  });

  it("renders the initial View as exact text or sanitized Markdown", () => {
    const text = renderPastePage({
      locale: "en",
      paste: { ...paste, format: "text" },
      content: "exact\r\n<script>literal</script>\n  ",
    });
    const markdown = renderPastePage({
      locale: "en",
      paste: { ...paste, format: "markdown" },
      content: "## Heading\n\n<script>literal</script>",
    });

    expect(text).toContain('<section id="panel-view" role="tabpanel" tabindex="0" aria-labelledby="tab-view" data-panel="view"><pre class="paste-content" data-source-view></pre></section>');
    expect(text).not.toContain("<script>literal</script>");
    expect(markdown).toContain('<section id="panel-view" role="tabpanel" tabindex="0" aria-labelledby="tab-view" data-panel="view"><article class="paste-content"><h2>Heading</h2>\n&lt;script&gt;literal&lt;/script&gt;</article></section>');
    expect(markdown).not.toContain("<script>literal</script>");
  });

  it("carries exact source once in inert UTF-8 base64 data", () => {
    const content = "\nleading\rstandalone\r\ncrlf\0replacement:� <>&  ﻿ non-BMP:\u{1F642}";
    const model = {
      locale: "en" as const,
      paste: { ...paste, format: "text" as const },
      content,
      password: "not-for-bootstrap",
    };
    const html = renderPastePage(model);
    const bootstrap = bootstrapData(html);

    expect([...html.matchAll(/<script id="source-data" type="application\/octet-stream" data-source-encoding="utf-8-base64">/g)]).toHaveLength(1);
    expect(decodeSourceData(sourceData(html))).toBe(content);
    expect(bootstrap).not.toHaveProperty("content");
    expect(bootstrap).not.toHaveProperty("password");
    expect(html).not.toContain("not-for-bootstrap");
    expect(html).toContain('<pre class="paste-content" data-source-view></pre>');
    expect(html).toContain('<textarea id="source" class="editor-input" name="source" readonly spellcheck="false"></textarea>');
  });

  it("preserves inert source data through HTML parsing", async () => {
    const content = "\nleading\rstandalone\r\ncrlf\0replacement:� <>&  ﻿ non-BMP:\u{1F642}";
    const html = renderPastePage({ locale: "en", paste: { ...paste, format: "text" }, content });

    expect(decodeSourceData(await parsedSourceData(html))).toBe(content);
  });

  it.each([
    ["ordinary paste", () => renderPastePage({ locale: "en", paste: { ...paste, format: "text" }, content: "ordinary\r\nsource" })],
    ["restricted paste", () => renderPastePage({ locale: "en", paste: { ...paste, format: "text", viewOnce: true }, content: "restricted\r\nsource", consumed: true })],
    ["ordinary Markdown document", () => renderMarkdownDocument({ locale: "en", paste, content: "# ordinary\r\nsource" })],
    ["view-once Markdown document", () => renderMarkdownDocument({ locale: "en", paste: { ...paste, viewOnce: true }, content: "# restricted\r\nsource" })],
  ])("keeps %s source out of bootstrap while retaining one transport node", (_name, render) => {
    const html = render();

    expect([...html.matchAll(/<script id="source-data" type="application\/octet-stream" data-source-encoding="utf-8-base64">/g)]).toHaveLength(1);
    expect(bootstrapData(html)).not.toHaveProperty("content");
    expect(decodeSourceData(sourceData(html))).toContain("source");
  });

  it("keeps a megabyte of text source near base64 expansion", () => {
    const content = "<".repeat(1_048_576);
    const html = renderPastePage({ locale: "en", paste: { ...paste, format: "text" }, content });

    expect(html.length).toBeLessThan(content.length * 1.38 + 20_000);
    expect(decodeSourceData(sourceData(html))).toBe(content);
  });

  it.each([
    ["en", ["Optional. Up to 200 characters.", "Select the default view for this paste.", "Choose when this paste expires.", "Optional. Use 1 to 128 visible ASCII characters.", "Optional. Start with an ASCII letter or number; use up to 64 ASCII letters, numbers, underscores, or hyphens."]],
    ["zh-CN", ["可选。最多 200 个字符。", "选择此剪贴板默认打开的视图。", "选择剪贴板何时过期。", "可选。使用 1 到 128 个可见 ASCII 字符。", "可选。以 ASCII 字母或数字开头，最多 64 个 ASCII 字母、数字、下划线或连字符。"]],
  ] as const)("renders %s create fields in reading order with visible descriptions", (locale, descriptions) => {
    const html = renderCreatePage(locale);
    const ids = ["title", "format", "expiration", "content", "password", "custom-id", "view-once"];
    const positions = ids.map((id) => html.indexOf(`id="${id}"`));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    for (const [id, description] of [
      ["title", descriptions[0]],
      ["format", descriptions[1]],
      ["expiration", descriptions[2]],
      ["password", descriptions[3]],
      ["custom-id", descriptions[4]],
    ]) {
      expect(html).toContain(`aria-describedby="${id}-description ${id}-error"`);
      expect(html).toContain(`<p id="${id}-description">${description}</p>`);
    }
    expect(html).toContain('<input id="title" name="title" type="text" aria-describedby="title-description title-error">');
    expect(html).not.toContain("maxlength=");
  });

  it("renders a workbench shell with an accessible tab workspace and empty deferred panels", () => {
    const create = renderCreatePage("en");
    const html = renderPastePage({ locale: "en", paste, content: "source" });

    expect(create).toContain('<main class="workbench" data-workbench="create">');
    expect(create).toContain('<aside class="lifecycle-rail" aria-labelledby="lifecycle-title">');
    expect(create).toContain('class="form-section editor-surface"');
    expect(html).toContain('<main class="workbench" data-workbench="paste" data-consumed="false">');
    expect(html).toContain('<button id="tab-view" type="button" role="tab" aria-selected="true" aria-controls="panel-view" tabindex="0" data-tab="view">View</button>');
    expect(html).toContain('<button id="tab-history" type="button" role="tab" aria-selected="false" aria-controls="panel-history" tabindex="-1" data-tab="history">History</button>');
    expect(html).toContain('<section id="panel-view" role="tabpanel" tabindex="0" aria-labelledby="tab-view" data-panel="view">');
    expect(html).toContain('<section id="panel-history" role="tabpanel" tabindex="0" aria-labelledby="tab-history" data-panel="history" hidden><div class="history-workbench"><div class="history-list" data-history-list></div><div class="history-detail" data-history-detail></div></div></section>');
    expect(html).toContain('<section id="panel-settings" role="tabpanel" tabindex="0" aria-labelledby="tab-settings" data-panel="settings" hidden></section>');
  });

  it("derives every paste lifecycle rail entry from the paste summary", () => {
    const html = renderPastePage({
      locale: "en",
      paste: { ...paste, protected: false, viewOnce: false, expiresAt: "2026-09-14T00:00:00.000Z", contentRevision: 4, contentBytes: 321 },
      content: "source",
    });

    expect(html).toContain('<code>example</code>');
    expect(html).toContain('Not protected');
    expect(html).toContain('Standard');
    expect(html).toContain('<time datetime="2026-09-14T00:00:00.000Z">2026-09-14T00:00:00.000Z</time>');
    expect(html).toContain('<code>4</code>');
    expect(html).toContain('321 bytes');
  });

  it("renders CSS hooks for the responsive workbench, history, and dialog primitives", () => {
    const html = renderPastePage({ locale: "en", paste, content: "source" });

    expect(html).toContain('class="workbench"');
    expect(html).toContain('class="lifecycle-rail"');
    expect(html).toContain('class="workbench-surface"');
    expect(html).toContain('class="history-workbench"');
    expect(html).toContain('class="history-list" data-history-list');
    expect(html).toContain('class="history-detail" data-history-detail');
    expect(html).toContain('<dialog id="delete-dialog" class="delete-dialog" aria-labelledby="delete-dialog-title">');
  });

  it("escapes user text and never puts a supplied password in bootstrap data", () => {
    const model = {
      locale: "en" as const,
      paste: { ...paste, title: '<img src=x onerror=alert(1)>' },
      content: "</textarea><img src=x onerror=alert(1)>",
      password: "not-for-bootstrap",
    };
    const html = renderPastePage(model);

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain("not-for-bootstrap");
  });

  it("renders consumed view-once pages with only a root create link and local actions", () => {
    const ordinary = renderPastePage({ locale: "en", paste, content: "source" });
    const consumed = renderPastePage({ locale: "en", paste: { ...paste, viewOnce: true }, content: "source", consumed: true });
    const links = [...consumed.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((match) => match[1]);

    expect(ordinary).toContain('role="tablist"');
    expect(ordinary).toContain('data-action="delete"');
    expect(consumed).toContain('data-consumed="true"');
    expect(consumed).toContain('<a href="/">Create a paste</a>');
    expect(links).toEqual(["/"]);
    expect(consumed).toContain('data-action="copy"');
    expect(consumed).toContain('data-action="download"');
    expect(consumed).not.toContain('data-action="delete"');
    expect(consumed).not.toContain('data-tab="edit"');
    expect(consumed).not.toContain('data-tab="history"');
    expect(consumed).not.toContain('data-tab="settings"');
    expect(consumed).not.toContain('"links"');
    expect(consumed).not.toContain('href="/example"');
    expect(consumed).not.toContain('href="/raw/example"');
    expect(consumed).not.toContain('href="/html/example"');
    expect(consumed).not.toContain('href="/md/example"');
    expect(consumed).not.toContain('href="/file/example"');
  });

  it("keeps a view-once Markdown document local after its content is loaded", () => {
    const html = renderMarkdownDocument({ locale: "en", paste: { ...paste, viewOnce: true }, content: "# source" });
    const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((match) => match[1]);

    expect(links).toEqual(["/"]);
    expect(html).toContain('data-consumed="true"');
    expect(html).toContain('<button class="markdown-document-action" type="button" data-action="copy">Copy</button>');
    expect(html).not.toContain('data-action="open-source"');
    expect(html).not.toContain('"links"');
  });

  it("marks ordinary Markdown document actions for narrow screens", () => {
    const html = renderMarkdownDocument({ locale: "en", paste, content: "# source" });

    expect(html).toContain('<a class="markdown-document-action" data-action="open-source" href="/example">Open source</a>');
    expect(html).toContain('<button class="markdown-document-action" type="button" data-action="copy">Copy</button>');
  });

  it("keeps English and Chinese dictionary keys in parity", () => {
    expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(dictionaries["zh-CN"]).sort());
  });

  it.each(["en", "zh-CN"] as const)("renders every %s dictionary entry across representative whole pages", (locale) => {
    const localizedPaste = { ...paste, title: "" };
    const pages = [
      renderCreatePage(locale),
      renderPastePage({ locale, paste: localizedPaste, content: "source" }),
      renderPastePage({ locale, paste: { ...localizedPaste, protected: false }, content: "source" }),
      renderPastePage({ locale, paste: { ...localizedPaste, viewOnce: true }, content: "source", consumed: true }),
      renderPasswordPage({ locale, error: "Incorrect password" }),
      renderErrorPage({ locale, error: "Missing paste" }),
      renderMarkdownDocument({ locale, paste: localizedPaste, content: "source" }),
    ].join("\n");

    expect(pages).toContain(`<html lang="${locale}">`);
    for (const [key, value] of Object.entries(dictionaries[locale])) {
      expect(pages, key).toContain(value);
    }
  });

  it("renders generic password and escaped error pages without paste data", () => {
    const password = renderPasswordPage({ locale: "en", error: "Wrong <password>" });
    const error = renderErrorPage({ locale: "en", error: "Missing <paste>" });

    expect(password).toContain('data-page="password"');
    expect(password).toContain("Wrong &lt;password&gt;");
    expect(password).not.toContain("Example paste");
    expect(password).not.toContain('"content"');
    expect(error).toContain('role="alert"');
    expect(error).toContain("Missing &lt;paste&gt;");
  });

  it("wraps safe Markdown in a semantic application article", () => {
    const html = renderMarkdownDocument({ locale: "en", paste, content: '<script>alert(1)</script>\n\nReference[^1]\n\n[^1]: note' });

    expect(html).toContain("<article>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("user-content-");
    expect(html).toContain('href="/example"');
  });

  it.each([
    ["create", () => renderCreatePage("en")],
    ["paste", () => renderPastePage({ locale: "en", paste, content: "source" })],
    ["password", () => renderPasswordPage({ locale: "en" })],
    ["error", () => renderErrorPage({ locale: "en", error: "error" })],
    ["markdown", () => renderMarkdownDocument({ locale: "en", paste, content: "source" })],
  ])("loads hashed assets without inline executable scripts on %s pages", (_name, render) => {
    const html = render();

    expect(html).toContain(`href="${assetPaths.appCss}"`);
    expect(executableScriptSources(html)).toEqual([assetPaths.appJs]);
  });
});

describe("deriveDownloadHeaders", () => {
  it("derives the canonical download filename independently of its headers", () => {
    expect(deriveDownloadFileName({ ...paste, title: "draft/final\\copy.  " })).toBe("draft_final_copy");
    expect(deriveDownloadFileName({ ...paste, title: "...   " })).toBe("paste-example.txt");
  });

  it("uses the ASCII paste fallback and RFC5987 encoded Unicode title", () => {
    const headers = deriveDownloadHeaders({ ...paste, title: "Résumé.txt" });

    expect(headers.get("Content-Type")).toBe("application/octet-stream");
    expect(headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"paste-example.txt\"; filename*=UTF-8''R%C3%A9sum%C3%A9.txt",
    );
    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("uses the fallback for empty or fully trimmed titles", () => {
    expect(deriveDownloadHeaders({ ...paste, title: "" }).get("Content-Disposition")).toContain("filename*=UTF-8''paste-example.txt");
    expect(deriveDownloadHeaders({ ...paste, title: "...   " }).get("Content-Disposition")).toContain("filename*=UTF-8''paste-example.txt");
  });

  it("replaces path separators and trims trailing spaces and dots", () => {
    expect(deriveDownloadHeaders({ ...paste, title: "draft/final\\copy.  " }).get("Content-Disposition")).toContain(
      "filename*=UTF-8''draft_final_copy",
    );
  });

  it.each(["bad\rtitle", "bad\ntitle", "bad title"])("rejects control characters in download titles", (title) => {
    try {
      deriveDownloadHeaders({ ...paste, title });
      throw new Error("Expected title validation to reject control characters.");
    } catch (error) {
      expect(error).toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });
});
