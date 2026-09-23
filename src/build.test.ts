import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build as viteBuild } from "vite";
import { describe, expect, it } from "vitest";
import { assetPaths } from "./generated/assets";

const {
  assertDynamicRootsOutsideInitial,
  markdownBudgetPaths,
  resolveManifestAssets,
  resolveMarkdownRoots,
  resolveWorkerBundleAssets,
} = await import(new URL("../scripts/build.mjs", import.meta.url).href) as {
  assertDynamicRootsOutsideInitial(manifest: Record<string, unknown>, rootKeys: string[], group: string): void;
  markdownBudgetPaths(markdownClosure: Iterable<string>, initial: Iterable<string>, pageClosures: Record<string, string[]>): string[];
  resolveManifestAssets(manifest: Record<string, unknown>): { appJs: string; appCss: string; diffWorker: string };
  resolveMarkdownRoots(manifest: Record<string, unknown>): string[];
  resolveWorkerBundleAssets?: (bundle: Record<string, unknown>) => { entry: string; assets: string[] };
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

const installedNotices = {
  "@milkdown/crepe@7.22.1": "node_modules/@milkdown/crepe/LICENSE",
  "@modelcontextprotocol/server@2.0.0": "node_modules/@modelcontextprotocol/server/LICENSE",
  "class-variance-authority@0.7.1": "node_modules/class-variance-authority/LICENSE",
  "cn@0.3.0": "node_modules/cn/LICENSE",
  "diff@8.0.2": "node_modules/diff/LICENSE",
  "hono@4.13.7": "node_modules/hono/LICENSE",
  "lucide-react@1.45.0": "node_modules/lucide-react/LICENSE",
  "micromark@4.0.2": "node_modules/micromark/license",
  "micromark-extension-gfm@3.0.0": "node_modules/micromark-extension-gfm/license",
  "radix-ui@1.6.7": "node_modules/radix-ui/LICENSE",
  "react@19.3.0": "node_modules/react/LICENSE",
  "react-dom@19.3.0": "node_modules/react-dom/LICENSE",
  "tw-animate-css@1.4.0": "node_modules/tw-animate-css/LICENSE",
  "typescript@7.0.2": "node_modules/typescript/LICENSE",
  "TypeScript distributed NOTICE": "node_modules/typescript/NOTICE.txt",
  "zod@4.6.4": "node_modules/zod/LICENSE",
} as const;

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
    ...(name === "OrdinaryPage" ? { assets: ["assets/diff-worker.js"] } : {}),
  }])),
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

const normalizeNotice = (value: string): string => value.replaceAll("\r\n", "\n").replace(/[\t ]+\n/gu, "\n").trim();

const pinnedShadcnSourceNotice = [
  "The following source was materialized or adapted from `shadcn-ui/ui` at commit `2b3e6d4f8d9161fe5c19340dc383aade392012dd`, using style `new-york-v4`, block `sidebar-11`, and `shadcn@4.21.0` for one-time materialization. The normal build does not invoke the shadcn CLI or a registry.",
  "",
  "### Block source paths",
  "",
  ...copiedSourceFiles
    .filter(([, upstreamPath]) => upstreamPath.startsWith("apps/v4/registry/new-york-v4/blocks/sidebar-11/"))
    .map(([localPath, upstreamPath]) => `- \`${upstreamPath}\` -> \`${localPath}\``),
  "",
  "### Materialized primitive and hook source paths",
  "",
  ...copiedSourceFiles
    .filter(([, upstreamPath]) => !upstreamPath.startsWith("apps/v4/registry/new-york-v4/blocks/sidebar-11/"))
    .map(([localPath, upstreamPath]) => `- \`${upstreamPath}\` -> \`${localPath}\``),
].join("\n");

