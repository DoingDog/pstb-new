import { describe, expect, it } from "vitest";
import { assetPaths } from "./generated/assets";

describe("build contract", () => {
  it("publishes only resolved hashed application asset URLs", () => {
    expect(assetPaths.appJs).toMatch(/^\/assets\/app-[A-Z0-9]+\.js$/i);
    expect(assetPaths.appCss).toMatch(/^\/assets\/app-[A-Z0-9]+\.css$/i);
    expect(assetPaths.diffWorker).toMatch(/^\/assets\/diff-[A-Z0-9]+\.js$/i);
    expect(new Set(Object.values(assetPaths)).size).toBe(3);
  });
});
