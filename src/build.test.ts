import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
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

const pageSources = {
  CreatePage: "src/client/pages/CreatePage.tsx",
  PasswordPage: "src/client/pages/PasswordPage.tsx",
  ErrorPage: "src/client/pages/ErrorPage.tsx",
  LocalOnlyPastePage: "src/client/pages/LocalOnlyPastePage.tsx",
  MarkdownPage: "src/client/pages/MarkdownPage.tsx",
  OrdinaryPage: "src/client/pages/OrdinaryPage.tsx",
} as const;

const pageNames = Object.keys(pageSources).sort() as Array<keyof typeof pageSources>;

const validManifest = {
  "index.html": {
    file: "assets/app-entry.js",
    src: "index.html",
    isEntry: true,
    css: ["assets/app-entry.css"],
    dynamicImports: Object.values(pageSources),
  },
  ...Object.fromEntries(Object.entries(pageSources).map(([name, src]) => [src, {
    file: `assets/${name}-entry.js`,
    src,
    isDynamicEntry: true,
  }])),
  "src/client/diff.ts": {
    file: "assets/diff-worker.js",
    src: "src/client/diff.ts",
    isEntry: true,
  },
};

type ClientAssetsManifest = {
  schemaVersion: 1;
  entry: { js: string; css: string; diffWorker: string };
  applicationPageRoots: Record<keyof typeof pageSources, string>;
  applicationPageClosures: Record<keyof typeof pageSources, string[]>;
  groups: {
    initial: string[];
    applicationPages: string[];
    markdown: string[];
    crepe: string[];
    diff: string[];
  };
  files: Array<{
    path: string;
    bytes: number;
    gzipLevel9Bytes: number;
    sha256: string;
  }>;
};

type SourceIntegrity = {
  repository: string;
  commit: string;
  style: string;
  block: string;
  cli: string;
  files: Array<{ localPath: string; upstreamPath: string; sha256: string }>;
};

const copiedSourceFiles = [
  ["src/client/App.tsx", "apps/v4/registry/new-york-v4/blocks/sidebar-11/page.tsx"],
  ["src/client/components/app-sidebar.tsx", "apps/v4/registry/new-york-v4/blocks/sidebar-11/components/app-sidebar.tsx"],
  ["src/client/components/ui/sidebar.tsx", "apps/v4/registry/new-york-v4/ui/sidebar.tsx"],
  ["src/client/components/ui/sheet.tsx", "apps/v4/registry/new-york-v4/ui/sheet.tsx"],
  ["src/client/components/ui/breadcrumb.tsx", "apps/v4/registry/new-york-v4/ui/breadcrumb.tsx"],
  ["src/client/components/ui/collapsible.tsx", "apps/v4/registry/new-york-v4/ui/collapsible.tsx"],
  ["src/client/components/ui/dialog.tsx", "apps/v4/registry/new-york-v4/ui/dialog.tsx"],
  ["src/client/components/ui/tooltip.tsx", "apps/v4/registry/new-york-v4/ui/tooltip.tsx"],
  ["src/client/components/ui/tabs.tsx", "apps/v4/registry/new-york-v4/ui/tabs.tsx"],
  ["src/client/components/ui/field.tsx", "apps/v4/registry/new-york-v4/ui/field.tsx"],
  ["src/client/components/ui/label.tsx", "apps/v4/registry/new-york-v4/ui/label.tsx"],
  ["src/client/components/ui/input.tsx", "apps/v4/registry/new-york-v4/ui/input.tsx"],
  ["src/client/components/ui/textarea.tsx", "apps/v4/registry/new-york-v4/ui/textarea.tsx"],
  ["src/client/components/ui/button.tsx", "apps/v4/registry/new-york-v4/ui/button.tsx"],
  ["src/client/components/ui/separator.tsx", "apps/v4/registry/new-york-v4/ui/separator.tsx"],
  ["src/client/hooks/use-mobile.tsx", "apps/v4/registry/new-york-v4/hooks/use-mobile.tsx"],
] as const;

async function listRegularFiles(directory: string, baseDirectory = directory): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listRegularFiles(path, baseDirectory));
    else if (entry.isFile()) files.push(relative(baseDirectory, path).replaceAll("\\", "/"));
  }
  return files;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceComment(upstreamPath: string): string {
  const source = upstreamPath.startsWith("apps/v4/registry/new-york-v4/blocks/sidebar-11/")
    ? "new-york-v4/sidebar-11"
    : upstreamPath.startsWith("apps/v4/registry/new-york-v4/ui/")
      ? `new-york-v4/${upstreamPath.slice("apps/v4/registry/new-york-v4/ui/".length, -".tsx".length)}`
      : upstreamPath;
  return `// Derived from shadcn-ui/ui ${source} at 2b3e6d4f8d9161fe5c19340dc383aade392012dd; MIT; see THIRD_PARTY_NOTICES.md.`;
}

