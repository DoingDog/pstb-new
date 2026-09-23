import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const assetsDirectory = resolve(root, "dist/assets");
const clientAssetsManifestPath = resolve(root, "dist/client-assets-manifest.json");
const generatedAssetsPath = resolve(root, "src/generated/assets.ts");
const immutableAssetHeaders = "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n";
const pageSources = Object.freeze({
  CreatePage: "src/client/pages/CreatePage.tsx",
  PasswordPage: "src/client/pages/PasswordPage.tsx",
  ErrorPage: "src/client/pages/ErrorPage.tsx",
  LocalOnlyPastePage: "src/client/pages/LocalOnlyPastePage.tsx",
  MarkdownPage: "src/client/pages/MarkdownPage.tsx",
  OrdinaryPage: "src/client/pages/OrdinaryPage.tsx",
});
const pageNames = Object.keys(pageSources);
const budgets = Object.freeze({
  initialJs: 250 * 1024,
  initialCss: 80 * 1024,
  markdown: 150 * 1024,
  crepe: 1.5 * 1024 * 1024,
  diff: 60 * 1024,
  files: 8 * 1024 * 1024,
});

const markdownRootNames = Object.freeze(["micromark", "micromark-extension-gfm"]);
const crepeRootSources = Object.freeze([
  "node_modules/@milkdown/crepe/lib/esm/index.js",
  "node_modules/@milkdown/kit/lib/core.js",
  "node_modules/@milkdown/kit/lib/prose/state.js",
]);
const sharedInitialRecordNames = Object.freeze(["button", "clsx", "jsx-runtime", "rolldown-runtime"]);

function normalizedPath(path) {
  return path.split(sep).join("/");
}

function assetPath(path) {
  return `/${normalizedPath(path)}`;
}

function removeLineComments(source) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
    } else if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      output += "\n";
    } else {
      output += character;
    }
  }

  return output;
}

async function writeStaticAssetHeaders() {
  const headersPath = resolve(assetsDirectory, "_headers");
  const temporaryPath = `${headersPath}.${process.pid}.tmp`;

  await writeFile(temporaryPath, immutableAssetHeaders);
  await rename(temporaryPath, headersPath);
  if ((await readFile(headersPath, "utf8")) !== immutableAssetHeaders) {
    throw new Error("Static asset headers do not match the build contract");
  }
}

async function writeGeneratedAssets(assetPaths) {
  const contents = `export const assetPaths = Object.freeze({\n  appJs: ${JSON.stringify(assetPaths.appJs)},\n  appCss: ${JSON.stringify(assetPaths.appCss)},\n  diffWorker: ${JSON.stringify(assetPaths.diffWorker)},\n});\n`;
  const temporaryPath = `${generatedAssetsPath}.${process.pid}.tmp`;

  await mkdir(dirname(generatedAssetsPath), { recursive: true });
  await writeFile(temporaryPath, contents);
  await rename(temporaryPath, generatedAssetsPath);
}

async function assertWranglerConfig() {
  const config = JSON.parse(removeLineComments(await readFile(resolve(root, "wrangler.jsonc"), "utf8")));
  const [namespace] = config.kv_namespaces ?? [];
  const namespaceKeys = Object.keys(namespace ?? {}).sort();
  const [route] = config.routes ?? [];
  const routeKeys = Object.keys(route ?? {}).sort();

  if (
    config.name !== "cf-pastebin-new" ||
    config.main !== "src/index.ts" ||
    config.compatibility_date !== "2026-09-12" ||
    config.assets?.directory !== "./dist/assets" ||
    config.workers_dev !== false ||
    config.preview_urls !== false ||
    config.route !== undefined ||
    config.kv_namespaces?.length !== 1 ||
    namespaceKeys.length !== 2 ||
    namespaceKeys[0] !== "binding" ||
    namespaceKeys[1] !== "id" ||
    namespace?.binding !== "PASTE_DB" ||
    namespace?.id !== "cd0ebbaba15e486a8e1071bb21e31a9f" ||
    config.routes?.length !== 1 ||
    routeKeys.length !== 3 ||
    routeKeys[0] !== "custom_domain" ||
    routeKeys[1] !== "pattern" ||
    routeKeys[2] !== "previews_enabled" ||
    route?.pattern !== "n.awsl.app" ||
    route?.custom_domain !== true ||
    route?.previews_enabled !== false
  ) {
    throw new Error("wrangler.jsonc does not match the production build contract");
  }
}

