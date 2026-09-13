import { describe, expect, it } from "vitest";
import { decodeSourceData, encodeSourceData } from "./source-data";

const maxSourceBytes = 10_485_760;
const exactSource = "\nleading\rstandalone\r\ncrlf\0replacement:� <>&  ﻿ non-BMP:\u{1F642}";

describe("source data transport", () => {
  it("round trips exact UTF-8 source", () => {
    expect(decodeSourceData(encodeSourceData(exactSource))).toBe(exactSource);
  });

  it("rejects empty, malformed, and noncanonical base64", () => {
    for (const encoded of ["", "A", "AAA", "AAA_", "A=AA", "AA=A", "A===", "Zh==", "Zm9="]) {
      expect(() => decodeSourceData(encoded), encoded).toThrow();
    }

    expect(decodeSourceData("Zg==")).toBe("f");
    expect(decodeSourceData("Zm8=")).toBe("fo");
  });

  it("rejects malformed UTF-8 and a canonical source one byte over the decoded limit", () => {
    expect(() => decodeSourceData("/w==")).toThrow();

    const overLimit = encodeSourceData("a".repeat(maxSourceBytes + 1));
    expect(overLimit).toHaveLength(13_981_016);
    expect(() => decodeSourceData(overLimit)).toThrow();
  });

  it("round trips the maximum allowed ASCII source without exhausting the stack", () => {
    const source = "a".repeat(maxSourceBytes);
    const encoded = encodeSourceData(source);

    expect(encoded).toHaveLength(13_981_016);
    expect(decodeSourceData(encoded)).toBe(source);
  });
});
