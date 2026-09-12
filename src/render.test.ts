import { describe, expect, it } from "vitest";
import { assetPaths } from "./generated/assets";
import {
  applicationHeaders,
  dictionaries,
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

    expect(text).toContain('<section role="tabpanel" data-panel="view"><pre class="paste-content">exact\r\n&lt;script&gt;literal&lt;/script&gt;\n  </pre></section>');
    expect(text).not.toContain("<script>literal</script>");
    expect(markdown).toContain('<section role="tabpanel" data-panel="view"><article class="paste-content"><h2>Heading</h2>\n&lt;script&gt;literal&lt;/script&gt;</article></section>');
    expect(markdown).not.toContain("<script>literal</script>");
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

  it("keeps English and Chinese dictionary keys in parity", () => {
    expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(dictionaries["zh-CN"]).sort());
  });

  it.each(["en", "zh-CN"] as const)("renders every %s dictionary entry across representative whole pages", (locale) => {
    const localizedPaste = { ...paste, title: "" };
    const pages = [
      renderCreatePage(locale),
      renderPastePage({ locale, paste: localizedPaste, content: "source" }),
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
