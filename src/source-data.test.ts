import { describe, expect, it } from "vitest";
import { decodeSourceData, encodeSourceData } from "./source-data";

const exactSource = "\nleading\rstandalone\r\ncrlf\0replacement:� <>&  ﻿ non-BMP:\u{1F642}";

describe("source data transport", () => {
  it("round trips exact UTF-8 source", () => {
    expect(decodeSourceData(encodeSourceData(exactSource))).toBe(exactSource);
  });

  it("rejects invalid base64 and malformed UTF-8", () => {
    expect(() => decodeSourceData("not base64!")).toThrow();
    expect(() => decodeSourceData("/w==")).toThrow();
  });
});
