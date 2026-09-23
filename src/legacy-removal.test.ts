import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("legacy removal", () => {
  it("ships only the module Worker without legacy scripts", async () => {
    expect(await exists("worker.js")).toBe(false);
    expect(await exists("aioapi.js")).toBe(false);
    expect(await readFile("wrangler.jsonc", "utf8")).toContain('"main": "src/index.ts"');
    expect(await readFile("src/index.ts", "utf8")).not.toContain('addEventListener("fetch"');
  });
});