describe("build contract", () => {
  it("publishes generated URLs that resolve to the final client manifest entry", async () => {
    const manifest = JSON.parse(await readFile("dist/client-assets-manifest.json", "utf8")) as ClientAssetsManifest;

    expect(assetPaths).toEqual({
      appJs: `/${manifest.entry.js}`,
      appCss: `/${manifest.entry.css}`,
      diffWorker: `/${manifest.entry.diffWorker}`,
    });
    for (const path of Object.values(assetPaths)) {
      expect(existsSync(resolve("dist/assets", `.${path}`))).toBe(true);
    }
    expect((await listRegularFiles("dist/assets")).sort()).toEqual(manifest.files.map((file) => file.path).sort());
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
    for (const banned of [
      "@hookform/resolvers", "@tanstack/react-query", "@trpc/server", "@vercel/node", "axe-playwright", "chart.js",
      "clsx", "esbuild", "express", "fastify", "jest-axe", "next", "next-auth", "react-hook-form", "react-router",
      "react-router-dom", "recharts", "tailwind-merge",
    ]) expect({ ...manifest.dependencies, ...manifest.devDependencies }).not.toHaveProperty(banned);
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

  it("enforces source integrity for the pinned shadcn materialization", async () => {
    const integrity = JSON.parse(await readFile("docs/shadcn-source-integrity.json", "utf8")) as SourceIntegrity;
    const expectedLocalPaths = copiedSourceFiles.map(([localPath]) => localPath).sort();
    const expectedUpstreamPaths = copiedSourceFiles.map(([, upstreamPath]) => upstreamPath).sort();

    expect(integrity.repository).toBe("shadcn-ui/ui");
    expect(integrity.commit).toBe("2b3e6d4f8d9161fe5c19340dc383aade392012dd");
    expect(integrity.style).toBe("new-york-v4");
    expect(integrity.block).toBe("sidebar-11");
    expect(integrity.cli).toBe("shadcn@4.21.0");
    expect(integrity.files.map((file) => file.localPath).sort()).toEqual(expectedLocalPaths);
    expect(integrity.files.map((file) => file.upstreamPath).sort()).toEqual(expectedUpstreamPaths);
    expect(existsSync("src/client/components/ui/skeleton.tsx")).toBe(false);

    const actualProvenanceFiles: string[] = [];
    for (const path of await listRegularFiles("src/client", ".")) {
      if (!/\.tsx?$/u.test(path)) continue;
      if ((await readFile(path, "utf8")).startsWith("// Derived from shadcn-ui/ui ")) actualProvenanceFiles.push(path);
    }
    expect(actualProvenanceFiles.sort()).toEqual(expectedLocalPaths);

    for (const [localPath, upstreamPath] of copiedSourceFiles) {
      const source = await readFile(localPath);
      const sourceText = new TextDecoder().decode(source);
      const record = integrity.files.find((file) => file.localPath === localPath);
      expect(sourceText.startsWith(sourceComment(upstreamPath))).toBe(true);
      expect(record).toEqual({ localPath, upstreamPath, sha256: sha256(source) });
      expect(sourceText).not.toContain("SidebarMenuSkeleton");
    }
  });

  it("enforces final client manifest and bundle budgets", async () => {
    const manifest = JSON.parse(await readFile("dist/client-assets-manifest.json", "utf8")) as ClientAssetsManifest;
    const byPath = new Map(manifest.files.map((file) => [file.path, file]));
    const gzip = (group: keyof ClientAssetsManifest["groups"]): number =>
      manifest.groups[group].reduce((total, path) => total + byPath.get(path)!.gzipLevel9Bytes, 0);
    const gzipPaths = (paths: string[]): number => paths.reduce((total, path) => total + byPath.get(path)!.gzipLevel9Bytes, 0);
    const initial = new Set(manifest.groups.initial);
    const applicationPages = new Set(manifest.groups.applicationPages);
    const initialJs = manifest.groups.initial.filter((path) => path.endsWith(".js"));
    const initialCss = manifest.groups.initial.filter((path) => path.endsWith(".css"));
    const deployFiles = await listRegularFiles("dist/assets");

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.entry).toEqual({
      js: assetPaths.appJs.slice(1),
      css: assetPaths.appCss.slice(1),
      diffWorker: assetPaths.diffWorker.slice(1),
    });
    expect(Object.keys(manifest.applicationPageRoots).sort()).toEqual(pageNames);
    expect(Object.keys(manifest.applicationPageClosures).sort()).toEqual(pageNames);
    expect(deployFiles.sort()).toEqual(manifest.files.map((file) => file.path).sort());
    expect(manifest.files.map((file) => file.path).sort()).toEqual([...new Set(manifest.files.map((file) => file.path))].sort());
    expect(applicationPages.size).toBe(manifest.groups.applicationPages.length);

    for (const file of manifest.files) {
      const bytes = await readFile(resolve("dist/assets", file.path));
      expect(file.bytes).toBe(bytes.byteLength);
      expect(file.gzipLevel9Bytes).toBe(gzipSync(bytes, { level: 9 }).byteLength);
      expect(file.sha256).toBe(sha256(bytes));
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(file.path.endsWith(".map")).toBe(false);
      if (file.path === "_headers") continue;
      expect(file.path).toMatch(/^assets\/.+-[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/u);
    }
    expect(manifest.files.some((file) => file.path === "_headers")).toBe(true);
    expect(deployFiles.some((path) => path === "index.html" || path.endsWith("manifest.json") || path.endsWith(".map"))).toBe(false);

    for (const pageName of pageNames) {
      const closure = manifest.applicationPageClosures[pageName];
      expect(new Set(closure).size).toBe(closure.length);
      expect(closure).toEqual([...closure].sort());
      expect(closure).toContain(manifest.applicationPageRoots[pageName]);
      expect(closure.every((path) => byPath.has(path) && applicationPages.has(path) && !initial.has(path))).toBe(true);
    }
    expect([...applicationPages].sort()).toEqual(
      [...new Set(pageNames.flatMap((pageName) => manifest.applicationPageClosures[pageName]))].sort(),
    );
    for (const pageName of pageNames.filter((name) => name !== "OrdinaryPage")) {
      expect(manifest.applicationPageClosures[pageName]).not.toContain(manifest.applicationPageRoots.OrdinaryPage);
    }
    for (const paths of Object.values(manifest.groups)) {
      expect(new Set(paths).size).toBe(paths.length);
      expect(paths.every((path) => byPath.has(path))).toBe(true);
    }
    for (const lazyGroup of [manifest.groups.markdown, manifest.groups.crepe, manifest.groups.diff]) {
      expect(lazyGroup.some((path) => initial.has(path))).toBe(false);
    }
    expect(manifest.groups.markdown.length).toBeGreaterThan(0);
    expect(manifest.groups.crepe.length).toBeGreaterThan(0);
    expect(initial.has(manifest.entry.diffWorker)).toBe(false);

    expect(gzipPaths(initialJs)).toBeLessThanOrEqual(250 * 1024);
    expect(gzipPaths(initialCss)).toBeLessThanOrEqual(80 * 1024);
    expect(gzip("markdown")).toBeLessThanOrEqual(150 * 1024);
    expect(gzip("crepe")).toBeLessThanOrEqual(1.5 * 1024 * 1024);
    expect(gzip("diff")).toBeLessThanOrEqual(60 * 1024);
    expect(manifest.files.reduce((total, file) => total + file.bytes, 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("records complete third-party notices", async () => {
    const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");

    expect(notices).toContain("shadcn@4.21.0");
    expect(notices).toContain("2b3e6d4f8d9161fe5c19340dc383aade392012dd");
    for (const [, upstreamPath] of copiedSourceFiles) expect(notices).toContain(upstreamPath);
    expect(notices).toContain("Copyright (c) 2023 shadcn");
    expect(notices).toContain("Permission is hereby granted, free of charge, to any person obtaining a copy");
    expect(notices).toContain("THE SOFTWARE IS PROVIDED \"AS IS\"");
    expect(notices).toContain("Lucide");
    expect(notices).toContain("ISC License");
    expect(notices).toContain("class-variance-authority");
    expect(notices).toContain("TypeScript");
    expect(notices).toContain("Apache License");
    expect(notices).toContain("Version 2.0, January 2004");
    expect(notices.replaceAll("\r\n", "\n")).toContain((await readFile("node_modules/typescript/NOTICE.txt", "utf8")).replaceAll("\r\n", "\n"));
  });
});
