import { describe, expect, it } from "vitest";
import { renderPastePage } from "./render";
import { decodeSourceData } from "./source-data";
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

function parsedSourceData(document: string): string {
  const source = new DOMParser().parseFromString(document, "text/html").querySelector<HTMLScriptElement>("script#source-data");
  expect(source).not.toBeNull();
  return source!.textContent ?? "";
}

describe("application documents", () => {
  it("preserves inert source data through HTML parsing", () => {
    const content = "\nleading\rstandalone\r\ncrlf\0replacement:� <>&  ﻿ non-BMP:\u{1F642}";
    const html = renderPastePage({ locale: "en", paste: { ...paste, format: "text" }, content });

    expect(decodeSourceData(parsedSourceData(html))).toBe(content);
  });
});
