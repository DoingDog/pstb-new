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

  if (
    config.name !== "cf-pastebin" ||
    config.main !== "src/index.ts" ||
    config.assets?.directory !== "./dist/assets" ||
    config.kv_namespaces?.length !== 1 ||
    namespaceKeys.length !== 2 ||
    namespaceKeys[0] !== "binding" ||
    namespaceKeys[1] !== "id" ||
    namespace?.binding !== "PASTE_DB" ||
    namespace?.id !== "11111111111111111111111111111111"
  ) {
    throw new Error("wrangler.jsonc does not match the build contract");
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

  const entryKeys = Object.entries(manifest)
    .filter(([, value]) => isRecord(value) && value.isEntry === true)
    .map(([key]) => key);
  const expectedEntryKeys = ["index.html", "src/client/diff.ts"];

  if (
    entryKeys.length !== expectedEntryKeys.length ||
    entryKeys.some((key) => !expectedEntryKeys.includes(key))
  ) {
    throw new Error("Vite manifest must contain exactly the approved entry records");
  }

  const indexEntry = manifestRecord(manifest, "index.html");
  const diffEntry = manifestRecord(manifest, "src/client/diff.ts");
  if (indexEntry.src !== "index.html" || diffEntry.src !== "src/client/diff.ts") {
    throw new Error("Vite manifest entry sources do not match the build contract");
  }

  const appJs = emittedPath(indexEntry.file, "Vite app entry");
  const appCss = emittedPath(requireSingle(stringList(indexEntry.css, "index.html css"), "entry CSS file"), "Vite app CSS entry");
  const diffWorker = emittedPath(diffEntry.file, "Vite diff worker entry");
  if (!/^assets\/app-[A-Za-z0-9_-]+\.js$/u.test(appJs) || !/^assets\/app-[A-Za-z0-9_-]+\.css$/u.test(appCss) || !/^assets\/diff-[A-Za-z0-9_-]+\.js$/u.test(diffWorker)) {
    throw new Error("Vite entry output does not match the build contract");
  }
  resolvePageRecords(manifest, indexEntry);

  return { appJs, appCss, diffWorker };
}

function sortedPaths(paths) {
  return [...new Set(paths)].sort();
}

function without(paths, ...excluded) {
  const excludedPaths = new Set(excluded.flatMap((pathSet) => [...pathSet]));
  return sortedPaths([...paths].filter((path) => !excludedPaths.has(path)));
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

async function createClientAssetsManifest(manifest) {
  const entry = resolveManifestAssets(manifest);
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
  const pageClosures = {};
  const pageRoots = {};
  for (const pageName of pageNames) {
    const rootKey = pageRecords[pageName];
    const rootPath = emittedPath(manifestRecord(manifest, rootKey).file, `${pageName} page root`);
    const closure = without(await collectClosure([rootKey]), initial);
    if (!closure.includes(rootPath)) throw new Error(`${pageName} root is missing from its closure`);
    pageClosures[pageName] = closure;
    pageRoots[pageName] = rootPath;
  }

  const applicationPages = sortedPaths(Object.values(pageClosures).flat());
  const markdownRoots = stringList(indexEntry.dynamicImports, "index.html dynamicImports")
    .filter((key) => {
      const record = manifestRecord(manifest, key);
      return record.name === "micromark" || record.name === "micromark-extension-gfm";
    });
  const crepeRoots = Object.entries(manifest)
    .filter(([, record]) => isRecord(record) && typeof record.src === "string" && record.src.startsWith("node_modules/@milkdown/"))
    .map(([key]) => key);
  if (!markdownRoots.length || !crepeRoots.length) throw new Error("Vite manifest is missing the lazy Markdown or Crepe graph");

  const markdown = without(
    await collectClosure(markdownRoots),
    initial,
    pageClosures.OrdinaryPage,
    pageClosures.LocalOnlyPastePage,
    pageClosures.MarkdownPage,
  );
  const crepe = without(await collectClosure(crepeRoots), initial, pageClosures.OrdinaryPage);
  const diff = without(await collectClosure(["src/client/diff.ts"]), initial, pageClosures.OrdinaryPage);
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
    "src/client/diff.ts",
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
  await build({ root });

  const manifestPath = resolve(assetsDirectory, ".vite/manifest.json");
  const rawManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const { appJs, appCss, diffWorker } = resolveManifestAssets(rawManifest);

  await writeStaticAssetHeaders();
  const clientAssetsManifest = await createClientAssetsManifest(rawManifest);
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
