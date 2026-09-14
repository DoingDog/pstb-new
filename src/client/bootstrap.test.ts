import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeSourceData } from "../source-data";
import type { AppBootstrap, PasteSummary } from "../types";
import { commitPastePassword, extractInitialPage, withPastePassword } from "./bootstrap";

const version = "550e8400-e29b-41d4-a716-446655440000.1";
const timestamp = "2026-09-13T00:00:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

function summary(overrides: Partial<PasteSummary> = {}): PasteSummary {
  return {
    id: "example",
    title: "Example",
    format: "text",
    viewOnce: false,
    protected: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: null,
    expiration: { kind: "permanent" },
    version,
    contentRevision: 1,
    contentBytes: 4,
    createdCountry: null,
    links: {
      view: "/example",
      raw: "/raw/example",
      html: "/html/example",
      markdown: "/md/example",
      file: "/file/example",
    },
    ...overrides,
  };
}

type Node = {
  id: "bootstrap" | "source-data" | "initial-markdown-preview";
  tagName: "SCRIPT" | "TEMPLATE" | "DIV";
  textContent: string | null;
  innerHTML: string;
  getAttribute(name: string): string | null;
  remove(): void;
};

type FixtureOptions = {
  bootstrap: AppBootstrap | unknown;
  sources?: string[];
  previews?: string[];
  sourceCount?: number;
  previewCount?: number;
  bootstrapCount?: number;
  bootstrapTag?: Node["tagName"];
  sourceTag?: Node["tagName"];
  previewTag?: Node["tagName"];
};

function pageFixture(options: FixtureOptions) {
  const removed: string[] = [];
  const visible = { textContent: "safe visible content" };
  const page = (options.bootstrap as { page?: unknown }).page;
  const defaultSourceCount = page === "paste" || page === "markdown" ? 1 : 0;
  const sources = options.sources ?? Array.from(
    { length: options.sourceCount ?? defaultSourceCount },
    () => encodeSourceData("source"),
  );
  const previews = options.previews ?? Array.from(
    { length: options.previewCount ?? 0 },
    () => "<p>trusted preview</p>",
  );
  const bootstrapCount = options.bootstrapCount ?? 1;
  const bootstrapNodes = Array.from(
    { length: bootstrapCount },
    () => node("bootstrap", JSON.stringify(options.bootstrap), "", options.bootstrapTag ?? "SCRIPT"),
  );
  const sourceNodes = sources.map((source) => node("source-data", source, "", options.sourceTag ?? "SCRIPT"));
  const previewNodes = previews.map((preview) => node("initial-markdown-preview", "", preview, options.previewTag ?? "TEMPLATE"));

  function node(id: Node["id"], textContent: string, innerHTML: string, tagName: Node["tagName"]): Node {
    return {
      id,
      tagName,
      textContent,
      innerHTML,
      getAttribute(name: string): string | null {
        if (id === "bootstrap" && name === "type") return "application/json";
        if (id === "source-data" && name === "type") return "application/octet-stream";
        if (id === "source-data" && name === "data-source-encoding") return "utf-8-base64";
        return null;
      },
      remove: vi.fn(() => removed.push(id)),
    };
  }

  const document = {
    querySelectorAll(selector: string): Node[] {
      if (selector === "#bootstrap") return bootstrapNodes;
      if (selector === "#source-data") return sourceNodes;
      if (selector === "#initial-markdown-preview") return previewNodes;
      return [];
    },
  } as unknown as Document;

  return {
    document,
    visible,
    removeCalls(): string[] {
      return removed;
    },
  };
}

