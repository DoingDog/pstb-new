import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assetPaths } from "./generated/assets";

const { resolveManifestAssets } = await import(new URL("../scripts/build.mjs", import.meta.url).href) as {
  resolveManifestAssets(manifest: Record<string, unknown>): { appJs: string; appCss: string; diffWorker: string };
};

const dependencies = {
  "@milkdown/crepe": "7.22.1",
  "@modelcontextprotocol/server": "2.0.0",
  "class-variance-authority": "0.7.1",
  cn: "0.3.0",
  diff: "8.0.2",
  hono: "4.13.7",
  "lucide-react": "1.45.0",
  micromark: "4.0.2",
  "micromark-extension-gfm": "3.0.0",
  "radix-ui": "1.6.7",
  react: "19.3.0",
  "react-dom": "19.3.0",
  "tw-animate-css": "1.4.0",
  zod: "4.6.4",
};

const devDependencies = {
  "@axe-core/playwright": "4.13.0",
  "@cloudflare/vitest-plugin": "1.1.8",
  "@cloudflare/workers-types": "5.20260911.1",
  "@playwright/test": "1.63.0",
  "@tailwindcss/vite": "4.3.3",
  "@types/node": "26.4.1",
  "@types/react": "19.3.0",
  "@types/react-dom": "19.3.0",
  "@vitejs/plugin-react": "6.1.1",
  "@vitest/browser-playwright": "4.1.11",
  tailwindcss: "4.3.3",
  typescript: "7.0.2",
  vite: "8.3.0",
  vitest: "4.1.11",
  wrangler: "4.131.1",
};

const scripts = {
  "build:client": "node scripts/build.mjs",
  build: "npm run build:client && tsc --noEmit",
  typecheck: "npm run build:client && tsc --noEmit",
  test: "npm run build:client && vitest run",
  "test:e2e": "playwright test",
  "dev:local": "wrangler dev --local --port 8787 --show-interactive-dev-session=false",
  "dev:e2e": "npm run build && wrangler dev --local --port 8787 --show-interactive-dev-session=false",
  smoke: "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke.ps1",
  verify: "npm run build && vitest run && playwright test && node scripts/browser-evidence.mjs self-test && node scripts/verify-release-evidence.mjs --self-test && node scripts/verify-release-evidence.mjs && npm run smoke && wrangler types --check && wrangler deploy --dry-run --outdir .wrangler-dist",
};

const validManifest = {
  "index.html": {
    file: "assets/app-entry.js",
    src: "index.html",
    isEntry: true,
    css: ["assets/app-entry.css"],
  },
  "src/client/diff.ts": {
    file: "assets/diff-worker.js",
    src: "src/client/diff.ts",
    isEntry: true,
  },
};

describe("build contract", () => {
  it("publishes generated URLs that resolve to the complete deploy tree", async () => {
    const generatedPaths = Object.values(assetPaths);
    const deployAssets = (await readdir("dist/assets/assets")).sort();

    expect(generatedPaths).toHaveLength(3);
    for (const path of generatedPaths) {
      expect(existsSync(resolve("dist/assets", `.${path}`))).toBe(true);
    }
    expect((await readdir("dist/assets")).sort()).toEqual(["_headers", "assets"]);
    expect(deployAssets).toEqual(generatedPaths.map((path) => path.slice("/assets/".length)).sort());
    expect(existsSync("dist/assets/_headers")).toBe(true);
    expect(existsSync("dist/assets/index.html")).toBe(false);
    expect(existsSync("dist/assets/.vite/manifest.json")).toBe(false);
  });

  it("requires exactly the two approved manifest entries", () => {
    expect(resolveManifestAssets(validManifest)).toEqual({
      appJs: "assets/app-entry.js",
      appCss: "assets/app-entry.css",
      diffWorker: "assets/diff-worker.js",
    });
    expect(resolveManifestAssets({
      ...validManifest,
      "src/client/chunk.ts": { file: "assets/chunk.js", src: "src/client/chunk.ts" },
    })).toEqual({
      appJs: "assets/app-entry.js",
      appCss: "assets/app-entry.css",
      diffWorker: "assets/diff-worker.js",
    });
    expect(() => resolveManifestAssets({ "index.html": validManifest["index.html"] })).toThrow();
    expect(() => resolveManifestAssets({
      ...validManifest,
      "src/client/diff.ts": { ...validManifest["src/client/diff.ts"], src: "src/client/wrong.ts" },
    })).toThrow();
    expect(() => resolveManifestAssets({
      ...validManifest,
      "src/client/extra.ts": { file: "assets/extra.js", src: "src/client/extra.ts", isEntry: true },
    })).toThrow();
  });

  it("pins the exact React Vite Tailwind package and lockfile contract", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      engines: Record<string, string>;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const lock = JSON.parse(await readFile("package-lock.json", "utf8")) as {
      packages: Record<string, {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        version?: string;
        license?: string;
        peerDependencies?: Record<string, string>;
      }>;
    };

    expect(manifest.engines).toEqual({ node: ">=22.12.0" });
    expect(manifest.scripts).toEqual(scripts);
    expect(manifest.dependencies).toEqual(dependencies);
    expect(manifest.devDependencies).toEqual(devDependencies);
    expect(lock.packages[""]?.dependencies).toEqual(dependencies);
    expect(lock.packages[""]?.devDependencies).toEqual(devDependencies);
    expect(lock.packages["node_modules/@axe-core/playwright"]).toMatchObject({
      version: "4.13.0",
      license: "MPL-2.0",
    });
    expect(lock.packages["node_modules/@axe-core/playwright"]?.peerDependencies?.["playwright-core"]?.replaceAll(" ", "")).toBe(">=1.0.0");
    expect(existsSync("index.html")).toBe(true);
    expect(existsSync("vite.config.ts")).toBe(true);
  });
});
