import { describe, expect, it } from "vitest";
import { diffResponse } from "./diff";

describe("diff worker protocol", () => {
  it("returns structured line records with exact newline markers", () => {
    const response = diffResponse({ type: "diff", id: 4, previous: "a\nb\n", current: "a\nc\n" });

    expect(response).toEqual({
      type: "result",
      id: 4,
      lines: [
        { kind: "same", text: "a\n" },
        { kind: "delete", text: "b\n" },
        { kind: "add", text: "c\n" },
      ],
    });
  });
});
