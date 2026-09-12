# Cloudflare Pastebin Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个 ES module Cloudflare Worker 完整重建在线剪贴板，实现已冻结的 HTTP、UI、KV、Markdown、history、password、view-once、MCP 和 `/ip-trace` contract。

**Architecture:** `src/index.ts` 将 `/mcp` 与 Hono application 分流，所有业务状态只通过 `src/pastes.ts` 访问唯一的 `PASTE_DB`。server-rendered 页面加载由 esbuild 生成的 hashed ESM/CSS assets，Crepe、browser Markdown renderer 和 diff worker 按功能动态加载；测试按纯领域、Worker integration、client state machine 和 Playwright 四层推进。

**Tech Stack:** TypeScript 7.0.2、Cloudflare Workers、Hono 4.13.7、micromark 4.0.2、micromark-extension-gfm 3.0.0、Milkdown Crepe 7.22.1、diff 8.0.2、`@modelcontextprotocol/server` 2.0.0、Zod 4.6.2、Wrangler 4.131.1、Vitest 4.1.11、`@cloudflare/vitest-plugin` 1.1.8、esbuild 0.28.2、Playwright 1.63.0。

**Spec:** `docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md`

## Global Constraints

- 业务存储只有 `env.PASTE_DB` 一个 KV namespace，不增加 Durable Object、D1、R2、Queue、第二个 KV 或全局 auth。
- 正文以 `<id> -> exact plaintext content` 保存；business metadata 和三个 revision slot 使用同一 namespace 的固定 sibling keys。
- custom ID 匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`，case-sensitive，拒绝冻结的 route names 和 internal prefix。
- content 是有效 Unicode scalar sequence，UTF-8 大小为 `1..10_485_760` bytes，不 trim、不 normalize、不改换行。
- password 为空时表示未保护或 clear，非空时只能是 `1..128` 个 U+0020..U+007E 字符，并按冻结 contract plaintext 传输和存储。
- view-once 使用 KV read-then-delete，先完成授权与 representation 渲染，再 awaited 删除五个 keys，最后返回正文；不声称跨地域 exactly-once。
- `/html/:id` 返回 exact source，顶层同源可执行，不加 wrapper、sanitizer、sandbox 或 CSP。
- `/md/:id` 与 client preview 使用 full GFM，`allowDangerousHtml:false`、`allowDangerousProtocol:false`。
- browser mutation 带 version；API 和 MCP 未提供 version 时采用 last-write-wins。
- dynamic response 使用 `Cache-Control:no-store`；hashed asset 使用一年 immutable cache。
- `wrangler.jsonc` 只声明 `PASTE_DB`，开发 namespace ID 固定为明显占位值 `11111111111111111111111111111111`，不得执行 deploy。
- 不保留 `GET|POST /api`、旧 response shape 或 `GET /delete/:id`。
- 不创建 git commit，不 push，不 deploy；每个任务以测试结果代替 commit checkpoint。

## Locked File Map

| Path | Responsibility |
|---|---|
| `package.json`, `package-lock.json` | 固定依赖、build、test、typecheck、Playwright 和 Wrangler scripts。 |
| `tsconfig.json` | Worker、DOM、ES2023 和 strict TypeScript 配置。 |
| `wrangler.jsonc` | `cf-pastebin` Worker、唯一 KV binding 和 static assets。 |
| `vitest.config.ts` | Workers Vitest pool 与 deterministic test settings。 |
| `playwright.config.ts` | Chromium、Firefox、WebKit、Edge 与 mobile projects。 |
| `scripts/build.mjs` | 先构建 diff worker，再构建 browser ESM/CSS，并生成 server asset manifest。 |
| `scripts/smoke.ps1` | supervised local Wrangler、curl assertions 和 process-tree cleanup。 |
| `src/types.ts` | 跨 server 模块共享的 Env、resource、metadata 和 error types。 |
| `src/json.ts` | 有 64 MiB 上限、fatal UTF-8 和 duplicate-key rejection 的 strict JSON object parser。 |
| `src/pastes.ts` | 所有 KV keys、validation、legacy、coherent read、CRUD、history、expiry 和 consume 规则。 |
| `src/render.ts` | application HTML、password/error pages、safe Markdown、filename 和 bootstrap escaping。 |
| `src/http.ts` | Hono routes、method/media parsing、credential precedence、response/error/header mapping。 |
| `src/mcp.ts` | Origin guard、fresh `McpServer`、八个 strict tools 和 domain result mapping。 |
| `src/index.ts` | ES module `fetch` entry 和 `/mcp` 分流。 |
| `src/generated/assets.ts` | `scripts/build.mjs` 生成的 hashed app JS、CSS 和 diff worker URL。 |
| `src/client/app.ts` | locale/theme/UI actions、autosave、create/view/settings/history orchestration。 |
| `src/client/markdown.ts` | 分开 dynamic import Crepe 与 micromark，维护 canonical source rule。 |
| `src/client/diff.ts` | Web Worker 中调用 `diffLines` 并返回 text-only structured lines。 |
| `src/client/styles.css` | responsive、light/dark、tabs、dialog、editor、diff 和 reduced-motion styles。 |
| `src/*.test.ts`, `src/client/*.test.ts` | 与生产模块对应的 Vitest tests。 |
| `test/e2e/pastebin.spec.ts` | browser behavior、network lazy-load、active HTML、a11y keyboard 和 mobile checks。 |
| `test/fixtures/external.html` | Playwright 中同源 active HTML 和外部 request marker fixture。 |
| `worker.js` | 完成 route parity 后删除旧 Service Worker 实现。 |

---

### Task 1: Reproducible Toolchain and Hashed Asset Pipeline

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `wrangler.jsonc`
- Create: `vitest.config.ts`
- Create: `scripts/build.mjs`
- Create: `src/generated/assets.ts`
- Create: `src/index.ts`
- Create: `src/client/app.ts`
- Create: `src/client/diff.ts`
- Create: `src/client/styles.css`
- Create: `.gitignore`
- Test: `src/build.test.ts`

**Interfaces:**
- Produces: `assetPaths: Readonly<{appJs:string;appCss:string;diffWorker:string}>` from `src/generated/assets.ts`.
- Produces: scripts `build`, `build:client`, `typecheck`, `test`, `test:e2e`, `dev:local`, `smoke`, and `verify`.
- Consumes: no application code.

- [ ] **Step 1: Write the package/config contract test**

```ts
// src/build.test.ts
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
```

At the end of `scripts/build.mjs`, parse `wrangler.jsonc` after removing line comments and assert the exact `name`, `main`, `assets.directory`, and single `kv_namespaces` entry shown in Step 3. A mismatch terminates the build with exit code 1.

- [ ] **Step 2: Create exact dependency and script definitions**

```json
{
  "name": "cf-pastebin",
  "private": true,
  "type": "module",
  "scripts": {
    "build:client": "node scripts/build.mjs",
    "build": "npm run build:client && tsc --noEmit",
    "typecheck": "npm run build:client && tsc --noEmit",
    "test": "npm run build:client && vitest run",
    "test:e2e": "npm run build:client && playwright test",
    "dev:local": "wrangler dev --local --port 8787 --show-interactive-dev-session=false",
    "smoke": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke.ps1",
    "verify": "npm run build && vitest run && playwright test && wrangler types --check && wrangler deploy --dry-run --outdir .wrangler-dist"
  },
  "dependencies": {
    "@milkdown/crepe": "7.22.1",
    "@modelcontextprotocol/server": "2.0.0",
    "diff": "8.0.2",
    "hono": "4.13.7",
    "micromark": "4.0.2",
    "micromark-extension-gfm": "3.0.0",
    "zod": "4.6.2"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "1.1.8",
    "@cloudflare/workers-types": "5.20260911.1",
    "@playwright/test": "1.63.0",
    "esbuild": "0.28.2",
    "typescript": "7.0.2",
    "vitest": "4.1.11",
    "wrangler": "4.131.1"
  }
}
```

Use `npm install` once to generate the lockfile. Do not use Vitest 5 because `@cloudflare/vitest-plugin@1.1.8` declares peer compatibility with `^4.1.0`; keep every direct dependency at the exact version shown above.

- [ ] **Step 3: Configure strict TypeScript, Workers Vitest, and Wrangler**

```jsonc
// wrangler.jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cf-pastebin",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-12",
  "kv_namespaces": [{ "binding": "PASTE_DB", "id": "11111111111111111111111111111111" }],
  "assets": { "directory": "./dist/assets" }
}
```

`tsconfig.json` uses `strict:true`, `noUncheckedIndexedAccess:true`, `exactOptionalPropertyTypes:true`, `module:"ESNext"`, `moduleResolution:"Bundler"`, `target:"ES2023"`, `lib:["ES2023","DOM","DOM.Iterable","WebWorker"]`, and types for `@cloudflare/workers-types` and `vitest/globals`. `vitest.config.ts` uses `defineWorkersConfig` and `poolOptions.workers.wrangler.configPath:"./wrangler.jsonc"`.

- [ ] **Step 4: Implement deterministic two-pass client build**

`scripts/build.mjs` must remove only `dist/assets`, build `src/client/diff.ts` as browser ESM worker into `dist/assets/assets/diff-[hash].js`, then build `src/client/app.ts` with `splitting:true`, `format:"esm"`, imported CSS, and `define.__DIFF_WORKER_URL__` set to the first output URL. Read both esbuild metafiles, find the app entry and its `cssBundle`, and atomically write this exact shape:

```ts
// src/generated/assets.ts
export const assetPaths = Object.freeze({
  appJs: "/assets/app-<resolved-hash>.js",
  appCss: "/assets/app-<resolved-hash>.css",
  diffWorker: "/assets/diff-<resolved-hash>.js",
});
```

The generated file must contain resolved names, not literal angle-bracket text. Dynamic imports from `src/client/markdown.ts` remain split chunks under `/assets/`.

- [ ] **Step 5: Add the smallest buildable entries**

`src/client/app.ts` imports `./styles.css` and exports `startApp():void` without running page behavior yet. `src/client/diff.ts` contains `export {}` so esbuild emits the worker entry. `src/client/styles.css` contains only `:root { color-scheme: light dark; }`. `src/index.ts` exports a module Worker whose temporary `fetch` returns an empty 404 response; Task 6 replaces this behavior after its route tests are RED.

- [ ] **Step 6: Install, build, and verify RED becomes GREEN**

Run:

```powershell
npm install
npm run build:client
npx vitest run src/build.test.ts
npm run typecheck
```

Expected: dependency resolution, hashed asset assertions and typecheck all pass.

- [ ] **Step 7: Refactor checkpoint**

Inspect the esbuild metafile and confirm Crepe, micromark, and diff are not bundled into the initial app entry. Run `npm ls vitest @cloudflare/vitest-plugin` and confirm Vitest resolves to 4.1.11 with no invalid peer dependency.

---

### Task 2: Shared Types, Domain Errors, and Strict JSON Boundary

**Files:**
- Create: `src/types.ts`
- Create: `src/json.ts`
- Test: `src/json.test.ts`

**Interfaces:**
- Produces: `Env`, `PasteSummary`, `PasteResource`, `MutationResult`, `HistoryList`, `RevisionResource`, `PasteMetadataV2`, `ContentMarkerV2`, `RevisionMarkerV2`, `ExpirationInput`, `LoadedPaste`.
- Produces: `PasteError(code,status,message,details?)` and `isPasteError(value)`.
- Produces: `readLimitedBytes(request,maxBytes)`, `decodeUtf8(bytes)`, and `parseStrictJsonObject(request,allowedKeys)`.

- [ ] **Step 1: Write failing parser tests**

```ts
import { describe, expect, it } from "vitest";
import { parseStrictJsonObject } from "./json";

it("rejects duplicate credential keys before JSON.parse can overwrite them", async () => {
  const request = new Request("https://unit.test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"password":"right","password":"wrong"}',
  });
  await expect(parseStrictJsonObject(request, new Set(["password"]))).rejects.toMatchObject({
    code: "VALIDATION_FAILED",
    status: 422,
  });
});

it.each([
  [new Uint8Array([0xc3, 0x28]), "BAD_REQUEST"],
  [new TextEncoder().encode('{"unknown":1}'), "VALIDATION_FAILED"],
])("rejects malformed or unknown input", async (bytes, code) => {
  const request = new Request("https://unit.test", { method: "POST", body: bytes });
  await expect(parseStrictJsonObject(request, new Set())).rejects.toMatchObject({ code });
});
```

Add tests for nested duplicate keys, trailing tokens, top-level arrays/null, 64 MiB `Content-Length` early rejection, streamed over-limit body, and valid escaped key strings.

- [ ] **Step 2: Run parser tests and record the expected RED**

Run `npx vitest run src/json.test.ts`. Expected: FAIL because `src/json.ts` does not exist.

- [ ] **Step 3: Define exact public types and fixed error messages**

`PasteError` carries the status/code table from spec section 13.1. Define summaries so `password` cannot appear in public types. `LoadedPaste` contains `{content,metadata,summary,legacy,marker}` for server-internal use only. Use discriminated unions for expiration and storage markers; do not add a generic repository interface.

- [ ] **Step 4: Implement one recursive-descent JSON parser**

The parser reads a maximum of `67_108_864` bytes, rejects malformed UTF-8 through `new TextDecoder("utf-8",{fatal:true})`, parses JSON string escapes and numbers according to JSON grammar, tracks a fresh `Set<string>` for every object, and throws on duplicate keys before constructing the result. It then enforces a plain top-level object and exact allowed top-level keys. Map malformed syntax/UTF-8 to `BAD_REQUEST`, wire size to `REQUEST_TOO_LARGE`, and duplicate/unknown keys to `VALIDATION_FAILED` with field errors.

- [ ] **Step 5: Make the parser suite GREEN**

Run `npx vitest run src/json.test.ts`. Expected: all strict JSON, duplicate and byte-limit cases pass.

- [ ] **Step 6: Refactor checkpoint**

Fuzz 1,000 deterministic JSON values by comparing successful parses with `JSON.parse`, while separately asserting duplicate-object fixtures fail. Keep the parser private helpers in `src/json.ts`; expose only the three boundary functions.

---

### Task 3: Paste Validation, Key Grammar, Create, and Coherent Read

**Files:**
- Create: `src/pastes.ts`
- Test: `src/pastes.test.ts`

**Interfaces:**
- Consumes: types and `PasteError` from `src/types.ts`.
- Produces: `class PasteService` with constructor `(db: KVNamespace, clock?:()=>Date, uuid?:()=>string)`.
- Produces methods `create(input,requestMeta)`, `loadContent(id,password)`, `getSettings(id,password)`, and `consume(loaded)`.
- Produces pure exports `validateId`, `validateContent`, `validateTitle`, `validatePassword`, `normalizeExpiration`, `contentKey`, `metaKey`, and `revisionKey`.

- [ ] **Step 1: Build an operation-recording in-memory KV fake**

In `src/pastes.test.ts`, implement only the `KVNamespace` members used by `PasteService`: `get`, `getWithMetadata`, `put`, and `delete`. Store value, attached metadata, expiration and an ordered operation log. Add targeted fault injection by operation number and optional stale snapshots; do not create a production repository abstraction.

- [ ] **Step 2: Write failing validation and creation tests**

Use table-driven tests for ID length/case/reserved names, valid Unicode scalar checks, content byte sizes `0`, `1`, `10_485_760`, `10_485_761`, unpaired surrogates, title scalar/control limits, password boundary characters and expiration inputs. The primary create assertion is:

```ts
const service = new PasteService(kv, () => new Date("2026-09-13T00:00:00.000Z"), () => "00000000-0000-4000-8000-000000000001");
const summary = await service.create({ content: "exact\r\ntext", expiration: 60 }, { country: "US" });
expect(await kv.get(summary.id)).toBe("exact\r\ntext");
expect(JSON.parse(await kv.get(`__cfpb:meta:${summary.id}`) as string)).toMatchObject({
  schemaVersion: 2,
  id: summary.id,
  versionCounter: 1,
  contentRevision: 1,
  createdCountry: "US",
  history: { nextSlot: 0, entries: [] },
});
expect(kv.operations.filter((op) => op.type === "put").map((op) => op.key)).toEqual([
  `__cfpb:meta:${summary.id}`,
  summary.id,
]);
```

Also assert custom collision checks all five keys, automatic IDs retry at most five times, create compensation deletes metadata/revisions after main write failure, and no response summary exposes password.

- [ ] **Step 3: Run focused tests and confirm RED**

Run `npx vitest run src/pastes.test.ts -t "validation|create"`. Expected: FAIL on missing domain exports.

- [ ] **Step 4: Implement validation and create in the frozen order**

Use `TextEncoder` for bytes and explicit code-point iteration for Unicode scalar/title/password checks. Normalize relative, permanent and timezone-bearing RFC3339 inputs against one captured `now`. Create checks `<id>`, metadata and three slots sequentially, writes metadata first and main second with identical `expiration` option, and compensates only keys created by that attempt.

- [ ] **Step 5: Write failing coherent-read and legacy-projection tests**

Cover schema 2 happy path, logical expiry cleanup, main missing, metadata-only orphan, incomplete marker, malformed/oversized metadata, generation mismatch, byte-length mismatch, legacy attached metadata projection, `createdAt + expiration*1000`, and mixed legacy-main/schema2-sibling fail-closed behavior. Assert legacy reads produce `version:"legacy"` without writes.

- [ ] **Step 6: Implement coherent read**

`loadContent` follows spec 7.1 exactly. Any appearance of a v2 marker field requires a complete marker and matching sibling. Parse business metadata with an exact-key validator and a 16 KiB byte cap. `getSettings` authorizes from the coherent state but returns no content. Logical expiry awaits deletion of all five keys before throwing `PASTE_NOT_FOUND`.

- [ ] **Step 7: Make create/read tests GREEN**

Run `npx vitest run src/pastes.test.ts -t "validation|create|read|legacy"`. Expected: all selected tests pass.

- [ ] **Step 8: Refactor checkpoint**

Search `src` for `PASTE_DB`, `.put(`, `.delete(` and `getWithMetadata`. At this checkpoint only `src/index.ts` may pass the binding and only `src/pastes.ts` may call KV methods. Confirm main KV values are never JSON envelopes.

---

### Task 4: Content Mutation, History Ring, Reconciliation, Settings, Password, and Delete

**Files:**
- Modify: `src/pastes.ts`
- Modify: `src/pastes.test.ts`

**Interfaces:**
- Adds methods `updateContent(id,input)`, `updateSettings(id,input)`, `updatePassword(id,input)`, `delete(id,password,version?)`, `listHistory(id,password)`, and `getHistory(id,revision,password)`.
- Maintains `version = generation + "." + versionCounter` and exact no-op semantics.

- [ ] **Step 1: Write RED tests for one through four content saves**

Assert save order `target revision -> changed-expiry active revisions -> main -> metadata`, `contentRevision` increments only for actual content changes, and descriptors are newest-first. After current values `v1` through `v5`, assert prior revisions are `v4`,`v3`,`v2`, fixed slots are only `0..2`, and `v1` has been overwritten. Assert same-content update logs no write and returns `changed:false` with unchanged version.

- [ ] **Step 2: Write RED tests for version and reconciliation**

Cover matching opaque version, stale version `VERSION_CONFLICT`, omitted version LWW, marker one revision ahead with valid `commit.previous`, and every non-provable mismatch returning `STORAGE_INCONSISTENT`. Reconciliation must preserve password/title/format/viewOnce/expiration from the sibling and must not increment version.

- [ ] **Step 3: Implement content save and bounded reconciliation**

Write the old current to `history.nextSlot` with exact revision marker, update current marker with a `commit`, then commit metadata last. Reconcile only `main.contentRevision === metadata.contentRevision + 1` with a matching revision slot marker and descriptor; all other partial states fail closed.

- [ ] **Step 4: Run history mutation tests GREEN**

Run `npx vitest run src/pastes.test.ts -t "content save|history ring|version|reconciliation|no-op"`. Expected: pass.

- [ ] **Step 5: Write RED tests for settings, password, expiry, and delete**

Test each settings field independently and combined settings fields in one metadata write. Verify settings/password/no-op do not create revisions. Exercise unprotected set, protected wrong/missing rejection, protected change, clear and 128/129 character limits. For expiration extension, shortening and permanent transitions with 0..3 active history slots, assert all existing keys receive the same physical expiration before metadata commits. Inject every write/delete failure and assert error code plus `mutationMayHaveApplied` where specified.

- [ ] **Step 6: Implement settings/password/delete order**

Metadata-only mutations write one key when physical expiration remains valid. Explicit expiration rewrites main and each active revision sequentially, then metadata. Delete authorizes and checks optional version, deletes main, runs three slot deletes via `Promise.allSettled`, deletes metadata, and returns only after all operations fulfill.

- [ ] **Step 7: Write and implement history reads**

Tests reject revision path forms `0`, `01`, `+1`, decimals and unsafe integers; view-once returns `VIEW_ONCE_HISTORY_FORBIDDEN` before reading a revision body. `getHistory` verifies slot, generation, revision, both timestamps and byteLength against the descriptor. Missing descriptor is 404; missing/mismatched slot is 503.

- [ ] **Step 8: Add first-mutation legacy migration tests and implementation**

Test content/settings/password mutations from legacy, preserving valid timestamps/expiry, using mutation time for unknown creation, turning unknown expiry permanent, and combining migration with one version. Content migration writes old current into slot 0 and new current revision 2; non-content migration starts revision 1 with empty history. DELETE never creates v2 metadata.

- [ ] **Step 9: Full domain GREEN and refactor checkpoint**

Run `npx vitest run src/pastes.test.ts --coverage=false`. Expected: all domain tests pass. Review every actual change path for exactly one `versionCounter` increment and every no-op path for zero KV writes.

---

### Task 5: Safe Rendering, Application Documents, and Download Names

**Files:**
- Create: `src/render.ts`
- Test: `src/render.test.ts`
- Consume generated: `src/generated/assets.ts`

**Interfaces:**
- Produces: `renderMarkdown(source):string`, `renderCreatePage(locale):string`, `renderPastePage(model):string`, `renderPasswordPage(model):string`, `renderErrorPage(model):string`, `renderMarkdownDocument(model):string`, `applicationHeaders()`, `escapeBootstrapJson(value)`, and `deriveDownloadHeaders(summary)`.
- Consumes only public summaries plus explicit content passed by HTTP handlers; never reads KV.

- [ ] **Step 1: Write RED security and fidelity tests**

Test title/error HTML escaping, bootstrap escaping for `<`, `>`, `&`, U+2028 and U+2029, no password in bootstrap, full GFM table/task/strike/autolink rendering, raw `<script>` rendered as text, `javascript:` and `data:` URLs omitted, and default clobber prefix retained. Assert executable script tags in application pages only reference `assetPaths.appJs`; no inline executable script exists.

- [ ] **Step 2: Implement the single canonical Markdown renderer**

```ts
return micromark(source, {
  allowDangerousHtml: false,
  allowDangerousProtocol: false,
  extensions: [gfm()],
  htmlExtensions: [gfmHtml()],
});
```

Only this output may enter Hono `raw()`. Every title, source, error and JSON bootstrap value uses escaped text or attribute helpers.

- [ ] **Step 3: Implement semantic page templates**

Create page has all labeled fields and seven expiration values. Paste page exposes semantic nav/tabs/actions for ordinary pastes and a restricted local-actions-only model for already-consumed view-once responses. Password page contains no title/content/settings data. `/md` wraps safe Markdown in `<article>`. All application documents link hashed CSS and app ESM, set `lang`, and contain no password bootstrap field.

- [ ] **Step 4: Implement exact filename derivation tests and code**

Cover empty title fallback, Unicode `filename*`, slash/backslash replacement, trailing spaces/dots removal, empty sanitized result and CR/LF/control rejection inherited from title validation. ASCII fallback stays `paste-<id>.txt`.

- [ ] **Step 5: Run rendering suite GREEN**

Run `npx vitest run src/render.test.ts`. Expected: all escaping, GFM, template and filename tests pass.

- [ ] **Step 6: Refactor checkpoint**

Search for `raw(` across `src`. Every call must receive only `renderMarkdown` output or static trusted template fragments. Verify `/html` is absent from application header/CSP helpers so HTTP can return it without inherited CSP.

---

### Task 6: Canonical Hono HTTP API and Representation Routes

**Files:**
- Create: `src/http.ts`
- Modify: `src/index.ts`
- Test: `src/http.test.ts`

**Interfaces:**
- Consumes: `PasteService`, rendering functions and strict JSON parser.
- Produces: `createHttpApp(env):Hono` and default Worker `{fetch(request,env,ctx):Promise<Response>}`.
- Reserves exact `/mcp` dispatch for Task 7.

- [ ] **Step 1: Write RED route/method/media tests through `exports.default.fetch()`**

Seed and inspect the real test `env.PASTE_DB`. Cover `/`, `/api/pastes`, resource/settings/password/history/read routes, all representation routes, HEAD and OPTIONS. Assert exact `Allow`, 404 for `/api` and `/delete/:id`, 405 for registered wrong methods, 415 accepted media details, no-store headers, resource ETag, and no stack in 500 errors.

- [ ] **Step 2: Implement common HTTP boundaries**

Add helpers for unique query parameters, password carrier precedence, strict media type matching, strict multipart fields, optional `If-Match`, JSON/body version agreement, API error envelopes, representation plaintext errors, HEAD body stripping, and OPTIONS. Do not create a second router abstraction; helpers return parsed values or `PasteError`.

- [ ] **Step 3: Implement create and mutation API routes**

Map JSON/multipart create to `PasteService.create`, return 201 summary with clean `Location` and quoted ETag. Map text PUT, content PATCH, settings PATCH, password PUT/DELETE and resource DELETE to one domain method each. Reject unknown fields, duplicate multipart names, custom ID on updates and body/ETag disagreement.

- [ ] **Step 4: Implement API reads and history routes**

Resource GET and both `/read` variants return `PasteResource`; settings GET returns summary only. History list/get never return current content and reject active view-once. For a content-bearing response, serialize the final body first, call `consume` when `viewOnce`, then create the `Response`.

- [ ] **Step 5: Implement browser page/password flow and representations**

For protected `GET /:id` with absent query password, render generic input page. `POST /:id` accepts exact form schema and after successful validation returns 302 whose `Location` is built with `URL` plus `URLSearchParams.set`. Wrong/missing form values return 403 page. Direct raw/html/md/file accepts only a unique query password; `/html` returns exact source with no CSP/wrapper; `/md` renders before consume; file emits exact UTF-8 source and both filename parameters.

- [ ] **Step 6: Write representation and password RED/GREEN matrix**

Test missing/wrong/correct password for every page, representation, API, history, mutation, settings and delete route. Include passwords containing leading/trailing space and `+%&#?`, duplicate query rejection and body/query/header precedence. Assert protected `/html` JavaScript source can read its query because response has no CSP, sandbox or referrer override.

Run `npx vitest run src/http.test.ts -t "password|raw|html|markdown|file"`. Expected: pass.

- [ ] **Step 7: Implement `/ip-trace` and exact tests**

Register GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS. Build `{url,method,data:await request.clone().text(),headers:Object.fromEntries(request.headers),cf:Object.fromEntries(Object.entries(request.cf ?? {}))}`, serialize with two-space indentation, and return the four wildcard CORS headers from spec. Test body, all fixture headers, nested/full cf values and local `{}`.

- [ ] **Step 8: Implement and verify view-once event order**

For `/:id`, all four direct representations, API resource GET, `/read` GET/POST, prepare exact final content and headers before `consume`. HEAD, OPTIONS, password form, 403, invalid revision/representation, history, mutations and DELETE do not consume. Inject renderer and delete failures; assert render failure leaves all keys, delete failure returns 503 without content, and success order is `render < delete-main < delete-revisions < delete-meta < response`.

- [ ] **Step 9: Run complete HTTP integration suite**

Run `npx vitest run src/http.test.ts`. Expected: route, header, auth, legacy migration, API schema, representation, trace and view-once tests pass.

- [ ] **Step 10: Refactor checkpoint**

Inspect all `new Response` sites. Application CSP is present on `/`, `/:id`, password/error and `/md`; absent on `/html`. HEAD never calls `renderMarkdown` and never consumes. No success links contain password.

---

### Task 7: MCP 2026-07-28 and Stateless Legacy Fallback

**Files:**
- Create: `src/mcp.ts`
- Modify: `src/index.ts`
- Test: `src/mcp.test.ts`

**Interfaces:**
- Produces: `handleMcp(request,env,ctx):Promise<Response>`.
- Consumes: one fresh `PasteService(env.PASTE_DB)` and `renderMarkdown` per HTTP request.
- Registers exact tools in order: `paste_create`, `paste_get`, `paste_update`, `paste_delete`, `paste_history_list`, `paste_history_get`, `paste_settings_update`, `paste_password_update`.

- [ ] **Step 1: Write RED transport and Origin tests**

Test absent Origin, exact same Origin and normalized default port; reject malformed, `null`, comma-separated and cross-origin values with HTTP 403 before SDK parsing. GET/DELETE return 405 `Allow:POST,OPTIONS`; OPTIONS returns 204. POST is passed to `createMcpHandler` with default legacy behavior, not `{legacy:"reject"}`.

- [ ] **Step 2: Implement fresh server factory and result helpers**

Use the SDK v2 web-standard exports documented in the installed package. Each handler call creates a new `McpServer`, registers all eight strict Zod 4 schemas, and returns `content[0].text === JSON.stringify(structuredContent)` for success/domain errors. Set `isError:true` only for domain failures and cache TTL 0; protocol/schema errors remain SDK JSON-RPC errors.

- [ ] **Step 3: Map all eight tools to domain methods**

`paste_get` prepares source/raw/html/markdown/file representation, consumes view-once after preparation, and only then returns the tool result. Mutation tools omit version when absent to preserve LWW. MCP password comes only from tool arguments. Output schemas exclude stored password and include every `PasteSummary` field.

- [ ] **Step 4: Write RED/GREEN modern protocol tests**

Use a modern request with MCP protocol `2026-07-28`, required `_meta`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` and matching named params. Test `server/discover`, `tools/list` exact order and all eight calls. Assert a wrong paste password is a successful JSON-RPC response whose tool result has `isError:true`, while malformed args are SDK protocol errors.

- [ ] **Step 5: Write RED/GREEN legacy fallback test**

Send SDK-compatible legacy `initialize`, `tools/list` and one tool call as independent stateless requests. Assert no `Mcp-Session-Id`, no standalone GET stream and no retained server state. Do not weaken modern header/body checks manually.

- [ ] **Step 6: Verify MCP password/view-once/history matrix**

Test protected set/change/clear/update/get/delete, omitted/wrong credential failures, view-once first `paste_get` success and second `PASTE_NOT_FOUND`, history error while view-once remains active, and allowed pre-read settings mutation.

Run `npx vitest run src/mcp.test.ts`. Expected: modern, legacy, Origin and all tool tests pass.

- [ ] **Step 7: Refactor checkpoint**

Search for module-scope mutable values in `src/mcp.ts`; none may hold server, identity, capability or password state. Confirm there are exactly eight `registerTool` calls and no bearer-token logic.

---

### Task 8: Deterministic Autosave State Machine

**Files:**
- Modify: `src/client/app.ts`
- Test: `src/client/app.test.ts`

**Interfaces:**
- Produces: `AutosaveController` with `input`, `compositionStart`, `compositionEnd`, `retry`, `overwrite`, `reload`, and `dispose` methods.
- Consumes injected `{now,setTimer,clearTimer,save,onStateChange}` to permit fake-clock tests.
- Browser entry starts only when `document` exists, keeping state-machine imports testable.

- [ ] **Step 1: Write fake-clock RED tests for the frozen transition table**

Test 999 ms no request, 1,000 ms one request, timer replacement, composition suppression, one in-flight maximum, coalesced latest draft, exact no-op avoidance, changed/no-op 200, network/413/422/500/503 error, 403 password re-entry, 404 terminal local preservation and 409 conflict. Assert each failure retains exact draft and last confirmed version.

```ts
clock.advance(1000);
expect(save.calls).toEqual([{ content: "second", version: "g.1", password: undefined }]);
controller.input("third");
clock.advance(1000);
expect(save.calls).toHaveLength(1);
save.resolve({ changed: true, paste: { version: "g.2" } });
expect(save.calls.at(-1)?.content).toBe("third");
```

- [ ] **Step 2: Implement minimal controller transitions**

Use one timer and one promise at a time. Snapshot `inFlightContent` before request. On success set `lastSavedContent` to that snapshot, then schedule only current `draft` at `max(0,dueAt-now)`. Error and conflict clear timer/in-flight without modifying draft. Overwrite omits version; reload replaces both draft and saved content only after explicit confirmation flow calls it.

- [ ] **Step 3: Implement unload and password-variable behavior**

Browser setup keeps `let pastePassword:string|null` derived from the unique URL query, never writes storage APIs, and installs `beforeunload` only while dirty/in-flight. Password success updates the variable and `history.replaceState` through `URLSearchParams`; clear removes the query without reload.

- [ ] **Step 4: Run autosave suite GREEN**

Run `npx vitest run src/client/app.test.ts`. Expected: every timer, IME, concurrency, retry and conflict case passes with fake time.

- [ ] **Step 5: Refactor checkpoint**

Instrument the save fake with an active counter and run a generated 200-input sequence; maximum active requests must equal 1, and final saved content must equal the final draft after all promises resolve.

---

### Task 9: Frontend Visual System, Create/View/Settings/History Interactions

**Files:**
- Modify: `src/client/app.ts`
- Modify: `src/client/styles.css`
- Modify: `src/render.ts`
- Modify: `src/render.test.ts`
- Test: `src/client/app.test.ts`

**Interfaces:**
- Consumes: server bootstrap without password, API routes, `AutosaveController`, and generated diff worker URL.
- Produces complete `en` and `zh-CN` dictionaries, locale/theme controllers, accessible tabs/dialogs, create/drop/copy/wrap/download/delete/settings/history behaviors.

- [ ] **Step 1: Invoke `frontend-design:frontend-design` before editing UI files**

Give the skill the frozen feature list, no-framework constraint, accessibility requirements, 320 px viewport, light/dark themes and bilingual behavior. Preserve the resulting visual direction while keeping every server/data contract unchanged.

- [ ] **Step 2: Write RED DOM-independent locale/theme/action tests**

Assert first supported `navigator.languages` selection, full key parity between dictionaries, manual switch updates `lang`, date formatting uses `Intl.DateTimeFormat`, system theme follows `matchMedia` until override, and no Storage method is called. Test URL generation with exact passwords `a+b %&#?` and clean server links.

- [ ] **Step 3: Implement create page behavior**

Submit JSON to `/api/pastes`, switching to multipart only when JSON envelope size approaches the 64 MiB wire boundary. Always include explicit `viewOnce`. Disable repeat submit. Drag/drop accepts first item, uses `File.text()`, sets exact content and filename title without truncation, and performs client byte validation. After 201 remain on `/`, show clean links and local password-bearing clickable links; never prefetch/navigate.

- [ ] **Step 4: Implement read/edit/local actions**

Use `textContent` or textarea `.value` for source. Copy uses Clipboard then hidden-textarea fallback. Wrap changes only presentation. Plain editor is monospace and uses AutosaveController. File/local view-once download uses a UTF-8 Blob; local HTML action navigates the current tab to a Blob URL and never re-reads the server.

- [ ] **Step 5: Implement settings, password and delete dialogs**

Each settings group makes a separate canonical mutation with current password/version. Successful password change updates URL/module state immediately. Enabling viewOnce hides edit/history/settings/server-delete at once. Delete uses a focus-trapped confirmation dialog, canonical DELETE, clears content/password references and navigates `/` only after 204.

- [ ] **Step 6: Implement history orchestration without diff internals**

Fetch list only when History opens and snapshot only on selection. Render revision metadata and snapshot through text nodes. For either side above 1 MiB or 50,000 lines, show Compute diff instead of constructing a worker. Mobile list/detail uses a Back control; desktop uses two columns.

- [ ] **Step 7: Implement visual and accessibility CSS**

Provide visible focus, 44×44 targets, WCAG AA color pairs, semantic tabs, dialog states, `aria-live`, `role=alert`, non-color diff prefixes, reduced motion, system monospace editor, content-local horizontal scrolling and no page overflow at 320 px. Use `data-theme` plus `color-scheme`.

- [ ] **Step 8: Run unit/render suites GREEN**

Run `npx vitest run src/client/app.test.ts src/render.test.ts`. Expected: locale/theme/URL/action models and complete page markup pass.

- [ ] **Step 9: Refactor checkpoint**

Search browser source for `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `window.name`, `innerHTML` and string-concatenated `password=`. The first six must be absent except test assertions; representation URLs must use `URL`/`URLSearchParams`.

---

### Task 10: Lazy Milkdown, Safe Preview, and Diff Worker

**Files:**
- Create: `src/client/markdown.ts`
- Modify: `src/client/diff.ts`
- Modify: `src/client/app.ts`
- Test: `src/client/markdown.test.ts`
- Test: `src/client/diff.test.ts`

**Interfaces:**
- Produces: `createMarkdownModes(options)` with `enterSource`, `enterVisual`, `enterPreview`, `leaveVisual`, `destroy`.
- Produces worker messages `{type:"diff",id,previous,current}` -> `{type:"result",id,lines:[{kind:"add"|"delete"|"same",text:string}]}` or `{type:"error",id,message}`.

- [ ] **Step 1: Write RED canonical-source tests with a fake Crepe adapter**

Assert entering/leaving visual without a real document-change transaction preserves byte-exact source and does not call autosave. After a real transaction, `getMarkdown()` becomes the draft and schedules save. Preview receives current draft but never changes it. Crepe initialization failure retains source textarea and retry action.

- [ ] **Step 2: Implement separate lazy imports**

`enterVisual` alone executes `import("@milkdown/crepe")`; `enterPreview` alone dynamically imports `micromark` plus GFM and uses the same security options as server. Source/read startup imports neither. Track `visualSourceSnapshot` and `visualDirty`; hook only genuine document-changing transactions, not focus/selection/init callbacks.

- [ ] **Step 3: Write RED diff worker tests**

Given previous `"a\nb\n"` and current `"a\nc\n"`, assert structured lines preserve newline markers and kinds produce visible prefixes ` `, `-`, `+` in UI. Assert stale worker response IDs are ignored and source text never becomes HTML.

- [ ] **Step 4: Implement worker and main-thread bridge**

`src/client/diff.ts` imports only `diffLines`, converts changes into line records, and posts structured-clone data. `app.ts` creates the worker only after a revision is selected and automatic/explicit size policy allows calculation. Terminate it on page disposal.

- [ ] **Step 5: Run lazy module suites GREEN and inspect bundle graph**

Run:

```powershell
npx vitest run src/client/markdown.test.ts src/client/diff.test.ts
npm run build:client
```

Inspect esbuild metafiles: initial app output must not include Crepe, micromark or diff code; visual dynamic chunks contain Crepe; preview dynamic chunks contain micromark; the standalone diff output contains `diffLines` exactly once.

- [ ] **Step 6: Refactor checkpoint**

Switch source -> visual -> source in the unit fixture without edits and assert content/version/history network calls remain zero. Make one visual document edit and assert exactly one autosave after 1,000 ms.

---

### Task 11: Playwright Cross-Browser Acceptance

**Files:**
- Create: `playwright.config.ts`
- Create: `test/e2e/pastebin.spec.ts`
- Create: `test/fixtures/external.html`
- Modify: `package.json`

**Interfaces:**
- Consumes built assets and `npm run dev:local` on `127.0.0.1:8787`.
- Produces automated Chromium, Firefox, WebKit, Edge and 320 px acceptance evidence.

- [ ] **Step 1: Configure projects and supervised web server**

Set `webServer.command` to `npm run dev:local`, `url` to `/`, 30-second timeout and no remote binding. Configure desktop Chromium/Firefox/WebKit, installed Edge channel when available, and a 320×720 mobile viewport. Keep trace/screenshot on first retry and disable test parallelism where one scenario depends on its own created paste.

- [ ] **Step 2: Write create/password/edit/history/delete journey**

Create custom-ID text and Markdown pastes, assert no automatic navigation, open through the generated link, perform password form POST/302, edit with 1-second autosave, force a version conflict in a second page, preserve draft, overwrite, inspect three revisions/diff/snapshot, change/clear password and expiry, then delete through the dialog.

- [ ] **Step 3: Write view-once and representation journey**

Assert initial view-once page returns content but no edit/history/settings/delete controls, keeps local copy/wrap/preview/download/Blob HTML actions, and server routes return 404 afterwards. In a separate paste, HEAD/OPTIONS/wrong password do not consume and first valid raw read does.

- [ ] **Step 4: Write active HTML and safe Markdown security checks**

Store HTML that writes a same-origin marker, records `location.search`, and requests a local marker endpoint; open `/html/:id?password=...` and confirm top-level origin/query visibility and execution. Do not send test data externally. Store Markdown with GFM/raw script/dangerous URLs and confirm GFM output plus no script execution.

- [ ] **Step 5: Write lazy-load, i18n, theme, keyboard and mobile checks**

Record network requests: initial/source has no Crepe/micromark/diff chunks; visual loads Crepe; preview loads micromark; revision diff loads worker. Test zh/en switching, system and override themes, tab Left/Right/Home/End, dialog focus/Escape, live statuses, visible focus, 44 px targets and no document-level horizontal overflow at 320 px.

- [ ] **Step 6: Run Playwright and classify environment-only skips**

Run `npx playwright install chromium firefox webkit` then `npx playwright test`. Expected: all bundled-engine projects pass. Run Edge project when current stable Edge is installed. Safari desktop cannot run on Windows; record that omission while retaining WebKit coverage, as allowed by spec completion gate.

- [ ] **Step 7: Refactor checkpoint**

Review traces for accidental extra content reads, prefetches, duplicate autosaves and leaked password storage. Every network call must map to a user action or specified initial load.

---

### Task 12: Local Wrangler Smoke, Dry-Run, Legacy Removal, and Full Verification

**Files:**
- Create: `scripts/smoke.ps1`
- Delete: `worker.js`
- Keep unchanged: `aioapi.js`
- Modify as findings require: files created in Tasks 1 through 11

**Interfaces:**
- Consumes all production/test artifacts.
- Produces reproducible command output and final requirement trace.

- [ ] **Step 1: Write the exact supervised smoke script**

Use the spec section 20.2 sequence: build/test, `Start-Process npx.cmd wrangler dev --local --port 8787`, 30-second readiness deadline, create/raw exact-body assertion, protected view-once first 200/second 404, `/ip-trace` reflected body/header assertion, and `finally` cleanup via `taskkill.exe /PID $server.Id /T /F`. Add API settings/password/history and `/html` exact-body checks without contacting any external origin.

- [ ] **Step 2: Run smoke RED/GREEN and fix root causes**

Run `npm run smoke`. Expected: exit 0 and no surviving Wrangler/Node child serving port 8787. If it fails, write or extend the narrowest automated test reproducing the same defect before changing production code.

- [ ] **Step 3: Remove the obsolete Worker**

Delete `worker.js` only after canonical route tests and smoke are green. Confirm Wrangler main is `src/index.ts`, no `addEventListener("fetch")` remains, `/api` and `/delete/:id` return 404, and `aioapi.js` remains only as the `/ip-trace` reference source.

- [ ] **Step 4: Run generated types and dry-run**

Run:

```powershell
npx wrangler types
npx wrangler types --check
npx wrangler deploy --dry-run --outdir .wrangler-dist
```

Expected: all exit 0. Record `Total Upload`; it must be below 64 MiB. Inspect `.wrangler-dist` and source maps/metafiles to confirm no duplicate server-side Crepe or diff bundle.

- [ ] **Step 5: Run the full release gate from a clean install**

Remove `node_modules`, `dist`, `.wrangler-dist` and test reports, then run:

```powershell
npm ci
npm run build
npx vitest run
npx playwright test
npm run smoke
npx wrangler types --check
npx wrangler deploy --dry-run --outdir .wrangler-dist
```

Expected: every command exits 0. Safari desktop is the only permitted environment skip on Windows; WebKit tests must pass.

- [ ] **Step 6: Request correctness/security review**

Invoke `superpowers:requesting-code-review`. Review only changed production/config/test files against the spec, emphasizing multi-key write ordering, schema fail-closed behavior, password carrier precedence, view-once render/delete/response ordering, unsandboxed `/html` exception, Markdown safety, MCP protocol and browser draft preservation. Verify each finding before editing and add a regression test for every correctness fix.

- [ ] **Step 7: Request simplification review**

Invoke `code-simplifier:code-simplifier` over recently created code. Preserve every frozen behavior and test; remove only duplication, unnecessary abstraction and dead code introduced by this rewrite. Re-run affected tests after each focused simplification, then rerun `npx vitest run`.

- [ ] **Step 8: Invoke verification-before-completion**

Invoke `superpowers:verification-before-completion` and execute its fresh-evidence checklist. Do not reuse earlier passing output after review fixes.

- [ ] **Step 9: Check all traceability rows**

Walk spec rows C01..C34 and T01..T10. For each row, record at least one automated test name or smoke assertion and its latest passing command. Explicitly record accepted, production-only limitations that local tests cannot remove: KV cross-region stale reads, custom-ID concurrent race, view-once duplicate delivery, partial multi-key propagation, production plan CPU/memory at 10 MiB, actual namespace replacement before deploy, and Safari stable manual smoke on non-Windows hardware.

- [ ] **Step 10: Final status report**

Report exact command results, test counts, dry-run upload size, Edge/WebKit status, Safari omission, changed/deleted files and the accepted production limitations. State plainly that no commit, push or deploy was performed.
