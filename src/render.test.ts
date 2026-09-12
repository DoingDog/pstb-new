import { describe, expect, it } from "vitest";
import { assetPaths } from "./generated/assets";
import {
  applicationHeaders,
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
    .filter((match) => !/\btype=(?:"application\/json"|'application\/json')/i.test(match[1] ?? ""))
    .map((match) => /\bsrc=(?:"([^"]+)"|'([^']+)')/i.exec(match[1] ?? "")?.[1] ?? "");
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
  it("creates a labeled form with seven expiration choices", () => {
    const html = renderCreatePage("zh-CN");

    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<label for="content">');
    expect(html).toContain('id="content" name="content"');
    expect(html).toContain('<label for="title">');
    expect(html).toContain('id="format" name="format"');
    expect(html).toContain('id="expiration" name="expiration"');
    expect(html.match(/<select id="expiration"[^>]*>(.*?)<\/select>/)?.[1]?.match(/<option\b/g)).toHaveLength(7);
    expect(html).toContain('id="password" name="password" type="password"');
    expect(html).toContain('id="view-once" name="viewOnce" type="checkbox"');
    expect(html).toContain('id="custom-id" name="customId"');
    expect(html).toContain("exactly once");
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

  it("renders ordinary paste controls and restricts consumed view-once pages to local actions", () => {
    const ordinary = renderPastePage({ locale: "en", paste, content: "source" });
    const consumed = renderPastePage({ locale: "en", paste: { ...paste, viewOnce: true }, content: "source", consumed: true });

    expect(ordinary).toContain('role="tablist"');
    expect(ordinary).toContain('data-action="delete"');
    expect(consumed).toContain('data-consumed="true"');
    expect(consumed).toContain('data-action="copy"');
    expect(consumed).toContain('data-action="download"');
    expect(consumed).not.toContain('data-action="delete"');
    expect(consumed).not.toContain('data-tab="edit"');
    expect(consumed).not.toContain('data-tab="history"');
    expect(consumed).not.toContain('data-tab="settings"');
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
