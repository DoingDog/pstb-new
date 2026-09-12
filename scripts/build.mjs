import { build } from "esbuild";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const assetsDirectory = resolve(root, "dist/assets");
const generatedAssetsPath = resolve(root, "src/generated/assets.ts");
const immutableAssetHeaders = "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n";

function outputForEntry(metafile, entryPoint) {
  const outputPath = Object.entries(metafile.outputs).find(
    ([, output]) => output.entryPoint && resolve(root, output.entryPoint) === entryPoint,
  )?.[0];

  if (!outputPath) {
    throw new Error(`Missing build output for ${entryPoint}`);
  }

  return outputPath;
}

function publicAssetPath(outputPath) {
  return `/${relative(assetsDirectory, resolve(root, outputPath)).split(sep).join("/")}`;
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

async function cleanupGeneratedAssetsTemporaryFiles() {
  const generatedDirectory = dirname(generatedAssetsPath);
  const temporaryFilePattern = /^assets\.ts\.\d+\.tmp$/;
  const files = await readdir(generatedDirectory);

  await Promise.all(
    files
      .filter((file) => temporaryFilePattern.test(file))
      .map((file) => rm(resolve(generatedDirectory, file), { force: true })),
  );
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

async function assertTestToolchainConfig() {
  const tsconfig = JSON.parse(await readFile(resolve(root, "tsconfig.json"), "utf8"));
  const expectedTypes = ["@cloudflare/workers-types", "@cloudflare/vitest-plugin/types", "vitest/globals"];
  const vitestConfig = await readFile(resolve(root, "vitest.config.ts"), "utf8");

  if (
    JSON.stringify(tsconfig.compilerOptions?.types) !== JSON.stringify(expectedTypes) ||
    !vitestConfig.includes('import { cloudflareTest } from "@cloudflare/vitest-plugin";') ||
    !vitestConfig.includes('cloudflareTest({') ||
    !vitestConfig.includes('configPath: "./wrangler.jsonc",') ||
    !/test:\s*\{\s*include:\s*\["src\/\*\*\/\*.test\.ts"\],?\s*\}/s.test(vitestConfig)
  ) {
    throw new Error("Vitest and TypeScript do not match the build contract");
  }
}

await mkdir(dirname(generatedAssetsPath), { recursive: true });
await cleanupGeneratedAssetsTemporaryFiles();
await rm(assetsDirectory, { force: true, recursive: true });

const diffEntryPoint = resolve(root, "src/client/diff.ts");
const diffBuild = await build({
  absWorkingDir: root,
  bundle: true,
  entryNames: "diff-[hash]",
  entryPoints: [diffEntryPoint],
  format: "esm",
  metafile: true,
  outdir: resolve(assetsDirectory, "assets"),
  platform: "browser",
});
const diffWorker = publicAssetPath(outputForEntry(diffBuild.metafile, diffEntryPoint));

const appEntryPoint = resolve(root, "src/client/app.ts");
const appBuild = await build({
  absWorkingDir: root,
  bundle: true,
  define: { __DIFF_WORKER_URL__: JSON.stringify(diffWorker) },
  entryNames: "app-[hash]",
  entryPoints: [appEntryPoint],
  format: "esm",
  metafile: true,
  outdir: resolve(assetsDirectory, "assets"),
  platform: "browser",
  splitting: true,
});
const appJsOutput = outputForEntry(appBuild.metafile, appEntryPoint);
const appCssOutput = appBuild.metafile.outputs[appJsOutput]?.cssBundle;

if (!appCssOutput) {
  throw new Error("Missing CSS bundle for app entry");
}

await writeStaticAssetHeaders();
await writeGeneratedAssets({
  appJs: publicAssetPath(appJsOutput),
  appCss: publicAssetPath(appCssOutput),
  diffWorker,
});
await assertWranglerConfig();
await assertTestToolchainConfig();
