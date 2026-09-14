import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assetPaths } from "./generated/assets";

describe("build contract", () => {
  it("publishes only resolved hashed application asset URLs", () => {
    expect(assetPaths.appJs).toMatch(/^\/assets\/app-[A-Z0-9]+\.js$/i);
    expect(assetPaths.appCss).toMatch(/^\/assets\/app-[A-Z0-9]+\.css$/i);
    expect(assetPaths.diffWorker).toMatch(/^\/assets\/diff-[A-Z0-9]+\.js$/i);
    expect(new Set(Object.values(assetPaths)).size).toBe(3);
  });

  it("pins the React Vite Tailwind toolchain", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      engines?: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.engines?.node).toBe(">=22.12.0");
    expect(manifest.dependencies).toMatchObject({
      react: "19.3.0",
      "react-dom": "19.3.0",
      "radix-ui": "1.6.7",
      cn: "0.3.0",
      zod: "4.6.4",
    });
    expect(manifest.devDependencies).toMatchObject({
      "@axe-core/playwright": "4.13.0",
      vite: "8.3.0",
      tailwindcss: "4.3.3",
      "@tailwindcss/vite": "4.3.3",
    });
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const banned of ["esbuild", "react-hook-form", "@hookform/resolvers", "clsx", "tailwind-merge", "axe-playwright", "jest-axe"])
      expect(all).not.toHaveProperty(banned);
    const lock = JSON.parse(await readFile("package-lock.json", "utf8")) as {
      packages: Record<string, { version?: string; license?: string; peerDependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
    };
    expect(lock.packages[""]?.devDependencies?.["@axe-core/playwright"]).toBe("4.13.0");
    expect(lock.packages["node_modules/@axe-core/playwright"]).toMatchObject({
      version: "4.13.0",
      license: "MPL-2.0",
    });
    expect(lock.packages["node_modules/@axe-core/playwright"]?.peerDependencies?.["playwright-core"]?.replaceAll(" ", "")).toBe(">=1.0.0");
    expect(existsSync("index.html")).toBe(true);
    expect(existsSync("vite.config.ts")).toBe(true);
  });
});