describe("initial page bootstrap", () => {
  it("removes every inert node after an exact CR/CRLF source is extracted", () => {
    const fixture = pageFixture({
      bootstrap: { page: "paste", locale: "en", paste: summary({ format: "text" }), consumed: false },
      sources: [encodeSourceData("a\r\nb\rc\n")],
      previews: [],
    });

    const result = extractInitialPage(fixture.document, new URL("https://paste.test/id?x=1&password=a%2Bb#frag"));

    expect(result).toMatchObject({ ok: true, exactSource: "a\r\nb\rc\n", password: "a+b" });
    expect(fixture.removeCalls()).toEqual(["bootstrap", "source-data"]);
  });

  it.each([
    ["missing ordinary source", 0, 0],
    ["duplicate ordinary source", 2, 0],
    ["unexpected text preview", 1, 1],
  ])("fails closed for %s", (_name, sourceCount, previewCount) => {
    const result = extractInitialPage(pageFixture({
      bootstrap: { page: "paste", locale: "en", paste: summary({ format: "text" }), consumed: false },
      sourceCount,
      previewCount,
    }).document, new URL("https://paste.test/id"));

    expect(result).toEqual({ ok: false, locale: "en", errorCode: "INTERNAL_ERROR" });
  });

  it("accepts every bootstrap row with its exact transport cardinality", () => {
    const cases: Array<{
      bootstrap: AppBootstrap;
      sources?: string[];
      previews?: string[];
      expected: Record<string, unknown>;
      removed: string[];
    }> = [
      {
        bootstrap: { page: "create", locale: "en" },
        expected: { ok: true, bootstrap: { page: "create", locale: "en" }, password: null },
        removed: ["bootstrap"],
      },
      {
        bootstrap: { page: "password", locale: "zh-CN", errorCode: "FORBIDDEN" },
        expected: { ok: true, bootstrap: { page: "password", locale: "zh-CN", errorCode: "FORBIDDEN" }, password: null },
        removed: ["bootstrap"],
      },
      {
        bootstrap: { page: "error", locale: "en", status: 500, errorCode: "INTERNAL_ERROR" },
        expected: { ok: true, bootstrap: { page: "error", locale: "en", status: 500, errorCode: "INTERNAL_ERROR" }, password: null },
        removed: ["bootstrap"],
      },
      {
        bootstrap: { page: "paste", locale: "en", paste: summary(), consumed: false },
        sources: [encodeSourceData("text")],
        expected: { ok: true, exactSource: "text", initialMarkdown: null, password: "ignored" },
        removed: ["bootstrap", "source-data"],
      },
      {
        bootstrap: { page: "paste", locale: "en", consumed: true, hasInitialMarkdownPreview: false },
        sources: [encodeSourceData("consumed")],
        expected: { ok: true, exactSource: "consumed", initialMarkdown: null, password: "ignored" },
        removed: ["bootstrap", "source-data"],
      },
      {
        bootstrap: { page: "paste", locale: "en", paste: summary({ format: "markdown" }), consumed: false },
        sources: [encodeSourceData("# markdown")],
        previews: ["<h1>markdown</h1>"],
        expected: { ok: true, exactSource: "# markdown", initialMarkdown: "<h1>markdown</h1>", password: "ignored" },
        removed: ["bootstrap", "source-data", "initial-markdown-preview"],
      },
      {
        bootstrap: { page: "paste", locale: "en", consumed: true, hasInitialMarkdownPreview: true },
        sources: [encodeSourceData("# consumed")],
        previews: ["<h1>consumed</h1>"],
        expected: { ok: true, exactSource: "# consumed", initialMarkdown: "<h1>consumed</h1>", password: "ignored" },
        removed: ["bootstrap", "source-data", "initial-markdown-preview"],
      },
      {
        bootstrap: { page: "markdown", locale: "en", id: "example", title: "Example", hasInitialMarkdownPreview: true },
        sources: [encodeSourceData("# document")],
        previews: ["<h1>document</h1>"],
        expected: { ok: true, exactSource: "# document", initialMarkdown: "<h1>document</h1>", password: "ignored" },
        removed: ["bootstrap", "source-data", "initial-markdown-preview"],
      },
    ];

    for (const testCase of cases) {
      const fixture = pageFixture(testCase);
      expect(extractInitialPage(fixture.document, new URL("https://paste.test/id?password=ignored"))).toMatchObject(testCase.expected);
      expect(fixture.removeCalls()).toEqual(testCase.removed);
    }
  });

  it("rejects bootstrap schema violations and removes every inert transport node", () => {
    const malformed = [
      { page: "create", locale: "en", extra: true },
      { page: "paste", locale: "en", paste: summary({ contentBytes: "4" as unknown as number }), consumed: false },
      { page: "paste", locale: "en", paste: summary({ links: { ...summary().links, raw: 1 as unknown as string } }), consumed: false },
      { page: "password", locale: "en", errorCode: "INTERNAL_ERROR" },
      { page: "error", locale: "en", status: "500", errorCode: "INTERNAL_ERROR" },
    ];

    for (const bootstrap of malformed) {
      const fixture = pageFixture({ bootstrap, sources: [encodeSourceData("encoded source")], previews: ["<p>preview</p>"] });
      expect(extractInitialPage(fixture.document, new URL("https://paste.test/id"))).toEqual({ ok: false, locale: "en", errorCode: "INTERNAL_ERROR" });
      expect(fixture.removeCalls()).toEqual(["bootstrap", "source-data", "initial-markdown-preview"]);
      expect(fixture.visible.textContent).toBe("safe visible content");
    }
  });

  it("rejects duplicate password queries before page-specific results", () => {
    const bootstraps: AppBootstrap[] = [
      { page: "create", locale: "en" },
      { page: "password", locale: "en", errorCode: null },
      { page: "error", locale: "en", status: 500, errorCode: "INTERNAL_ERROR" },
    ];

    for (const bootstrap of bootstraps) {
      const fixture = pageFixture({ bootstrap });
      expect(extractInitialPage(fixture.document, new URL("https://paste.test/id?password=one&password=two"))).toEqual({
        ok: false,
        locale: "en",
        errorCode: "INTERNAL_ERROR",
      });
      expect(fixture.removeCalls()).toEqual(["bootstrap"]);
    }
  });

  it("rejects non-inert bootstrap, source, and preview nodes", () => {
    const cases: Array<[FixtureOptions, string[]]> = [
      [{ bootstrap: { page: "create", locale: "en" }, bootstrapTag: "DIV" }, ["bootstrap"]],
      [
        {
          bootstrap: { page: "paste", locale: "en", paste: summary(), consumed: false },
          sources: [encodeSourceData("source")],
          sourceTag: "DIV",
        },
        ["bootstrap", "source-data"],
      ],
      [
        {
          bootstrap: { page: "paste", locale: "en", paste: summary({ format: "markdown" }), consumed: false },
          sources: [encodeSourceData("source")],
          previews: ["<h1>preview</h1>"],
          previewTag: "DIV",
        },
        ["bootstrap", "source-data", "initial-markdown-preview"],
      ],
    ];

    for (const [options, removed] of cases) {
      const fixture = pageFixture(options);
      expect(extractInitialPage(fixture.document, new URL("https://paste.test/id"))).toEqual({
        ok: false,
        locale: "en",
        errorCode: "INTERNAL_ERROR",
      });
      expect(fixture.removeCalls()).toEqual(removed);
      expect(fixture.visible.textContent).toBe("safe visible content");
    }
  });

  it("rejects duplicate IDs, source decode failures, and preview mismatches after cleanup", () => {
    const invalidCases: Array<[FixtureOptions, number]> = [
      [{ bootstrap: { page: "create", locale: "en" }, bootstrapCount: 2 }, 2],
      [{ bootstrap: { page: "paste", locale: "en", paste: summary(), consumed: false }, sources: ["/w=="] }, 2],
      [
        {
          bootstrap: { page: "paste", locale: "en", paste: summary({ format: "markdown" }), consumed: false },
          sources: [encodeSourceData("source")],
          previews: [],
        },
        2,
      ],
      [
        {
          bootstrap: { page: "paste", locale: "en", paste: summary({ format: "markdown" }), consumed: false },
          sources: [encodeSourceData("source")],
          previews: ["<h1>one</h1>", "<h1>two</h1>"],
        },
        4,
      ],
    ];

    for (const [options, count] of invalidCases) {
      const fixture = pageFixture(options);
      const result = extractInitialPage(fixture.document, new URL("https://paste.test/id"));
      expect(result).toEqual({ ok: false, locale: "en", errorCode: "INTERNAL_ERROR" });
      expect(fixture.removeCalls()).toHaveLength(count);
      expect(fixture.visible.textContent).toBe("safe visible content");
    }
  });

  it("rewrites only the unique password query in a relative history URL", () => {
    const target = new URL("https://paste.test/id?keep=one&password=old&keep=two#fragment");
    const replacement = withPastePassword(target, "new +%&#?");
    const replaceState = vi.fn();
    vi.stubGlobal("history", { replaceState });

    expect([...replacement.searchParams.entries()]).toEqual([
      ["keep", "one"],
      ["keep", "two"],
      ["password", "new +%&#?"],
    ]);
    expect(replacement.hash).toBe("#fragment");

    commitPastePassword(target, null);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/id?keep=one&keep=two#fragment");
  });
});