async function readBuiltFiles(directory = assetsDirectory, relativeDirectory = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = `${relativeDirectory}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await readBuiltFiles(resolve(directory, entry.name), `${relativePath}/`));
    } else {
      files.push(relativePath);
    }
  }

  return files.map(normalizedPath);
}

function requireSingle(value, description) {
  if (value.length !== 1) throw new Error(`Expected one ${description}`);
  return value[0];
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value, description) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${description} must be a string array`);
  }
  return value;
}

function manifestRecord(manifest, key) {
  const record = manifest[key];
  if (!isRecord(record)) throw new Error(`Vite manifest record is missing: ${key}`);
  return record;
}

function emittedPath(value, description) {
  if (
    typeof value !== "string" ||
    !/^assets\/.+-[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/u.test(value) ||
    value.includes("\\") ||
    value.includes("..")
  ) {
    throw new Error(`${description} is not a content-hashed asset path`);
  }
  return value;
}

function findSourceRecord(manifest, source) {
  const matches = Object.entries(manifest)
    .filter(([, record]) => isRecord(record) && record.src === source)
    .map(([key]) => key);
  return requireSingle(matches, `manifest record for ${source}`);
}

function resolvePageRecords(manifest, indexEntry) {
  const directDynamicImports = stringList(indexEntry.dynamicImports, "index.html dynamicImports");
  const directSources = new Map(directDynamicImports.map((key) => [key, manifestRecord(manifest, key).src]));
  const records = {};

  for (const [pageName, source] of Object.entries(pageSources)) {
    const key = findSourceRecord(manifest, source);
    if (directSources.get(key) !== source) {
      throw new Error(`index.html must directly dynamically import ${source}`);
    }
    records[pageName] = key;
  }

  const pageDynamicSources = [...directSources.values()].filter((source) => Object.values(pageSources).includes(source));
  if (
    pageDynamicSources.length !== pageNames.length ||
    new Set(pageDynamicSources).size !== pageNames.length ||
    pageNames.some((pageName) => !pageDynamicSources.includes(pageSources[pageName]))
  ) {
    throw new Error("index.html must directly dynamically import exactly the six application pages");
  }

  return records;
}

export function resolveManifestAssets(manifest) {
  if (!isRecord(manifest)) throw new Error("Vite manifest must be an object");
  for (const [key, value] of Object.entries(manifest)) {
    if (!isRecord(value)) throw new Error(`Vite manifest record must be an object: ${key}`);
    emittedPath(value.file, `Manifest record ${key}`);
  }

  const entryKeys = Object.entries(manifest)
    .filter(([, value]) => value.isEntry === true)
    .map(([key]) => key);
  if (entryKeys.length !== 1 || entryKeys[0] !== "index.html") {
    throw new Error("Vite manifest must contain exactly the approved app entry");
  }

  const indexEntry = manifestRecord(manifest, "index.html");
  if (indexEntry.src !== "index.html") {
    throw new Error("Vite manifest entry source does not match the build contract");
  }
  const pageRecords = resolvePageRecords(manifest, indexEntry);
  const diffWorkerPattern = /^assets\/diff-[A-Za-z0-9_-]+\.js$/u;
  const diffWorkerAssets = new Set();
  const diffWorkerOwners = new Set();
  for (const [key, value] of Object.entries(manifest)) {
    for (const asset of stringList(value.assets, `${key} assets`)) {
      const path = emittedPath(asset, `${key} asset`);
      if (!diffWorkerPattern.test(path)) continue;
      diffWorkerAssets.add(path);
      diffWorkerOwners.add(key);
    }
  }
  const diffWorker = requireSingle([...diffWorkerAssets], "runtime diff worker asset");
  if (
    diffWorkerOwners.size !== 1 ||
    !diffWorkerOwners.has(pageRecords.OrdinaryPage) ||
    manifestRecord(manifest, pageRecords.OrdinaryPage).isDynamicEntry !== true
  ) {
    throw new Error("Runtime diff worker must be owned only by the OrdinaryPage dynamic entry record");
  }

  const appJs = emittedPath(indexEntry.file, "Vite app entry");
  const appCss = emittedPath(requireSingle(stringList(indexEntry.css, "index.html css"), "entry CSS file"), "Vite app CSS entry");
  if (!/^assets\/app-[A-Za-z0-9_-]+\.js$/u.test(appJs) || !/^assets\/app-[A-Za-z0-9_-]+\.css$/u.test(appCss)) {
    throw new Error("Vite entry output does not match the build contract");
  }

  return { appJs, appCss, diffWorker };
}

function sortedPaths(paths) {
  return [...new Set(paths)].sort();
}

export function resolveWorkerBundleAssets(bundle) {
  if (!isRecord(bundle)) throw new Error("Vite worker bundle must be an object");
  const outputs = Object.entries(bundle).map(([key, output]) => {
    if (!isRecord(output)) throw new Error(`Vite worker output must be an object: ${key}`);
    return {
      type: output.type,
      isEntry: output.isEntry,
      fileName: emittedPath(output.fileName, `Vite worker output ${key}`),
    };
  });
  const entry = requireSingle(
    outputs.filter((output) => output.type === "chunk" && output.isEntry === true),
    "Vite worker entry",
  );
  return {
    entry: entry.fileName,
    assets: sortedPaths(outputs.map((output) => output.fileName)),
  };
}

function without(paths, ...excluded) {
  const excludedPaths = new Set(excluded.flatMap((pathSet) => [...pathSet]));
  return sortedPaths([...paths].filter((path) => !excludedPaths.has(path)));
}

function staticRecordClosure(manifest, rootKeys) {
  const keys = new Set();

  function visit(key) {
    if (keys.has(key)) return;
    keys.add(key);
    const record = manifestRecord(manifest, key);
    for (const importKey of stringList(record.imports, `${key} imports`)) visit(importKey);
  }

  for (const rootKey of rootKeys) visit(rootKey);
  return keys;
}

function emittedFilesForRecords(manifest, keys) {
  const paths = new Set();
  for (const key of keys) {
    const record = manifestRecord(manifest, key);
    paths.add(emittedPath(record.file, `Manifest record ${key}`));
    for (const path of stringList(record.css, `${key} css`)) paths.add(emittedPath(path, `${key} css`));
    for (const path of stringList(record.assets, `${key} assets`)) paths.add(emittedPath(path, `${key} assets`));
  }
  return paths;
}

function staticEmittedFileClosure(manifest, rootKeys) {
  return emittedFilesForRecords(manifest, staticRecordClosure(manifest, rootKeys));
}

function sharedInitialRecords(manifest, initial) {
  const shared = new Set();
  if (initial.has("index.html")) shared.add("index.html");
  for (const key of initial) {
    if (sharedInitialRecordNames.includes(manifestRecord(manifest, key).name)) shared.add(key);
  }
  return shared;
}

export function resolveMarkdownRoots(manifest) {
  const dynamicImports = stringList(manifestRecord(manifest, "index.html").dynamicImports, "index.html dynamicImports");
  return markdownRootNames.map((name) => requireSingle(
    dynamicImports.filter((key) => manifestRecord(manifest, key).name === name),
    `Markdown dynamic root named ${name}`,
  ));
}

function resolveCrepeRoots(manifest) {
  const dynamicImports = stringList(manifestRecord(manifest, "index.html").dynamicImports, "index.html dynamicImports");
  return crepeRootSources.map((source) => {
    const key = findSourceRecord(manifest, source);
    if (!dynamicImports.includes(key)) throw new Error(`index.html must directly dynamically import ${source}`);
    return key;
  });
}

export function assertDynamicRootsOutsideInitial(manifest, rootKeys, group) {
  const initial = staticRecordClosure(manifest, ["index.html"]);
  const initialFiles = staticEmittedFileClosure(manifest, ["index.html"]);
  const sharedRecords = sharedInitialRecords(manifest, initial);
  const sharedFiles = emittedFilesForRecords(manifest, sharedRecords);
  for (const rootKey of rootKeys) {
    const lazyRecords = staticRecordClosure(manifest, [rootKey]);
    const lazyFiles = staticEmittedFileClosure(manifest, [rootKey]);
    if (initial.has(rootKey)) throw new Error(`${group} dynamic root is reachable from the initial graph`);
    if ([...lazyRecords].some((key) => initial.has(key) && !sharedRecords.has(key))) {
      throw new Error(`${group} lazy implementation is reachable from the initial graph`);
    }
    if ([...lazyFiles].some((path) => initialFiles.has(path) && !sharedFiles.has(path))) {
      throw new Error(`${group} lazy implementation asset is reachable from the initial graph`);
    }
  }
}

export function markdownBudgetPaths(markdownClosure, initial, pageClosures) {
  return sortedPaths(Object.values(pageClosures).flatMap((pageClosure) => without(markdownClosure, initial, pageClosure)));
}

function cssAssetPath(cssPath, reference) {
  const target = reference.split(/[?#]/u, 1)[0];
  if (!target || target.startsWith("#") || target.startsWith("data:")) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) {
    throw new Error(`CSS references an external asset: ${reference}`);
  }

  const path = target.startsWith("/")
    ? target.slice(1)
    : target.startsWith("assets/")
      ? target
      : posix.normalize(posix.join(posix.dirname(cssPath), target));
  return emittedPath(path, `CSS asset reference from ${cssPath}`);
}

async function createClientAssetsManifest(manifest, workerAssets) {
  const entry = resolveManifestAssets(manifest);
  const diff = sortedPaths(stringList(workerAssets, "diff worker assets").map((path) =>
    emittedPath(path, "Diff worker asset")));
  if (!diff.includes(entry.diffWorker)) throw new Error("Diff worker bundle is missing its runtime entry");
  const indexEntry = manifestRecord(manifest, "index.html");
  const pageRecords = resolvePageRecords(manifest, indexEntry);
  const deployedFiles = (await readBuiltFiles())
    .filter((path) => path !== "index.html" && !path.startsWith(".vite/"))
    .sort();
  const deployedPaths = new Set(deployedFiles);

  if (deployedPaths.size !== deployedFiles.length) throw new Error("Deploy directory contains duplicate files");
  if (!deployedPaths.has("_headers")) throw new Error("Deploy directory is missing _headers");
  for (const path of deployedFiles) {
    if (path === "_headers") continue;
    emittedPath(path, `Deploy file ${path}`);
    if (path.endsWith(".map")) throw new Error("Deploy directory contains a source map");
  }

  async function addAsset(path, closure) {
    if (!deployedPaths.has(path)) throw new Error(`Manifest references a missing deployed asset: ${path}`);
    if (closure.has(path)) return;
    closure.add(path);

    if (!path.endsWith(".css")) return;
    const css = await readFile(resolve(assetsDirectory, path), "utf8");
    for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gu)) {
      const referencedPath = cssAssetPath(path, match[2]);
      if (referencedPath !== null) await addAsset(referencedPath, closure);
    }
  }

  async function collectClosure(rootKeys) {
    const closure = new Set();
    const visited = new Set();

    async function visit(key) {
      if (visited.has(key)) return;
      visited.add(key);
      const record = manifestRecord(manifest, key);
      await addAsset(emittedPath(record.file, `Manifest record ${key}`), closure);
      for (const path of stringList(record.css, `${key} css`)) {
        await addAsset(emittedPath(path, `${key} css`), closure);
      }
      for (const path of stringList(record.assets, `${key} assets`)) {
        await addAsset(emittedPath(path, `${key} assets`), closure);
      }
      for (const importKey of stringList(record.imports, `${key} imports`)) await visit(importKey);
    }

    for (const rootKey of rootKeys) await visit(rootKey);
    return closure;
  }

  function collectRecordKeys(rootKeys, followDynamicImports = false) {
    const keys = new Set();

    function visit(key) {
      if (keys.has(key)) return;
      keys.add(key);
      const record = manifestRecord(manifest, key);
      for (const importKey of stringList(record.imports, `${key} imports`)) visit(importKey);
      if (followDynamicImports) {
        for (const importKey of stringList(record.dynamicImports, `${key} dynamicImports`)) visit(importKey);
      }
    }

    for (const rootKey of rootKeys) visit(rootKey);
    return keys;
  }

  const initial = await collectClosure(["index.html"]);
  const markdownRoots = resolveMarkdownRoots(manifest);
  const crepeRoots = resolveCrepeRoots(manifest);
  assertDynamicRootsOutsideInitial(manifest, markdownRoots, "Markdown");
  assertDynamicRootsOutsideInitial(manifest, crepeRoots, "Crepe");
  if (diff.some((path) => initial.has(path))) throw new Error("Diff worker is reachable from the initial graph");
  const pageClosures = {};
  const pageRoots = {};
  for (const pageName of pageNames) {
    const rootKey = pageRecords[pageName];
    const rootPath = emittedPath(manifestRecord(manifest, rootKey).file, `${pageName} page root`);
    const closure = without(await collectClosure([rootKey]), initial, diff);
    if (!closure.includes(rootPath)) throw new Error(`${pageName} root is missing from its closure`);
    pageClosures[pageName] = closure;
    pageRoots[pageName] = rootPath;
  }

  const applicationPages = sortedPaths(Object.values(pageClosures).flat());
  const markdown = markdownBudgetPaths(
    without(await collectClosure(markdownRoots), diff),
    initial,
    {
      OrdinaryPage: pageClosures.OrdinaryPage,
      LocalOnlyPastePage: pageClosures.LocalOnlyPastePage,
      MarkdownPage: pageClosures.MarkdownPage,
    },
  );
  const crepe = without(await collectClosure(crepeRoots), initial, pageClosures.OrdinaryPage, diff);
  const groups = {
    initial: sortedPaths(initial),
    applicationPages,
    markdown,
    crepe,
    diff,
  };

  const files = [];
  for (const path of deployedFiles) {
    const bytes = await readFile(resolve(assetsDirectory, path));
    files.push({
      path,
      bytes: bytes.byteLength,
      gzipLevel9Bytes: gzipSync(bytes, { level: 9 }).byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  const filesByPath = new Map(files.map((file) => [file.path, file]));
  if (filesByPath.size !== files.length) throw new Error("Client manifest contains duplicate file metadata");
  for (const [groupName, paths] of Object.entries(groups)) {
    if (new Set(paths).size !== paths.length || paths.some((path) => !filesByPath.has(path))) {
      throw new Error(`Client manifest group is inconsistent: ${groupName}`);
    }
  }
  if (new Set(applicationPages).size !== applicationPages.length || applicationPages.join("\n") !== sortedPaths(Object.values(pageClosures).flat()).join("\n")) {
    throw new Error("Application page group is inconsistent");
  }

  for (const pageName of pageNames) {
    const closure = pageClosures[pageName];
    if (closure.some((path) => groups.initial.includes(path))) {
      throw new Error(`${pageName} closure overlaps the initial graph`);
    }
    for (const otherPageName of pageNames) {
      if (otherPageName !== pageName && closure.includes(pageRoots[otherPageName])) {
        throw new Error(`${pageName} closure contains ${otherPageName}`);
      }
    }
  }

  const classifiedPaths = new Set(Object.values(groups).flat());
  for (const dynamicKey of stringList(indexEntry.dynamicImports, "index.html dynamicImports")) {
    const dynamicRecord = manifestRecord(manifest, dynamicKey);
    const dynamicPath = emittedPath(dynamicRecord.file, `Dynamic manifest record ${dynamicKey}`);
    if (!classifiedPaths.has(dynamicPath)) throw new Error(`Unclassified dynamic manifest root: ${dynamicKey}`);
  }

  const classifiedRecordKeys = new Set([
    "index.html",
    ...Object.values(pageRecords),
    ...markdownRoots,
    ...collectRecordKeys(crepeRoots, true),
  ]);
  for (const [key, record] of Object.entries(manifest)) {
    if (!isRecord(record)) continue;
    for (const dynamicKey of stringList(record.dynamicImports, `${key} dynamicImports`)) {
      if (!classifiedRecordKeys.has(dynamicKey)) throw new Error(`Unclassified nested dynamic manifest root: ${dynamicKey}`);
    }
  }

  return {
    schemaVersion: 1,
    entry: { js: entry.appJs, css: entry.appCss, diffWorker: entry.diffWorker },
    applicationPageRoots: pageRoots,
    applicationPageClosures: pageClosures,
    groups,
    files,
  };
}

function assertBundleBudgets(manifest) {
  const filesByPath = new Map(manifest.files.map((file) => [file.path, file]));
  const gzip = (paths) => paths.reduce((total, path) => total + filesByPath.get(path).gzipLevel9Bytes, 0);
  const initialJavaScript = manifest.groups.initial.filter((path) => path.endsWith(".js"));
  const initialCss = manifest.groups.initial.filter((path) => path.endsWith(".css"));
  const limits = [
    ["initial JavaScript", gzip(initialJavaScript), budgets.initialJs],
    ["initial CSS", gzip(initialCss), budgets.initialCss],
    ["Markdown", gzip(manifest.groups.markdown), budgets.markdown],
    ["Crepe", gzip(manifest.groups.crepe), budgets.crepe],
    ["diff", gzip(manifest.groups.diff), budgets.diff],
    ["all deployed files", manifest.files.reduce((total, file) => total + file.bytes, 0), budgets.files],
  ];

  for (const [name, actual, limit] of limits) {
    if (actual > limit) throw new Error(`${name} bundle budget exceeded: ${actual} > ${limit}`);
  }
}

async function writeClientAssetsManifest(manifest) {
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  const temporaryPath = `${clientAssetsManifestPath}.${process.pid}.tmp`;
  await mkdir(dirname(clientAssetsManifestPath), { recursive: true });
  await writeFile(temporaryPath, contents);
  await rename(temporaryPath, clientAssetsManifestPath);
}

async function buildClient() {
  await rm(assetsDirectory, { force: true, recursive: true });
  await rm(clientAssetsManifestPath, { force: true });
  const diffWorkerSource = normalizedPath(resolve(root, "src/client/diff.ts"));
  let diffWorkerBundle;
  await build({
    root,
    worker: {
      plugins: () => [{
        name: "capture-diff-worker-bundle",
        generateBundle(_options, bundle) {
          const entries = Object.values(bundle).filter((output) =>
            output.type === "chunk" &&
            output.isEntry === true &&
            typeof output.facadeModuleId === "string" &&
            normalizedPath(output.facadeModuleId) === diffWorkerSource);
          if (entries.length === 0) return;
          if (entries.length !== 1 || diffWorkerBundle !== undefined) {
            throw new Error("Expected one emitted diff worker bundle");
          }
          diffWorkerBundle = resolveWorkerBundleAssets(bundle);
        },
      }],
    },
  });
  if (diffWorkerBundle === undefined) throw new Error("Expected one emitted diff worker bundle");

  const manifestPath = resolve(assetsDirectory, ".vite/manifest.json");
  const rawManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const { appJs, appCss, diffWorker } = resolveManifestAssets(rawManifest);
  if (diffWorkerBundle.entry !== diffWorker) throw new Error("Runtime diff worker does not match its emitted bundle entry");

  await writeStaticAssetHeaders();
  const clientAssetsManifest = await createClientAssetsManifest(rawManifest, diffWorkerBundle.assets);
  assertBundleBudgets(clientAssetsManifest);
  await writeGeneratedAssets({
    appJs: assetPath(appJs),
    appCss: assetPath(appCss),
    diffWorker: assetPath(diffWorker),
  });
  await writeClientAssetsManifest(clientAssetsManifest);
  await assertWranglerConfig();
  await rm(resolve(assetsDirectory, "index.html"), { force: true });
  await rm(resolve(assetsDirectory, ".vite"), { force: true, recursive: true });

  for (const path of [appJs, appCss, diffWorker]) {
    if (!existsSync(resolve(assetsDirectory, path))) {
      throw new Error(`Generated asset does not exist: ${path}`);
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildClient();
}
