import { describe, expect, it } from "vitest";
import { assetPaths } from "./generated/assets";
import { decodeSourceData, sourceDataEncoding } from "./source-data";
import {
  applicationHeaders,
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

function occurrenceCount(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function readBootstrap(html: string): unknown {
  const match = /<script id="bootstrap" type="application\/json">([^<]*)<\/script>/.exec(html);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!);
}

function pasteSummary(overrides: Partial<PasteSummary> = {}): PasteSummary {
  return { ...paste, ...overrides };
}

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
  it("renders an ordinary Markdown paste as inert transport only", () => {
    const html = renderPastePage({ locale: "en", paste: pasteSummary({ format: "markdown" }), content: "# exact\r\n", consumed: false });

    expect(html).toContain('<div id="app"></div>');
    expect(readBootstrap(html)).toEqual({
      page: "paste",
      locale: "en",
      paste: pasteSummary({ format: "markdown" }),
      consumed: false,
    });
    expect(occurrenceCount(html, 'id="source-data"')).toBe(1);
    expect(occurrenceCount(html, 'id="initial-markdown-preview"')).toBe(1);
    expect(html).not.toMatch(/<(?:form|article|aside|nav|button|textarea)\b/);
    expect(html).not.toContain("# exact");
  });

  it.each([
    [renderCreatePage("en"), { page: "create", locale: "en" }],
    [renderPasswordPage({ locale: "en", errorCode: null }), { page: "password", locale: "en", errorCode: null }],
    [renderPasswordPage({ locale: "en", errorCode: "FORBIDDEN" }), { page: "password", locale: "en", errorCode: "FORBIDDEN" }],
    [renderErrorPage({ locale: "en", status: 503, errorCode: "STORAGE_READ_FAILED" }), { page: "error", locale: "en", status: 503, errorCode: "STORAGE_READ_FAILED" }],
  ])("renders non-content variants without source or preview nodes", (html, bootstrap) => {
    expect(readBootstrap(html)).toEqual(bootstrap);
    expect(occurrenceCount(html, 'id="source-data"')).toBe(0);
    expect(occurrenceCount(html, 'id="initial-markdown-preview"')).toBe(0);
  });

  it.each([
    [
      "ordinary text",
      () => renderPastePage({ locale: "en", paste: pasteSummary({ format: "text" }), content: "exact\r\n", consumed: false }),
      { page: "paste", locale: "en", paste: pasteSummary({ format: "text" }), consumed: false },
      0,
    ],
    [
      "ordinary Markdown",
      () => renderPastePage({ locale: "en", paste: pasteSummary({ format: "markdown" }), content: "# exact\r\n", consumed: false }),
      { page: "paste", locale: "en", paste: pasteSummary({ format: "markdown" }), consumed: false },
      1,
    ],
    [
      "consumed text",
      () => renderPastePage({ locale: "en", paste: pasteSummary({ format: "text", viewOnce: true }), content: "exact\r\n", consumed: true }),
      { page: "paste", locale: "en", consumed: true, hasInitialMarkdownPreview: false },
      0,
    ],
    [
      "consumed Markdown",
      () => renderPastePage({ locale: "en", paste: pasteSummary({ format: "markdown", viewOnce: true }), content: "# exact\r\n", consumed: true }),
      { page: "paste", locale: "en", consumed: true, hasInitialMarkdownPreview: true },
      1,
    ],
  ])("preserves source and preview cardinality for %s", (_name, render, bootstrap, previews) => {
    const html = render();

    expect(readBootstrap(html)).toEqual(bootstrap);
    expect(occurrenceCount(html, 'id="source-data"')).toBe(1);
    expect(occurrenceCount(html, 'id="initial-markdown-preview"')).toBe(previews);
  });

  it("keeps exact source once in inert UTF-8 base64 data", () => {
    const content = "\nleading\rstandalone\r\ncrlf\0replacement:� <>&  ﻿ non-BMP:\u{1F642}";
    const model = {
      locale: "en" as const,
      paste: pasteSummary({ format: "text" }),
      content,
      password: "not-for-bootstrap",
    };
    const html = renderPastePage(model);
    const bootstrap = readBootstrap(html) as Record<string, unknown>;

    expect(occurrenceCount(html, 'id="source-data"')).toBe(1);
    expect(decodeSourceData(sourceData(html))).toBe(content);
    expect(bootstrap).not.toHaveProperty("content");
    expect(bootstrap).not.toHaveProperty("password");
    expect(html).not.toContain("not-for-bootstrap");
  });

  it("uses only sanitized Markdown in the safe preview template", () => {
    const content = '<script>alert(1)</script>\n\nReference[^1]\n\n[^1]: note';
    const html = renderPastePage({ locale: "en", paste: pasteSummary({ format: "markdown" }), content });

    expect(decodeSourceData(sourceData(html))).toBe(content);
    expect(html).toContain('<template id="initial-markdown-preview">');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("user-content-");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("renders Markdown documents with only local source and preview transport", () => {
    const html = renderMarkdownDocument({ locale: "en", paste: pasteSummary({ viewOnce: true }), content: "# exact\r\n" });

    expect(readBootstrap(html)).toEqual({
      page: "markdown",
      locale: "en",
      id: "example",
      title: "Example paste",
      hasInitialMarkdownPreview: true,
    });
    expect(occurrenceCount(html, 'id="source-data"')).toBe(1);
    expect(occurrenceCount(html, 'id="initial-markdown-preview"')).toBe(1);
    expect(html).not.toMatch(/<(?:form|article|aside|nav|button|textarea)\b/);
  });

  it("omits unknown server-only paste properties from bootstrap data", () => {
    const html = renderPastePage({
      locale: "en",
      paste: { ...pasteSummary(), password: "server-only" } as PasteSummary,
      content: "source",
    });

    expect(JSON.stringify(readBootstrap(html))).not.toContain("server-only");
  });

  it.each([
    ["create", () => renderCreatePage("en")],
    ["paste", () => renderPastePage({ locale: "en", paste: pasteSummary(), content: "source" })],
    ["password", () => renderPasswordPage({ locale: "en", errorCode: null })],
    ["error", () => renderErrorPage({ locale: "en", status: 500, errorCode: "INTERNAL_ERROR" })],
    ["markdown", () => renderMarkdownDocument({ locale: "en", paste: pasteSummary(), content: "source" })],
  ])("loads exactly one stylesheet and external module script on %s pages", (_name, render) => {
    const html = render();

    expect(occurrenceCount(html, `<link rel="stylesheet" href="${assetPaths.appCss}">`)).toBe(1);
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

  it.each(["bad\rtitle", "bad\ntitle", "bad\0title"])("rejects control characters in download titles", (title) => {
    try {
      deriveDownloadHeaders({ ...paste, title });
      throw new Error("Expected title validation to reject control characters.");
    } catch (error) {
      expect(error).toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });
});