const shadcnMitLicense = [
  "Copyright (c) 2023 shadcn",
  "",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  "of this software and associated documentation files (the \"Software\"), to deal",
  "in the Software without restriction, including without limitation the rights",
  "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
  "copies of the Software, and to permit persons to whom the Software is",
  "furnished to do so, subject to the following conditions:",
  "",
  "The above copyright notice and this permission notice shall be included in all",
  "copies or substantial portions of the Software.",
  "",
  "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR",
  "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
  "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
  "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
  "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
  "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
  "SOFTWARE.",
].join("\n");

function parseNoticeSections(notices: string): Map<string, string> {
  const markdown = notices.replaceAll("\r\n", "\n");
  const headings = [...markdown.matchAll(/^## (.+)$/gmu)];
  const sections = new Map<string, string>();
  for (const [index, heading] of headings.entries()) {
    const name = heading[1]!;
    if (sections.has(name)) throw new Error(`Duplicate third-party notice section: ${name}`);
    const start = heading.index! + heading[0].length;
    const end = headings[index + 1]?.index ?? markdown.length;
    sections.set(name, markdown.slice(start, end));
  }
  return sections;
}

function requiredNoticeSection(sections: Map<string, string>, name: string): string {
  const section = sections.get(name);
  if (section === undefined) throw new Error(`Missing third-party notice section: ${name}`);
  return section;
}

async function assertThirdPartyNotices(notices: string): Promise<void> {
  const sections = parseNoticeSections(notices);
  if (normalizeNotice(requiredNoticeSection(sections, "Pinned shadcn/ui source")) !== pinnedShadcnSourceNotice) {
    throw new Error("Pinned shadcn/ui source section does not match expected content");
  }
  if (normalizeNotice(requiredNoticeSection(sections, "shadcn/ui MIT License")) !== shadcnMitLicense) {
    throw new Error("shadcn/ui MIT License section does not match expected content");
  }
  for (const [packageName, sourcePath] of Object.entries(installedNotices)) {
    const installedNotice = normalizeNotice(await readFile(sourcePath, "utf8"));
    if (normalizeNotice(requiredNoticeSection(sections, packageName)) !== installedNotice) {
      throw new Error(`Notice section ${packageName} does not match ${sourcePath}`);
    }
  }
  expect(notices).not.toMatch(/[\t ]+$/mu);
  expect(notices).toMatch(/\n$/u);
  expect(notices).not.toMatch(/\n\n$/u);
}

describe("build contract", () => {
  it("uses only the production Worker binding and custom domain", async () => {
    expect(JSON.parse(await readFile("wrangler.jsonc", "utf8"))).toEqual({
      $schema: "node_modules/wrangler/config-schema.json",
      name: "cf-pastebin-new",
      main: "src/index.ts",
      compatibility_date: "2026-09-12",
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: "b-new.awsl.app", custom_domain: true, previews_enabled: false }],
      kv_namespaces: [{ binding: "PASTE_DB", id: "cd0ebbaba15e486a8e1071bb21e31a9f" }],
      assets: { directory: "./dist/assets" },
    });
  });

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

  it("requires the sole app entry and the emitted runtime diff worker", () => {
    expect(resolveManifestAssets(validManifest)).toEqual({
      appJs: "assets/app-entry.js",
      appCss: "assets/app-entry.css",
      diffWorker: "assets/diff-worker.js",
    });
    expect(resolveManifestAssets({
      ...validManifest,
      "src/client/chunk.ts": { file: "assets/chunk-extra.js", src: "src/client/chunk.ts" },
    })).toEqual({
      appJs: "assets/app-entry.js",
      appCss: "assets/app-entry.css",
      diffWorker: "assets/diff-worker.js",
    });
    expect(() => resolveManifestAssets({ "index.html": validManifest["index.html"] })).toThrow();
    expect(() => resolveManifestAssets({
      ...validManifest,
      [pageSources.OrdinaryPage]: {
        file: "assets/OrdinaryPage-entry.js",
        src: pageSources.OrdinaryPage,
        isDynamicEntry: true,
        assets: [],
      },
    })).toThrow();
    expect(() => resolveManifestAssets({
      ...validManifest,
      "src/client/extra.ts": { file: "assets/extra-more.js", src: "src/client/extra.ts", isEntry: true },
    })).toThrow();
  });

  it("requires the OrdinaryPage dynamic entry to be the sole runtime diff worker owner", () => {
    const worker = "assets/diff-worker.js";
    const initialOwner = {
      ...validManifest,
      "index.html": { ...validManifest["index.html"], assets: [worker] },
    };
    const soleInitialOwner = {
      ...initialOwner,
      [pageSources.OrdinaryPage]: {
        file: "assets/OrdinaryPage-entry.js",
        src: pageSources.OrdinaryPage,
        isDynamicEntry: true,
        assets: [],
      },
    };
    const passwordPageOwner = {
      ...validManifest,
      [pageSources.PasswordPage]: {
        file: "assets/PasswordPage-entry.js",
        src: pageSources.PasswordPage,
        isDynamicEntry: true,
        assets: [worker],
      },
    };
    const ordinaryPageWithoutDynamicEntry = {
      ...validManifest,
      [pageSources.OrdinaryPage]: {
        file: "assets/OrdinaryPage-entry.js",
        src: pageSources.OrdinaryPage,
        isDynamicEntry: false,
        assets: [worker],
      },
    };

    expect(() => resolveManifestAssets(initialOwner)).toThrow(
      "Runtime diff worker must be owned only by the OrdinaryPage dynamic entry record",
    );
    expect(() => resolveManifestAssets(soleInitialOwner)).toThrow(
      "Runtime diff worker must be owned only by the OrdinaryPage dynamic entry record",
    );
    expect(() => resolveManifestAssets(passwordPageOwner)).toThrow(
      "Runtime diff worker must be owned only by the OrdinaryPage dynamic entry record",
    );
    expect(() => resolveManifestAssets(ordinaryPageWithoutDynamicEntry)).toThrow(
      "Runtime diff worker must be owned only by the OrdinaryPage dynamic entry record",
    );
    expect(resolveManifestAssets(validManifest).diffWorker).toBe(worker);
  });

  it("captures every emitted file in a split pinned-Vite worker bundle", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "cf-pastebin-vite-worker-"));
    let workerBundle: Record<string, unknown> | undefined;

    try {
      await Promise.all([
        writeFile(join(fixtureRoot, "index.html"), '<script type="module" src="/main.js"></script>'),
        writeFile(join(fixtureRoot, "main.js"), 'new Worker(new URL("./worker.js", import.meta.url), { type: "module" });'),
        writeFile(join(fixtureRoot, "worker.js"), 'void import("./worker-dependency.js").then(({ value }) => postMessage(value));'),
        writeFile(join(fixtureRoot, "worker-dependency.js"), 'export const value = "worker dependency";'),
      ]);
      await viteBuild({
        configFile: false,
        root: fixtureRoot,
        publicDir: false,
        logLevel: "silent",
        build: {
          manifest: true,
          outDir: "dist",
          rollupOptions: {
            input: join(fixtureRoot, "index.html"),
            output: {
              entryFileNames: "assets/app-[hash].js",
              chunkFileNames: "assets/[name]-[hash].js",
            },
          },
        },
        worker: {
          format: "es",
          plugins: () => [{
            name: "capture-worker-bundle-fixture",
            generateBundle(_options, bundle) {
              workerBundle = Object.fromEntries(Object.entries(bundle).map(([key, output]) => [key, output.type === "chunk"
                ? {
                    type: output.type,
                    fileName: output.fileName,
                    facadeModuleId: output.facadeModuleId,
                    isEntry: output.isEntry,
                  }
                : { type: output.type, fileName: output.fileName }]));
            },
          }],
          rollupOptions: {
            output: {
              entryFileNames: "assets/diff-[hash].js",
              chunkFileNames: "assets/[name]-[hash].js",
            },
          },
        },
      });

      expect(workerBundle).toBeDefined();
      const outputs = Object.values(workerBundle!) as Array<{ fileName: string; isEntry?: boolean }>;
      const workerEntry = outputs.find((output) => output.isEntry)?.fileName;
      const workerAssets = outputs.map((output) => output.fileName).sort();
      expect(workerAssets).toHaveLength(2);
      expect(workerEntry).toMatch(/^assets\/diff-[A-Za-z0-9_-]+\.js$/u);

      const rawManifest = JSON.parse(await readFile(join(fixtureRoot, "dist/.vite/manifest.json"), "utf8")) as Record<string, { assets?: string[] }>;
      const rawOwnerAssets = Object.values(rawManifest).flatMap((record) => record.assets ?? []);
      expect(rawOwnerAssets).toEqual([workerEntry]);
      expect(resolveWorkerBundleAssets?.(workerBundle!)).toEqual({
        entry: workerEntry,
        assets: workerAssets,
      });
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("validates every top-level manifest record before graph discovery", () => {
    for (const invalid of [null, 1, []]) {
      expect(() => resolveManifestAssets({ ...validManifest, unused: invalid })).toThrow(
        "Vite manifest record must be an object: unused",
      );
    }
    expect(() => resolveManifestAssets({ ...validManifest, unused: { file: 1 } })).toThrow(
      "Manifest record unused is not a content-hashed asset path",
    );
  });

  it("accounts for the Markdown graph per callsite before deduplicating", () => {
    const pageClosures = {
      OrdinaryPage: ["ordinary-only", "shared-markdown"],
      LocalOnlyPastePage: ["local-only"],
      MarkdownPage: ["markdown-page-only"],
    };

    expect(markdownBudgetPaths(
      ["initial", "markdown-only", "shared-markdown"],
      ["initial"],
      pageClosures,
    )).toEqual(["markdown-only", "shared-markdown"]);
  });

  it("rejects a raw-manifest lazy root hoisted into the entry graph", () => {
    const eagerMarkdownManifest = {
      "index.html": {
        file: "assets/app-entry.js",
        src: "index.html",
        isEntry: true,
        imports: ["micromark"],
      },
      micromark: {
        file: "assets/micromark-entry.js",
        name: "micromark",
      },
    };

    expect(() => assertDynamicRootsOutsideInitial(eagerMarkdownManifest, ["micromark"], "Markdown")).toThrow(
      "Markdown dynamic root is reachable from the initial graph",
    );
  });

  it("rejects an eager static implementation of an otherwise dynamic root", () => {
    const eagerMarkdownImplementationManifest = {
      "index.html": {
        file: "assets/app-entry.js",
        src: "index.html",
        isEntry: true,
        imports: ["markdown-implementation"],
      },
      micromark: {
        file: "assets/micromark-entry.js",
        name: "micromark",
        imports: ["markdown-implementation"],
      },
      "markdown-implementation": {
        file: "assets/markdown-implementation.js",
      },
    };

    expect(() => assertDynamicRootsOutsideInitial(eagerMarkdownImplementationManifest, ["micromark"], "Markdown")).toThrow(
      "Markdown lazy implementation is reachable from the initial graph",
    );
  });

  it("requires both pinned Markdown roots", () => {
    const missingMarkdownRootManifest = {
      "index.html": {
        file: "assets/app-entry.js",
        src: "index.html",
        isEntry: true,
        dynamicImports: ["micromark"],
      },
      micromark: {
        file: "assets/micromark-entry.js",
        name: "micromark",
      },
    };

    expect(() => resolveMarkdownRoots(missingMarkdownRootManifest)).toThrow(
      "Expected one Markdown dynamic root named micromark-extension-gfm",
    );
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
      expect(record).toEqual({ localPath, upstreamPath, sha256: sha256(Buffer.from(sourceText.replaceAll("\r\n", "\n"))) });
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

  it("rejects notice mutations that document-wide containment accepts", async () => {
    const notices = (await readFile("THIRD_PARTY_NOTICES.md", "utf8")).replaceAll("\r\n", "\n");
    const section = (heading: string): string => {
      const start = notices.indexOf(`## ${heading}\n`);
      const end = notices.indexOf("\n## ", start + 1);
      return notices.slice(start, end === -1 ? notices.length : end);
    };
    const diffSection = section("diff@8.0.2");
    const swappedHeadingNotices = notices
      .replace("## diff@8.0.2", "## swapped package heading")
      .replace("## hono@4.13.7", "## diff@8.0.2")
      .replace("## swapped package heading", "## hono@4.13.7");

    for (const { mutated, reason } of [
      {
        mutated: swappedHeadingNotices,
        reason: "Notice section diff@8.0.2 does not match node_modules/diff/LICENSE",
      },
      {
        mutated: notices.replace("## hono@4.13.7", `${diffSection}\n\n## hono@4.13.7`),
        reason: "Duplicate third-party notice section: diff@8.0.2",
      },
      {
        mutated: notices.replace(diffSection, ""),
        reason: "Missing third-party notice section: diff@8.0.2",
      },
      {
        mutated: notices.replace("## Pinned shadcn/ui source\n\n", ""),
        reason: "Missing third-party notice section: Pinned shadcn/ui source",
      },
      {
        mutated: notices.replace("one-time materialization", "one time materialization"),
        reason: "Pinned shadcn/ui source section does not match expected content",
      },
      {
        mutated: notices.replace("Copyright (c) 2023 shadcn", "Copyright (c) 2024 shadcn"),
        reason: "shadcn/ui MIT License section does not match expected content",
      },
    ]) {
      expect(mutated, reason).not.toBe(notices);
      try {
        await assertThirdPartyNotices(mutated);
      } catch (error) {
        expect(error).toHaveProperty("message", reason);
        continue;
      }
      throw new Error(`Accepted notice mutation: ${reason}`);
    }
  });

  it("records exact installed third-party notices", async () => {
    await assertThirdPartyNotices(await readFile("THIRD_PARTY_NOTICES.md", "utf8"));
  });

  it("executes the extracted smoke helper in Windows PowerShell 5.1", async () => {
    if (process.platform !== "win32") return;

    const runPowerShell = (arguments_: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn("powershell.exe", arguments_, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => child.kill(), 15_000);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolveResult({ code, stdout, stderr });
      });
    });

    let version;
    try {
      version = await runPowerShell(["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!/^5\.1\./u.test(version.stdout.trim())) return;
    expect(version.code).toBe(0);

    const requests = new Map<string, { method: string; headers: Record<string, string | string[] | undefined>; body: string }>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const path = request.url ?? "/";
        requests.set(path, { method: request.method ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
        if (path === "/get") {
          response.end("get");
        } else if (path === "/post") {
          response.statusCode = 201;
          response.end("created");
        } else if (path === "/empty") {
          response.statusCode = 204;
          response.end();
        } else if (path === "/missing") {
          response.statusCode = 418;
          response.end("missing");
        } else if (path === "/not-modified") {
          response.statusCode = 304;
          response.setHeader("ETag", "\"test-etag\"");
          response.setHeader("Cache-Control", "no-store");
          response.end();
        } else if (path === "/slow") {
          setTimeout(() => response.end("slow"), 2_000);
        } else {
          response.statusCode = 404;
          response.end();
        }
      });
    });

    await new Promise<void>((resolveServer, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolveServer();
      });
    });

    let temporaryDirectory: string | undefined;
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Local smoke helper endpoint did not bind to a TCP port");
      const smoke = (await readFile("scripts/smoke.ps1", "utf8")).replaceAll("\r\n", "\n");
      const helperEnd = smoke.indexOf("\nnpm run build\n");
      expect(helperEnd).toBeGreaterThan(0);
      temporaryDirectory = await mkdtemp(join(tmpdir(), "cf-pastebin-smoke-helper-"));
      const scriptPath = join(temporaryDirectory, "helper.ps1");
      const base = `http://127.0.0.1:${address.port}`;
      await writeFile(scriptPath, `${smoke.slice(0, helperEnd)}

$get = Invoke-HttpResponse \"${base}/get\" -TimeoutMilliseconds 1000
$post = Invoke-HttpResponse \"${base}/post\" -Method POST -ContentType \"application/json; charset=utf-8\" -Headers @{ \"X-Test\" = \"utf8\" } -Body '{\"message\":\"héllø 世界\"}' -TimeoutMilliseconds 1000
$empty = Invoke-HttpResponse \"${base}/empty\" -Method POST -Body \"\" -TimeoutMilliseconds 1000
$missing = Invoke-HttpResponse \"${base}/missing\" -TimeoutMilliseconds 1000
$notModified = Invoke-HttpResponse \"${base}/not-modified\" -TimeoutMilliseconds 1000
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$timedOut = $false
try {
  Invoke-HttpResponse \"${base}/slow\" -TimeoutMilliseconds 250 | Out-Null
} catch [System.Net.WebException] {
  $timedOut = $true
} finally {
  $stopwatch.Stop()
}
[pscustomobject]@{
  get = [pscustomobject]@{ status = $get.StatusCode; content = $get.Content }
  post = [pscustomobject]@{ status = $post.StatusCode; content = $post.Content }
  empty = [pscustomobject]@{ status = $empty.StatusCode; content = $empty.Content }
  missing = [pscustomobject]@{ status = $missing.StatusCode; content = $missing.Content }
  notModified = [pscustomobject]@{ status = $notModified.StatusCode; etag = [string]$notModified.Headers[\"ETag\"]; cacheControl = [string]$notModified.Headers[\"Cache-Control\"]; hasContentLength = $null -ne $notModified.Headers[\"Content-Length\"]; hasContentType = $null -ne $notModified.Headers[\"Content-Type\"]; hasTrailer = $null -ne $notModified.Headers[\"Trailer\"]; content = $notModified.Content }
  timedOut = $timedOut
  timeoutMilliseconds = $stopwatch.ElapsedMilliseconds
} | ConvertTo-Json -Depth 4 -Compress
`, "utf8");

      const result = await runPowerShell(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath]);
      expect(result.code, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout) as {
        get: { status: number; content: string };
        post: { status: number; content: string };
        empty: { status: number; content: string };
        missing: { status: number; content: string };
        notModified: { status: number; etag: string; cacheControl: string; hasContentLength: boolean; hasContentType: boolean; hasTrailer: boolean; content: string };
        timedOut: boolean;
        timeoutMilliseconds: number;
      };

      expect(output.get).toEqual({ status: 200, content: "get" });
      expect(output.post).toEqual({ status: 201, content: "created" });
      expect(output.empty).toEqual({ status: 204, content: "" });
      expect(output.missing).toEqual({ status: 418, content: "missing" });
      expect(output.notModified).toEqual({
        status: 304,
        etag: "\"test-etag\"",
        cacheControl: "no-store",
        hasContentLength: false,
        hasContentType: false,
        hasTrailer: false,
        content: "",
      });
      expect(output.timedOut).toBe(true);
      expect(output.timeoutMilliseconds).toBeLessThan(1_500);
      expect(requests.get("/get")).toMatchObject({ method: "GET", body: "" });
      expect(requests.get("/get")!.headers).not.toHaveProperty("content-length");
      expect(requests.get("/get")!.headers).not.toHaveProperty("content-type");
      expect(requests.get("/post")).toMatchObject({ method: "POST", body: "{\"message\":\"héllø 世界\"}" });
      expect(requests.get("/post")!.headers).toMatchObject({ "content-type": "application/json; charset=utf-8", "x-test": "utf8" });
      expect(requests.get("/empty")).toMatchObject({ method: "POST", body: "" });
      expect(requests.get("/empty")!.headers).toMatchObject({ "content-length": "0" });
    } finally {
      if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { force: true, recursive: true });
      await new Promise<void>((resolveServer, reject) => server.close((error) => error === undefined ? resolveServer() : reject(error)));
    }
  }, 15_000);
});
