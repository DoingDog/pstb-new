import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const assetsDirectory = resolve(root, "dist/assets");
const generatedAssetsPath = resolve(root, "src/generated/assets.ts");
const immutableAssetHeaders = "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n";

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

  const indexEntry = manifest["index.html"];
  const diffEntry = manifest["src/client/diff.ts"];
  if (
    !isRecord(indexEntry) ||
    !isRecord(diffEntry) ||
    indexEntry.src !== "index.html" ||
    diffEntry.src !== "src/client/diff.ts"
  ) {
    throw new Error("Vite manifest entry sources do not match the build contract");
  }

  const appJs = indexEntry.file;
  const appCss = requireSingle(Array.isArray(indexEntry.css) ? indexEntry.css : [], "entry CSS file");
  const diffWorker = diffEntry.file;
  if (
    typeof appJs !== "string" ||
    typeof appCss !== "string" ||
    typeof diffWorker !== "string" ||
    !/^assets\/app-[A-Za-z0-9_-]+\.js$/.test(appJs) ||
    !/^assets\/app-[A-Za-z0-9_-]+\.css$/.test(appCss) ||
    !/^assets\/diff-[A-Za-z0-9_-]+\.js$/.test(diffWorker)
  ) {
    throw new Error("Vite entry output does not match the build contract");
  }

  return { appJs, appCss, diffWorker };
}

export async function buildClient() {
  await rm(assetsDirectory, { force: true, recursive: true });
  await build({ root });

  const manifestPath = resolve(assetsDirectory, ".vite/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const { appJs, appCss, diffWorker } = resolveManifestAssets(manifest);

  await writeStaticAssetHeaders();
  await writeGeneratedAssets({
    appJs: assetPath(appJs),
    appCss: assetPath(appCss),
    diffWorker: assetPath(diffWorker),
  });
  await assertWranglerConfig();
  await rm(resolve(assetsDirectory, "index.html"), { force: true });
  await rm(resolve(assetsDirectory, ".vite"), { force: true, recursive: true });

  const deployFiles = await readBuiltFiles();
  if (
    deployFiles.some(
      (path) => path !== "_headers" && !/^assets\/.+-[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(path),
    )
  ) {
    throw new Error("Deploy directory contains a non-hashed file");
  }

  for (const path of [appJs, appCss, diffWorker]) {
    if (!existsSync(resolve(assetsDirectory, path))) {
      throw new Error(`Generated asset does not exist: ${path}`);
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildClient();
}
