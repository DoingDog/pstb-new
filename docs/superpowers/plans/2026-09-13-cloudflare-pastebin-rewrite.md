# Cloudflare Pastebin Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已完成并通过独立评审的 parser/domain/MCP/multipart/autosave/Markdown-diff 基线上，完成冻结的 canonical HTTP contract、React 19.3.0 Document Workbench、精确 browser autosync/reconciliation 状态机、跨浏览器验收和无真实部署的 Cloudflare release gates。

**Architecture:** `src/index.ts` 继续先把精确 `/mcp` 分流给 stateless MCP handler，其余请求进入唯一 Hono router；只有 `src/pastes.ts` 访问唯一业务存储 `env.PASTE_DB`。Worker application routes 只返回最小 React shell、validated inert bootstrap、单份 exact-source transport和可选 fixed-renderer safe Markdown template。Vite 8.3.0 构建 React/shadcn initial graph、lazy Crepe、lazy browser Markdown和独立 diff worker；ordinary paste 的一个 framework-neutral page controller串行化所有 mutation，并与单 timer/单 in-flight autosync controller、history epochs和 staged derived-surface coordinator协作。Full-document routes仍是 page identity boundary；仅 delete 204 在同一 React root内 hand off到 create branch。

**Tech Stack:** TypeScript 7.0.2、Cloudflare Workers、Hono 4.13.7、React/React DOM 19.3.0、Vite 8.3.0、Tailwind CSS 4.3.3、pinned shadcn/ui `new-york-v4/sidebar-11`、Radix `radix-ui` 1.6.7、Milkdown Crepe 7.22.1、micromark 4.0.2、micromark-extension-gfm 3.0.0、diff 8.0.2、`@modelcontextprotocol/server` 2.0.0、Zod 4.6.4、Vitest 4.1.11、`@cloudflare/vitest-plugin` 1.1.8、Playwright 1.63.0、`@axe-core/playwright` 4.13.0、Wrangler 4.131.1、Node.js 22.12.0 或更高版本。

**Spec:** `docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md`（binding authority）；视觉细化为 `docs/superpowers/specs/2026-09-13-pastebin-ui-direction.md`。

## Global Constraints

- 业务存储只有 `env.PASTE_DB` 一个 KV namespace；不增加 Durable Object、D1、R2、Queue、第二个 KV、Cache correctness layer、service binding、account、owner/session token、global auth、rate limit或其他协调服务。
- 正文始终以 `<id> -> exact plaintext content` 保存；business metadata和三个 revision slot只使用同一 namespace 的冻结 sibling keys。任何 server/client 新模块不得直接访问 KV。
- custom ID 完整匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`，case-sensitive，拒绝冻结 route names与 internal prefix；content是 `1..10_485_760` UTF-8 bytes的有效 Unicode scalar sequence，不 trim、不 normalize、不改换行。
- relative expiration至少60秒且结果不晚于 `9999-12-31T23:59:59.999Z`；password为空表示未保护或 clear，非空 stored/new password只允许1..128个 U+0020..U+007E字符。冻结的 plaintext password与 URL-query风险不得被 hash、encryption或新 token暗改。
- view-once严格按“完整验证并准备 body/headers → delete main →并行 delete三个 revisions → delete metadata → return”执行；HEAD、OPTIONS、password form、错误、history和 mutation不消费，且不声称跨地域 exactly once。
- `/html/:id` 返回 exact source的顶层 same-origin executable document；不加 wrapper、sanitizer、iframe、sandbox、CSP或 application `Referrer-Policy`。application CSP绝不经共享 middleware落到该 route。
- `/md/:id`和 client safe preview只接受固定 micromark/GFM renderer输出；`allowDangerousHtml:false`、`allowDangerousProtocol:false`、默认 clobber prefix。source/title/error/history/diff不得进入 trusted HTML boundary。
- 可见 application UI全部由 React `createRoot`产生；server shell不含 visible form、article wrapper、tabs、sidebar、dialog或 error panel。不得保留 handwritten visible DOM binder、旧 selector tree或未集成 imperative tabs candidate。
- 不增加 React Router、RSC、Next.js、Vercel runtime、auth/query/chart/admin package、第二个 backend、SSE、WebSocket、long polling、Web Push、KV event subscription或 hidden server polling。
- ordinary controlled paste page只用 `GET /api/pastes/:id`进行每3,000 ms的顺序 conditional polling；每个 load/真实 user activity window精确300,000 ms，最多一个 timer和一个 fetch，deadline不 round、不 grace、不因 dispatch/Retry/settle延长。
- 所有 browser mutation携带可用 current version；authoritative 409使 `versionUsable=false`，只有完整 Reload恢复。明确用户选择的 Overwrite可省略 version；curl/MCP省略 version仍是冻结的 last-write-wins。
- dynamic application/API/representation/error/304全部 `Cache-Control: no-store`；content-hashed Vite assets为一年 immutable。initial JS、CSS、lazy Markdown、lazy Crepe、diff worker和总静态输出必须逐项满足规格第18节预算。
- `wrangler.jsonc`只声明一个 `PASTE_DB` binding，开发 ID保持 `11111111111111111111111111111111`；只允许 `wrangler dev --local`、`wrangler types --check`和 `wrangler deploy --dry-run`，不得真实 deploy或 push。
- 不恢复 `GET|POST /api`、legacy response shape、`GET /delete/:id`或 destructive GET；`aioapi.js`只作为 `/ip-trace`参考且保持不变。
- 不引入 `react-hook-form`或 `@hookform/resolvers`：所有表单是受控 React state，client只做 UX validation，现有 server/domain strict validation继续是 authority；这两项不能提供本计划所需的 mutation serialization、credential precedence或 reconciliation，因此没有具体缺口可证明其必要性。本计划不得使用 `useForm`、`Controller`或 `zodResolver`。只有未来出现受控 state 无法直接满足的具体 form/schema need，并先修改 binding spec与当时 implementation plan证明该需要时，才可加入这些 packages或APIs。
- 每个 remaining task先写实际 RED、再做最小 GREEN；每个 task在独立 worktree由 Sonnet 1M xhigh实现并形成聚焦 commit，随后由另一个干净 worktree中的 Opus 1M max独立评审。只有明确 `APPROVED` 的 candidate commit才可 cherry-pick到 feature worktree。
- 同一 wave内不得并发编辑同一个 router、package/lockfile、generated asset、i18n catalog、render shell、shared React state或 copied shadcn source。所有共享文件按下文唯一 owner和先后顺序处理。

## Reviewed Baseline（不创建重做任务）

本计划修订前的 reviewed code HEAD 是 `5e3250a51c22e72b6e3a402bf35a80fc1ef04d5f`；执行起点是下文定义的 `PLAN_HEAD`。以下实现已经完成、经过 scoped independent review并进入当前分支；remaining tasks只复用或迁移其 public behavior，不重新实现其领域规则。

| 已完成 foundation | Reviewed commits / 当前证据 | 后续 disposition |
|---|---|---|
| Hashed client asset和Cloudflare toolchain foundation | `ed58958`；现有 `scripts/build.mjs`、`src/generated/assets.ts`、Wrangler/Vitest配置 | Task 8把 frontend builder从esbuild替换为Vite，但保留hashed URL、immutable `_headers`和server manifest handoff语义。 |
| Strict JSON、UTF-8、wire limits和opaque carrier parsing | `6e83ca9`、`8f13b11`、`00eea02`及整合后的`e2a61d1`、`1853b85`、`1aa75c6` | `src/json.ts`及其差分/边界tests保持foundation；HTTP新增body schema必须调用现有parser policy，不另建JSON parser。 |
| Paste domain、KV grammar、legacy、history、mutation、reconciliation、delete/consume | `d44e3ff`、`0fc3e4b`、`5965e6d`、`e852e5e`、`fb45542`、`1fa4864` | `src/pastes.ts`/`src/pastes.test.ts`不进入remaining implementation file map；route/client只调用现有方法。 |
| Safe Markdown、download headers、application CSP和exact source codec | `856b3c9`、`ec88611`、`1311b2b`、`4a8fbe7` | Task 2只删除stale visible server markup并规范bootstrap；保留renderer、codec、CSP和filename规则。 |
| Streaming multipart parser和production wiring | `6711776`、`e7dfef8`、`6ad2015`、`4868e33`、`982cd7f` | Production parser不改；Task 1仅把两个已知worst-case tests拆成独立timeout，不减少case。 |
| MCP 2026-07-28、八tools、stateless fallback、64 MiB boundary和index mount | `356d6a3`、`9a51a61`、`9e4fbbc`、`760a57a`、`e063c47`、`62ebc2a` | `src/mcp.ts`/`src/mcp.test.ts`保持reviewed baseline；HTTP/React变更不得改变tools或mount顺序。 |
| Autosave、Markdown modes和diff worker headless foundation | `b47201b`、`ad03878`；`ce2daf1`至`d2c8562`；integrated Markdown chain `7fe15d1`、`c99d4a8`、`8418b21`、`d2c8562` | Tasks 5与7迁移这些实现；Task 5只增加计划中枚举的 page-slot/event/action/status/authoritative-transition seams，Task 13增加React adapter；不复制或重写第二套timer、Crepe或diff算法。 |
| Locale/theme/password URL helpers | `b23f01d`、`6576716`、`6c0379e` | Task 6迁移pure helper，Task 11让React接管copy；不保留document-wide scanner或WeakMap startup owner。 |
| Backend boundary integration | multipart `982cd7f` + MCP `62ebc2a` 后 JSON/HTTP/MCP/domain 364/364、`npm run build`和`npm run typecheck`通过 | Task 3/4只补尚缺route matrix。完整baseline曾有532/533，唯一failure是`src/multipart.test.ts` one-byte 10 MiB matrix在180秒超时；Task 1保留断言并隔离计时。 |
| Binding React/sync specs | `573bbdd`、`57b70dc`、`223d1c8`、`5e3250a`，round-four Opus review无finding | 68个requirement ID全部是本计划release gate，不重新选择template、polling或storage。 |

未集成的 `98ed2d1 -> 2da846c -> bfaac29` imperative tabs candidate永久 superseded；不得merge、cherry-pick或搬运controller，只在React Tabs tests中重现其用户可观察keyboard cases。

## Final File Map and Single-Responsibility Ownership

`Owner`列表示可写task；同一行多个task均按数字顺序执行，绝不在同一wave并发。

| Disposition | Path | Single responsibility | Owner |
|---|---|---|---:|
| Modify | `package.json`, `package-lock.json` | exact dependencies（含唯一 axe runner `@axe-core/playwright@4.13.0`）、Node engine和build/test scripts；不含runtime行为 | 8 |
| Create | `index.html` | Vite build entry，仅含`#app`和`/src/client/main.tsx` module；emitted copy不部署 | 8 |
| Create | `vite.config.ts` | React/Tailwind build、hashed entry/chunks、manifest和Vite worker boundary | 8 |
| Modify | `tsconfig.json`, `vitest.config.ts` | TSX/aliases与worker/node/browser Vitest projects | 8 |
| Keep | `wrangler.jsonc` | exact Worker/config/single-KV/static-assets contract | 17只读检查 |
| Modify | `scripts/build.mjs` | Vite orchestration、manifest projection、asset cleanup；release reachability/budget projection | 8，然后17 |
| Create | `scripts/smoke.ps1` | supervised real Wrangler local smoke与process-tree cleanup | 17 |
| Create | `scripts/browser-evidence.mjs`, `scripts/verify-release-evidence.mjs` | acquire andnormalize official stable release histories、derive browser targets、capture actual branded/engine versions、record manual rows andfail closed onall release evidence | 16 |
| Modify generated | `src/generated/assets.ts` | resolved `appJs`、`appCss`、`diffWorker` public URLs；只由build script写 | 8，然后17 |
| Create | `components.json` | pinned shadcn Vite/TSX/new-york-v4 materialization aliases | 8 |
| Create | `docs/shadcn-source-integrity.json` | exact upstream/local source set和local SHA-256 bytes | 17 |
| Create | `THIRD_PARTY_NOTICES.md` | copied-source provenance、MIT/ISC/Apache-2.0/NOTICE obligations | 17 |
| Modify | `src/types.ts` | existing server/domain public types加exact `AppBootstrap` union；无client state | 2 |
| Keep | `src/json.ts`, `src/multipart.ts`, `src/pastes.ts`, `src/mcp.ts`, `src/source-data.ts`, `src/client/markdown.ts`, `src/client/diff.ts` | reviewed parser/domain/MCP/codec/Markdown/diff algorithms | no remaining production owner |
| Modify | `src/i18n.ts`, `src/i18n.test.ts` | one complete en/zh-CN catalog、recursive parity、server/browser locale/date/error helpers | 11 |
| Modify test only | `src/multipart.test.ts` | independent timing of unchanged worst-case multipart cases | 1 |
| Modify | `src/render.ts`, `src/render.test.ts` | minimal application envelope、inert source/preview/bootstrap cardinality、safe renderer和download tests | 2 |
| Modify | `src/http.ts`, `src/http.test.ts` | Task2 updates existing root caller/assertions forrequired error bootstrap status；Tasks3/4 then ownthe one canonical Hono router andall remaining route behavior | 2，然后3，然后4 |
| Keep | `src/index.ts`, `src/mcp.test.ts` | exact `/mcp`-first dispatch和reviewed MCP behavior | read-only in 3/4/17 |
| Create | `src/client/contracts.ts` | exact browser-only unions for remote snapshots、operation records、credentials、mutation/apply/history state | 6 |
| Create | `src/client/bootstrap.ts`, `src/client/bootstrap.test.ts` | strict inert-node extraction、bootstrap validation、exact source和unique password URL helpers | 6 |
| Create | `src/client/api.ts`, `src/client/api.test.ts` | same-origin fetch、strict response bytes/schema/ETag、AbortSignal和error decoding | 6 |
| Create | `src/client/theme.ts`, `src/client/theme.test.ts` | document-only system/light/dark controller | 6 |
| Create | `src/client/autosave.ts`, `src/client/autosave.test.ts` | moved reviewed autosave controller和Markdown adapter；Task 13只加React adapter file | 5 |
| Create/Modify | `src/client/history.ts`, `src/client/history.test.ts` | moved reviewed diff lifecycle加history request epoch/token owner；Vite worker URL只在build migration中改 | 7，然后8（Task 8只改`history.ts`） |
| Modify, then delete | `src/client/app.ts`, `src/client/app.test.ts` | Tasks5/6/7 remove moved headless helpers/tests andtemporarily importfinal modules；Task8 deletesremaining imperative entry/test | 5，然后6，然后7，然后8 |
| Delete | `src/client/styles.css` | obsolete selector-compatible visible UI stylesheet | 8 |
| Create | `src/client/paste-sync.ts`, `src/client/paste-sync.test.ts` | only ordinary-page polling timer/fetch/candidate scheduler | 9 |
| Create | `src/client/paste-controller.ts`, `src/client/paste-controller.test.ts` | canonical page state、single mutation slot、reconciliation、terminal arbitration | 10 |
| Create | `src/client/surface-apply.ts`, `src/client/surface-apply.test.ts` | preview/Crepe/diff detached staging、generation guards、rollback/retry cleanup | 10 |
| Create | `src/client/main.tsx` | extract/validate inert data before one `createRoot`; no page behavior | 8 |
| Create/Modify | `src/client/App.tsx` | top-level bootstrap/page phase switch only | 8，然后11，然后15 |
| Create | `src/client/index.css` | Tailwind import、pinned tokens、Crepe/prose/diff rules、reduced-motion override only | 8 |
| Create | `src/client/hooks/use-mobile.tsx` | exact pinned upstream mobile media hook | 8 |
| Create | `src/client/hooks/use-autosave.ts` | one React adapter around reviewed controller | 13 |
| Create | `src/client/hooks/use-paste-page.ts` | one React lifecycle adapter around page/sync/surface controllers | 15 |
| Create | `src/client/pages/OrdinaryPage.tsx` | sole ordinary lazy adapter；calls `usePastePage` and renders Task 13 `OrdinaryPastePage` | 15 |
| Create | `src/client/components/ui/{sidebar,sheet,breadcrumb,collapsible,dialog,tooltip,tabs,field,label,input,textarea,button,separator}.tsx` | exact pinned official primitive source with provenance; no product state | 8 |
| Create | `src/client/components/app-sidebar.tsx` | pinned sidebar-11 product adaptation; real modes/metadata/actions only | 11 |
| Create | `src/client/components/{WorkbenchShell,HelpTrigger,OperationStatus,SafeMarkdown,LocalActions}.tsx` | shared React chrome/help/status/trusted renderer/local actions | 11 |
| Create test | `src/client/components/workbench.browser.test.tsx` | shared shell/help/status/local-action component acceptance | 11 |
| Create | `src/client/pages/{CreatePage,PasswordPage,ErrorPage,LocalOnlyPastePage,MarkdownPage}.tsx` | non-ordinary React branches | 12 |
| Create test | `src/client/pages/static-pages.browser.test.tsx` | create/password/error/consumed/read-only-md semantics | 12 |
| Create | `src/client/components/{OrdinaryPastePage,ContentModes,PlaintextEditor,MarkdownWorkbench}.tsx` | ordinary content/read/edit/Markdown workbench | 13 |
| Create test | `src/client/components/content-modes.browser.test.tsx` | ordinary view/editor/Crepe/source/preview lifecycle | 13 |
| Create | `src/client/components/{HistoryPanel,SettingsPanel,PasswordPanel,DeleteFlow}.tsx` | history/diff/settings/password/delete UI against injected callbacks | 14 |
| Create test | `src/client/components/management.browser.test.tsx` | management forms/races/focus/result-table presentation | 14 |
| Create test | `src/client/App.browser.test.tsx`, `src/client/App.module-graph.test.ts` | complete branch/controller integration、StrictMode-like remount、request audit andsource-only lazy/import ownership proof | 15 |
| Create | `playwright.config.ts`, `test/e2e/helpers.ts` | real Wrangler webServer和bundled Chromium/Firefox/WebKit projects/helpers；不冒充branded browser evidence | 16 |
| Create | `test/e2e/{create-password,ordinary-sync,view-once-representations,accessibility}.spec.ts` | end-to-end journeys、每个application branch的AxeBuilder scan和engine matrix | 16 |
| Create | `test/fixtures/external.html`, `test/e2e/browser-matrix.json`, `test/e2e/browser-manual.md`, `test/e2e/accessibility-manual.md`, `test/e2e/accessibility-manual.json`, `test/e2e/evidence/browser-target-sources/*.json`, `test/e2e/evidence/browser-matrix/**`, `test/e2e/evidence/engine/**`, `test/e2e/evidence/accessibility/**` | same-origin active-HTML marker、official stable release-history snapshots、exact-two-derived-major branded rows/manual commands、tracked engine receipts andfour release-blocking accessibility rows | 16 |
| Modify | `src/build.test.ts` | exact pins/source set/manifest/hash/budget/no-banned-stack checks | 8，然后17 |
| Create test | `src/legacy-removal.test.ts` | final proof旧Worker不存在且`aioapi.js`不变 | 18 |
| Delete | `worker.js` | obsolete Service Worker implementation；仅所有release gates先通过后删除 | 18 |
| Keep | `aioapi.js` | `/ip-trace` reference only | no owner |

## Exact Shared Types and State Contracts

### Server-to-client bootstrap

Task 2在`src/types.ts`加入下列exact union；不得增加password、content或protected URL字段：

```ts
export type AppLocale = "en" | "zh-CN";

export type AppBootstrap =
  | { page: "create"; locale: AppLocale }
  | { page: "paste"; locale: AppLocale; paste: PasteSummary; consumed: false }
  | {
      page: "paste";
      locale: AppLocale;
      consumed: true;
      hasInitialMarkdownPreview: boolean;
    }
  | {
      page: "markdown";
      locale: AppLocale;
      id: string;
      title: string;
      hasInitialMarkdownPreview: true;
    }
  | { page: "password"; locale: AppLocale; errorCode: null | "FORBIDDEN" }
  | { page: "error"; locale: AppLocale; status: number; errorCode: string };
```

Inert-node cardinality是类型contract的一部分：

| Variant | `#source-data` | `#initial-markdown-preview` |
|---|---:|---:|
| create/password/error | 0 | 0 |
| ordinary paste text | 1 | 0 |
| ordinary paste markdown | 1 | 1 |
| consumed paste with flag false/true | 1 | 0/1，与flag严格相等 |
| markdown | 1 | 1 |

### Browser canonical and operation state

Task5先在`autosave.ts`固定`AutosaveState`；Task6在`src/client/contracts.ts`以`import type { AutosaveState } from "./autosave"`复用它并一次性固定其余public unions；后续parallel tasks只import，不修改：

```ts
export type ActionKey =
  | "create"
  | "autosave"
  | "manual-save"
  | "save-retry"
  | "overwrite"
  | "content-reconcile"
  | "reload-server"
  | "use-remote"
  | "use-consumed-response"
  | "retry-sync"
  | "copy"
  | "download"
  | "history-list"
  | "history-snapshot"
  | "settings-title"
  | "settings-format"
  | "settings-expiration"
  | "settings-view-once"
  | "settings-reconcile"
  | "password-set"
  | "password-clear"
  | "password-reconcile"
  | "delete";

export type TerminalOutcomeKey =
  | "content-reconcile-terminal-current-kept"
  | "reload-terminal-response-displayed"
  | "reload-terminal-response-display-failed"
  | "reload-terminal-current-unchanged"
  | "reload-terminal-current-kept-choice"
  | "use-consumed-response-displayed"
  | "use-consumed-response-display-failed";

export type LastAction =
  | { state: "idle" }
  | { state: "pending"; key: ActionKey; attempt: number; startedAt: string }
  | {
      state: "succeeded" | "failed";
      key: ActionKey;
      attempt: number;
      startedAt: string;
      settledAt: string;
      outcomeKey: TerminalOutcomeKey | null;
    };

// Imported from ./autosave and re-exported here; Task 5 owns the string union.
export type AutosaveStatus = AutosaveState;
export type AutosyncStatus =
  | "waiting" | "checking" | "unchanged" | "remote-applied"
  | "paused-local" | "paused-offline" | "error" | "forbidden"
  | "not-found" | "conflict" | "inactive";
export type NetworkStatus = "online" | "offline" | "degraded";

export interface OperationRecords {
  autosave: {
    state: AutosaveStatus;
    confirmedAt: string | null;
    failedAt: string | null;
  };
  autosync: {
    state: AutosyncStatus;
    stateChangedAt: string | null;
    checkedAt: string | null;
    appliedAt: string | null;
  };
  network: { state: NetworkStatus; changedAt: string };
  lastAction: LastAction;
}

export type VersionIdentity =
  | { kind: "legacy" }
  | { kind: "v2"; generation: string; versionCounter: number };

export interface RemoteSnapshot {
  etag: `"sha256-${string}"`;
  source: string;
  summary: PasteSummary;
  identity: VersionIdentity;
  contentRevision: number;
  updatedAtMs: number;
}

export type RemoteOrder =
  | "definitely-older"
  | "definitely-newer"
  | "marker-equal"
  | "incomparable";

export interface CredentialState {
  committed: string | null;
  pending: string | null;
}

export interface AcceptedPasteState {
  acceptedSource: string;
  draft: string;
  summary: PasteSummary;
  version: string;
  versionUsable: boolean;
  contentRevision: number;
  updatedAt: string;
  responseEtag: `"sha256-${string}"` | null;
  acceptedApplyGeneration: number;
  localGeneration: number;
  displayGeneration: number;
}

export type PastePhase =
  | "ordinary"
  | "armed-view-once"
  | "consumed"
  | "not-found"
  | "delete-uncertain";

export type SourceEvent =
  | { type: "input"; content: string; eventAt: number }
  | { type: "composition-start"; content: string; eventAt: number }
  | { type: "composition-input"; content: string; eventAt: number }
  | { type: "composition-end"; content: string; eventAt: number }
  | { type: "crepe-change"; content: string; eventAt: number };

export interface BaselineCapture {
  acceptedApplyGeneration: number;
  localGeneration: number;
  generation: string | "legacy";
  version: string;
  contentRevision: number;
  updatedAt: string;
  acceptedSource: string;
}

export interface TerminalOriginSettleContext {
  actionKey: "content-reconcile" | "reload-server";
  actionAttempt: number;
  startedAt: string;
}
```

`TerminalOriginSettleContext`不得增加ID、credential、URL、source、request或response body。`acceptedSource`与autosave的`lastSavedContent`是同一reducer transition中的同一值，不允许独立推进。

### HTTP route/body/ETag contract to implement

| Route | Exact methods / `Allow` | Request | Success and ETag | Content-bearing |
|---|---|---|---|---|
| `/` | GET,HEAD；`Allow: GET,HEAD` | none | 200 minimal create shell；HEAD empty；OPTIONS and every other method 405 | no |
| `/:id` | GET,HEAD,POST；`Allow: GET,HEAD,POST` | GET/HEAD optional unique query password；POST form has zero or one password field | GET 200 paste/password shell；POST success 302 encoded unique query；OPTIONS 405 | authorized GET with source only |
| `/raw/:id` | GET,HEAD；`Allow: GET,HEAD` | protected only unique query password | exact source text；OPTIONS 405 | GET |
| `/html/:id` | GET,HEAD；`Allow: GET,HEAD` | protected only unique query password | exact source executable HTML；no CSP/sandbox/referrer override；OPTIONS 405 | GET |
| `/md/:id` | GET,HEAD；`Allow: GET,HEAD` | protected only unique query password | minimal read-only React shell、exact source、safe template；OPTIONS 405 | GET |
| `/file/:id` | GET,HEAD；`Allow: GET,HEAD` | protected only unique query password | exact UTF-8 bytes和frozen Content-Disposition；OPTIONS 405 | GET |
| `/api/pastes` | POST,OPTIONS | existing strict JSON/multipart create | 201 summary；`ETag:"<version>"`；clean Location | no |
| `/api/pastes/:id` | GET,HEAD,PUT,PATCH,DELETE,OPTIONS | GET credential query/header与optional `If-None-Match`; mutations as frozen | ordinary GET 200/304 uses strong response ETag；PUT/PATCH 200 mutation-token ETag；DELETE 204 | GET 200 only |
| `/api/pastes/:id/settings` | GET,HEAD,PATCH,OPTIONS | GET credential query/header；strict PATCH settings body | summary/mutation 200；`ETag:"<version>"` | no |
| `/api/pastes/:id/password` | PUT,DELETE,OPTIONS | exact bodies from spec 12.6 | mutation 200；`ETag:"<version>"` | no |
| `/api/pastes/:id/history` | GET,HEAD,OPTIONS | credential query/header | list 200；`ETag:"<version>"` | no |
| `/api/pastes/:id/history/:revision` | GET,HEAD,OPTIONS | positive canonical decimal path | revision 200；`ETag:"<version>"` | no |
| `/api/pastes/:id/read` | GET,HEAD,POST,OPTIONS | GET credential query/header；POST strict `{password?}` | every 200 uses unconditional current-version `ETag:"<version>"`；never 304 | GET/POST 200 |
| `/ip-trace` | GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS | arbitrary body/headers | pretty JSON exact reflection和frozen wildcard CORS headers | no |
| `/assets/*` | GET,HEAD | static binding serves existing hash；Worker fallback 404 | one-year immutable for existing asset | no |

Browser/direct OPTIONS for `/`、`/:id`、`/raw/:id`、`/html/:id`、`/md/:id`和 `/file/:id` must terminate as route-appropriate 405 foravalid registered path before KV read, password authorization, rendering, or consume/delete。Do not register a success handler or include OPTIONS in their `Allow`。API OPTIONS remains 204 with each API row’s exact `Allow`；`/ip-trace` OPTIONS remains 200 with its frozen CORS response；reviewed `/mcp` OPTIONS remains 204 after its Origin rule with `Allow: POST,OPTIONS`。

Password query cardinality is deferred until after route/ID/coherent-read/logical-expiry authority but before credential comparison. If `searchParams.getAll("password")` has more than one value, the HTTP layer performs a read-only `loadContent(id, impossibleOpaqueMatch)` preflight: propagate ID/404/storage/inconsistency failures, translate either an unprotected successful load or the protected preflight’s `FORBIDDEN` into `400 AMBIGUOUS_PASSWORD`, and never call a mutation/consume method. This exceptional duplicate path may perform the preflight read; no normal request adds a second read. It applies before body/query/header precedence and uniformly to main, API, raw/html/md/file routes.

Strong resource ETag必须是deterministic `PasteResource` exact UTF-8 bytes的SHA-256 base64url（无padding），格式严格为`"sha256-`加43个base64url字符再加`"`。Ordinary `If-None-Match`接受单独`*`或OWS包围的strong/weak comma list，使用weak comparison；star与list混用、empty member、bad quote或非法opaque字符返回400。先执行coherent read、expiry和authorization，再解析ordinary validator。View-once GET完全忽略validator（包括malformed），准备完整200并consume；view-once HEAD返回200 headers-only且不consume。

304只保留current strong `ETag`和`Cache-Control:no-store`，不得有body、`Content-Type`、`Content-Length`或trailers。除`GET|HEAD /api/pastes/:id`外，create/mutation/settings/history和`GET|HEAD|POST /read`继续使用quoted mutation-version ETag，绝不把response hash用于`If-Match`。

Exact error mapping：

| HTTP | Code | Exact condition/details |
|---:|---|---|
| 400 | `BAD_REQUEST` | malformed JSON/UTF-8/path/query或ordinary malformed validator；无details |
| 400 | `AMBIGUOUS_PASSWORD` | duplicate password query；无details |
| 400 | `AMBIGUOUS_VERSION` | body/`If-Match`不同或bad ETag syntax；无details |
| 403 | `FORBIDDEN` | protected credential missing/wrong；无details |
| 404 | `PASTE_NOT_FOUND` | missing/logically expired；无details |
| 404 | `REVISION_NOT_FOUND` | revision absent；无details |
| 409 | `ID_CONFLICT` | any custom-ID sibling visible；`{id}` |
| 409 | `VERSION_CONFLICT` | supplied version stale；`{currentVersion,updatedAt}` |
| 409 | `VIEW_ONCE_HISTORY_FORBIDDEN` | authorized active view-once history；无details |
| 413 | `CONTENT_TOO_LARGE` | decoded content >10,485,760；`{maxBytes:10485760}` |
| 413 | `REQUEST_TOO_LARGE` | JSON/MCP wire >67,108,864；`{maxBytes:67108864}` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | route media mismatch；`{accepted}` |
| 422 | `VALIDATION_FAILED` | semantic schema/ID/title/password/expiration/empty content；field-error array |
| 500 | `RENDER_FAILED` | fixed Markdown renderer unexpected failure；无details |
| 500 | `INTERNAL_ERROR` | uncategorized server defect；无details |
| 503 | `STORAGE_READ_FAILED` | KV read rejection；`{retryable:true}` |
| 503 | `STORAGE_WRITE_FAILED` | create/mutation write rejection；`{retryable:true,mutationMayHaveApplied}` |
| 503 | `STORAGE_INCONSISTENT` | unsafe schema/generation/revision combination；`{retryable:true}` |
| 503 | `CONSUME_FAILED` | any view-once delete rejection；`{retryable:true,mutationMayHaveApplied:true}` |
| 503 | `ID_GENERATION_FAILED` | five generated IDs occupied；`{retryable:true}` |

API errors useJSON`{error:{code,message,details?}}` withfixedEnglish safe message；application routes useminimal error bootstrap；direct raw/html/md/file errors usebriefEnglish`text/plain; charset=utf-8`；never401/429。Header matrix：

| Response | Exact required headers |
|---|---|
| API JSON | `Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store` androute-specific ETag above |
| API 304 | `ETag`、`Cache-Control: no-store` only（plusplatform automatic headers） |
| React application andMarkdown shell | `Content-Type: text/html; charset=utf-8`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、exact application CSP |
| raw | `Content-Type: text/plain; charset=utf-8`、`Cache-Control: no-store` |
| user HTML | `Content-Type: text/html; charset=utf-8`、`Cache-Control: no-store`；noCSP/sandbox/application`Referrer-Policy` |
| file | `Content-Type: application/octet-stream`、frozen`Content-Disposition`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff` |
| password 302 | `Location`、`Cache-Control: no-store` |
| 405 | route media type、exact`Allow`、`Cache-Control: no-store` |
| retryable 503 | route media type、`Retry-After: 1`、`Cache-Control: no-store` |
| hashed asset | correctmedia type、`Cache-Control: public, max-age=31536000, immutable` |

### Exact browser timing and ordering

- Autosave debounce：真实source input或committed compositionend的event timestamp +1,000 ms；最多一个mutation request；save期间只coalesce latest draft。
- Autosync active deadline：load完成或最后一次spec-defined真实user activity的event timestamp +300,000 ms；initial due为load+3,000，settle/recovery due为对应instant+3,000；唯一timer始终arm到`min(syncDueAt ?? activeUntil, activeUntil)`。
- `localGeneration`在每次source/Crepe/settings field change、composition start/intermediate input和每次mutation dispatch前递增；只有真实committed user activity移动deadline。
- Ordinary autosync apply仅允许same-generation三marker全部非降且至少一个增长的`definitely-newer`；exact marker/source/summary equal为unchanged。Older、marker-equal divergent、mixed marker、different generation和legacy divergent只产生candidate，重复返回永远不是freshness proof。
- 每个200 read先完整读取bytes、验证digest、strict resource schema/ID/links/contentBytes/version/timestamp，再检查`viewOnce`，最后才检查ordinary token。任何完整valid `viewOnce:true` 200即使ordinary token已被edit/mutation/offline/deadline retire，也必须进入terminal local-only；abort/truncate/digest/schema failure不得进入terminal。
- Autosync、Use remote、confirmed Reload和consumed source choice使用各自entry/commit guard，不共享`locallyClean`。Remote/terminal source publication必须走detached/offscreen staged transaction；失败restore完整old generation或保留绑定old generation的failure fallback，绝不部分推进canonical markers。
- 所有content/settings/password/delete mutation共享一个page slot；sync/reload/history read不占slot但slot occupied时不得dispatch。Uncertain content write转为绑定原token/target/baseline/later draft的content reconciliation；uncertain metadata/password/expiry按spec 17.10.3；delete严格按204/403/409/404/uncertain五类结果。

## Dependency and Execution Waves

`PLAN_HEAD` means the documentation-only commit that contains this revised plan and its matching binding-spec corrections. Before implementation, run:

```powershell
$planHead = (git rev-parse HEAD).Trim()
git diff --name-only 5e3250a51c22e72b6e3a402bf35a80fc1ef04d5f $planHead
```

The second command must list exactly `docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md` and `docs/superpowers/plans/2026-09-13-cloudflare-pastebin-rewrite.md`, with no other path；retain `$planHead` as `PLAN_HEAD` for the implementation run and never start a candidate at the parent commit where these corrections are absent.

每个wave开始前，feature worktree必须clean；同wave标为parallel的implementation worktree从同一个已审核integrated HEAD创建。Each fresh implementation/review worktree runs `npm ci` before its first RED/check (Task 8 reruns it after regenerating the lockfile). Worktrees that execute `*.browser.test.tsx` first run `npx playwright install chromium`; Task 16 installs Chromium, Firefox, and WebKit as its explicit matrix step. Browser binaries are environment prerequisites, never repository changes or evidence by themselves.Wave 1先parallel执行Tasks1/2，再从两者approved/cherry-picked后的HEAD串行执行Task3；Wave3是另一条明确serial dependency chain：Task6从approved Task5后的HEAD开始，Task7从approved Task6后的HEAD开始，Task8再从approved Task7后的HEAD开始。实现进程固定`claude-sonnet-5[1m]`、effort `xhigh`；review进程固定`claude-opus-5[1m]`、effort `max`，review worktree只含integrated base和单个candidate。Review发现问题时，原Sonnet worktree先加RED regression与fix commit，再由新的Opus context复审完整task range。不得让reviewer自行批准未验证的fix。

| Wave | Parallel candidates | Dependency | File-disjoint proof / integration order |
|---:|---|---|---|
| 1 | Tasks 1 and 2 in parallel，then Task 3 serial | clean `PLAN_HEAD`；Task 3 requires approved Tasks 1/2 integration | Task 1只写multipart test；Task 2写types/render及existing root HTTP caller/assertions；review后按1→2 cherry-pick。Task 3再从新HEAD独占HTTP router/test并review/cherry-pick。 |
| 2 | Tasks 4 and 5 in parallel | approved Wave 1 | Task 4只写HTTP；Task 5提取autosave并写old app/test。Review后按4→5。 |
| 3 | Tasks 6→7→8 serial | approved Wave 2；each task additionally requires its immediate predecessor | Task 6先提取contracts/bootstrap/api/theme并写old app/test；approved/cherry-picked后Task 7提取history并再次写old app/test；approved/cherry-picked后Task 8修改history worker URL并独占package/lock/build/generated source、copied shadcn、main/App/index.css和remaining obsolete client deletion。 |
| 4 | Tasks 9、10、11 | approved Task 8 | Task 9只写paste-sync；Task 10只写paste-controller/surface-apply；Task 11只写i18n与shared React chrome/App。Review后按9→10→11。 |
| 5 | Tasks 12、13、14 | approved Wave 4 | 三组page/component源与各自browser tests完全分开，不写App/i18n/index.css/shared controller。Review后按12→13→14。 |
| 6 | Task 15 | approved Wave 5 | 独占shared App lifecycle、ordinary lazy`OrdinaryPage` hook owner和React controller adapter。 |
| 7 | Tasks 16、17 | approved Task 15 | Task 16只写Playwright/config/evidence scripts/fixtures；Task 17只写build/notices/smoke/generated manifest。两者paths不重叠；Review后按16->17。 |
| 8 | Task 18 | approved Wave 7 | 先跑所有release gates，再独占legacy-removal test与`worker.js` deletion，最后fresh full gate。 |

每个task的“full checks”均在candidate worktree执行。当前reviewed handoff供Tasks1-7作为起点，Task8再提交Vite handoff；任何Tasks1-16中不拥有`src/generated/assets.ts`的task在`npm run build`期间允许build script临时投影当前hash，以便render/build tests检查真实assets，但checks完成后必须运行`git restore --source=HEAD -- src/generated/assets.ts`并确认candidate commit不含该path。Task17作为下一位且最后一位owner从最终React graph重新生成并提交它；parallel candidates绝不传递或提交自己的投影。Task18不改client graph，fresh build必须证明Task17 bytes完全相同而不以restore掩盖nondeterminism。Review worktree按对应规则执行。Review批准后，主worktree只`git cherry-pick`列出的task commits，再重跑该task focused checks并restore非owner generated projection；不得手工复制文件。

Tasks 2–7 are explicitly non-release migration states: Task 2 removes server-owned visible UI before the React/Vite entry exists, while Tasks 5–7 relocate reviewed client behavior without publishing a replacement. Their scoped and full unit/build suites must still pass, but no smoke, browser-matrix, dry-run release decision, or deployment is permitted from those commits. Approved Task 8 is the first post-migration commit required to restore a renderable React application branch; Tasks 15–18, not any intermediate commit, establish complete product and release acceptance.

---

### Task 1: Isolate Multipart Worst-Case Timing Without Losing Coverage

**Files:**
- Modify test: `src/multipart.test.ts`
- Production files: none

**Contract:** 现有parser bytes与expected errors完全不变。把当前content-cap chunk matrix和“all UTF-8 scalar/field caps”大循环拆为Vitest独立cases；特别保留10,485,759 ASCII bytes + 2-byte scalar在1-byte stream delivery下的413，以及content 10 MiB边界下2/3/4-byte scalar、bulk/one-byte的全部组合。

- [ ] **Step 1: Capture the existing RED timeout**

Run:

```powershell
npx vitest run src/multipart.test.ts -t "reports valid two-, three-, and four-byte scalar overflows at every field cap through bulk and one-byte delivery" --testTimeout=180000
```

Expected RED: assertion body仍未完成时由该单一test的180,000 ms timeout失败；不得把这个环境性timeout记为parser correctness failure。

- [ ] **Step 2: Make the minimal GREEN change by replacing both monolithic matrices with independently named cases**

Use these exact case generators in `src/multipart.test.ts`:

```ts
const contentScalarChunkCases = [
  { name: "whole body", chunkBytes: undefined },
  { name: "1 MiB chunks", chunkBytes: 1_048_576 },
  { name: "8 KiB chunks", chunkBytes: 8_192 },
  { name: "one-byte chunks", chunkBytes: 1 },
] as const;

it.each(contentScalarChunkCases)(
  "reports a valid UTF-8 scalar crossing the 10 MiB cap with $name",
  async ({ chunkBytes }) => {
    const boundary = "content-utf8-cap";
    const body = multipart(boundary, [
      formPart("content", join(
        new Uint8Array(contentLimit - 1).fill(0x61),
        Uint8Array.of(0xc2, 0xa2),
      )),
    ]);
    await expect(fieldsFor(body, boundary, chunkBytes)).rejects.toMatchObject({
      code: "CONTENT_TOO_LARGE",
      status: 413,
      details: { maxBytes: contentLimit },
    });
  },
  600_000,
);

const utf8CapCases = ([
  ["content", contentLimit],
  ["title", 800],
  ["format", 8],
  ["expiration", 29],
  ["password", 128],
  ["viewOnce", 5],
  ["customId", 64],
] as const).flatMap(([field, limit]) =>
  ([
    ["two-byte", Uint8Array.of(0xc2, 0xa2)],
    ["three-byte", Uint8Array.of(0xe2, 0x82, 0xac)],
    ["four-byte", Uint8Array.of(0xf0, 0x9f, 0x99, 0x82)],
  ] as const).flatMap(([scalarName, scalar]) =>
    ([
      ["bulk", undefined],
      ["one-byte", 1],
    ] as const).map(([delivery, chunkBytes]) => ({
      field,
      limit,
      scalarName,
      scalar,
      delivery,
      chunkBytes,
    })),
  ),
);

it.each(utf8CapCases)(
  "reports $scalarName overflow for $field with $delivery delivery",
  async ({ field, limit, scalar, chunkBytes }) => {
    const boundary = `cap-${field}`;
    const body = multipart(boundary, [
      formPart(field, join(new Uint8Array(limit - 1).fill(0x61), scalar)),
    ]);
    const expected = field === "content"
      ? { code: "CONTENT_TOO_LARGE", status: 413, details: { maxBytes: contentLimit } }
      : { code: "VALIDATION_FAILED", status: 422, details: { fields: [{ field }] } };
    await expect(fieldsFor(body, boundary, chunkBytes)).rejects.toMatchObject(expected);
  },
  600_000,
);
```

Delete the two old combined tests after these exact replacements exist. Case count must be4 + 42，且至少4个tests的`chunkBytes===1`同时构造接近10 MiB content。

- [ ] **Step 3: Run focused and full GREEN checks**

```powershell
npx vitest run src/multipart.test.ts --testTimeout=600000
npm run build
npx vitest run --testTimeout=600000
```

Expected GREEN: all64 existing parser behaviors plus拆分后的independent cases通过；full suite不再由一个180-second aggregate case遮蔽其他结果。

- [ ] **Step 4: Commit and independent review gate**

```powershell
git add src/multipart.test.ts
git commit -m "test: isolate multipart worst-case timing"
```

Independent Opus 1M max review必须核对原两个矩阵的Cartesian coverage、1-byte 10 MiB构造、expected error precedence和只改test。Reviewer运行focused命令并给出`APPROVED`后才cherry-pick。

---

### Task 2: Replace Visible Server Templates With Exact Inert React Shells

**Files:**
- Modify: `src/types.ts`
- Modify: `src/render.ts`
- Modify test: `src/render.test.ts`
- Modify integration caller/test: `src/http.ts`, `src/http.test.ts`（existing root 405 only；Task3 begins onlyafterthis commit isapproved）

**Interfaces:** 保留`renderMarkdown`、`escapeBootstrapJson`、`applicationHeaders`、`deriveDownloadFileName`和`deriveDownloadHeaders`。`renderCreatePage`、`renderPastePage`、`renderPasswordPage`、`renderErrorPage`、`renderMarkdownDocument`继续是HTTP调用面，但全部经一个private `renderApplicationDocument`输出最小shell。`ErrorPageModel`增加`status:number`；`PasswordPageModel.errorCode`变为`null | "FORBIDDEN"`。

- [ ] **Step 1: Replace stale markup assertions with RED shell/cardinality tests**

Add these helpers and tests before editing production:

```ts
function occurrenceCount(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function readBootstrap(html: string): unknown {
  const match = /<script id="bootstrap" type="application\/json">([^<]*)<\/script>/.exec(html);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!);
}

function pasteSummary(overrides: Partial<PasteSummary> = {}): PasteSummary {
  return { ...paste, ...overrides };
}

it("renders an ordinary Markdown paste as inert transport only", () => {
  const html = renderPastePage({ locale: "en", paste: pasteSummary({ format: "markdown" }), content: "# exact\r\n", consumed: false });
  expect(html).toContain('<div id="app"></div>');
  expect(readBootstrap(html)).toEqual({
    page: "paste",
    locale: "en",
    paste: pasteSummary({ format: "markdown" }),
    consumed: false,
  });
  expect(occurrenceCount(html, 'id="source-data"')).toBe(1);
  expect(occurrenceCount(html, 'id="initial-markdown-preview"')).toBe(1);
  expect(html).not.toMatch(/<(?:form|article|aside|nav|button|textarea)\b/);
  expect(html).not.toContain("# exact");
});

it.each([
  [renderCreatePage("en"), { page: "create", locale: "en" }],
  [renderPasswordPage({ locale: "en", errorCode: null }), { page: "password", locale: "en", errorCode: null }],
  [renderPasswordPage({ locale: "en", errorCode: "FORBIDDEN" }), { page: "password", locale: "en", errorCode: "FORBIDDEN" }],
  [renderErrorPage({ locale: "en", status: 503, errorCode: "STORAGE_READ_FAILED" }), { page: "error", locale: "en", status: 503, errorCode: "STORAGE_READ_FAILED" }],
])("renders non-content variants without source or preview nodes", (html, bootstrap) => {
  expect(readBootstrap(html)).toEqual(bootstrap);
  expect(occurrenceCount(html, 'id="source-data"')).toBe(0);
  expect(occurrenceCount(html, 'id="initial-markdown-preview"')).toBe(0);
});
```

Also add exact rows for ordinary text（source1/preview0）、consumed false/true preview flag（source1/preview0或1）和markdown（source1/preview1）。In`src/http.test.ts` replace the existingroot GET visible-Chinese and`data-workbench` assertions：GET bootstrap mustequal`{page:"create",locale:"zh-CN"}` andhaveempty`#app`；POST root 405 bootstrap mustequal`{page:"error",locale:"zh-CN",status:405,errorCode:"METHOD_NOT_ALLOWED"}` withno visible server error string。

Run RED:

```powershell
npx vitest run src/render.test.ts src/http.test.ts -t "inert transport|non-content variants|cardinality|exact root method contract"
```

Expected RED: old functions still emit visible workbench markup and wrong discriminators/cardinality。

- [ ] **Step 2: Add `AppBootstrap` and the minimal GREEN document implementation**

Implement the union from“Exact Shared Types”。Use one private input:

```ts
type ApplicationDocument = {
  locale: Locale;
  title: string;
  bootstrap: AppBootstrap;
  source?: string;
  initialMarkdownSource?: string;
};

function renderApplicationDocument(model: ApplicationDocument): string {
  const source = model.source === undefined ? "" : sourceData(model.source);
  const preview = model.initialMarkdownSource === undefined
    ? ""
    : `<template id="initial-markdown-preview">${renderMarkdown(model.initialMarkdownSource)}</template>`;
  return `<!doctype html>
<html lang="${model.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(model.title)}</title>
<link rel="stylesheet" href="${escapeText(assetPaths.appCss)}">
</head>
<body data-page="${model.bootstrap.page}">
<div id="app"></div>
${source}${preview}
<script id="bootstrap" type="application/json">${escapeBootstrapJson(model.bootstrap)}</script>
<script type="module" src="${escapeText(assetPaths.appJs)}"></script>
</body>
</html>`;
}
```

`initialMarkdownSource`只接受该document的exact source并在helper内调用固定`renderMarkdown`；interface不接受caller-produced HTML。`renderPastePage`规则：ordinary bootstrap含public summary与locale；consumed bootstrap不含summary，只含flag，flag为`paste.format === "markdown"`；`renderMarkdownDocument`只产生`page:"markdown"`、clean id/title与literal true，ordinary/view-once output完全相同local-only能力。Password和error bootstrap采用exact safe fields。

- [ ] **Step 3: Preserve security boundaries and remove obsolete helpers**

Change theexisting`rootMethodNotAllowed` call to`renderErrorPage({locale:requestLocale,status:405,errorCode:"METHOD_NOT_ALLOWED"})`；do notregister orchangeany route inthis task。Delete `translated`、`siteHeader`、lifecycle rail、form/panel/local-action/template-string visible helpers。Keep exactly one executable external module tag、one stylesheet tag、no inline executable code。`applicationHeaders()`仍返回规格16.5 exact CSP；`/html`不调用它。

- [ ] **Step 4: Focused and full GREEN checks**

```powershell
npx vitest run src/render.test.ts src/http.test.ts -t "application documents|exact root method contract"
npx vitest run src/source-data.test.ts
npm run build
npx vitest run --testTimeout=600000
```

Expected GREEN: safe Markdown/filename/CSP/exact-source baseline仍通过；新variant/cardinality/no-visible-markup tests通过。

- [ ] **Step 5: Commit and independent review gate**

```powershell
git add src/types.ts src/render.ts src/render.test.ts src/http.ts src/http.test.ts
git commit -m "refactor: render inert React application shells"
```

Independent Opus review核对每个bootstrap variant、unknown secret absence、source/preview cardinality、safe-template trust boundary、CSP和`/html`隔离。只有focused/full commands通过且review为`APPROVED`才cherry-pick。

---

### Task 3: Complete Canonical API Reads, Conditional ETags, Settings, Password, History, and `/read`

**Files:**
- Modify: `src/http.ts`
- Modify test: `src/http.test.ts`

**Dependency:** approved Tasks1 and2 integrated；this task receives sole`src/http.ts`/`src/http.test.ts` ownership onlyafterTask2。

**Consumes:** reviewed `PasteService` methods；Task 2 render signatures不在本task修改。

- [ ] **Step 1: Add RED tests for deterministic resource bytes and validators**

Add a local helper that uses the existing `request()` and canonical create endpoint:

```ts
async function createJsonPaste(input: Record<string, unknown>): Promise<PasteSummary> {
  const response = await request("/api/pastes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(201);
  return await response.json() as PasteSummary;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

it("uses exact PasteResource bytes as the strong conditional validator", async () => {
  const paste = await createJsonPaste({ content: "etag\r\n🙂", expiration: "permanent" });
  try {
    const first = await request(`/api/pastes/${paste.id}`);
    const bytes = new Uint8Array(await first.clone().arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const etag = `"sha256-${base64Url(digest)}"`;
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe(etag);
    expect(await first.json()).toMatchObject({ id: paste.id, content: "etag\r\n🙂" });

    for (const validator of [etag, `W/${etag}`, `"other", W/${etag}`, "*"]) {
      const response = await request(`/api/pastes/${paste.id}`, { headers: { "if-none-match": validator } });
      expect(response.status).toBe(304);
      expect(response.headers.get("etag")).toBe(etag);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.has("content-type")).toBe(false);
      expect(response.headers.has("content-length")).toBe(false);
      expect(await response.arrayBuffer()).toHaveProperty("byteLength", 0);
    }
  } finally {
    await deletePaste(paste.id);
  }
});
```

The RED test must also build the expected JSON independently with every `PasteSummary` field enumerated in declaration order, `PasteLinks` in `view/raw/html/markdown/file` order, `Expiration` rebuilt as `kind` then optional `seconds`, and `content` last, then compare it byte-for-byte with the 200 body; hashing the received body alone is not sufficient evidence of deterministic serialization. Add `it.each` malformed values `['*, "tag"', '"a",', ',"a"', 'W/"unterminated', '"bad space"']` expecting400 `BAD_REQUEST` only after an existing authorized ordinary resource；same values onview-once GET must yield200+consume。Through the public resource route, send a syntactically legal list member containing literal U+005C backslash whose opaque value does not equal the route’s actual `sha256-<43 base64url chars>` validator and assert200，proving parse-success/nonmatch。Separately use `W/${etag}` built from the actual response validator and assert304，proving weak comparison without exposing or injecting the private parser。Add ordinary HEAD matching304/nonmatching200 and proveempty body；view-once HEAD withvalid ormalformed validator alwaysreturns200 headers-only anddoesnotconsume。

Run RED:

```powershell
npx vitest run src/http.test.ts -t "strong conditional validator"
```

Expected RED: resource GET remains405/404 and no strong hash exists。

- [ ] **Step 2: Implement the minimal GREEN deterministic serialization and RFC entity-tag parser in `src/http.ts`**

Keep helpers private to the one router:

```ts
type EntityTagCondition = { any: true } | { any: false; opaqueTags: string[] };

function serializePasteResource(loaded: LoadedPaste): Uint8Array {
  const summary = loaded.summary;
  const value: PasteResource = {
    id: summary.id,
    title: summary.title,
    format: summary.format,
    viewOnce: summary.viewOnce,
    protected: summary.protected,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    expiresAt: summary.expiresAt,
    expiration: summary.expiration.kind === "relative"
      ? { kind: "relative", seconds: summary.expiration.seconds }
      : { kind: summary.expiration.kind },
    version: summary.version,
    contentRevision: summary.contentRevision,
    contentBytes: summary.contentBytes,
    createdCountry: summary.createdCountry,
    links: {
      view: summary.links.view,
      raw: summary.links.raw,
      html: summary.links.html,
      markdown: summary.links.markdown,
      file: summary.links.file,
    },
    content: loaded.content,
  };
  return new TextEncoder().encode(JSON.stringify(value));
}

async function strongResponseEtag(bytes: Uint8Array): Promise<`"sha256-${string}"`> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `"sha256-${base64Url(digest)}"`;
}
```

Parser只把weak prefix排除在opaque comparison外；opaque grammar严格为RFC 9110 `etagc`：U+0021、U+0023..U+007E和U+0080..U+00FF，反斜杠U+005C是合法字节；拒绝U+0000..U+0020、双引号U+0022、U+007F和超出U+00FF的code unit。`*`只能单独出现。Route先`loadContent`完成schema/expiry/password，再对ordinary解析header；view-once直接跳过parse。

- [ ] **Step 3: Add RED tests for the remaining API schemas and method matrix**

Use table-driven requests for:

```ts
const apiAllow = [
  ["/api/pastes/ID", "GET,HEAD,PUT,PATCH,DELETE,OPTIONS"],
  ["/api/pastes/ID/settings", "GET,HEAD,PATCH,OPTIONS"],
  ["/api/pastes/ID/password", "PUT,DELETE,OPTIONS"],
  ["/api/pastes/ID/history", "GET,HEAD,OPTIONS"],
  ["/api/pastes/ID/history/1", "GET,HEAD,OPTIONS"],
  ["/api/pastes/ID/read", "GET,HEAD,POST,OPTIONS"],
] as const;
```

Cover exact strict bodies:

```ts
type SettingsBody = {
  password?: string;
  version?: string;
  title?: string;
  format?: "text" | "markdown";
  expiration?: ExpirationInput;
  viewOnce?: boolean;
};
type PasswordPutBody = { password?: string; newPassword: string; version?: string };
type PasswordDeleteBody = { password?: string; version?: string };
type ReadPostBody = { password?: string };
```

Tests must prove body credential > unique query > header；duplicate password query overrides every carrier only after coherent/expiry authority for protected and unprotected resources, missing remains 404, and duplicate mutation cases record zero writes/deletes；body/header version equality or400 `AMBIGUOUS_VERSION`；settings至少一个business field；password set/change/clear；history list/snapshot and canonical revision syntax；view-once history409；all success version ETags。`GET|HEAD|POST /read` always200/current-version ETag；absent、valid andmalformed`If-None-Match` areallignored，never304/400；`GET /read`仍content-bearing。

Run RED:

```powershell
npx vitest run src/http.test.ts -t "API method matrix|settings API|password API|history API|read API"
```

Expected RED: these routes are absent andresource `Allow` omitsGET/HEAD。

- [ ] **Step 4: Implement the minimal GREEN API routes using existing strict parser policies**

Extend the existing retained-memory policies with `newPassword` and every exact settings/read key；current `password` and `version` remain opaque comparison carriers, while `newPassword` is a normal string passed to `PasteService.updatePassword` for domain validation。Do not use`request.json()`。

For every content-bearing API response:

1. `loadContent(id, selectedCredential)`；
2. serialize exact response and compute the relevant ETag；
3. if view-once, `await service.consume(loaded)`；
4. construct `Response` only afterconsume fulfilled。

`/read` uses `"${loaded.summary.version}"` instead of SHA-256 and never parses`If-None-Match`。Settings/history responses contain no current content or stored password。

- [ ] **Step 5: Focused and full GREEN checks**

```powershell
npx vitest run src/http.test.ts -t "conditional validator|settings API|password API|history API|read API|API method matrix"
npx vitest run src/http.test.ts src/pastes.test.ts
npm run build
npx vitest run --testTimeout=600000
```

Expected GREEN: allnew routes/status/body/header rules pass；existing streaming create/PUT/PATCH/DELETE tests remain unchanged。

- [ ] **Step 6: Commit and independent review gate**

```powershell
git add src/http.ts src/http.test.ts
git commit -m "feat: complete conditional paste API"
```

Independent Opus review重点验证authorization-before-validator、deterministic bytes/hash、304 forbidden headers、view-once ignore/consume、`/read` unconditional version ETag、credential/version precedence和strict parser reuse。`APPROVED`前不得cherry-pick。

---

### Task 4: Complete Browser Pages, Direct Representations, `/ip-trace`, HEAD/OPTIONS, and Consume Order

**Files:**
- Modify: `src/http.ts`
- Modify test: `src/http.test.ts`

**Dependency:** approved Tasks 2 and 3。

- [ ] **Step 1: Write RED browser/direct route matrix tests**

Create exact test rows:

```ts
const representationRows = [
  ["raw", "text/plain; charset=utf-8"],
  ["html", "text/html; charset=utf-8"],
  ["md", "text/html; charset=utf-8"],
  ["file", "application/octet-stream"],
] as const;

it.each(representationRows)("serves %s GET and non-consuming HEAD", async (route, mediaType) => {
  const paste = await createJsonPaste({ content: "exact\r\n<body>🙂</body>", expiration: "permanent" });
  try {
    const head = await request(`/${route}/${paste.id}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(mediaType);
    expect(await head.text()).toBe("");
    const get = await request(`/${route}/${paste.id}`);
    expect(get.status).toBe(200);
  } finally {
    await deletePaste(paste.id);
  }
});
```

Add protected rows for main/raw/html/md/file: absent/wrong/empty single credential403 exceptmain absent returns200 password bootstrap；duplicate query onprotected andunprotected always400 `AMBIGUOUS_PASSWORD`。Password form tests send exact `application/x-www-form-urlencoded` with `a+b %&#?` through`URLSearchParams`，expect302 relative Location with one decoded value。Test zero named fields and one wrong/empty password field as403 password bootstrap，proving absent credential reaches authorization；one correct field redirects；duplicate password or any unknown field returns422；wrong media returns415。Form POST must notconsume view-once。Add browser/direct OPTIONS rows for `/`、main andallfour representations：eachreturns405 beforeKV/password work，performszero reads/deletes，andusesexact `Allow: GET,HEAD` exceptmain `GET,HEAD,POST`。Keep separate assertions that API OPTIONS is204、`/ip-trace` OPTIONS is200 andreviewed `/mcp` OPTIONS remains204。

Add assertions：raw exact text；HTML exact bytes and absence ofCSP、sandbox、`Referrer-Policy`、nosniff wrapper；md bootstrap/source/template cardinality and CSP；file frozen ASCII/RFC5987 Content-Disposition。

Run RED:

```powershell
npx vitest run src/http.test.ts -t "browser route matrix|password form|direct representation"
```

Expected RED: routes remain404。

- [ ] **Step 2: Implement the minimal GREEN route registration in frozen order**

Inside the oneHono app register exact order：`/`、`/ip-trace`、`/assets/*`、`/api/*`、`/raw/:id`、`/html/:id`、`/md/:id`、`/file/:id`、`/:id`、final404。Do not add a second router或prefix slicing ID。For direct representations only unique query password is accepted；ignore`X-Paste-Password`。Password POST accepts only`application/x-www-form-urlencoded` andreadsbounded bytes withthe existing stream/UTF-8 policy rather than`formData()`。Its form parser accepts zero or one`password` field andno unknown field；zero fields passesabsent credential toauthorization，whileduplicatepassword oranyunknown field returns422。A successful authorization constructs302 Location through`URL`/`URLSearchParams.set`。

EachGET handler loads once and prepares exact body/headers beforeconsume。EachHEAD performs existence/schema/expiry/auth and representation headers, does not call`renderMarkdown`, does notconsume and returns no body。Do not register OPTIONS onbrowser/direct routes；their existing wrong-method path returns405 beforeKV/password work withroute-appropriate media type andexact`Allow` fromthe global table。Do not changeTask3 API OPTIONS 204、`/ip-trace` OPTIONS 200 orthe reviewed`/mcp` OPTIONS 204 behavior。

- [ ] **Step 3: Write RED consume-order and prepared-body tests**

Instrument existing render mock and KV delete spies to record events：

```ts
expect(events[0]).toBe("body-prepared");
const main = events.indexOf("delete-main");
const meta = events.indexOf("delete-meta");
const response = events.indexOf("response-observed");
expect(main).toBeGreaterThan(0);
expect(meta).toBeGreaterThan(main);
const revisionEvents = events.slice(main + 1, meta);
expect(revisionEvents).toHaveLength(3);
expect(new Set(revisionEvents)).toEqual(new Set([
  "delete-revision-0",
  "delete-revision-1",
  "delete-revision-2",
]));
expect(response).toBeGreaterThan(meta);
```

Because revision deletes are parallel, assert all three occur aftermain and beforemeta without asserting their internal order。Run this formain/raw/html/md/file/resource GET/read GET/read POST；API rows from Task3 may share a helper, not duplicate handler code。Injected render failure leaves allfive keys；any delete rejection returns503 `CONSUME_FAILED` withoutsource/body。

Run RED:

```powershell
npx vitest run src/http.test.ts -t "view-once order"
```

Expected RED: the first route-only GREEN does not yet prove preparation/deletion/return ordering or render-failure non-consumption；the spy assertions fail until the shared content-bearing response helper is used。

- [ ] **Step 4: Implement the remaining minimal GREEN content-bearing helper and exact `/ip-trace`**

Use one handler forGET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS：

```ts
const value = {
  url: request.url,
  method: request.method,
  data: await request.clone().text(),
  headers: Object.fromEntries(request.headers),
  cf: Object.fromEntries(Object.entries(request.cf ?? {})),
};
```

Serialize`JSON.stringify(value, null, 2)` without appended newline。Setexact headers `Content-Type: application/json; charset=utf-8`、`Access-Control-Allow-Origin: *`、`Access-Control-Allow-Headers: *`、`Access-Control-Allow-Methods: GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS`、`Cache-Control: no-store`，且不发送`Access-Control-Allow-Credentials`。Do not filter Authorization/Cookie/body/cf。HEAD browser removesbody；OPTIONS stillreturns200 per `/ip-trace` special contract。

- [ ] **Step 5: Close method/error/header matrix**

Tests must include malformed percent-decoded path400、decoded slash/extra segment404、legacy `/api` and `/delete/:id`404、all registered wrong methods405、retryable503 `Retry-After:1`、application error shell vsdirect plaintext error vsAPI JSON error、every dynamic response no-store。`/assets/missing-hash.js` GET/HEAD404 and wrong method405；existing static files remainCloudflare asset binding responsibility。

- [ ] **Step 6: Focused and full GREEN checks**

```powershell
npx vitest run src/http.test.ts -t "browser route matrix|password form|direct representation|ip-trace|view-once order|method and header matrix"
npx vitest run src/http.test.ts src/render.test.ts src/pastes.test.ts
npm run build
npx vitest run --testTimeout=600000
```

- [ ] **Step 7: Commit and independent review gate**

```powershell
git add src/http.ts src/http.test.ts
git commit -m "feat: complete browser paste routes"
```

Independent Opus review verifiesall route rows、page/direct/API error media types、HEAD/OPTIONS non-consumption、password encoding、prepared-body/delete/return ordering、active HTML exception和`/ip-trace` exact reflection。Only `APPROVED` commits integrate。

---

### Task 5: Move the Reviewed Autosave Controller Into Its Final Module

**Files:**
- Create: `src/client/autosave.ts`
- Create test: `src/client/autosave.test.ts`
- Modify: `src/client/app.ts`, `src/client/app.test.ts`（remove moved definitions/tests；temporary imperative callers importthe new module；Task8 deletes the remainder）

**Contract:** move—not reimplement—the existing `AutosaveController`, types, and `createAutosaveMarkdownModes`. Preserve its reviewed transition algorithms while making only the narrow final-contract adaptations required by Sections 17.6–17.10: `input`/committed `compositionEnd` receive the caller’s monotonic `eventAt`; each save request identifies its closed action; 403 and 404 receive their frozen status names; and a due `tryDispatch` may return `blocked`. A blocked controller remains `waiting`, emits one coalesced intent, and `slotAvailable()` retries the latest draft once. No React import.

```ts
export type AutosaveState =
  | "clean" | "waiting" | "saving" | "saved" | "error"
  | "password-required" | "not-found" | "conflict";

export interface AutosaveSaveRequest {
  action: "autosave" | "save-retry" | "overwrite";
  content: string;
  version?: string;
  password?: string;
}

export type AutosaveSaveResult =
  | { status: 200; changed: boolean; paste: PasteSummary }
  | { status: number; mutationMayHaveApplied?: boolean };

export interface AutosaveSnapshot {
  state: AutosaveState;
  draft: string;
  acceptedSource: string;
  lastSavedContent: string;
  version: string;
  lastInputAt: number | null;
  dueAt: number | null;
  inFlightContent: string | null;
  dirtyWhileSaving: boolean;
  failureStatus: number | null;
  requiresExplicitRetry: boolean;
  coalescedIntent: boolean;
}

export type AutosaveDispatch =
  | { kind: "started"; completion: Promise<AutosaveSaveResult> }
  | { kind: "blocked" };

export type AutosaveAuthoritativeTransition =
  | { kind: "replace"; acceptedSource: string; version: string }
  | { kind: "metadata"; acceptedSource: string; version: string }
  | { kind: "reconciled-applied"; acceptedSource: string; version: string }
  | { kind: "reconciled-not-applied"; acceptedSource: string; version: string }
  | {
      kind: "pause";
      state: "password-required" | "not-found" | "conflict";
      failureStatus: number | null;
    };

export interface AutosaveOptions {
  content: string;
  version: string;
  now(): number;
  setTimer(callback: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
  tryDispatch(request: AutosaveSaveRequest): AutosaveDispatch;
  onCoalescedIntent(): void;
  getPassword?(): string | null;
  onStateChange(snapshot: AutosaveSnapshot): void;
}

export interface AutosaveControllerApi {
  snapshot(): Readonly<AutosaveSnapshot>;
  input(content: string, eventAt: number): void;
  compositionStart(): void;
  compositionEnd(content: string, eventAt: number): void;
  retry(): void;
  overwrite(): void;
  applyAuthoritative(transition: AutosaveAuthoritativeTransition): void;
  slotAvailable(): void;
  dispose(): void;
}

export interface AutosaveMarkdownModesOptions
  extends Omit<MarkdownModesOptions, "onDocumentChange"> {
  autosave: Pick<AutosaveControllerApi, "input">;
  onCrepeChange(content: string, eventAt: number): void;
  now(): number;
}
```

The exported `AutosaveController` class implements `AutosaveControllerApi` and keeps its existing constructor shape updated to one `AutosaveOptions` object. Internally it stores exactly one accepted-source value; every snapshot projects that same value under both `acceptedSource` and the compatibility name `lastSavedContent`, and no transition may advance them separately. These aliases are not a second canonical page store: Task 10 owns authoritative `AcceptedPasteState`. In final Task 15 wiring, raw mutation completion first enters the page coordinator’s synchronous authoritative transition; only an accepted result is adapted to `AutosaveSaveResult` and released to the controller, and its `onStateChange` is folded into the same React coordinator action. A component render-log test must prove there is no rendered frame with a newly accepted page source/version and stale autosave acceptance, or the inverse.

- [ ] **Step 1: Move existing tests first and confirm RED**

Move the`AutosaveController` describe block and Markdown adapter tests from`app.test.ts` to`autosave.test.ts`，change imports to`./autosave`，then add:

```ts
it("coalesces one latest source intent while the page mutation slot is occupied", () => {
  const dispatches: AutosaveSaveRequest[] = [];
  let blocked = true;
  const coalesced = vi.fn();
  const fixture = autosaveFixture({
    tryDispatch(request) {
      if (blocked) return { kind: "blocked" };
      dispatches.push(request);
      return { kind: "started", completion: Promise.resolve({ status: 200, changed: true, paste: summary({ version: "g.2" }) }) };
    },
    onCoalescedIntent: coalesced,
  });
  fixture.controller.input("latest", 0);
  fixture.clock.advance(1_000);
  expect(dispatches).toEqual([]);
  expect(coalesced).toHaveBeenCalledTimes(1);
  blocked = false;
  fixture.controller.slotAvailable();
  expect(dispatches).toEqual([{ action: "autosave", content: "latest", version: "g.1" }]);
});

it("anchors debounce to the supplied monotonic event instant", () => {
  const { clock, controller, save, states } = setup();
  clock.advance(200);
  controller.input("second", 125);
  expect(lastState(states).dueAt).toBe(1_125);
  clock.advance(924);
  expect(save.calls).toEqual([]);
  clock.advance(1);
  expect(save.calls).toEqual([{ action: "autosave", content: "second", version: "g.1" }]);
});
```

While moving the reviewed cases, pass `clock.now()` to every ordinary `input` and committed `compositionEnd`; intermediate composition input still carries its actual event instant but must not update `lastInputAt` or `dueAt`.

Run RED:

```powershell
npx vitest run src/client/autosave.test.ts
```

Expected RED：`./autosave` 无法解析；移动前后产品行为不得改变。再加入表驱动测试，验证 403→`password-required`、404→`not-found`、409→`conflict`、413/422→`error`，并断言每次发出的 snapshot 都满足 `acceptedSource === lastSavedContent`。Replace the stale client-known no-op expectation with immediate `clean`, `dueAt:null`, and zero request; retain `saved` only for an authoritative local 200 whose acknowledged source equals the current draft. The moved Markdown adapter test must prove one real document transaction reads `now()` once and calls `onCrepeChange` before `autosave.input` with the identical source/instant, while init/focus/mode changes call neither. 为 `applyAuthoritative` 五个 union 分支加入表驱动状态测试，特别证明 `reconciled-applied` 才允许调用 `slotAvailable()` 发送 later draft，而 `reconciled-not-applied` 保持 explicit-retry `error` 且零自动 dispatch。

- [ ] **Step 2: Make the minimal GREEN move and add only the enumerated final-contract seams**

Preserve exact timer replacement, IME, one in-flight, server-acknowledged no-op, 403/404/409, Retry/Overwrite, beforeunload, and dispose semantics from the reviewed source; the binding spec supersedes the old client-known no-op label, so a draft equal to accepted source cancels its timer immediately and is `clean`, never `saved`. For non-composition input and committed composition end, set `lastInputAt=eventAt`, `dueAt=eventAt+1_000`, and schedule `max(0, dueAt-now())`; intermediate composition input updates only the draft. A proven 413/422 sets `requiresExplicitRetry=true`; later input/composition updates the draft and event fields but arms no timer until `retry()`. The same flag is true for 403 and `reconciled-not-applied`, while an uncertain content result leaves it false because the occupied page slot—not a second autosave policy—blocks the due/coalesced attempt pending explicit Content Reconcile. `retry()` attempts only from `error` or `password-required` with this flag; the page adapter returns `blocked` when version is unusable, reconciliation is active, or the slot is occupied. A blocked explicit Retry/Overwrite restores its prior state and emits no coalesced intent, whereas only a blocked timer-driven autosave creates that intent. Timer-driven and coalesced dispatches use `action:"autosave"`, explicit `retry()` uses `action:"save-retry"`, and `overwrite()` uses `action:"overwrite"`; `version` is omitted if and only if the action is `overwrite`. `createAutosaveMarkdownModes` preserves the reviewed Crepe document-change filter and changes only its accepted callback to capture `const eventAt=now()` once, call `onCrepeChange(markdown,eventAt)` first, then call `autosave.input(markdown,eventAt)`, so focus, initialization, and mode switches still schedule nothing. `applyAuthoritative` is called only after Task 10 has accepted the same transition: `replace` sets accepted source, draft, and version together and enters timestamp-free `clean`; `metadata` requires its accepted source to equal the existing alias, updates the mutation version without replacing a later draft, clears an external pause, and restores/schedules the underlying clean/saved/waiting state from the preserved due/coalesced data; `reconciled-applied` advances accepted source/version while preserving a later draft and enters `saved` when equal or non-dispatching `waiting` when different; `reconciled-not-applied` advances the proved server baseline/version, preserves draft and the original `failureStatus` (the page coordinator separately preserves its `failedAt`), cancels automatic dispatch, and remains explicit-retry `error`; `pause` preserves source/draft/version, cancels timers, and sets only the named status/failure. Only the caller invokes `slotAvailable()` after a reconciled-applied or ordinary slot release; it must not invoke it for proved-not-applied, conflict, terminal, or still-reconciling results. Delete the moved declarations from `app.ts` and import them from `./autosave` wherever its temporary startup still calls them; delete the moved describe blocks from `app.test.ts`. A symbol/content search must find each implementation/test case in exactly one file. `tryDispatch.kind="blocked"` must not set `inFlightContent` or `state="saving"`; call `onCoalescedIntent` once per blocked due, and `slotAvailable` starts only when the draft differs from accepted source and no timer/in-flight/conflict/terminal blocker exists.

- [ ] **Step 3: Focused and full GREEN checks**

```powershell
npx vitest run src/client/autosave.test.ts
npx vitest run src/client/app.test.ts src/client/markdown.test.ts src/client/diff.test.ts
npm run build
npx vitest run --testTimeout=600000
```

The moved autosave suite and the remaining imperative-app suite both pass temporarily. No test or implementation exists in both files; Task 8 deletes only the residual imperative entry tests after proving every reusable describe block was moved.

- [ ] **Step 4: Commit and independent review gate**

```powershell
git add src/client/autosave.ts src/client/autosave.test.ts src/client/app.ts src/client/app.test.ts
git commit -m "refactor: extract reviewed autosave controller"
```

Independent Opus compares exports/transition tests againstcurrent`app.ts`，verifiesonly slot seam changed andgenerated 200-input maximum concurrency remains1。`APPROVED` required。

---

### Task 6: Establish Exact Client Contracts, Bootstrap, API, Theme, and Credential Boundaries

**Files:**
- Create: `src/client/contracts.ts`
- Create: `src/client/bootstrap.ts`, `src/client/bootstrap.test.ts`
- Create: `src/client/api.ts`, `src/client/api.test.ts`
- Create: `src/client/theme.ts`, `src/client/theme.test.ts`
- Modify: `src/client/app.ts`, `src/client/app.test.ts`（remove migrated bootstrap/password/theme definitions/tests andimportnew modules；Task8 deletes theremainder）

**Dependency:** approved Task 5，because this serial extraction writes the sameold app/test boundary。

- [ ] **Step 1: Write RED bootstrap shape/cardinality tests**

Define a tinyfake document fixture with`querySelectorAll` returning explicit arrays。Tests cover everybootstrap row and:

```ts
it("removes every inert node after an exact CR/CRLF source is extracted", () => {
  const fixture = pageFixture({
    bootstrap: { page: "paste", locale: "en", paste: summary({ format: "text" }), consumed: false },
    sources: [encodeSourceData("a\r\nb\rc\n")],
    previews: [],
  });
  const result = extractInitialPage(fixture.document, new URL("https://paste.test/id?x=1&password=a%2Bb#frag"));
  expect(result).toMatchObject({ ok: true, exactSource: "a\r\nb\rc\n", password: "a+b" });
  expect(fixture.removeCalls()).toEqual(["bootstrap", "source-data"]);
});

it.each([
  ["missing ordinary source", 0, 0],
  ["duplicate ordinary source", 2, 0],
  ["unexpected text preview", 1, 1],
])("fails closed for %s", (_name, sourceCount, previewCount) => {
  const result = extractInitialPage(pageFixture({
    bootstrap: { page: "paste", locale: "en", paste: summary({ format: "text" }), consumed: false },
    sourceCount,
    previewCount,
  }).document, new URL("https://paste.test/id"));
  expect(result).toEqual({ ok: false, locale: "en", errorCode: "INTERNAL_ERROR" });
});
```

Also rejectunknown bootstrap fields、wrong primitive/summary/link、duplicate DOM IDs、source decode failure、preview cardinality mismatch andduplicate password query。On all failures removeall inert transport nodes and never expose encoded text in visible DOM。

Run RED:

```powershell
npx vitest run src/client/bootstrap.test.ts
```

Expected RED: `./bootstrap` cannot resolve；the extraction assertions cannot pass beforethe module exists。

- [ ] **Step 2: Implement the minimal GREEN bootstrap result and URL helpers**

```ts
export type TrustedMarkdownHtml = string & { readonly __trustedMarkdownHtml: unique symbol };

export type InitialPage =
  | { ok: true; bootstrap: Extract<AppBootstrap, { page: "create" | "password" | "error" }>; password: null }
  | { ok: true; bootstrap: Extract<AppBootstrap, { page: "paste" | "markdown" }>; exactSource: string; initialMarkdown: TrustedMarkdownHtml | null; password: string | null }
  | { ok: false; locale: Locale; errorCode: "INTERNAL_ERROR" };

export function withPastePassword(target: URL, password: string | null): URL {
  const result = new URL(target.href);
  result.searchParams.delete("password");
  if (password !== null) result.searchParams.set("password", password);
  return result;
}
```

`extractInitialPage`手写exact-key/primitive checks，不能import Zod进initial browser graph。It reads and removesbootstrap/source/template beforeReact mount；onlytemplate.innerHTML crosses the branded boundary。Onlyvalidated`paste`/`markdown` variants retain the unique decoded query password；create/password/error returnliteral null evenifthe current URL contains one。`commitPastePassword` performs`history.replaceState(null,"",relativePathWithQueryAndFragment)` and preservesnon-password query/fragment。

- [ ] **Step 3: Write RED thin API adapter tests**

Inject`fetch` and Web Crypto；assert exact request shapes、`cache:"no-store"`、AbortSignal、body credential only whennon-null、GET query via`withPastePassword`、no storage/log calls。For resource 200, test fatal UTF-8, exact 43-character SHA-256 verification, unknown/missing fields, ID/link/contentBytes/version/timestamp rejection, exact JSON media type, and `no-store`. A 304 is accepted only when the request supplied a non-null identical strong validator, the response repeats it with `no-store`, and body/Content-Type/Content-Length/trailers are absent; otherwise return a decoded failure rather than inventing an unchanged snapshot. For errors accept only `{error:{code,message,details?}}` with the route’s exact media/cache headers.

```ts
export type ApiFailure =
  | {
      kind: "http";
      status: number;
      code: ErrorCode;
      details?: Record<string, unknown>;
      mutationMayHaveApplied: boolean | null;
    }
  | {
      kind: "network";
      status: null;
      code: "NETWORK_ERROR";
      mutationMayHaveApplied: boolean;
    }
  | {
      kind: "malformed";
      status: number | null;
      code: "MALFORMED_RESPONSE";
      mutationMayHaveApplied: boolean;
    };

export type ApiResult<T> =
  | { ok: true; status: number; value: T; etag: string | null }
  | { ok: false; failure: ApiFailure };

export type ResourceReadResult =
  | { kind: "snapshot"; snapshot: RemoteSnapshot }
  | { kind: "not-modified"; etag: `"sha256-${string}"` }
  | { kind: "failure"; failure: ApiFailure };

export interface CreateRequest {
  content: string;
  title: string;
  format: "text" | "markdown";
  expiration: ExpirationInput;
  password: string;
  viewOnce: boolean;
  customId?: string;
}

export type SettingsChange =
  | { field: "title"; value: string }
  | { field: "format"; value: "text" | "markdown" }
  | { field: "expiration"; value: ExpirationInput }
  | { field: "viewOnce"; value: boolean };

export interface PasteApi {
  create(input: CreateRequest, signal: AbortSignal): Promise<ApiResult<PasteSummary>>;
  readResource(input: { id: string; password: string | null; ifNoneMatch: `"sha256-${string}"` | null; signal: AbortSignal }): Promise<ResourceReadResult>;
  saveContent(input: { id: string; content: string; password: string | null; version: string | null; signal: AbortSignal }): Promise<ApiResult<MutationResult>>;
  getSettings(input: { id: string; password: string | null; signal: AbortSignal }): Promise<ApiResult<PasteSummary>>;
  updateSettings(input: { id: string; change: SettingsChange; password: string | null; version: string; signal: AbortSignal }): Promise<ApiResult<MutationResult>>;
  updatePassword(input: { id: string; password: string | null; newPassword: string; version: string; signal: AbortSignal }): Promise<ApiResult<MutationResult>>;
  clearPassword(input: { id: string; password: string | null; version: string; signal: AbortSignal }): Promise<ApiResult<MutationResult>>;
  deletePaste(input: { id: string; password: string | null; version: string; signal: AbortSignal }): Promise<ApiResult<null>>;
  listHistory(input: { id: string; password: string | null; signal: AbortSignal }): Promise<ApiResult<HistoryList>>;
  getHistory(input: { id: string; revision: number; password: string | null; signal: AbortSignal }): Promise<ApiResult<RevisionResource>>;
}
```

Run the API RED beforeimplementation：

```powershell
npx vitest run src/client/api.test.ts -t "selects create encoding|validates resource digest|encodes credentials"
```

Expected RED: `./api` cannot resolve。

For an HTTP error, `mutationMayHaveApplied` is the strict boolean from error details when present and `null` otherwise; controller result tables still classify proven 4xx before consulting it. A read-side network/malformed failure sets it to `false`. Once a mutation fetch is dispatched, network rejection or any malformed success/error response sets it to `true`, forcing the corresponding reconciliation/uncertain path; `AbortError` from a retired token is classified by the owning controller and never surfaced as a current failure.

Each method accepts only its documented success status/media/body cardinality. Create, `MutationResult`, settings, and history-list ETags must be a quoted mutation token equal to `paste.version` or `currentVersion` in the validated body; history-snapshot ETag must be a syntactically valid quoted current mutation token; delete accepts only an empty 204 with no invented value. Minimal GREEN implements an exact `PasteApi` object with methods `create`、`readResource`、`saveContent`、`getSettings`、`updateSettings`、`updatePassword`、`clearPassword`、`deletePaste`、`listHistory`、`getHistory`。No method names another endpoint；Reload/Reconcile call`readResource` with`ifNoneMatch:null`。`create` serializes the exact JSON object first andcomputes its UTF-8 wire bytes；at`<= 62_914_560` bytes（60MiB）it sendsJSON，above that threshold it sendsmultipart withcontent/title/format/expiration/password/viewOnce exactlyonce andcustomId exactlyonce onlywhen theoptional field ispresent；`viewOnce` isalways explicit。Exposepure`selectCreateEncoding(jsonWireBytes)` andtest62,914,559/62,914,560/62,914,561-byte boundaries；server’s64MiBwire and10MiBdecoded limits remain authoritative。

- [ ] **Step 4: Move and expand the document-only theme controller**

Exact final API:

```ts
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export interface ThemeSnapshot { preference: ThemePreference; resolved: ResolvedTheme }
export interface ThemeController {
  snapshot(): ThemeSnapshot;
  setPreference(preference: ThemePreference): void;
  dispose(): void;
}
```

Initial preference=`system`；system listener always installed once, but onlyapplies whilepreference system；switch back reads current`matches` immediately；updates root`data-theme` and`style.colorScheme`；no storage。Tests mount/dispose twice and inspect listener counts。Afterbootstrap/password/theme tests areGREEN，delete their olddefinitions anddescribe blocks from`app.ts`/`app.test.ts`，importthe newpure modules inremainingtemporary startup，andsearch toproveone implementation/case perbehavior。The newAPI adapter hasnoold duplicate。

- [ ] **Step 5: Focused and full GREEN checks**

```powershell
npx vitest run src/client/bootstrap.test.ts src/client/api.test.ts src/client/theme.test.ts src/source-data.test.ts src/i18n.test.ts
npm run build
npx vitest run --testTimeout=600000
```

- [ ] **Step 6: Commit and independent review gate**

```powershell
git add src/client/contracts.ts src/client/bootstrap.ts src/client/bootstrap.test.ts src/client/api.ts src/client/api.test.ts src/client/theme.ts src/client/theme.test.ts src/client/app.ts src/client/app.test.ts
git commit -m "refactor: define client transport boundaries"
```

Independent Opus reviews exact-key validation、inert-node cleanup、no secret leakage、hash/schema validation、request carrier precedence、AbortSignal、theme lifecycle and initial bundle avoidance ofZod。Only `APPROVED` integrates。

---

### Task 7: Move Diff Lifecycle and Add History Request Epoch Arbitration

**Files:**
- Create: `src/client/history.ts`
- Create test: `src/client/history.test.ts`
- Modify: `src/client/app.ts`, `src/client/app.test.ts`（remove moved history/diff bridge definitions/tests andimportthe new module）
- Keep: `src/client/diff.ts`, `src/client/diff.test.ts`

**Dependency:** approved Task 6, because `BaselineCapture` has one canonical definition in `src/client/contracts.ts`; `HistoryFailure` uses only a type-only `ApiFailure` import, never the API runtime.

**Contract:** move reviewed`createHistoryDiff`、threshold constants and`formatHistoryDiffLine` out ofold app。Add one history controller that owns list/snapshot tokens andbaseline captures；it neverowns current paste mutation。

```ts
export interface HistoryFailure {
  status: number | null;
  code: ApiFailure["code"];
}

export interface HistoryControllerSnapshot {
  epoch: number;
  listState: "idle" | "loading" | "ready" | "failed" | "stale";
  snapshotState: "idle" | "loading" | "ready" | "failed";
  list: HistoryList | null;
  selected: RevisionResource | null;
  failure: { target: "list" | "snapshot"; value: HistoryFailure } | null;
}

export interface HistoryController {
  snapshot(): Readonly<HistoryControllerSnapshot>;
  open(capture: BaselineCapture): { token: number; signal: AbortSignal };
  acceptList(token: number, capture: BaselineCapture, value: HistoryList): boolean;
  failList(token: number, capture: BaselineCapture, failure: HistoryFailure): boolean;
  select(revision: number, capture: BaselineCapture): { token: number; signal: AbortSignal };
  acceptSnapshot(token: number, capture: BaselineCapture, value: RevisionResource): boolean;
  failSnapshot(token: number, capture: BaselineCapture, failure: HistoryFailure): boolean;
  invalidate(reason: "remote-apply" | "reload" | "mutation" | "terminal" | "delete"): void;
  retainAfterApply(previous: BaselineCapture, next: BaselineCapture): "all" | "snapshot-only" | "none";
  destroy(): void;
}
```

- [ ] **Step 1: Move RED diff tests and add reverse-settle races**

Change imports from`./app` to`./history` before source exists。Add controllablepromise tests：list started atG1 thenremote applyG2；snapshot1 thenselection2 resolvesreverse；settings-only version change retains settled history；same generation contentRevision change markslist stale but retains identifiable immutable snapshot；generation change clearsall。Late response returnsfalse and leavesstate unchanged。

```ts
it("drops a snapshot that resolves after accepted current content changes", () => {
  const controller = createHistoryController();
  const g1 = baseline({ version: "g.1", contentRevision: 1, acceptedSource: "one" });
  const request = controller.select(1, g1);
  controller.invalidate("remote-apply");
  const accepted = controller.acceptSnapshot(request.token, g1, revision({ revision: 1, content: "old" }));
  expect(accepted).toBe(false);
  expect(controller.snapshot().selected).toBeNull();
});
```

Run RED:

```powershell
npx vitest run src/client/history.test.ts
```

Expected RED: `./history` cannot resolve，so moved diff andnew arbitration assertions cannot run。

- [ ] **Step 2: Make the minimal GREEN move and add exact token checks**

Each list/snapshot request captures separate monotonic token, shared epoch, and full `BaselineCapture`. `accept*` and `fail*` require token, epoch, and every capture field exact; accepted/failure callbacks return `false` without changing even loading/settled presentation when stale.`invalidate` aborts current request and increments epoch but does not convertlate response toempty/error。Diff lines staytext records withvisible prefix；worker created onlyautomatic/explicit policy allows andterminated ondestroy。Delete moveddefinitions/tests from`app.ts`/`app.test.ts`，import`createHistoryDiff` intheremaining temporary caller，andsearch toproveexactlyone copy。

- [ ] **Step 3: Focused and full GREEN checks**

```powershell
npx vitest run src/client/history.test.ts src/client/diff.test.ts
npx vitest run src/client/app.test.ts src/client/markdown.test.ts
npm run build
npx vitest run --testTimeout=600000
```

- [ ] **Step 4: Commit and independent review gate**

```powershell
git add src/client/history.ts src/client/history.test.ts src/client/app.ts src/client/app.test.ts
git commit -m "refactor: extract history lifecycle arbitration"
```

Independent Opus compares moved diff behavior and verifiesfull baseline equality、reverse settle、retain rules、worker cleanup and noHTML insertion。`APPROVED` required。

---

### Task 8: Adopt React 19, Vite 8, Tailwind 4, and the Pinned shadcn Source

**Files:**
- Modify: `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `scripts/build.mjs`, `src/build.test.ts`, `src/generated/assets.ts`
- Create: `index.html`, `vite.config.ts`, `components.json`
- Create: `src/client/main.tsx`, `src/client/App.tsx`, `src/client/index.css`
- Create pinned source: the exact UI primitive files and`src/client/hooks/use-mobile.tsx` fromthe final file map；adapt pinned block`page.tsx` composition into`src/client/App.tsx`；Task 11 exclusively creates the product`app-sidebar.tsx` adaptation
- Delete: `src/client/app.ts`, `src/client/app.test.ts`, `src/client/styles.css`
- Modify move target: `src/client/history.ts`（replace compile-time global worker URL withVite `new URL` form）

- [ ] **Step 1: Write RED package/build contract**

Update`src/build.test.ts` first witha real manifest test（add`readFile` from`node:fs/promises` and`existsSync` from`node:fs`）：

```ts
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
```

Run RED:

```powershell
npx vitest run src/build.test.ts -t "pins the React Vite Tailwind toolchain"
```

Expected RED: current package lacksReact/Vite/Tailwind and stilllistsesbuild。

- [ ] **Step 2: Make the minimal GREEN package/lockfile change with exact versions**

Use this exactpackage shape；existing name/private/type remain：

```json
{
  "engines": { "node": ">=22.12.0" },
  "dependencies": {
    "@milkdown/crepe": "7.22.1",
    "@modelcontextprotocol/server": "2.0.0",
    "class-variance-authority": "0.7.1",
    "cn": "0.3.0",
    "diff": "8.0.2",
    "hono": "4.13.7",
    "lucide-react": "1.45.0",
    "micromark": "4.0.2",
    "micromark-extension-gfm": "3.0.0",
    "radix-ui": "1.6.7",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "tw-animate-css": "1.4.0",
    "zod": "4.6.4"
  },
  "devDependencies": {
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
    "tailwindcss": "4.3.3",
    "typescript": "7.0.2",
    "vite": "8.3.0",
    "vitest": "4.1.11",
    "wrangler": "4.131.1"
  }
}
```

Scripts must be:

```json
{
  "build:client": "node scripts/build.mjs",
  "build": "npm run build:client && tsc --noEmit",
  "typecheck": "npm run build:client && tsc --noEmit",
  "test": "npm run build:client && vitest run",
  "test:e2e": "playwright test",
  "dev:local": "wrangler dev --local --port 8787 --show-interactive-dev-session=false",
  "dev:e2e": "npm run build && wrangler dev --local --port 8787 --show-interactive-dev-session=false",
  "smoke": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke.ps1",
  "verify": "npm run build && vitest run && playwright test && node scripts/browser-evidence.mjs self-test && node scripts/verify-release-evidence.mjs --self-test && node scripts/verify-release-evidence.mjs && npm run smoke && wrangler types --check && wrangler deploy --dry-run --outdir .wrangler-dist"
}
```

Run`npm install --package-lock-only` then`npm ci`。Both root package entries and `node_modules/@axe-core/playwright` lock entry must pin4.13.0；the lock assertion recordsMPL-2.0 andnormalizes whitespace beforecheckingpeer`playwright-core >=1.0.0`。It is the sole direct axe/accessibility runner；do not add`axe-playwright`、`jest-axe` oranother runner。Retain the`react-hook-form`/`@hookform/resolvers` ban anddo notplan`useForm`、`Controller` or`zodResolver`。Do not add`shadcn` as dependency；one-time materialization uses`npx shadcn@4.21.0` only against acheckout of thepinned commit, never thelive registry head。

- [ ] **Step 3: Materialize the exact source set from the pinned commit**

`components.json` records `$schema:"https://ui.shadcn.com/schema.json"`, `style:"new-york-v4"`, `rsc:false`, `tsx:true`, Tailwind CSS path `src/client/index.css` with CSS variables enabled and no config file, icon library `lucide`, plus local aliases `@/components`, `@/components/ui`, and `@/hooks`; it contains no live registry override and is never read by the normal build. Source identity：repository`shadcn-ui/ui`，commit`2b3e6d4f8d9161fe5c19340dc383aade392012dd`，style`new-york-v4`，block`sidebar-11`。The two block source paths are exact：

```text
apps/v4/registry/new-york-v4/blocks/sidebar-11/page.tsx
apps/v4/registry/new-york-v4/blocks/sidebar-11/components/app-sidebar.tsx
```

Task 8 adapts the first path’s`SidebarProvider`/`SidebarInset`/header/Breadcrumb/Separator composition into`src/client/App.tsx`；it doesnot copy a local`page.tsx`。Task 11 alone adapts the second path into`src/client/components/app-sidebar.tsx`，so no sample tree orintermediate product sidebar entersTask8。Both local files start with:

```ts
// Derived from shadcn-ui/ui new-york-v4/sidebar-11 at 2b3e6d4f8d9161fe5c19340dc383aade392012dd; MIT; see THIRD_PARTY_NOTICES.md.
```

Task 8 materializes only these exact registry sources into thecorresponding`src/client/components/ui/*.tsx` orhook path：

```text
apps/v4/registry/new-york-v4/ui/sidebar.tsx
apps/v4/registry/new-york-v4/ui/sheet.tsx
apps/v4/registry/new-york-v4/ui/breadcrumb.tsx
apps/v4/registry/new-york-v4/ui/collapsible.tsx
apps/v4/registry/new-york-v4/ui/dialog.tsx
apps/v4/registry/new-york-v4/ui/tooltip.tsx
apps/v4/registry/new-york-v4/ui/tabs.tsx
apps/v4/registry/new-york-v4/ui/field.tsx
apps/v4/registry/new-york-v4/ui/label.tsx
apps/v4/registry/new-york-v4/ui/input.tsx
apps/v4/registry/new-york-v4/ui/textarea.tsx
apps/v4/registry/new-york-v4/ui/button.tsx
apps/v4/registry/new-york-v4/ui/separator.tsx
apps/v4/registry/new-york-v4/hooks/use-mobile.tsx
```

Each primitive starts with the same provenance sentence butreplaces`sidebar-11` withits exact registry component name；the hook comment is exactly`// Derived from shadcn-ui/ui apps/v4/registry/new-york-v4/hooks/use-mobile.tsx at 2b3e6d4f8d9161fe5c19340dc383aade392012dd; MIT; see THIRD_PARTY_NOTICES.md.`。Delete`SidebarMenuSkeleton` export andits`Skeleton` import fromsidebar；do notcreate`skeleton.tsx`。No unlisted registry component/source/sample data may enter thetree。

- [ ] **Step 4: Configure Vite/Tailwind and deterministic projection**

`index.html` exactbody：

```html
<div id="app"></div>
<script type="module" src="/src/client/main.tsx"></script>
```

`vite.config.ts` uses `react()` and `tailwindcss()`, sets `publicDir:false`, and uses `build.outDir="dist/assets"`、`assetsDir="assets"`、`manifest:true`、`sourcemap:false`、`cssCodeSplit:true`。Rollup names：app entry`assets/app-[hash].js`，otherchunks`assets/[name]-[hash].js`，CSS entry`assets/app-[hash].css`。Worker config usesES format and`assets/diff-[hash].js`。No proxy、SSR、RSC或router config。

`history.ts` constructs worker only whenneeded：

```ts
new Worker(new URL("./diff.ts", import.meta.url), { type: "module" });
```

`src/client/index.css` begins with `@import "tailwindcss";` and `@import "tw-animate-css";`; it contains only application-owned Crepe/prose/diff token overrides and does not import any `@milkdown` stylesheet. It then maps exact light values`--canvas/#F3F6F8`、`--surface/#FFFFFF`、`--ink/#18212B`、`--muted/#526171`、`--rule/#C8D2DC`、`--signal/#2855A6`、`--on-signal/#FFFFFF`、`--positive/#176B4D`、`--danger/#A9213D`、`--on-danger/#FFFFFF` to shadcn background/card/popover/sidebar/foreground/muted/border/input/primary/ring/destructive variables。Dark values are`#121820/#1B2430/#EDF2F7/#A8B4C2/#394858/#8EAEFF/#101722/#72D2AA/#FF8CA3/#1B0B10` inthesame order。Radius isatmost6px。Body uses`16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif`；labels14px/1.4；metadata/status13px/1.45；source/diff/ID/version15px/1.62`ui-monospace,"SFMono-Regular",Consolas,"Liberation Mono",monospace`；title`clamp(1.35rem,2.5vw,1.9rem)/1.2` weight650。OnlyTabs/Sheet/Dialog/status color transitions mayreach120ms；`prefers-reduced-motion:reduce` setsall animation/transition durations anddelays to0。No old selector names arecopied。

`scripts/build.mjs` removes only`dist/assets`，invokesVite JS API，reads`dist/assets/.vite/manifest.json`，requiresone`index.html` entry、oneentry CSS andone`diff-[hash].js`，atomically writesresolved`src/generated/assets.ts`，writesimmutable`_headers`，then deletesemitted`index.html` and`.vite` directory。Finaldeploy directory contains `_headers` pluscontent-hashed files only。

- [ ] **Step 5: Configure TS and three Vitest projects**

Add`jsx:"react-jsx"` and exact aliases for`@/components/* -> src/client/components/*`、`@/hooks/* -> src/client/hooks/*`。`vitest.config.ts` exports a workspace with three non-overlapping projects: `workers` includes only `src/http.test.ts` and alone installs `cloudflareTest({wrangler:{configPath:"./wrangler.jsonc"}})`; `node` includes `src/**/*.test.ts` and excludes `src/http.test.ts` plus every `*.browser.test.tsx`; `browser` includes `src/**/*.browser.test.tsx`, enables headless Chromium through `@vitest/browser-playwright`, and installs no Worker plugin. All projects share the repository aliases but not environment plugins. Thus plain `npx vitest run` executes all three exactly once, and every focused file command selects its sole owning project.

- [ ] **Step 6: Implement the permanent entry and initial semantic branch shell**

`main.tsx` imports`./index.css` andcalls`extractInitialPage(document,new URL(location.href))` before`createRoot`，then exactlyonce：

```tsx
const mount = document.querySelector<HTMLDivElement>("#app");
if (mount === null) throw new Error("Missing application root");
createRoot(mount).render(<App initialPage={initialPage} />);
```

`App.tsx` uses an exhaustive switch andat this task renders one semantic`<main><h1>` for each valid branch andthe localized application error forshape failure；no explanation/sample/filler copy。Tasks11/15 extend this same switch，不替换entry contract。

- [ ] **Step 7: Delete obsolete mixed entry only after moved tests are accounted for**

Account for every remainingdescribe block inold`app.test.ts`：headless autosave/bootstrap/theme/history behavior already moved byTasks5/6/7；pure locale behavior remains in`i18n.test.ts`；selector/startup/visible-markup assertions arestale implementation tests andmust be deleted rather thanported。Then deleteold app/test/styles。Search must find no`hydratePasteSource`、document-wide`data-i18n` scanner、module-global`pastePassword/pasteContent`或`__DIFF_WORKER_URL__`。LaterTasks11-15 addReact-observable locale/startup/page behavior tests withoutretaining oldselectors。

- [ ] **Step 8: Focused and full GREEN checks**

```powershell
npm ci
npm run build:client
npx vitest run src/build.test.ts src/client/autosave.test.ts src/client/bootstrap.test.ts src/client/api.test.ts src/client/theme.test.ts src/client/history.test.ts
npm run typecheck
npx vitest run --testTimeout=600000
```

Inspectbuilt files：initial app graph hasReact/shadcn shell but noMilkdown/micromark/diff code；emittedindex andraw Vite manifest areabsent fromdeploy tree；generated paths resolve tofiles。

- [ ] **Step 9: Commit and independent review gate**

```powershell
git add package.json package-lock.json tsconfig.json vitest.config.ts index.html vite.config.ts components.json scripts/build.mjs src/build.test.ts src/generated/assets.ts src/client
git commit -m "build: adopt React Vite shadcn client"
```

Independent Opus comparescopied source identity/path/comments、dependency pins、the sole `@axe-core/playwright@4.13.0` package/lock entry and peer metadata、continued form-package ban、pruned skeleton、Vite manifest projection、test project coverage、deleted obsolete ownership andlazy graph。No notices waiver is allowed；Task17 completesfull texts，but Task8 source comments already point tofinalnotice path。Only`APPROVED` integrates。

---

### Task 9: Implement the Exact Ordinary-Page Autosync Scheduler

**Files:**
- Create: `src/client/paste-sync.ts`
- Create test: `src/client/paste-sync.test.ts`

**Interfaces:**

```ts
export interface PasteSyncCapture {
  phase: PastePhase;
  activeUntil: number;
  locallyClean: boolean;
  offline: boolean;
  localGeneration: number;
  acceptedApplyGeneration: number;
  baseline: BaselineCapture;
  responseEtag: `"sha256-${string}"` | null;
}

export type PasteSyncEvent =
  | { type: "state"; state: AutosyncStatus; at: number | null }
  | { type: "unchanged"; etag: `"sha256-${string}"`; checkedAt: number }
  | { type: "proven-newer"; snapshot: RemoteSnapshot; capture: PasteSyncCapture; checkedAt: number }
  | { type: "candidate"; snapshot: RemoteSnapshot; capture: PasteSyncCapture; checkedAt: number }
  | { type: "terminal-view-once"; snapshot: RemoteSnapshot; capture: PasteSyncCapture; ordinaryTokenCurrent: boolean; receivedAt: number }
  | { type: "credential-proved"; password: string; at: number }
  | { type: "not-found" | "forbidden" | "conflict" | "error"; at: number };

export interface PasteSyncController {
  start(loadAt: number): void;
  recordUserActivity(activityAt: number): void;
  localWorkChanged(): void;
  localWorkSettled(settledAt: number): void;
  setOnline(online: boolean, eventAt: number): void;
  keepCurrent(actionAt: number): void;
  retrySync(actionAt: number, pendingCredential: string | null): boolean;
  dispose(): void;
}
```

Constructor options injectmonotonic `now`、timer、AbortController、`capture()`、`read({ifNoneMatch,password,signal})` and`emit`。`classifyRemote` is pure andcompares exactthree markers asbinding spec17.8。

- [ ] **Step 1: Write fake-clock RED timing tests**

Use one deterministic clock andcontrollable read promise。Exact assertions：load+2,999 no request；+1 exactlyone；settle+2,999 none；+1 one；299,999 maydispatch whenpredicate true；300,000 turnsinactive anddispatchesnone。Request duration pushes nextdue fromsettle。No user activity window withinstant responses produces exactly99 GETs at3,000..297,000。

```ts
it("uses one timer for cadence and the exclusive active deadline", async () => {
  const fixture = syncFixture({ loadAt: 0 });
  fixture.clock.advance(2_999);
  expect(fixture.reads).toHaveLength(0);
  fixture.clock.advance(1);
  expect(fixture.reads).toHaveLength(1);
  fixture.resolve304(0, '"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
  await fixture.flush();
  fixture.clock.advance(296_999);
  expect(fixture.lastState()).not.toBe("inactive");
  fixture.clock.advance(1);
  expect(fixture.lastState()).toBe("inactive");
  expect(fixture.activeTimerCount()).toBe(0);
});
```

Run RED:

```powershell
npx vitest run src/client/paste-sync.test.ts -t "exclusive active deadline|99 GETs|single timer"
```

Expected RED: `./paste-sync` cannot resolve；the fake clock therefore records no valid scheduler transitions。

- [ ] **Step 2: Implement the minimal GREEN one-timer/one-fetch scheduler and exact activity rules**

Only`recordUserActivity` sets`activeUntil=activityAt+300_000`。`localWorkChanged` cancels cadence、aborts/retirestoken andkeepsdeadline timer；composition intermediate callers nevercallrecord activity。Dispatch capturesall fields, clears`syncDueAt` andimmediately armsdeadline。Settle schedules`settledAt+3_000` onlyifeligible；noimmediate retry loop。

- [ ] **Step 3: Write and implement ordering/candidate/HTTP/offline RED matrix**

Table cases：304；200 exact unchanged；definitely older/newer；marker-equal divergent；mixed marker；different generation；legacy exact/divergent；403/404/409/503；online network rejection；AbortError retired；offline→online。Only definitely-newer emitsproven-newer。All divergent emitscandidate；repeated same candidate remainscandidate。Keep current dismisses andarms+3,000；Retry arms+3,000 andnextrequest hasnovalidator；neither extendsdeadline。Offline clears candidate and due, online waits a full 3,000 ms. After exact inactivity, Retry/button/settle cannot reopen the window; a later genuine `recordUserActivity(eventAt)` alone sets `activeUntil=eventAt+300_000`, and only after current local work becomes clean may it establish a full `settledAt+3_000` due.

- [ ] **Step 4: Prove retired view-once precedence**

Startread，then independently triggeredit、mutation invalidation、offline andexactdeadline before resolving acomplete valid`viewOnce:true` snapshot。Each emits exactlyone`terminal-view-once` with`ordinaryTokenCurrent:false` andneverupdatescadence/baseline。Abort/truncated/digest/schema errors fromAPI adapter do not emitterminal。Concurrent timer/fetch counters stay≤1。

- [ ] **Step 5: Focused and full GREEN checks**

```powershell
npx vitest run src/client/paste-sync.test.ts
npm run build
npx vitest run --testTimeout=600000
```

- [ ] **Step 6: Commit and independent review gate**

```powershell
git add src/client/paste-sync.ts src/client/paste-sync.test.ts
git commit -m "feat: add deterministic paste autosync"
```

Independent Opus checksall clock boundaries、99 ceiling、single timer/fetch、abort token、candidate rules、credential proof、offline andterminal precedence。`APPROVED` required。

---

### Task 10: Coordinate Page Mutations, Reconciliation, Terminal State, and Staged Surfaces

**Files:**
- Create: `src/client/paste-controller.ts`
- Create test: `src/client/paste-controller.test.ts`
- Create: `src/client/surface-apply.ts`
- Create test: `src/client/surface-apply.test.ts`

**Consumes:** immutable unions fromTask6；noReact import、fetch或DOM query。

**Exact mutation state:**

```ts
export type MutationIntent =
  | { kind: "content"; action: "autosave" | "manual-save" | "save-retry" | "overwrite"; content: string; omitVersion: boolean }
  | { kind: "settings-title"; action: "settings-title" | "settings-reconcile"; title: string }
  | { kind: "settings-format"; action: "settings-format" | "settings-reconcile"; format: "text" | "markdown" }
  | { kind: "settings-expiration"; action: "settings-expiration" | "settings-reconcile"; expiration: ExpirationInput }
  | { kind: "settings-view-once"; action: "settings-view-once" | "settings-reconcile"; viewOnce: boolean }
  | { kind: "password-set"; action: "password-set" | "password-reconcile"; newPassword: string; authorizationPassword: string | null }
  | { kind: "password-clear"; action: "password-clear" | "password-reconcile"; authorizationPassword: string | null }
  | { kind: "delete"; action: "delete"; authorizationPassword: string | null };

export type NonContentMutationIntent = Exclude<
  MutationIntent,
  { kind: "content" } | { kind: "delete" }
>;

export type MutationSlot =
  | { state: "idle"; nextToken: number }
  | { state: "in-flight"; token: number; intent: MutationIntent; capture: BaselineCapture }
  | {
      state: "content-reconciliation";
      token: number;
      originActionKey: "autosave" | "manual-save" | "save-retry" | "overwrite";
      capture: BaselineCapture & { inFlightContent: string };
      laterDraft: string;
      requestToken: number;
    }
  | { state: "metadata-reconciliation"; token: number; intent: NonContentMutationIntent; capture: BaselineCapture };
```

`MutationIntent.kind` is the onlyserializer discriminator；controller neverpasses an untyped target togeneric serialization。Forcontent，`omitVersion` must equal`action === "overwrite"` andisasserted atconstruction；other actions requireusable current version。

- [ ] **Step 1: Write RED single-slot and reverse-settle tests**

Tests usecontrollable promises/effects to startautosave thenattempttitle/password/delete；onlyfirst dispatches，latest source iscoalesced once。Repeat withsettings first thenautosave due。Retire tokens byremote apply、terminal anddelete；resolveold callbacks reverse andassertno summary/version/ETag/draft rollback orduplicatePATCH。

```ts
it("serializes autosave and settings while retaining one latest source intent", () => {
  const controller = pasteControllerFixture();
  const save = controller.startMutation({ kind: "content", action: "autosave", content: "one", omitVersion: false });
  if (save.kind !== "dispatch") throw new Error("expected content dispatch");
  expect(controller.startMutation({ kind: "settings-title", action: "settings-title", title: "T" }).kind).toBe("blocked");
  controller.sourceEvent({ type: "input", content: "two", eventAt: 10 });
  controller.sourceEvent({ type: "input", content: "three", eventAt: 11 });
  expect(controller.snapshot().coalescedSource).toBe("three");
  controller.acceptContentMutation(save.token, mutationResult({ content: "one", version: "g.2" }), 12);
  expect(controller.effects().filter((effect) => effect.type === "dispatch-content")).toHaveLength(1);
  expect(controller.effects().at(-1)).toMatchObject({ type: "dispatch-content", content: "three" });
});
```

Run RED:

```powershell
npx vitest run src/client/paste-controller.test.ts -t "serializes autosave"
```

Expected RED: `./paste-controller` is absent，so the single-slot assertion fails at import。

- [ ] **Step 2: Implement the minimal GREEN authoritative acceptance invariants**

`sourceEvent(event:SourceEvent)` is the only source-event entry: every variant updates draft and increments `localGeneration`; only `input`, `composition-end`, and `crepe-change` call the activity port with the supplied `eventAt`; composition start/input never move the deadline. `startMutation` incrementslocalGeneration、invalidatessync/history andcapturesbaseline beforeeffect dispatch。Response onlyapplies when token current andcapture authoritative。Content200 updatesacceptedSource/lastSaved alias、summary/version/revision/updatedAt together；laterdraft remains。Metadata200 requires generation/contentRevision/source markers match, updates summary/version, clears the read ETag, and emits `applyAuthoritative({kind:"metadata",acceptedSource,version:result.paste.version})` before any slot-release effect so the next save cannot use the prior version. A mutation slot release emits one explicit `autosave-slot-available` effect only for an authoritative 200 or a non-content operation’s proven pre-write failure that leaves content mutation legal; Task 15 interprets it by calling `slotAvailable()`. A 403, any 409, terminal result, uncertain/reconciling result, or proved-not-applied content reconciliation emits no such effect. The settings-first reverse-settle RED must prove one later autosave dispatch after the eligible release and zero dispatch for every ineligible row. 409 sets`versionUsable=false` anddoes notadopt error details。404/terminal invalidatesall。

- [ ] **Step 3: Implement content reconciliation tests and transitions**

After uncertain autosave/manual/Overwrite (`503` may applied、flag absent、500、fetch rejection)，slot converts rather thanreleases。Explicit Reconcile emitsone unconditional resource GET tiedtooriginal token/capture/target；noautosave/sync/other mutation dispatches。

Concrete result cases：

1. server source exact target（includingtarget===baseline lost no-op）→ authoritative acknowledgement；laterdraft preserved；emit `applyAuthoritative({kind:"reconciled-applied",...})`, then and only then release the slot and call `slotAvailable()` for existing due/coalesced work；
2. target differs baseline andfullserver tuple exact captured baseline→ provednot applied，retainlatest draft andallow explicitRetry only；emit `applyAuthoritative({kind:"reconciled-not-applied",...})`, release the slot, and never call `slotAvailable()`；
3. anythird snapshot→ non-destructive conflict candidate；emit `applyAuthoritative({kind:"pause",state:"conflict",failureStatus:null})`, release the slot, and never call `slotAvailable()`；
4. 403 keeps reconciliation and pending credential and emits `pause/password-required/403`; 404 emits `pause/not-found/404` before terminal disposal; 503/network stays retryable; unexpected 304/malformed stays failed reconciliation; none invokes `slotAvailable()`；
5. validview-once skips1-4 andenters terminal withorigin context。

Tests include main-write/metadata-failure repairedserver response、edit duringreconcile andno blind mutation retry。

- [ ] **Step 4: Implement metadata/password/relative-expiry reconciliation**

Use exactspec17.10.3 table。Title/format/viewOnce/absolute/permanent may be proved byauthorized settingsread onlywhen source markers match。Same-seconds relative expiry neverproves success；Reconcile creates a newfullsettings mutation withfresh version/new now andmust remainreconciliation-required untilvalidated200。Password uncertain probesintended new (or no credential forclear) first，then theexact authorizing credential captured atdispatch；onlyauthorized non-password-changing GET maycommit provedold/pending credential。Password mutation 200 commits the intended `newPassword` for non-empty `password-set`, commits null for `password-set` with exact empty string or `password-clear`, and never commits the retry authorizing credential.

- [ ] **Step 5: Implement Delete result table**

Testexact rows：204 root handoff effect andclean success；403 ordinary page +pending credential explicit retry；409 ordinary conflict +`versionUsable=false`，requiresfullReload beforedelete retry；404 terminalnot-found；503/fetch/may-applied terminal`delete-uncertain` withno retry/server controls。Never commitpending credential on204/409/404/uncertain。

- [ ] **Step 6: Write staged-surface RED races**

`surface-apply.ts` concreteports：

```ts
export interface DerivedSurfaceCapture {
  localGeneration: number;
  currentExactSource: string;
  currentDisplayGeneration: number;
  hostGeneration: number;
  parentApplyGeneration: number;
  parentApplyToken: number;
  derivedRetryToken: number;
}

export interface StagedSurfacePorts {
  stagePreview(source: string, generation: number): Promise<unknown>;
  stageVisual(source: string, generation: number): Promise<unknown>;
  stageDiff(source: string, generation: number): Promise<unknown>;
  commit(staged: { preview: unknown; visual: unknown; diff: unknown }, generation: number): void;
  restoreOld(generation: number, source: string): Promise<boolean>;
  showOldGenerationFailure(generation: number, source: string): void;
  disposeAttemptResources(attempt: unknown): void;
}
```

Tests injectmid-stage edit/mutation/deadline、preview import/render rejection、Crepe reset rejection+destroy throw+recreate rejection、diff worker rejection。RunPreview/Crepe/diff retries afterlocal edit andafterhost remount；starttwo retries andresolve reverse；also invalidate byremote apply、Reload、consumed source choice andnewerRetry。Beforepublish compare allseven capture fields；stale attempt may onlydispose itsown detached resources andmust notclear currentfallback/status orchange draft/source/markers。

Run RED:

```powershell
npx vitest run src/client/surface-apply.test.ts -t "stages surfaces|reverse retry|seven-field guard"
```

Expected RED: `./surface-apply` cannot resolve；none of the detached-stage publication guards exist。

- [ ] **Step 7: Implement the minimal GREEN source-specific apply and terminal settlement**

Autosync、Use remote、Reload andterminal-local each allocateexactlyone independent token atentry。Use remote guard intentionally ignorescandidate-caused`Autosync=conflict`；Reload permitsdirty/inactive afterconfirmation；terminal-local ignoresordinary controller/active/clean。

Valid terminal response sequence：capture current exactdraft andoptional`TerminalOriginSettleContext`；invalidate/dispose allserver capabilities；retainlocal/response sources；stage chosen source；oneinitial React-facing state commit setsphase consumed andsettlesorigin exactlyonce withthese message keys：

- `content-reconcile-terminal-current-kept`
- `reload-terminal-response-displayed`
- `reload-terminal-response-display-failed`
- `reload-terminal-current-unchanged`
- `reload-terminal-current-kept-choice`

Keep current onlydismisses choice；Use consumed response hasnew`use-consumed-response` attempt with`use-consumed-response-displayed` or`use-consumed-response-display-failed`。No terminal branch retainsorigin pending。

- [ ] **Step 8: Focused and full GREEN checks**

```powershell
npx vitest run src/client/paste-controller.test.ts src/client/surface-apply.test.ts
npx vitest run src/client/autosave.test.ts src/client/history.test.ts src/client/paste-sync.test.ts
npm run build
npx vitest run --testTimeout=600000
```

- [ ] **Step 9: Commit and independent review gate**

```powershell
git add src/client/paste-controller.ts src/client/paste-controller.test.ts src/client/surface-apply.ts src/client/surface-apply.test.ts
git commit -m "feat: coordinate paste mutations and remote apply"
```

Independent Opus runsall controllable-promise matrices andaudits token/capture fields、accepted aliasing、relative/password reconciliation、Delete rows、offscreen cleanup、terminal order/settlement andzero blind retry。`APPROVED` required。

---

### Task 11: Build the Shared React Workbench, Help, Status, Local Actions, and Complete Locale Catalog

**Files:**
- Modify: `src/i18n.ts`, `src/i18n.test.ts`, `src/client/App.tsx`
- Create: `src/client/components/app-sidebar.tsx`
- Create: `src/client/components/WorkbenchShell.tsx`
- Create: `src/client/components/HelpTrigger.tsx`
- Create: `src/client/components/OperationStatus.tsx`
- Create: `src/client/components/SafeMarkdown.tsx`
- Create: `src/client/components/LocalActions.tsx`
- Create test: `src/client/components/workbench.browser.test.tsx`

**Ownership constraint:** this task freezes every dictionary key/translation andshared component prop beforeWave5。Tasks12-14 must not edit i18n/App/shared files。

- [ ] **Step 1: Write RED recursive dictionary parity and visible-copy policy tests**

Replace the duplicate literal locale declaration with `export type Locale = AppLocale` via a type-only import from `src/types.ts`, then replace—not add beside—the stale flat visible catalog with typed `labels`, `validation`, `errors`, `help`, `status`, `actions`, and `terminal` records. Remove `titleDescription`, `formatDescription`, `expirationDescription`, `passwordDescription`, `customIdDescription`, `storedExactly`, and `viewOnceDescription` from visible labels; preserve their permitted substance only under the matching closed `help` key. Destructive confirmation copy such as `deleteDescription` remains validation/action context, not generic explanatory prose.`errors` exhaustively maps every server `ErrorCode` plus client-only `NETWORK_ERROR`, `MALFORMED_RESPONSE`, and normalized `UNKNOWN_ERROR`, without rendering a server-supplied message. `help` exact keys：`contentStorage`、`contentLimit`、`format`、`expiration`、`relativeExpiration`、`password`、`passwordUrl`、`viewOnce`、`activeHtml`、`markdownNormalization`、`autosave`、`autosync`、`largeDiff`。`status` exhaustively maps everyAutosaveStatus/AutosyncStatus/NetworkStatus/LastAction state。`actions` maps everyclosed`ActionKey` to`pending/succeeded/failed` labels。`terminal` contains the seven message keys fromTask10 includingthe two use-consumed outcomes。

`assertDictionaryParity` recursively comparesallleaf keys foren/zh-CN。Add a scan that rendersclosed HelpTriggers andrejects explanation prose/sample filenames/change badges/marketing text invisible text。The parity RED isconcrete：

```ts
it("checks recursive dictionary parity and terminal outcomes", () => {
  expect(() => assertDictionaryParity(dictionaries)).not.toThrow();
  const broken = structuredClone(dictionaries);
  delete (broken["zh-CN"].help as Partial<Record<string, string>>).autosync;
  expect(() => assertDictionaryParity(broken as never)).toThrow("dictionary keys do not match at help.autosync");
  expect(Object.keys(dictionaries.en.terminal).sort()).toEqual([
    "content-reconcile-terminal-current-kept",
    "reload-terminal-current-kept-choice",
    "reload-terminal-current-unchanged",
    "reload-terminal-response-display-failed",
    "reload-terminal-response-displayed",
    "use-consumed-response-display-failed",
    "use-consumed-response-displayed",
  ]);
});
```

Run RED:

```powershell
npx vitest run src/i18n.test.ts src/client/components/workbench.browser.test.tsx -t "recursive dictionary parity|visible copy policy"
```

Expected RED: the current flat catalog lacksnew help/status/action/terminal keys andthe React workbench test module is absent。

- [ ] **Step 2: Implement the minimal GREEN pinned Document Workbench shell**

`src/client/components/app-sidebar.tsx` starts withthe exact block provenance comment fromTask8 andadapts onlythe pinned`apps/v4/registry/new-york-v4/blocks/sidebar-11/components/app-sidebar.tsx`。`WorkbenchShell` composes`SidebarProvider`、`SidebarInset`、`SidebarTrigger`、`SidebarRail`、Breadcrumb、Separator andadapted`AppSidebar`。Sidebar containsonlyreal destinations/metadata/actions passed asprops；no sample tree、logo、account/team、repository path或dummyhref。Desktop width16rem；under48rem upstreamSheet width`min(18rem,100vw)`；selected destination closesSheet andmovesfocus toheading orreturns trigger。

`App.tsx` continues exhaustive page switch butdelegates onlycommon shell at this task。It initializesdocument-local locale with`resolveBrowserLocale(navigator.languages,bootstrap.locale)`，updates`document.documentElement.lang`、literal`dir="ltr"`、document title/allReact copy onmanual switch，andownsoneTask6ThemeController througha dispose-safe hook forsystem/light/dark controls；neither preference writesstorage。Task15 keeps these owners unchanged。NoReact Router、anchor prefetch或duplicate mobile/desktop action DOM。

- [ ] **Step 3: Implement controlled `HelpTrigger` and browser RED/GREEN tests**

```ts
export interface HelpTriggerProps {
  label: string;
  content: string;
  descriptionId: string;
}
```

Use official controlledTooltip andsemantic44×44 Button showing`?`。Exactlyonehelp open throughprovider/context；hover/focus open unpinned；leave/blur closeonly unpinned；click/touch togglespinned；Escape/outside alwaysclose/unpin；focus remains/returns trigger；locale updatesopen content in place。`aria-describedby` pointsstableID。Browser test dispatchespointer/focus/click/Escape/outside andchecksoneopen tooltip/max width。

- [ ] **Step 4: Implement exact `OperationStatus` timestamp selection**

Renderfourrecords forordinary page；non-applicable pages renderNetwork+Last action only。Initialautosave clean、autosync waiting andlast-action idle renderno`<time>`。Timestamp selectors:

- Autosave saved→confirmedAt；error/password-required/not-found/conflict→failedAt；waiting/saving onlyexistingconfirmedAt；clean none。
- Autosync unchanged→checkedAt；remote-applied→appliedAt；allotherpost-initial states→currentstateChangedAt；missing instant meansno time。
- Network→changedAt。
- Last action pending→startedAt；settled→settledAt；idle none。

Onepolite live boundary announcesonlychanged record。For settled Last action，`outcomeKey:null` selects`actions[key][state]`；a non-nullclosed`TerminalOutcomeKey` selects theexactterminal catalog entry andmust matchthe controller-supplied success/failure state。Button outcomes stayuntilsame-key attempt/page transition。No credential/body/protected URL serialization。

- [ ] **Step 5: Implement trusted Markdown and shared local actions**

`SafeMarkdown` is the onlycomponent using`dangerouslySetInnerHTML` anditsprop type is`TrustedMarkdownHtml`。`LocalActions` receives exact in-memory source andinjected clipboard/download/navigation ports；copy usesClipboard thenhidden-textarea fallback；wrap/raw-source arepure toggles withnoActionKey；download uses`new Blob([new TextEncoder().encode(source)],{type:"application/octet-stream"})` andsettlesafterURL/click dispatch, notdisk write；HTML uses`new Blob([source],{type:"text/html"})` andtop-level`location.assign(blobUrl)` withoutserver request。Direct representation navigation isnot aLast action；link copy is`copy`。

- [ ] **Step 6: Apply exact visual tokens and accessibility contract**

`index.css` already owns global tokens fromTask8；this task usesutility classes only。Verifylight/dark pair values fromUI direction、max radius6px、no decorative shadow/gradient/glass/card stack/external font；44px targets、2px focus ring/offset、content-local overflow、reduced motion and320px no page overflow。No shared CSS edit is needed unlessTask8 token bytes were wrong；such a finding returnsTask8 forfix/re-review rather thanconcurrent edit。

- [ ] **Step 7: Focused and full GREEN checks**

```powershell
npx vitest run src/i18n.test.ts src/client/components/workbench.browser.test.tsx
npm run build
npx vitest run --testTimeout=600000
```

- [ ] **Step 8: Commit and independent review gate**

```powershell
git add src/i18n.ts src/i18n.test.ts src/client/App.tsx src/client/components
git commit -m "feat: add React workbench shell and status"
```

Independent Opus checksprovenance retained、singleDOM action source、Help interaction、timestamp table、closed ActionKey exhaustiveness、secret scan、visible-copy ban、320px/focus/contrast/reduced motion。`APPROVED` required。

---

### Task 12: Implement React Create, Password, Error, Consumed, and Read-Only Markdown Branches

**Files:**
- Create: `src/client/pages/CreatePage.tsx`
- Create: `src/client/pages/PasswordPage.tsx`
- Create: `src/client/pages/ErrorPage.tsx`
- Create: `src/client/pages/LocalOnlyPastePage.tsx`
- Create: `src/client/pages/MarkdownPage.tsx`
- Create test: `src/client/pages/static-pages.browser.test.tsx`

**Constraint:** onlythesefiles；consume sharedshell/help/status/local actions withoutmodifying them。

- [ ] **Step 1: Write RED create interaction tests**

MountCreatePage withfakePasteApi。Assertvisible Labels andseven exact expiration values`60,3600,86400,604800,2592000,31104000,permanent`；controlled fields；client UTF-8 size/scalar/title/password/ID validation；explicit`viewOnce:false|true` in everyrequest；pending disables repeat submit。Drop text writesexact content；drop file usesfirst item`File.text()` andexact filename title；invalid title reports error withouttruncation。Use onefile-local`mount()` helper built fromReact`act`+`createRoot` andthis real test：

```tsx
it("submits exact controlled create fields and stays on root", async () => {
  const create = vi.fn().mockResolvedValue({ ok: true, status: 201, value: summary, etag: '"g.1"' });
  const fixture = await mount(<CreatePage locale="en" create={create} />);
  await fixture.input("content", "exact\r\n🙂");
  await fixture.input("title", "  title  ");
  await fixture.click("viewOnce");
  await fixture.click("create");
  expect(create).toHaveBeenCalledWith({
    content: "exact\r\n🙂",
    title: "  title  ",
    format: "text",
    expiration: 86400,
    password: "",
    viewOnce: true,
  }, expect.any(AbortSignal));
  expect(location.pathname).toBe("/");
  expect(fixture.host.textContent).toContain(summary.id);
});
```

Task 6’s API adapter is the soleJSON/multipart selector。Page tests proveordinary valid inputs remainJSON andcall the already-unit-tested60MiB boundary selector throughthe adapter；CreatePage neverrecomputeswire size或constructsFormData。

201 keeps`location.pathname==="/"`、renderssummary/clean links/copy actions、does notclick/prefetch/navigate。Protected result links arederived at render/click usingcurrent create password andURLSearchParams；bootstrap summary remainsclean。

Run RED:

```powershell
npx vitest run src/client/pages/static-pages.browser.test.tsx -t "create interaction|password page|local-only capability"
```

Expected RED: the five page component modules are absent andthe first CreatePage import fails。

- [ ] **Step 2: Implement the minimal GREEN create, password, and error pages**

`CreatePage` owns one controlled state `{content,title,format,expiration,password,viewOnce,customId}` plus`idle|pending|succeeded|failed` submission state。Submit validates exact scalar/byte constraints，calls only`api.create`，andkeeps the201`PasteSummary` andthe submitted password inpage-local result state forderived links；it neverplacespassword insummary/status orauto-navigates。Drop callbacks commitfirst text/file exact bytes through thesame controlled setter；pending ignoresrepeat submit。

`PasswordPage` usescontrolledlabeled password/reveal/Submit butsubmits native`application/x-www-form-urlencoded` POST tocurrent path；bootstrap errorCode FORBIDDEN rendersinline role=alert。It neverreceivestitle/content/summary。`ErrorPage` mapsstatus+normalized code throughlocal dictionary andshowscreate recovery；no server message/stack。

- [ ] **Step 3: Write RED local-only capability tests**

Define `LocalOnlyPastePageProps.phase` as `"armed-view-once" | "consumed" | "not-found" | "delete-uncertain"`. Mount all four phases for plain and Markdown preview flags, plus `MarkdownPage`. Inject a fetch spy and exercise copy, wrap, raw/source toggle, safe preview, exact UTF-8 download, Blob HTML navigation, and create-new anchor. Assert business-fetch count 0; no Edit/History/Settings/Delete or raw/html/md/file server URL; only the optional browser renderer chunk can load after explicit recompute. Armed renders view-once metadata without claiming consumed and offers full refresh as the only way to initiate a later server read; consumed renders irreversible consumed state; not-found keeps local copy/download/full-refresh/create-new; delete-uncertain keeps the same local source while displaying the exact uncertain-outcome error and never offers same-document Retry. `MarkdownPage` shows the server safe article, title, copy/download/source-preview toggle and no ordinary status/controllers/second content read.

Run this second RED before creating either local-only module:

```powershell
npx vitest run src/client/pages/static-pages.browser.test.tsx -t "local-only capability|read-only Markdown"
```

Expected RED: `LocalOnlyPastePage` and `MarkdownPage` still do not exist after Step 2, so the local-only suite fails at import rather than passing against hidden ordinary controls.

- [ ] **Step 4: Implement distinct local-only component trees**

LocalOnlyPastePage neverimports`paste-sync`、autosave、history、api orpage controller。MarkdownPage has thesame restriction。Both derive every action from one exact source prop; initial safe preview uses branded `SafeMarkdown`. An explicit preview recompute may instantiate the reviewed `createMarkdownModes` against a private source adapter/detached host and consume only `onPreview`, then destroy it; neither page imports micromark directly, copies renderer options, or exposes a visual editor.Create/password/error showNetwork+Last action records only anddo notfabricate autosave/autosync timestamps。

- [ ] **Step 5: Focused and full GREEN checks**

```powershell
npx vitest run src/client/pages/static-pages.browser.test.tsx
npm run build
npx vitest run --testTimeout=600000
```

- [ ] **Step 6: Commit and independent review gate**

```powershell
git add src/client/pages src/client/pages/static-pages.browser.test.tsx
git commit -m "feat: add React create and local-only pages"
```

Independent Opus verifiescreate exact request/result、noautonavigation/prefetch、password native302 flow assumptions、error safety、local-only imports/DOM/request count、Blob/download exact bytes andMarkdown trust boundary。`APPROVED` required。

---

### Task 13: Implement Ordinary Content Modes, Plaintext Autosave Adapter, and Crepe Lifecycle

**Files:**
- Create: `src/client/hooks/use-autosave.ts`
- Create: `src/client/components/OrdinaryPastePage.tsx`
- Create: `src/client/components/ContentModes.tsx`
- Create: `src/client/components/PlaintextEditor.tsx`
- Create: `src/client/components/MarkdownWorkbench.tsx`
- Create test: `src/client/components/content-modes.browser.test.tsx`

**Constraint:** noApp/i18n/index.css/shared-controller edits。

- [ ] **Step 1: Write RED default/mode/Tabs tests**

Text format defaultsplainView；Markdown format displaysprovidedserver preview withoutbrowser micromark request。`OrdinaryPastePage` owns theofficial View/Edit/Markdown/History/Settings Tabs butdoesnotimportTask14 files；its exact props include`historyPanel:ReactNode`、`settingsPanel:ReactNode`、`passwordPanel:ReactNode` and`deleteFlow:ReactNode`，whichTask15 supplies。Tabs useautomatic activation、Left/Right/Home/End、wraparound、roving focus、normalTab exit andnested ownership cleanup。Hard remount usesformat-defined default，notlastclientmode。The first browser assertion isactual：

```tsx
it("uses format-defined default content mode without a client renderer", async () => {
  const importBrowserMarkdown = vi.fn();
  const fixture = await mount(<OrdinaryPastePage {...ordinaryPageProps({
    format: "markdown",
    source: "# exact",
    initialMarkdown: trustedHtml("<h1>exact</h1>"),
    historyPanel: null,
    settingsPanel: null,
    passwordPanel: null,
    deleteFlow: null,
    importBrowserMarkdown,
  })} />);
  expect(fixture.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("View");
  expect(fixture.host.querySelector("h1")?.textContent).toBe("exact");
  expect(importBrowserMarkdown).not.toHaveBeenCalled();
});
```

Run RED:

```powershell
npx vitest run src/client/components/content-modes.browser.test.tsx -t "default content mode|Tabs keyboard|plaintext autosave"
```

Expected RED: the ordinary content components andReact autosave hook are absent，so the browser suite fails at import。

- [ ] **Step 2: Implement the minimal GREEN plaintext editor and one React autosave adapter**

Create `OrdinaryPastePage`, `ContentModes`, and `PlaintextEditor` far enough to satisfy the default-view and official Tabs RED without a browser Markdown or Crepe implementation. The Textarea is controlled, monospace, whitespace-preserving, has `spellCheck={false}`, and receives an explicit wrap prop. Its handlers capture `event.timeStamp` once and emit the exact `SourceEvent` variant to the page before calling the matching autosave method with the same source/instant. Normal input uses `input`; composition start uses `composition-start` then `compositionStart()`; composing change uses `composition-input` then `input`; committed end uses `composition-end` then `compositionEnd`. Suppress the browser’s duplicate post-composition input for the same committed value so activity/debounce is recorded once. `useAutosave` creates exactly one `AutosaveController` per paste identity, forwards each DOM event’s monotonic `event.timeStamp` to `input(content,eventAt)` or `compositionEnd(content,eventAt)`, subscribes state, and disposes on unmount. Mount→unmount→mount causes no duplicate timer/listener/request. Composition start/intermediate/end call the exact controller paths; programmatic remote reset calls `applyAuthoritative({kind:"replace",acceptedSource:content,version})` and never `input`.

- [ ] **Step 3: Write RED Markdown lifecycle, local-failure, and direct-action browser tests**

Cover exact CR/CRLF source before first edit; source→visual→source with no edit and zero save; one visual edit schedules one save at exactly 1,000 ms from the transaction event; a late serializer retry after a newer visual transaction is discarded; source remains keyboard-editable after Crepe failure and ordinary offline/403/409/503 presentation. A 404 is deliberately excluded here because Task 15 must dispose the ordinary editor and enter Task 12’s non-editable local-only `not-found` branch. Unmount awaits destroy before host reuse; a StrictMode-like double mount has one active editor. Add ordinary action rows proving clean links plus literal metacharacter credentials are regenerated on every render, copy/wrap/download use the exact in-memory source, top-level HTML is a normal anchor, no action prefetches, and navigation does not settle Last action.

Run this RED before lifecycle/action implementation:

```powershell
npx vitest run src/client/components/content-modes.browser.test.tsx -t "Markdown lifecycle|visual transaction debounce|ordinary direct actions"
```

Expected RED: the plaintext-only GREEN lacks the Crepe/preview lifecycle and exact representation actions, so the first matching assertion fails without issuing a business request.

- [ ] **Step 4: Implement the minimal GREEN Markdown source/visual/preview lifecycle**

`MarkdownWorkbench` always keeps the source Textarea usable. It creates one `MarkdownModes` per host lifecycle; source mode reads/writes canonical draft; the visual host is a React-owned empty node whose children are Milkdown-owned. Only a real Crepe document transaction captures one `performance.now()` instant; its `onCrepeChange` adapter first emits `{type:"crepe-change",content,eventAt}` to the page and then invokes autosave with the same values. Mode/focus/init alone keeps exact bytes/version/history/network zero. Preview uses the initial safe fragment when exact source matches; first recompute passes the injected `importBrowserMarkdown` seam as `MarkdownModesOptions.loadPreview`; its default is the reviewed module’s existing `Promise.all([import("micromark"),import("micromark-extension-gfm")])`, so no second renderer or wrapper module exists. On first visual entry, the React adapter first awaits `import("@milkdown/crepe/theme/common/style.css")`, then calls the reviewed `MarkdownModes.enterVisual()`, whose existing dynamic imports remain the sole Crepe/Kit JS loader. No Crepe CSS is statically imported by `index.css`, and no classic/nord/frame theme CSS enters the graph. Crepe/CSS load, init, serialize, or destroy failure keeps full source and a Retry action; the adapter maps failure kind to localized safe copy and never renders the dependency-provided `message`.

- [ ] **Step 5: Implement the minimal GREEN ordinary local/direct actions without credential caching**

Ordinary page receives clean links plus committed password and builds raw/html/md/file hrefs on every render through `withPastePassword`. Copy/wrap/download use `LocalActions`; top-level direct HTML remains normal anchor navigation and does not claim Last action completion. Do not import React Router or prefetch API.

- [ ] **Step 6: Focused and full GREEN checks**

```powershell
npx vitest run src/client/components/content-modes.browser.test.tsx src/client/autosave.test.ts src/client/markdown.test.ts
npm run build
npx vitest run --testTimeout=600000
```

- [ ] **Step 7: Commit and independent review gate**

```powershell
git add src/client/hooks/use-autosave.ts src/client/components/OrdinaryPastePage.tsx src/client/components/ContentModes.tsx src/client/components/PlaintextEditor.tsx src/client/components/MarkdownWorkbench.tsx src/client/components/content-modes.browser.test.tsx
git commit -m "feat: add React document editing modes"
```

Independent Opus verifiesoneautosave/controller、Tabs keyboard、exact source、lazy boundaries、Crepe host ownership/cleanup、no mode-switch save、credential URL regeneration andsource fallback。`APPROVED` required。

---

### Task 14: Implement History, Settings, Password, and Delete UI Against Injected Controller Callbacks

**Files:**
- Create: `src/client/components/HistoryPanel.tsx`
- Create: `src/client/components/SettingsPanel.tsx`
- Create: `src/client/components/PasswordPanel.tsx`
- Create: `src/client/components/DeleteFlow.tsx`
- Create test: `src/client/components/management.browser.test.tsx`

**Constraint:** components receive typedstate/actions fromcontroller；they do notfetch directly orduplicate mutation rules。

- [ ] **Step 1: Write RED History lazy/race/presentation tests**

History list callback fires onlywhenHistory opens；snapshot callback onlyonrevision select。Desktop layout15rem list/detail；mobile startslist，selection showsdetail+Back。Detail officialTabs showUnified diff andFull snapshot。Diff directionselected→current；React text children render`+/-/space` prefixes andneverHTML。Either side>1MiB or>50,000 lines showsCompute diff action；threshold explanation onlyHelpTrigger。Loading/empty/403/404/409/503/corruption preserve currentdraft。Late list/snapshot fixture updatesnothing。Add this real lazy-load test witha complete local`historyState()` fixture：

```tsx
it("loads history only after the History destination opens", async () => {
  const openHistory = vi.fn();
  const fixture = await mount(<HistoryPanel active={false} state={historyState()} openHistory={openHistory} selectRevision={vi.fn()} computeDiff={vi.fn()} back={vi.fn()} />);
  expect(openHistory).not.toHaveBeenCalled();
  await fixture.render(<HistoryPanel active state={historyState()} openHistory={openHistory} selectRevision={vi.fn()} computeDiff={vi.fn()} back={vi.fn()} />);
  expect(openHistory).toHaveBeenCalledTimes(1);
});
```

Run RED:

```powershell
npx vitest run src/client/components/management.browser.test.tsx -t "history lazy load|settings result table|Delete result"
```

Expected RED: allfour management components are absent andthe first component import fails。

- [ ] **Step 2: Write the remaining RED settings/password result-table tests**

Separatecontrolled drafts/forms for title、format、expiration、viewOnce、password；ID readonly。Each user field input reportsactivity timestamp；submit callsonecallback anddoesnotextend deadline。200 commitsfield；413/422 inline error；403 inline credential；409 showsReload andblocksretry untilversion usable；safe503 allowsRetry；uncertain showsReconcile；Discard restoresaccepted。Relative uncertain alwayslabelsReconcile asnewfull rewrite，evenidentical seconds。

Password tests：set/change/clear；initial403 retry credential onlyauthorizesattempt；successful mutation displaysintended new/null andrepresentation links/current URL fromcommitted value；wrong retry unchanged。Uncertain reconciliation prompts/probes incontroller-defined order andneverplaces credential intext/status/log attributes。

Run the complete management RED before implementing the components:

```powershell
npx vitest run src/client/components/management.browser.test.tsx -t "history lazy load|settings result table|password result table|Delete result"
```

Expected RED: the typed settings/password/Delete imports and their callback/result-table behavior are absent; no test may be made green by a direct fetch inside a component.

- [ ] **Step 3: Implement the minimal GREEN management components and exact Delete presentation**

`HistoryPanel` receiveslist/snapshot/diff state andtyped`openHistory/selectRevision/computeDiff/back` callbacks；it owns onlydesktop/mobile selection presentation andneverstores a second current-source baseline。`SettingsPanel` maintainsone controlleddraft perbusiness field andcalls its matchingtyped controller callback；Discard copies thelatest accepted prop。`PasswordPanel` keeps current retry andnewpassword inputs inlocal controlled state，passes values onlyto explicit callbacks，clears input values aftera committed success andrenders no credential inattributes/status。

OfficialDialog in`DeleteFlow` haslabel/description、initial focus、trap、Escape/outside policy、focus return andexplicit destructive Button。Cancelled dialog hasnoActionKey/token。Pending disablesother mutations。Result props render：204 root success handoff signal；403 ordinary credentialRetry；409 ordinaryReload-before-delete；404 local not-found；uncertain local delete-uncertain。Only404/uncertain remove server controls；403/409 preserve source/actions。

- [ ] **Step 4: Focused and full GREEN checks**

```powershell
npx vitest run src/client/components/management.browser.test.tsx src/client/history.test.ts
npm run build
npx vitest run --testTimeout=600000
```

- [ ] **Step 5: Commit and independent review gate**

```powershell
git add src/client/components/HistoryPanel.tsx src/client/components/SettingsPanel.tsx src/client/components/PasswordPanel.tsx src/client/components/DeleteFlow.tsx src/client/components/management.browser.test.tsx
git commit -m "feat: add React history settings and delete"
```

Independent Opus verifiesno directfetch、history laziness/token presentation、diff text safety、separate field mutations、relative/password recovery wording/credential absence、Dialog accessibility andallDelete rows。`APPROVED` required。

---

### Task 15: Integrate the Complete React Paste Lifecycle

**Files:**
- Modify: `src/client/App.tsx`
- Create: `src/client/pages/OrdinaryPage.tsx`
- Create: `src/client/hooks/use-paste-page.ts`
- Create tests: `src/client/App.browser.test.tsx`, `src/client/App.module-graph.test.ts`

**Consumes:** approved page/components/controllers only。No child component、i18n、router、generated asset或package edits。

- [ ] **Step 1: Write RED full-branch mount and request-audit tests**

Mount every`InitialPage` variant andassertuniquevisible branch。`App.tsx` statically imports onlycommon shell/status anddeclaresexactly six route components through`React.lazy(() => import(...))`：CreatePage、PasswordPage、ErrorPage、LocalOnlyPastePage、MarkdownPage andtheTask15-owned`OrdinaryPage` adapter underone localized`Suspense` loading main。App neverimports`usePastePage` or`OrdinaryPastePage` directly。The paste discriminator choosesordinary versusconsumed beforestarting either import；thereforecreate/password/error/consumed/markdown branch modules neither import norinstantiateordinary controller code。Only`OrdinaryPage.tsx` importsandcalls`usePastePage`，thenrendersTask13`OrdinaryPastePage`。Ordinary createsoneapi、autosave、autosync、history、page andsurface controller；mount->unmount->mount leavesone listener/timer andzeroautomaticduplicate request。Default ordinary load issuesnoextraimmediate GET；first sync at3,000ms。UseVitest fake timers andthis executable request audit：

```tsx
it("does not re-read initial ordinary content before the first three-second due", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  vi.stubGlobal("fetch", fetchMock);
  const fixture = await mount(<App initialPage={ordinaryInitialPage("exact")} />);
  expect(fetchMock).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(2_999));
  expect(fetchMock).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await fixture.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
```

In the same RED suite, load the real lazy `OrdinaryPage` while mocking only Task13’s child `OrdinaryPastePage` as a render probe that records `{acceptedSource,version,autosaveAcceptedSource,lastSavedContent,autosaveState}` on every committed render. Resolve one controlled content-save 200. The exact render sequence may contain the complete old tuple and the complete accepted tuple only; it must contain no cross-product frame, and both autosave aliases must be identical in every record.

`src/client/App.module-graph.test.ts` is the sole source-level import proof。Usingthe installed TypeScript compiler API，loadtheproject`tsconfig.json` compiler options，parse static import declarations andliteral dynamic`import()` expressions，resolve every relative or`@/` production edge with`ts.resolveModuleName`，andtraverse resolved`src/client` modules recursively whileexcluding`node_modules` andall`*.test.*`/`*.browser.test.*` files，thenassert：App hasexactly one source dynamic edge to`./pages/OrdinaryPage` andno source edge to`./hooks/use-paste-page` or`./components/OrdinaryPastePage`；`OrdinaryPage.tsx` hasdirect static import declarations tobothofthose modules；noother production module imports eitherordinary module；andthefive nonordinary page-root closures exclude`OrdinaryPage`、`use-paste-page`、`OrdinaryPastePage`、`autosave`、`paste-sync`、`paste-controller`、`surface-apply` and`history`。The shared`api.ts` remainsallowed because`CreatePage` uses`api.create`。Task17 build tests do notrepeat orreplace these source-edge assertions。

Run RED:

```powershell
npx vitest run src/client/App.browser.test.tsx src/client/App.module-graph.test.ts -t "mounts every branch|one ordinary lifecycle|no immediate GET|accepts autosave atomically|keeps ordinary imports solely in OrdinaryPage"
```

Expected RED: `use-paste-page` is absent andthe current temporary App shell does notrender theapproved page components orcontroller lifecycle。

- [ ] **Step 2: Implement the minimal GREEN activity, eligibility, mutation, and history effect interpreter**

`usePastePage` is the only React interpreter of controller effects，and`OrdinaryPage.tsx` is its only component caller。The adapter receives the ordinary `InitialPage` props selected by App，calls thehook unconditionally atcomponent top level，constructsTask14 panels fromthe returned single snapshot/callback set，andpasses those panels plus hook state/actions intoTask13`OrdinaryPastePage`。App doesnotcall a hook conditionally，and`OrdinaryPastePage` remainsunchanged fromTask13。`usePastePage` forwards each real DOM event’s monotonic `event.timeStamp` to activity/autosave transitions, uses injected `performance.now()` for load, timer, dispatch, and settle instants, and uses `new Date().toISOString()` only for displayed status timestamps. It routes all content/settings/password/delete mutations through the single slot, sync through `PasteSyncController`, and history through `HistoryController`. Autosave `tryDispatch` never exposes the raw fetch promise: its chain strictly decodes the API result, synchronously asks `PasteController` to accept the still-current token/capture, emits the one combined React coordinator action, and only then yields an accepted `AutosaveSaveResult` to `AutosaveController`; rejection/non-200 follows the Task 10 reconciliation transition before autosave status publication. React automatic batching is not assumed without evidence；the Step 1 render probe is the gate。Mutation dispatch aborts/invalidatessync/history first。No status-only request、heartbeat orsecond retry loop。

- [ ] **Step 3: Wire staged remote/candidate/reload behavior**

Definitely-newer sync entersautosync source-specific guard；candidate displaysUse remote/Keep current/Retry sync。Use remote canpass whilecandidate itself causedconflict，butentry rejectsnewedit/composition/timer/coalesced/mutation/baseline generation changes。Confirmed Reload usesDialog、unconditionalGET、worksdirty/inactive andpreservesdraft untilstaged commit。Allpreview/Crepe/diff publication goesSurfaceApplyController；success updatescanonical state inoneReact commit andnevercallsautosave input/history mutation。

- [ ] **Step 4: Wire credential replacement and password URL updates**

403 field writes onlypendingCredential。Non-password operation commits it onlyafterauthorized200/304。Password set/change/clear success commitsintended new/null；delete204 clearsboth withoutfirst writingpending。One helper updatescurrent URL preservingother query/fragment andregeneratesallrepresentation hrefs。Test literalleading/trailing spaces、`+%&#?`、duplicate query normalization andhard-remount behavior。No password inbootstrap、visible text、status、unrelated attributes orapplication log。

- [ ] **Step 5: Wire reconciliation and terminal transitions**

Exerciseall Task10 result effects throughvisible UI。For anycompletevalidview-once resource response：capturecurrent draft +safeorigin context，removeordinary controls/URLs anddisposecontrollers，thenstage/commit consumed branch。Current definitely-newer autosync orvalid definitely-newerReload mayautoselectresponse；exact equal keepscurrent；retired/older/divergent keepscurrent andofferslocal choice。Afterterminal, business request count remainszero。

Use controllable promises for exact terminal outcomes：content reconcile current kept；Reload newer displayed；Reload newer staging failed；Reload exactequal；Reload ambiguous/older thenKeep current；same thenUse consumed response。Initialterminal commit settlesorigin onceatcommit instant；Keep doesnotresettle；Use response settlesonlynewkey；late callback cannotreset。

- [ ] **Step 6: Wire armed-view-once, not-found, delete-uncertain, and delete root handoff**

Settings `viewOnce:true` authoritative200 firstdisposesordinary controllers andswitches`armed-view-once` withoutmarkingconsumed。404 preservesexactdraft withlocalcopy/download/fullrefresh/create new。Delete uncertain preserveslocal source butremovesallserver capability。Delete204 invalidates/disposes/clears allsource/history/password/URLs beforeoneReact state transition tocreate；then`history.replaceState(null,"","/")` androot Last action keepsquery-independent success untilnextaction/refresh。

- [ ] **Step 7: Verify OperationStatus and action semantics end-to-end in component tests**

Assertinitial nofake times；alllaterautosync transitions useownstateChangedAt；200/304 checkedAt；acceptedapply appliedAt；remote clean doesnotmodifyconfirmedAt；failure-after-success displaysfailure time。EveryclosedActionKey pending/settled outcome staysinline；pure Help/Sidebar/tab/mode/locale/theme/reveal/wrap/raw toggle andunobservable navigation leaveLast action unchanged。NoDialog/toast/snackbar/alert forfeedback。

- [ ] **Step 8: Focused and full GREEN checks**

```powershell
npx vitest run src/client/App.browser.test.tsx src/client/App.module-graph.test.ts src/client/paste-sync.test.ts src/client/paste-controller.test.ts src/client/surface-apply.test.ts
npm run build
npx vitest run --testTimeout=600000
```

Inspectnetwork/import graph underbrowser tests；ordinary source startup hasnoCrepe/micromark/diff load；terminal branch haszero business requests。

- [ ] **Step 9: Commit and independent review gate**

```powershell
git add src/client/App.tsx src/client/pages/OrdinaryPage.tsx src/client/hooks/use-paste-page.ts src/client/App.browser.test.tsx src/client/App.module-graph.test.ts
git commit -m "feat: integrate React paste lifecycle"
```

Independent Opus performsmax-effort state-machine review againstspec17.5-17.11，runsreverse-promise/fake-clock/component suites，usesonlyTask15’s TypeScript source-graph test toverify`OrdinaryPage` is the sole direct hook/component import owner andthefive nonordinary source closures excludeordinary code，auditsall token/cleanup/credential/status rules andensuresno child contract workaround。Only`APPROVED` integrates。

---

### Task 16: Add Real-Wrangler Playwright Journeys and Browser Matrix

**Files:**
- Create: `playwright.config.ts`
- Create: `scripts/browser-evidence.mjs`, `scripts/verify-release-evidence.mjs`
- Create: `test/e2e/helpers.ts`
- Create: `test/e2e/create-password.spec.ts`
- Create: `test/e2e/ordinary-sync.spec.ts`
- Create: `test/e2e/view-once-representations.spec.ts`
- Create: `test/e2e/accessibility.spec.ts`
- Create: `test/fixtures/external.html`
- Create: `test/e2e/browser-matrix.json`, `test/e2e/browser-manual.md`
- Create: `test/e2e/accessibility-manual.md`, `test/e2e/accessibility-manual.json`
- Create generated official-source and release receipts: `test/e2e/evidence/browser-target-sources/{chrome,edge,firefox,safari}-stable.json`, `test/e2e/evidence/browser-matrix/**`, `test/e2e/evidence/engine/**`, `test/e2e/evidence/accessibility/**`

- [ ] **Step 1: Capture a real Playwright RED, then configure the minimal GREEN supervised Wrangler server**

Create`test/e2e/create-password.spec.ts` first withthe executable root probe：

```ts
import { expect, test } from "@playwright/test";

test("loads the React create branch from real Wrangler", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#app main")).toBeVisible();
  await expect(page.locator("#source-data")).toHaveCount(0);
});
```

Run RED beforecreating`playwright.config.ts`：

```powershell
npx playwright test test/e2e/create-password.spec.ts --project=chromium
```

Expected RED: Playwright reports thatproject`chromium` isnot configured（or cannot reach127.0.0.1:8787 underdefault config）；no test may pass againstan unrelated reused server。Beforecreatingthe evidence scripts，also capturetheir missing-command RED：

```powershell
node scripts/browser-evidence.mjs self-test
node scripts/verify-release-evidence.mjs --self-test
```

Both commands mustexitnonzero becauseTask16 hasnot createdthem；do notmanufacture passing evidence。Then create `playwright.config.ts` with `webServer.command="npm run dev:e2e"`, URL `http://127.0.0.1:8787/`, timeout 120,000, and `reuseExistingServer:false`. The Task 8-owned command performs a fresh Vite projection and TypeScript check before Wrangler starts, which is mandatory in a clean isolated worktree; no Playwright command may rely on ignored `dist/` bytes or a generated asset projection left by another task. Exact bundled-engine project names are `chromium`, `firefox`, `webkit`, `mobile-320`（Chromium，320×720，touch/mobile）and `reduced-motion`（Chromium）。Do not add or conditionally detect an `msedge` project and do not label these engine projects Chrome、Edge or Safari evidence。Use retries1 withtrace andscreenshot onfirst retry。Eachtest ownsuniquecrypto ID anddoesnotdepend onanother test。The root probe isminimal GREEN onlyafterthe configured Wrangler process serves theReact shell。

`browser-matrix.json` is the release-time machine-readable contract，not a prose checklist。It uses this exact discriminated shape：

```ts
type BrowserProduct = "Chrome" | "Edge" | "Firefox" | "Safari";
type BrowserSlot = "current" | "previous";
type BrandedEnvironment =
  | "windows-chrome-current"
  | "windows-chrome-previous"
  | "windows-edge-current"
  | "windows-edge-previous"
  | "windows-firefox-current"
  | "windows-firefox-previous"
  | "macos-safari-current"
  | "macos-safari-previous";
type BrowserMatrix = {
  schemaVersion: 3;
  releaseDate: string;
  targets: Array<{
    product: BrowserProduct;
    slot: BrowserSlot;
    major: number;
    exactVersion: string;
    sourceArtifact: string;
  }>;
  rows: Array<
    | {
        product: BrowserProduct;
        slot: BrowserSlot;
        targetMajor: number;
        observedVersion: string;
        mode: "manual-branded";
        environment: BrandedEnvironment;
        status: "passed";
        testedAt: string;
        versionArtifact: string;
        evidence: string;
      }
    | {
        product: "Safari";
        slot: BrowserSlot;
        targetMajor: number;
        observedVersion: null;
        mode: "manual-branded";
        environment: "macos-safari-current" | "macos-safari-previous";
        status: "not-available";
        testedAt: string;
        versionArtifact: null;
        evidence: string;
      }
  >;
  engineCoverage: Array<{
    project: "chromium" | "firefox" | "webkit";
    exactVersion: string;
    status: "passed";
    testedAt: string;
    evidence: string;
  }>;
};

type VendorSourceId =
  | "google-chrome-versionhistory-win-stable"
  | "microsoft-edge-enterprise-win-x64-stable"
  | "mozilla-firefox-stability-releases"
  | "apple-security-releases-safari";

type VendorReleaseSourceArtifact = {
  schemaVersion: 1;
  releaseDate: string;
  product: BrowserProduct;
  channel: "stable";
  source: {
    id: VendorSourceId;
    url: string;
    responseCount: number;
    responseSha256: string;
  };
  retrievedAt: string;
  releases: Array<{
    sourceReleaseIds: string[];
    exactVersion: string;
    major: number;
    releasedAt: string;
  }>;
};
```

Task16’s`browser-evidence.mjs acquire-targets` is theonly acquisition/normalization owner。It usesNode22 global`fetch` plusstdlib JSON/crypto/fs，calls each URL with`redirect:"error"`，requiresHTTP200 beforeparsing，andhasthese exact built-in source adapters；there isno manual copy orseparate normalization step：

| Product | Required `source.id` and exact official `source.url` | Accepted vendor records and owned normalization |
|---|---|---|
| Chrome | `google-chrome-versionhistory-win-stable`；`https://versionhistory.googleapis.com/v1/chrome/platforms/win/channels/stable/versions/all/releases?filter=fraction%3D1&order_by=starttime%20desc&page_size=1000` | Follow`nextPageToken` withthe same query plus`page_token` untilabsent；acceptonly`fraction===1` records withstring`name`、numeric dotted`version` andRFC3339`serving.startTime`。Group same`version`，sort/deduplicate its`name` values into`sourceReleaseIds`，anduse theearliest start instant as`releasedAt`。Conflicting repeats exitnonzero。 |
| Edge | `microsoft-edge-enterprise-win-x64-stable`；`https://edgeupdates.microsoft.com/api/products?view=enterprise` | Selectthe sole`Product==="Stable"` array，thenonly`Platform==="Windows"` and`Architecture==="x64"`；map`String(ReleaseId)` asits sole`sourceReleaseIds` member，`ProductVersion` as`exactVersion` and`PublishedTime` asrelease time。The source’s timezone-free exact`YYYY-MM-DDTHH:mm:ss` value isdefined bythis adapter asUTC andnormalized byappending`Z` beforecanonical timestamp parsing。 |
| Firefox | `mozilla-firefox-stability-releases`；`https://product-details.mozilla.org/1.0/firefox_history_stability_releases.json` | Map everyown object entry whosekey is numeric dottedversion andwhosevalue isavalid Gregorian`YYYY-MM-DD`；use theversion key asits sole`sourceReleaseIds` member andnormalize thedate to`T00:00:00.000Z`。 |
| Safari | `apple-security-releases-safari`；`https://support.apple.com/en-us/100100` | Parse everyHTML table row whosefirst text cell isexactly`Safari <numeric-dotted-version>` andwhose release-date cell is`DD Mon YYYY`；use thecanonical stripped row text asits sole`sourceReleaseIds` member andnormalize thedate toUTC midnight。Any duplicate Safari version withdifferent date orrow identity exitsnonzero。 |

Forall adapters，`source.responseSha256` islowercase SHA-256 ofthe exact response-body bytes inrequest order separated byone LF byte，mustmatch`^[0-9a-f]{64}$`，and`responseCount` isapositive safe integer equal tothatbody count。After vendor filtering，the artifact containsone canonical record perexact version andatleastthree distinct stable majors，notonly thetwo selected targets。`exactVersion` mustmatch`^(0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$`；`major` isapositive safe integer equal tothefirst numeric component；each`sourceReleaseIds` array isnonempty/sorted/unique andno ID occurs inanother record；each`releasedAt` iscanonical UTC andnotlater than`retrievedAt`。Duplicate exact versions、duplicate source IDs、field disagreement orunexpected response shape makesacquisition exitnonzero andwrite nothing。Allfour successful artifacts arewritten atomically to`test/e2e/evidence/browser-target-sources/{chrome,edge,firefox,safari}-stable.json`，withthe fixed product/channel/source identity shownabove。

`releaseDate` hasexact grammar`YYYY-MM-DD`：it mustmatch`^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$` and，with`midnight = releaseDate + "T00:00:00.000Z"`，satisfy`Number.isFinite(Date.parse(midnight)) && new Date(Date.parse(midnight)).toISOString() === midnight`。Every`retrievedAt`、`releasedAt` and`testedAt` inany source、browser、Safari-unavailable、engine oraccessibility artifact mustbe canonical RFC3339 UTC`YYYY-MM-DDTHH:mm:ss.sssZ`，match`^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$`，parse toafinite instant，andround-trip exactly through`new Date(value).toISOString()`。Let`D=Date.parse(releaseDate+"T00:00:00.000Z")`；theone freshness interval forall evidence is`[D - 7 * 86_400_000, D + 86_400_000)`。Every`retrievedAt` and`testedAt` mustfallinsideit。Historical`releasedAt` values mayprecede theinterval butmustnotexceed theirartifact’s`retrievedAt`。Thus acquisition maystart seven days beforethe UTC release date，and evidence maycomplete throughthat release date butnotafterits nextUTC midnight。

`acquire-targets --release-date` validatesits explicit argument andcurrent time againstthat interval beforeandafterfetching，sets each`retrievedAt` fromthe post-fetch current instant，then derives targets independently perartifact fromrecords whose`releasedAt <= retrievedAt`：sortdistinct majors numerically descending，mapthehighest to`current` andsecond-highest to`previous`，andwithin each selected major choose thegreatest numeric dot-component tuple paddedwithzero components，usinglater`releasedAt` onlyto breakanequal tuple；anequal tuple/timestamp fromdifferent exact strings isambiguous andfails。The selected majors may beconsecutive ornonconsecutive；the script performsno arithmetic relation check betweenthem。The command writesexactlytwo targets perproduct andresets`rows`/`engineCoverage` toempty in`browser-matrix.json`；it alsoinitializes`accessibility-manual.json` withthe same exact`releaseDate` andempty rows。A failure writesnoneofthese files。

`scripts/verify-release-evidence.mjs` reparses allfour fixed source-artifact paths andrejects schema/product/channel/source ID/source URL/releaseDate mismatches、stale`retrievedAt`、malformed/repeated/inconsistent release records orfewerthanthree distinct majors。It independently repeats the selection above andrequires exactlyone matching target andone final row foreachofthe eight product/slot pairs，withthe target’s`major`、`exactVersion` andfixed`sourceArtifact` equal tothederived values andthe row’s`targetMajor` equal tothe target。Both Chrome rows、both Edge rows andboth Firefox rows mustbe`passed` witha fresh`testedAt` andnonempty runtime`observedVersion` whose normalized exact version equals`target.exactVersion` andwhose parsed major equals`target.major`，plus existing matching version/test evidence artifacts。Safari uses thesame passed exact-version/freshness rule whenacquired；onlya Safari row may be`not-available`，andit muststill bindthederived target andfresh runner-provisioning failure artifact。A Safari unavailable row isnotapass andnever satisfiesmanual accessibility evidence。`engineCoverage` mustseparately containexactlyone fresh passed Chromium、Firefox andWebKit report withversions；the verifier nevermapsChromium toChrome/Edge orWebKit toSafari。Finally itrequires`browser-matrix.json` and`accessibility-manual.json` tohaveexactly thesame valid`releaseDate`，requires theverifier’s owncurrent instant inside thesame interval，andapplies thatinterval toevery`retrievedAt`/`testedAt`。Implement both self-test modes with`fs.mkdtemp` under`os.tmpdir()` and`finally` cleanup，no network andno tracked writes。`browser-evidence.mjs self-test` feedsminimal raw payloads throughallfour adapters，including Chrome duplicate-fraction grouping、Edge timezone conversion、Firefox UTC-midnight conversion、Safari nonadjacent majors，andproves atomic no-write onone source failure orinterval crossing。`verify-release-evidence.mjs --self-test` first accepts onecomplete synthetic campaign whose twohighest majors arenonadjacent，thenrequires rejection aftereach independent mutation：wrong product/channel/source ID/source URL，duplicate exact version，duplicate source release ID，version/major disagreement，malformed/future release time，fewerthanthree majors，wrong target/slot/exact version/source path，aggregate date disagreement，one out-of-window evidence timestamp，andanout-of-window verifier clock。

- [ ] **Step 2: Write RED create/password/edit/history/delete journey**

Concrete journey：create protected custom-ID Markdown with a metacharacter password；assert location `/` and no automatic resource request；navigate deliberately to the credential-free `PasteSummary.links.view` path to get the password branch, submit its native form and assert 302/full navigation leaves exactly one encoded password query；hard refresh that URL；edit plain source andobserveexact1s autosave；secondpage causes409，draft retained，Reload/Overwrite choices；perform4 content saves；History newest3、snapshot/diff prefixes；settings title/format/expiry；password change/clear andhard refresh；deleteDialog204 root handoff andrefresh removesfeedback。

- [ ] **Step 3: Write autosync fake-server-controlled browser races through real routes**

Use two realpages androute delay only tocontrol response timing，not mockresponse bodies。Verify3s cadence、single in-flight、remote apply、dirty pause、offline/online wait、candidate choices、deadline inactivity。Create view-once mutation whilefirstpage resource GET delayed；resolve afteredit/mutation/deadline variants andassertterminal local-only/no furtherbusiness network。Use `page.on("request")` counters andclassify hashedassets separately。

- [ ] **Step 4: Write view-once/direct representation/active HTML journeys**

View-once main response showscopy/wrap/source/safe preview/download/Blob HTML，noordinary controls，server secondread404。Separate paste provesHEAD andwrong password do notconsume；browser/direct OPTIONS returns405 with`Allow: GET,HEAD` ormain`GET,HEAD,POST` beforeauthorization andalso doesnotconsume；the firstvalid rawdoesconsume。Keep API OPTIONS204、`/ip-trace` OPTIONS200 and`/mcp` OPTIONS204 assertions separate。`external.html` writesonlysame-origin marker、captures`location.search` andrequestslocal marker；storeasHTML，openprotected`/html` top-level，assertexecution/origin/queryvisibility/noCSP/sandbox andexact source。Noexternalnetwork host。

- [ ] **Step 5: Write accessibility/mobile/copy-policy/lazy graph matrix**

Tests coverTabs arrows/Home/End/normalTab、Tooltip hover/focus/click/touch/Escape/outside、Dialog/Sheet focus/Escape/return、44px targets、320px `scrollWidth===clientWidth` andfull editor width、200% zoom、reduced motion computed durations0、diff non-color prefixes、en/zh switch、system/light/dark/noStorage。Network graph：initial noCrepe/micromark/diff；visual loadsCrepe only；client preview loadsMarkdown only；diff loadsworker only。Closed-help visible-text scan rejectsallbanned prose/sample copy。Credential scan onlyallowscurrent location、representation href andexplicit clipboard result。No status-only requests。

`accessibility.spec.ts` imports the sole runner directly and executes the scan，rather than recording an unevaluated checklist：

```ts
import AxeBuilder from "@axe-core/playwright";

async function expectNoAxeViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
}
```

Create real-Wrangler fixtures and callthis helper aftereach branch reaches settled visible state：create、password、application error、ordinary text、ordinary Markdown、armed-view-once、consumed text、consumed Markdown、not-found、delete-uncertain andread-only`/md`。The delete-uncertain fixture may abort the real app’s already-dispatched DELETE in thepage，butmust notmock thedocument orserver response；allother branch setup usesreal routes/mutations。Run thebranch table in`chromium`、`firefox` and`webkit` focused commands。Do not addanother axe/accessibility runner。

`accessibility-manual.md` defines four separate execution checklists。Each tracked input receipt under`test/e2e/evidence/accessibility/` hasthis exact shape，and`record-accessibility` copiesitsvalidated row plusinput path intothe aggregate：

```ts
type AccessibilityCategory =
  | "screen-reader"
  | "contrast"
  | "zoom-reflow-200"
  | "physical-touch";
type ManualAccessibilityReceipt = {
  schemaVersion: 1;
  releaseDate: string;
  category: AccessibilityCategory;
  status: "passed" | "failed";
  testedAt: string;
  tester: string;
  environment: {
    os: string;
    osVersion: string;
    browser: string;
    browserVersion: string;
    tool: string;
    toolVersion: string;
    device: string;
  };
  notes: string;
};
type ManualAccessibilityEvidence = {
  schemaVersion: 1;
  releaseDate: string;
  rows: Array<Omit<ManualAccessibilityReceipt, "schemaVersion" | "releaseDate"> & {
    evidence: string;
  }>;
};
```

The screen-reader row exercises heading/landmark announcement、everyfield/error/help relationship、Tabs/Sheet/Dialog focus、polite status changes anddiff prefixes withan actual screen reader such asNVDA onWindows orVoiceOver onmacOS/iOS。The contrast row records measured light/dark normal-text、large-text、non-text control andfocus-indicator ratios againstWCAG2.2AA。The zoom row runs browser zoomat200% andrecordsreflow、content availability、focus visibility andabsence ofpage-level horizontal scrolling。The physical-touch row usesreal touch hardware andruns44px Help、Sheet、Dialog、Create andEdit flows；mouse emulation doesnotqualify。Every row needsexact environment/tool versions anditsown tracked receipt。`record-accessibility --release-date --category --evidence` requiresallthree explicit arguments，requires thecommand’s current instant andreceipt`testedAt` inside thedefined interval，andrequires receipt/aggregate releaseDate equality、argument/category equality、allknown keys、nonempty environment/tester/notes andan existing in-tree evidence path；it replaces onlythat category atomically anddoesnotaccept duplicates orextra fields。`scripts/verify-release-evidence.mjs` rejects a missing orduplicate category，`failed` status，empty version/tester/notes，missing orout-of-tree artifact，artifact/content mismatch orout-of-window timestamp；the manual schema hasno unavailable status。`accessibility-manual.md` may record that apreferred platform/tool wasunavailable，butthat note doesnotcreate orsatisfy aJSON category row。Use another actual available platform/tool orblock release，never record unavailable aspass。

- [ ] **Step 6: Acquire exact release-time branded browser and manual accessibility evidence**

Branded browser history is not acquired by `npx playwright install`。Provision these release environments before this step：`windows-chrome-current`、`windows-chrome-previous`、`windows-edge-current`、`windows-edge-previous`、`windows-firefox-current` and`windows-firefox-previous` are isolated Windows11 runners whose named target branded binary ispreinstalled at the path exported as`CFPB_BROWSER_EXECUTABLE` andwhose auto-update isdisabled forthe run。`macos-safari-current` and`macos-safari-previous` areactual Mac runners whose OS contains thetarget Safari major at`/Applications/Safari.app`。A historical branded binary ormatching historical macOS runner thatcannot beprovisioned blocksChrome/Edge/Firefox andmay produceonly theexplicit Safari unavailable row；it isnot replaced by aPlaywright download。Never run orclaim Safari onWindows。

First，onthe release controller with`CFPB_RELEASE_DATE` setto the intended UTC release date，run theowned all-or-nothing source acquisition。This command mustcomplete beforeany capture andisrerun fromscratch ratherthanediting generated targets：

```powershell
node scripts/browser-evidence.mjs acquire-targets --release-date $env:CFPB_RELEASE_DATE
```

Distribute byte-identical read-only copies ofthe initialized matrix andfour source artifacts toeach isolated runner，butkeepone writable aggregate onthe release controller；nevermerge independently edited matrices。Every later command uses thatsame explicit releaseDate andrefuses acontent mismatch。On each Windows runner，Terminal A runs：

```powershell
npm ci
npm run dev:e2e
```

Terminal B sets the exact installed binary path，then uses the matching literal command fromthis list：

```powershell
# Run capture on the named runner; after its artifacts return, run record-pass on the release controller.
$env:CFPB_RELEASE_DATE = (Get-Content test/e2e/browser-matrix.json -Raw | ConvertFrom-Json).releaseDate
$env:CFPB_BROWSER_EXECUTABLE = "C:\release-browsers\chrome\current\chrome.exe"
node scripts/browser-evidence.mjs capture --release-date $env:CFPB_RELEASE_DATE --product Chrome --slot current --environment windows-chrome-current --executable-env CFPB_BROWSER_EXECUTABLE
node scripts/browser-evidence.mjs record-pass --release-date $env:CFPB_RELEASE_DATE --product Chrome --slot current --environment windows-chrome-current --evidence test/e2e/evidence/browser-matrix/chrome-current.json

$env:CFPB_BROWSER_EXECUTABLE = "C:\release-browsers\chrome\previous\chrome.exe"
node scripts/browser-evidence.mjs capture --release-date $env:CFPB_RELEASE_DATE --product Chrome --slot previous --environment windows-chrome-previous --executable-env CFPB_BROWSER_EXECUTABLE
node scripts/browser-evidence.mjs record-pass --release-date $env:CFPB_RELEASE_DATE --product Chrome --slot previous --environment windows-chrome-previous --evidence test/e2e/evidence/browser-matrix/chrome-previous.json
$env:CFPB_BROWSER_EXECUTABLE = "C:\release-browsers\edge\current\msedge.exe"
node scripts/browser-evidence.mjs capture --release-date $env:CFPB_RELEASE_DATE --product Edge --slot current --environment windows-edge-current --executable-env CFPB_BROWSER_EXECUTABLE
node scripts/browser-evidence.mjs record-pass --release-date $env:CFPB_RELEASE_DATE --product Edge --slot current --environment windows-edge-current --evidence test/e2e/evidence/browser-matrix/edge-current.json
$env:CFPB_BROWSER_EXECUTABLE = "C:\release-browsers\edge\previous\msedge.exe"
node scripts/browser-evidence.mjs capture --release-date $env:CFPB_RELEASE_DATE --product Edge --slot previous --environment windows-edge-previous --executable-env CFPB_BROWSER_EXECUTABLE
node scripts/browser-evidence.mjs record-pass --release-date $env:CFPB_RELEASE_DATE --product Edge --slot previous --environment windows-edge-previous --evidence test/e2e/evidence/browser-matrix/edge-previous.json
$env:CFPB_BROWSER_EXECUTABLE = "C:\release-browsers\firefox\current\firefox.exe"
node scripts/browser-evidence.mjs capture --release-date $env:CFPB_RELEASE_DATE --product Firefox --slot current --environment windows-firefox-current --executable-env CFPB_BROWSER_EXECUTABLE
node scripts/browser-evidence.mjs record-pass --release-date $env:CFPB_RELEASE_DATE --product Firefox --slot current --environment windows-firefox-current --evidence test/e2e/evidence/browser-matrix/firefox-current.json
$env:CFPB_BROWSER_EXECUTABLE = "C:\release-browsers\firefox\previous\firefox.exe"
node scripts/browser-evidence.mjs capture --release-date $env:CFPB_RELEASE_DATE --product Firefox --slot previous --environment windows-firefox-previous --executable-env CFPB_BROWSER_EXECUTABLE
node scripts/browser-evidence.mjs record-pass --release-date $env:CFPB_RELEASE_DATE --product Firefox --slot previous --environment windows-firefox-previous --evidence test/e2e/evidence/browser-matrix/firefox-previous.json
```

For each command pair，set`CFPB_BROWSER_EXECUTABLE` tothe corresponding runner’s real installed path andrunits`capture` line there。`capture` uses`child_process.spawn(executablePath,["--version"],{shell:false})` torunthat exact executable’s version command，normalizes andcompares itsexact version andmajor withthe matching target，writes`test/e2e/evidence/browser-matrix/<product>-<slot>-version.txt`，thenlaunches that executable at`http://127.0.0.1:8787/`。The tester executes every`browser-manual.md` check andwrites this exact evidence shape：

```ts
type BrandedBrowserSmoke = {
  schemaVersion: 1;
  releaseDate: string;
  product: BrowserProduct;
  slot: BrowserSlot;
  testedAt: string;
  tester: string;
  environment: BrandedEnvironment;
  checks: Array<{
    id: "root-create" | "password-post-hard-refresh" | "ordinary-edit-autosave" | "tabs-sheet" | "raw-html-md-file" | "delete-root-handoff";
    status: "passed" | "failed";
    notes: string;
  }>;
};
type SafariRunnerUnavailable = {
  schemaVersion: 1;
  releaseDate: string;
  product: "Safari";
  slot: BrowserSlot;
  testedAt: string;
  reporter: string;
  environment: "macos-safari-current" | "macos-safari-previous";
  targetSourceArtifact: string;
  failure: "runner-not-provisioned";
  notes: string;
};
type EngineCoverageReceipt = {
  schemaVersion: 1;
  releaseDate: string;
  project: "chromium" | "firefox" | "webkit";
  exactVersion: string;
  status: "passed";
  testedAt: string;
  report: string;
};
```

Every capture subcommand requires`--release-date` equal tothe matrix date andvalidates current time beforereading/writing a version artifact orlaunching thebrowser。Afterthe runner returns itsversion text andsmoke JSON tothe controller’s matching tracked paths，the controller runs thecorresponding`record-pass` line showninthe pair。`record-pass` also requires current time andthe receipt’s canonical`testedAt` inside theinterval，thenaccepts onlyan existingin-tree JSON artifact withthat same releaseDate，exact known keys，exact matching product/slot/environment，nonempty tester，andexactly oneofeach six check IDs allpassed。It updates onlythe matching matrix row atomically withthe receipt timestamp、captured runtime version andartifact paths；it doesnotaccept atyped version orfree-form success string。The script usesNode stdlib anddoesnot addabrowser automation dependency。

On each actual Safari Mac runner，Terminal A runs`npm ci` and`npm run dev:e2e`；Terminal B runs：

```bash
# Run capture-safari on the named runner; after its artifacts return, run record-pass on the release controller.
CFPB_RELEASE_DATE="$(node -p "JSON.parse(require('node:fs').readFileSync('test/e2e/browser-matrix.json','utf8')).releaseDate")"
node scripts/browser-evidence.mjs capture-safari --release-date "$CFPB_RELEASE_DATE" --slot current --environment macos-safari-current
node scripts/browser-evidence.mjs record-pass --release-date "$CFPB_RELEASE_DATE" --product Safari --slot current --environment macos-safari-current --evidence test/e2e/evidence/browser-matrix/safari-current.json
node scripts/browser-evidence.mjs capture-safari --release-date "$CFPB_RELEASE_DATE" --slot previous --environment macos-safari-previous
node scripts/browser-evidence.mjs record-pass --release-date "$CFPB_RELEASE_DATE" --product Safari --slot previous --environment macos-safari-previous --evidence test/e2e/evidence/browser-matrix/safari-previous.json
```

Run each`capture-safari` line onlyonits named runner。It runs exact`/usr/bin/safaridriver --version` forversion capture and`/usr/bin/open -a Safari http://127.0.0.1:8787/` formanual execution；afterthe runner returns itsversion text andsmoke JSON，runthat slot’s`record-pass` line onthe release controller。If one named Mac runner doesnotexist，the release controller may run onlythis command forits corresponding row froman available control host：

```bash
CFPB_RELEASE_DATE="$(node -p "JSON.parse(require('node:fs').readFileSync('test/e2e/browser-matrix.json','utf8')).releaseDate")"
node scripts/browser-evidence.mjs record-safari-unavailable --release-date "$CFPB_RELEASE_DATE" --slot current --environment macos-safari-current --evidence test/e2e/evidence/browser-matrix/safari-current-runner-unavailable.json
node scripts/browser-evidence.mjs record-safari-unavailable --release-date "$CFPB_RELEASE_DATE" --slot previous --environment macos-safari-previous --evidence test/e2e/evidence/browser-matrix/safari-previous-runner-unavailable.json
```

Use onlythe applicable slot command。`record-safari-unavailable` accepts onlythe exact`SafariRunnerUnavailable` shape atanin-tree path；it requires theexplicit releaseDate andcurrent/receipt times inside theinterval，exact Safari product/slot/environment，nonempty reporter/notes，`runner-not-provisioned` failure and`targetSourceArtifact` equal tothe matching derived target。It rejects every non-Safari product andatomically writes onlythat unavailable row。

Acquire separate bundled-engine receipts andingest each manual accessibility receipt withthese exact commands：

```powershell
$releaseDate = (Get-Content test/e2e/browser-matrix.json -Raw | ConvertFrom-Json).releaseDate
node scripts/browser-evidence.mjs record-engine --release-date $releaseDate --project chromium
node scripts/browser-evidence.mjs record-engine --release-date $releaseDate --project firefox
node scripts/browser-evidence.mjs record-engine --release-date $releaseDate --project webkit
node scripts/browser-evidence.mjs record-accessibility --release-date $releaseDate --category screen-reader --evidence test/e2e/evidence/accessibility/screen-reader.json
node scripts/browser-evidence.mjs record-accessibility --release-date $releaseDate --category contrast --evidence test/e2e/evidence/accessibility/contrast.json
node scripts/browser-evidence.mjs record-accessibility --release-date $releaseDate --category zoom-reflow-200 --evidence test/e2e/evidence/accessibility/zoom-reflow-200.json
node scripts/browser-evidence.mjs record-accessibility --release-date $releaseDate --category physical-touch --evidence test/e2e/evidence/accessibility/physical-touch.json
node scripts/verify-release-evidence.mjs
```

Each`record-engine` validates theexplicit releaseDate andstart clock，runs that exact Playwright project againstsupervised Wrangler withthe JSON reporter，captures`browser.version()` fromthe project fixture，thenrevalidates completion clock。Onlyanexit0 run completed inside theinterval atomically writes its exact`EngineCoverageReceipt` under`test/e2e/evidence/engine/<project>.json` andcorresponding matrix row，with`testedAt = new Date().toISOString()` atcompletion；crossingthe interval writesnothing。Execute all four manual checklists onavailable actual tools/devices beforetheir record commands。Any missing/failing Chrome、Edge、Firefox row，malformed/extra browser row，missing/stale engine report，source-derivation mismatch ormissing/failed/stale manual category exitsnonzero。

- [ ] **Step 7: Run focused RED/GREEN and full browser checks**

Initial RED beforeimplementation integration shouldidentify missingselectors/behaviors；afterTask15 integration:

```powershell
npx playwright install chromium firefox webkit
npx playwright test test/e2e/create-password.spec.ts --project=chromium
npx playwright test test/e2e/ordinary-sync.spec.ts --project=chromium
npx playwright test test/e2e/view-once-representations.spec.ts --project=chromium
npx playwright test test/e2e/accessibility.spec.ts --project=chromium
npx playwright test test/e2e/accessibility.spec.ts --project=firefox
npx playwright test test/e2e/accessibility.spec.ts --project=webkit
npx playwright test test/e2e/accessibility.spec.ts --project=mobile-320
npm run build
npx vitest run --testTimeout=600000
npx playwright test
$releaseDate = (Get-Content test/e2e/browser-matrix.json -Raw | ConvertFrom-Json).releaseDate
node scripts/browser-evidence.mjs record-engine --release-date $releaseDate --project chromium
node scripts/browser-evidence.mjs record-engine --release-date $releaseDate --project firefox
node scripts/browser-evidence.mjs record-engine --release-date $releaseDate --project webkit
node scripts/browser-evidence.mjs self-test
node scripts/verify-release-evidence.mjs --self-test
node scripts/verify-release-evidence.mjs
```

Allbundled engines andeverybranch AxeBuilder scan pass。The final verifier independently requires exactly eightbranded target/row pairs andfourpassed manual accessibility categories；neither bundled engine output norSafari unavailable evidence isconverted intoanother row ormanual pass。

- [ ] **Step 8: Commit and independent review gate**

```powershell
git add playwright.config.ts scripts/browser-evidence.mjs scripts/verify-release-evidence.mjs test
git commit -m "test: add cross-browser paste journeys"
```

Independent Opus reviewsnetwork traces、real Wrangler usage、race controls、no external exfiltration、everybranch executable AxeBuilder scan、thefour fixed official-source adapters、independently derived nonadjacent-capable target selection、exact eight-row branded matrix schema、one release-date grammar/freshness interval、runtime version capture、pre-provisioned runner/manual command interface、four mandatory manual accessibility rows、keyboard/touch/320/reduced motion andalljourney assertions。Reviewer rerunsboth evidence-script self-tests、Chromium full、Firefox andWebKit accessibility focused sets，andthe final evidence verifier；`APPROVED` required。

---

### Task 17: Add Bundle, Provenance, Notice, Generated-Manifest, Wrangler Smoke, and Dry-Run Gates

**Files:**
- Modify: `scripts/build.mjs`, `src/build.test.ts`, `src/generated/assets.ts`
- Create: `docs/shadcn-source-integrity.json`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `scripts/smoke.ps1`
- Keep unchanged: `package.json`, `package-lock.json`, `wrangler.jsonc`, `worker.js`, `aioapi.js`

- [ ] **Step 1: Write RED build/source/license assertions**

`src/build.test.ts` readsVite projection andproduction bytes inNode test project。Assert：every deployed filename except exact `_headers` is content-hashed；no sourcemap/index/raw manifest indeploy tree；exact source path set/comments；`SidebarMenuSkeleton`/`skeleton.tsx` absent；local file SHA-256 matchesintegrity JSON；all exact package pins；no banned package；initial graph excludesMilkdown/micromark/diff；license file containsrequired source paths/pin/CLI andlicense markers。Add an executable manifest gate：

```ts
it("enforces the final client manifest and bundle budgets", async () => {
  const manifest = JSON.parse(await readFile("dist/client-assets-manifest.json", "utf8")) as ClientAssetsManifest;
  const pageNames = [
    "CreatePage", "ErrorPage", "LocalOnlyPastePage", "MarkdownPage", "OrdinaryPage", "PasswordPage",
  ] as const;
  const byPath = new Map(manifest.files.map((file) => [file.path, file]));
  const gzip = (group: keyof ClientAssetsManifest["groups"]): number =>
    manifest.groups[group].reduce((total, path) => total + byPath.get(path)!.gzipLevel9Bytes, 0);
  const initialJs = manifest.groups.initial.filter((path) => path.endsWith(".js"));
  const initialCss = manifest.groups.initial.filter((path) => path.endsWith(".css"));
  const gzipPaths = (paths: string[]): number => paths.reduce((total, path) => total + byPath.get(path)!.gzipLevel9Bytes, 0);
  const initial = new Set(manifest.groups.initial);
  const applicationPages = new Set(manifest.groups.applicationPages);
  expect(manifest.schemaVersion).toBe(1);
  expect(Object.keys(manifest.applicationPageRoots).sort()).toEqual(pageNames);
  expect(Object.keys(manifest.applicationPageClosures).sort()).toEqual(pageNames);
  expect(applicationPages.size).toBe(manifest.groups.applicationPages.length);
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
  expect(gzipPaths(initialJs)).toBeLessThanOrEqual(250 * 1024);
  expect(gzipPaths(initialCss)).toBeLessThanOrEqual(80 * 1024);
  expect(gzip("markdown")).toBeLessThanOrEqual(150 * 1024);
  expect(gzip("crepe")).toBeLessThanOrEqual(1.5 * 1024 * 1024);
  expect(gzip("diff")).toBeLessThanOrEqual(60 * 1024);
  expect(manifest.files.reduce((total, file) => total + file.bytes, 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(manifest.files.every((file) => !file.path.endsWith(".map"))).toBe(true);
});
```

Run RED:

```powershell
npm run build:client
npx vitest run src/build.test.ts -t "final client manifest|source integrity|third-party notices|bundle budgets"
```

Expected RED: finalmanifest/integrity/notices/budget metadata isabsent andthe first exact-file assertion fails。

- [ ] **Step 2: Produce the minimal GREEN machine-readable final build manifest**

Beforedeleting raw Vite manifest，`scripts/build.mjs` recursively followsstatic`imports` and`dynamicImports` andwritesignored`dist/client-assets-manifest.json` exactshape：

```ts
type ClientAssetsManifest = {
  schemaVersion: 1;
  entry: { js: string; css: string; diffWorker: string };
  applicationPageRoots: {
    CreatePage: string;
    PasswordPage: string;
    ErrorPage: string;
    LocalOnlyPastePage: string;
    MarkdownPage: string;
    OrdinaryPage: string;
  };
  applicationPageClosures: {
    CreatePage: string[];
    PasswordPage: string[];
    ErrorPage: string[];
    LocalOnlyPastePage: string[];
    MarkdownPage: string[];
    OrdinaryPage: string[];
  };
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
```

The six fixed source mappings are`CreatePage -> src/client/pages/CreatePage.tsx`、`PasswordPage -> src/client/pages/PasswordPage.tsx`、`ErrorPage -> src/client/pages/ErrorPage.tsx`、`LocalOnlyPastePage -> src/client/pages/LocalOnlyPastePage.tsx`、`MarkdownPage -> src/client/pages/MarkdownPage.tsx` and`OrdinaryPage -> src/client/pages/OrdinaryPage.tsx`。Beforedeleting the raw Vite manifest，`build.mjs` finds theunique raw record atkey`index.html` with`src==="index.html"` and`isEntry===true`，requires itsdirect`dynamicImports` toresolveexactly those six source records，andmaps each name tothe record’s emitted`file` in`applicationPageRoots`。Thus the raw Vite graph mustcontain the App-owned dynamic`OrdinaryPage` entry established atsource level byTask15。

`applicationPageClosures` hasexactly thesame six keys。Each value isthe named emitted root plusall files inits transitive Vite static`imports`/CSS/assets closure，minus`initial`，sorted byemitted path；the root mustappear inits ownclosure andnoother emitted page root mayappear。`applicationPages` isexactly thededuplicated union ofthose six arrays。Every closure path mustexist in`files` and`applicationPages` andmustbeabsent from`initial`；shared emitted chunks mayappear inmorethanone per-page closure butcountonce ineach final budget set。For`OrdinaryPage` specifically，the final test requires its emitted root andfull incremental closure in`applicationPages` andoutside`initial`，andrequires its emitted root outsideallfive nonordinary closures。

Task17 treats theemitted graph onlyasfile reachability/classification；`use-paste-page`、`OrdinaryPastePage` andother source module names areoutsideits assertions。Vite may inline bothordinary modules intothe`OrdinaryPage` chunk orproduce shared chunks；do notadd`manualChunks`、artificial dynamic imports orany other chunk split toretain source boundaries。Task15’s`App.module-graph.test.ts` remains thesole proof that`OrdinaryPage.tsx` directly statically importsboth ordinary modules andthatnonordinary source closures excludeordinary controllers。

`files` enumerates every regular file actually deployed under `dist/assets`, including exact `_headers` and every hashed JS/CSS/worker asset but excluding the outside evidence file `dist/client-assets-manifest.json`; therefore the raw-total assertion includes `_headers`. Only `_headers` is exempt from the content-hashed filename rule, and it belongs to no reachability group. Discover the complete graph through manifest `imports` and `dynamicImports`, but compute each budget as incremental network files: `initial` is the entry’s transitive static closure；`markdown` is the union, across Ordinary/LocalOnly/Markdown call sites, of each micromark/GFM root’s static closure after subtracting `initial` plus that call site’s page closure；this conservative union is the measured ≤150 KiB group。`crepe` is its JS plus common-style CSS static closure minus `initial` and the OrdinaryPage closure。`diff` is the worker closure minus `initial` and the OrdinaryPage closure，because History need not have loaded Crepe。Deduplicate by emitted path inside each final set；no array may repeat a path。Initial matches spec18。Fail build onunclassified dynamic root、duplicate file、missing generated path orany closure/root/group inconsistency。Use `zlib.gzipSync(bytes,{level:9})`；`sha256` is the exact 64-character lowercase hexadecimal result of `crypto.createHash("sha256").update(bytes).digest("hex")`。

Exact gates：initialJS≤250KiBgzip；initialCSS≤80KiB；newMarkdown graph≤150KiB；newCrepe graph≤1.5MiB；diff graph≤60KiB；all`dist/assets` files≤8MiB uncompressed；no sourcemap；everyserved filename content-hashed except`_headers`。`src/generated/assets.ts` is regenerated frommanifest’sresolvedentry andcommitted finalbytes。

- [ ] **Step 3: Freeze copied-source integrity and notices**

`docs/shadcn-source-integrity.json` listsrepository、commit、style、block、CLI andone object peractual local copied/adapted path withupstreamPath/local SHA-256；doesnotlistpruned skeleton。Build test computescurrent bytes andcompares。

`THIRD_PARTY_NOTICES.md` enumeratestwo block paths、each materialized primitive、fullhook path、`shadcn@4.21.0` andcommit；then containsfull shadcn MIT beginning`Copyright (c) 2023 shadcn`、direct MIT notices、Lucide ISC、Apache-2.0 forCVA/TypeScript andanydistributed dependency NOTICE text。No in-product credit isadded。

- [ ] **Step 4: Implement supervised `scripts/smoke.ps1`**

Script firstrunsbuild+Vitest，then`Start-Process npx.cmd wrangler dev --local --port 8787 --show-interactive-dev-session=false`，30-second readiness loop，and`finally` executes`taskkill.exe /PID $server.Id /T /F`。Assertions：rootReact shell；JSON create；raw exactbody；strongETag + matching304 headers/body；settings/password/history round-trip；protected view-once first200/second404；HTML exactbody/noCSP；`/ip-trace` body/header reflection；`/api` and`/delete/:id`404。Noexternal origin。Aftercleanup verifyport8787 hasno childserver。

- [ ] **Step 5: Run focused and full release-tooling GREEN checks**

```powershell
npm ci
npm run build:client
npx vitest run src/build.test.ts -t "final client manifest|source integrity|third-party notices|bundle budgets"
npm run build
npx vitest run --testTimeout=600000
npm run smoke
npx wrangler types --check
npx wrangler deploy --dry-run --outdir .wrangler-dist
```

Recorddry-run`Total Upload` andassert<64MiB；inspect`.wrangler-dist` forno duplicate server-sideCrepe/micromark/diff/source maps。Do notrunrealdeploy。

- [ ] **Step 6: Commit and independent review gate**

```powershell
git add scripts/build.mjs src/build.test.ts src/generated/assets.ts docs/shadcn-source-integrity.json THIRD_PARTY_NOTICES.md scripts/smoke.ps1
git commit -m "build: add release and bundle gates"
```

Independent Opus validatesraw Vite entry dynamic-root discovery、all six emitted per-page closures andtheir final classifications、manifest graph math、gzip/raw budgets、hash/source set、license completeness、supervised cleanup、smoke assertions、dry-run only andunchangedworker/aioapi/package/config。The review leavesall source import ownership exclusively toTask15 andusesnooutput-chunk assertion torepresent those source imports；it mustnotrequest chunk splitting forordinary modules。`APPROVED` required。

---

### Task 18: Pass Every Release Gate, Then Delete the Legacy Worker

**Files:**
- Create test: `src/legacy-removal.test.ts`
- Delete: `worker.js`
- Keep unchanged: `aioapi.js`
- Production/config modifications: none unlessa newRED regression firstdemonstrates a release defect；such fixes must return tothe owning task andreceivefresh review beforethis task resumes。

At the start ofStep1 pre-deletion，Step4 final candidate andStep6 final integration，run this exact ancestry-and-source gate inthat current worktree beforeany reusable release command：

```powershell
foreach ($candidate in @("98ed2d1", "2da846c", "bfaac29")) {
  git merge-base --is-ancestor $candidate HEAD
  $code = $LASTEXITCODE
  if ($code -eq 0) { throw "$candidate is an ancestor of HEAD" }
  if ($code -ne 1) { throw "git merge-base --is-ancestor $candidate HEAD failed with exit $code" }
}
foreach ($symbol in @(
  "createTabsController",
  "function tabRecords",
  "function applyTabSelection",
  "function initializeTablists",
  "appDocuments = new WeakMap",
  "hydratePasteSource",
  "__DIFF_WORKER_URL__"
)) {
  git grep -n -F -e $symbol -- src
  $code = $LASTEXITCODE
  if ($code -eq 0) { throw "superseded source symbol remains: $symbol" }
  if ($code -ne 1) { throw "git grep failed for $symbol with exit $code" }
}
$global:LASTEXITCODE = 0
```

Exit0 from`merge-base --is-ancestor` isafailure becauseit provescandidate ancestry；exit1 istherequired non-ancestor result；everyother code isGit failure andmustblock。The exact source scans remainmandatory becausea copied controller canexist withoutcandidate ancestry；do not replace either gate withthe other。

- [ ] **Step 1: Run all pre-deletion release gates on the integrated approved tree**

First run the mandatory ancestry-and-source block above，then：

```powershell
npm ci
npm run build
npx vitest run --testTimeout=600000
npx playwright test
node scripts/browser-evidence.mjs self-test
node scripts/verify-release-evidence.mjs --self-test
node scripts/verify-release-evidence.mjs
npm run smoke
npx wrangler types --check
npx wrangler deploy --dry-run --outdir .wrangler-dist
```

Every command mustexit0 beforedeletion。The verifier mustparse thefour fixed official stable-source artifacts，recompute thehighest two distinct majors bythe Task16 numeric-descending rule，andmatchall eight targets。It mustalso reportexactly eight product/slot rows；all sixChrome/Edge/Firefox rows passed；each Safari row passed orhonestly not-available underits sole exception；three separate engine rows passed；screen-reader、contrast、zoom-reflow-200 andphysical-touch rows allpassed。Both aggregates mustsharethe exact valid releaseDate，andthe verifier clock plusevery retrieval/test timestamp mustbeinside`[D - 7 * 86_400_000, D + 86_400_000)`；missing、failed、stale、malformed orsource-unbound evidence blocksdeletion。Also recordtest counts、bundle groups、static total anddry-run upload。Ifany gate fails，do notdeleteworker；route thefix toitsowner task withRED test andre-review。

- [ ] **Step 2: Add the final RED legacy-removal test**

```ts
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { describe, expect, it } from "vitest";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("legacy removal", () => {
  it("ships only the module Worker and retains the ip-trace reference", async () => {
    expect(await exists("worker.js")).toBe(false);
    expect(await readFile("aioapi.js", "utf8")).toContain("request.clone().text()");
    expect(await readFile("wrangler.jsonc", "utf8")).toContain('"main": "src/index.ts"');
    expect(await readFile("src/index.ts", "utf8")).not.toContain("addEventListener(\"fetch\"");
  });
});
```

Run:

```powershell
npx vitest run src/legacy-removal.test.ts
```

Expected RED: `worker.js` still exists，证明gate会捕获premature retention。

- [ ] **Step 3: Delete only the obsolete file and make focused test GREEN**

```powershell
Remove-Item "worker.js"
npx vitest run src/legacy-removal.test.ts
```

Confirm`git diff --name-status` showsonlynewtest anddeletedworker for this task。

- [ ] **Step 4: Run fresh final evidence; do not reuse Step 1 output**

First rerun the mandatory ancestry-and-source block above againstthe candidate HEAD，then：

```powershell
npm ci
npm run build
npx vitest run --testTimeout=600000
npx playwright test
node scripts/browser-evidence.mjs self-test
node scripts/verify-release-evidence.mjs --self-test
node scripts/verify-release-evidence.mjs
npm run smoke
npx wrangler types --check
npx wrangler deploy --dry-run --outdir .wrangler-dist
git diff --check
git status --short
```

Expected：allexit0；onlyTask18 files pending beforecommit；no Wrangler/Node child on8787；no realdeploy/push。

- [ ] **Step 5: Commit and independent review gate**

```powershell
git add src/legacy-removal.test.ts worker.js
git commit -m "chore: remove legacy worker after release gates"
```

Independent Opus 1M max reviews the complete approved range from `PLAN_HEAD` through Task18 againstthe68-ID table below，checksTask18 onlydeletedobsolete implementation，rerunsallthree inverted ancestry checks、thecandidate-symbol source scans、thefocused legacy test、both release-pipeline self-tests andthe final release-evidence verifier，andconfirms fresh official-source-bound evidence。Any finding returns tooriginalowner forRED/fix/re-review；thecandidate may integrate onlyafterTask18 review says`APPROVED`。

- [ ] **Step 6: Cherry-pick the approved candidate and verify the final integration itself**

In thefeature worktree，cherry-pick onlythe approved Task18 commit，rerun the mandatory ancestry-and-source block above againstthe integrated HEAD，then runfresh commands withoutreusing prior output：

```powershell
npm ci
npm run build
npx vitest run --testTimeout=600000
npx playwright test
node scripts/browser-evidence.mjs self-test
node scripts/verify-release-evidence.mjs --self-test
node scripts/verify-release-evidence.mjs
npm run smoke
npx wrangler types --check
npx wrangler deploy --dry-run --outdir .wrangler-dist
git diff --check
git status --short
```

Restore nothing：Task17 already owns thefinal generated projection，anddeterministicTask18 rebuild mustleaveit byte-identical。Completion requiresallcommands exit0，empty`git status --short`，no process on8787，andno realdeploy/push。

## Requirement-to-Task-and-Automated-Check Traceability（68/68）

Every row is a release gate。Test title strings below arefixed acceptance names；implementation may group them inone`describe` butmust keepthe named`it` so a focused`-t` command canlocateeach requirement。

| ID | Exact task ownership | Automated check / command |
|---|---|---|
| C01 | reviewed domain；Tasks 17 and 18 config gates | `src/build.test.ts` “allows only one PASTE_DB business binding and no coordination stack”；`npm run build` |
| C02 | Tasks 3 and 4 | `src/http.test.ts` “consumes every authorized content-bearing GET only after preparation”；MCP baseline “consumes paste_get once”；`npx vitest run src/http.test.ts src/mcp.test.ts` |
| C03 | Task 4 | `src/http.test.ts` “orders render before all five deletes before response”；injected failures |
| C04 | Tasks 10, 12, 15, and 16 | `App.browser.test.tsx` “enters irreversible local-only capability for every valid view-once read”；Playwright view-once journey |
| C05 | reviewed domain baseline；Task 18 full gate | `src/pastes.test.ts` “accepts the documented concurrent custom-ID last-write-wins race” |
| C06 | reviewed domain plus Task 4 | `src/pastes.test.ts` ID reuse aftercleanup；HTTP create afterexpiry/delete |
| C07 | reviewed domain plus Task 4 | legacy read/mutation matrix in`pastes.test.ts` andallrepresentations in`http.test.ts` |
| C08 | Tasks 6, 10, 15, and 16 | bootstrap/API/controller credential scans；Playwright metachar password journey |
| C09 | Task 4 | `src/http.test.ts` “applies direct-representation password and duplicate-query rules uniformly” |
| C10 | reviewed domain plus Tasks 12 and 14 | password boundary domain tests；React inlinevalidation browser tests |
| C11 | reviewed domain plus Tasks 3 and 14 | API/MCP set/change/clear matrix andPasswordPanel tests |
| C12 | Tasks 4 and 16 | exact HTML response headers/body plusPlaywright same-origin script marker |
| C13 | Task 16 | `view-once-representations.spec.ts` active HTML requests local external fixture withoutrewrite |
| C14 | reviewed renderer plus Tasks 2, 12, and 13 | `render.test.ts` fullGFM safety；SafeMarkdown andclient preview tests |
| C15 | Tasks 8, 13, and 17 | build graph budget test andvisual-mode Playwright lazy request |
| C16 | reviewed Markdown plus Task 13 | “mode switch preserves exact source and creates no save”；onevisual transaction autosaves |
| C17 | Tasks 7, 14, and 16 | history list/diff/snapshot/large threshold tests andordinary journey |
| C18 | reviewed domain plus Task 14 | four saves→threeprior；settings/password/no-op do notcreatehistory |
| C19 | Tasks 12, 13, and 16 | bothformat fixtures exposeboth editors andallrepresentations |
| C20 | Tasks 3 and 4 | canonical API matrix；`/api` legacy path404 |
| C21 | reviewed domain plus Tasks 10, 15, and 16 | stale browser mutation409/draft retained；explicit LWW Overwrite/curl/MCP omitted version |
| C22 | reviewed MCP plus Task 18 | MCP modern+legacy+eight-tool suite remainsgreen |
| C23 | reviewed MCP baseline；Task 18 full gate | absent/same/cross/null Origin tests andno bearer config scan |
| C24 | Tasks 4 and 17 | `/ip-trace` deep equality/unit andsmoke reflection |
| C25 | reviewed domain plus Tasks 10, 12, and 14 | seven UI options、fourAPI forms、fresh-relative Reconcile full rewrite test |
| C26 | reviewed domain plus Task 3 | ID boundary/reserved/case/immutable/reuse tests |
| C27 | Tasks 11 and 16 | recursive dictionary parity、browser language/manual switch journey |
| C28 | Tasks 6, 11, and 16 | theme controller/remount/noStorage andactiveHTML unaffected |
| C29 | Tasks 11, 16, and 18 | four fixed official stable histories derive two newest distinct majors；exact eight fresh branded current/previous rows withonlySafari unavailable exception；separate Chromium/Firefox/WebKit engine reports；everybranch AxeBuilder scans；four same-release-date passed manual category rows；320/touch/focus/zoom/contrast checks |
| C30 | Tasks 17 and 18 | exact Wrangler config、local smoke、types check、dry-run only |
| C31 | Tasks 4 and 17 | legacy routes404/noKV mutation inunit+smoke |
| C32 | Tasks 2, 4, 12, and 16 | password bootstrap containsno summary；POST form zero fields reachesauthorization andreturns403，one wrongreturns403，duplicate/unknown returns422，one correctreturns302 exact query |
| C33 | Tasks 4 and 16 | activeHTML reads`location.search` andcanissue same-origin fetch；noCSP/sandbox |
| C34 | Tasks 15 and 16 | redirect password becomespage memory andallrequests carrydecoded exact value |
| C35 | Tasks 3 and 17 | `/read` GET/HEAD/POST current-version ETag/no304 tests andsmoke resource ETag distinction |
| T01 | reviewed domain plus Task 17 | direct KV main plaintext andbusiness metadata sibling tests/config scan |
| T02 | reviewed domain plus Task 10 | fixed ring slots/common physical expiration andrelative reconcile rewrite |
| T03 | Tasks 5, 13, and 15 | fake1s/IME/single-flight/coalescing pluscomputed monospace editor |
| T04 | Tasks 5, 10, and 15 | failure draft preservation、accepted alias、content reconcile target/baseline/third snapshot |
| T05 | Tasks 12 through 16 | title/drop/copy/wrap/file/Delete UI andrealbrowser journey |
| T06 | reviewed domain/MCP plus Tasks 3, 4, and 15 | full protected route/tool/mutation matrix |
| T07 | Tasks 12 and 16 | create201 location stays`/` andnetwork trace hasno resource prefetch |
| T08 | reviewed domain plus Task 10 | 0..3 revision expiry rewrite andsame-seconds uncertain Reconcile freshfull rewrite |
| T09 | Tasks 2, 6, 11, 15, and 16 | credential scan withonlythreeexplicit URL transport exceptions |
| T10 | every task plus Tasks 17 and 18 | RED/GREEN history、real Wrangler smoke andfresh release commands |
| T11 | Tasks 10, 14, and 15 | deterministic content/metadata/password/Delete uncertain/proven recovery matrices |
| SY01 | Tasks 9 and 17 | dependency/route/runtime scan rejectsallpush/hidden-polling alternatives；browser timer ownsreads |
| SY02 | Tasks 9, 12, and 15 | sync controller instantiatedonlyordinary branch；zero requests onallotherbranches |
| SY03 | Task 9 | fake-clock2,999/3,000、299,999/300,000、slow settle、99 ceiling |
| SY04 | Tasks 9, 10, and 15 | edit/IME/mutation abort races、old response effect zero、single concurrency counters |
| SY05 | Tasks 3, 9, and 17 | strong conditional HTTP matrix、no-store andno newendpoint |
| SY06 | Tasks 3 and 4 | valid/malformed validator ignored byview-once GET；HEAD no consume/no304 |
| SY07 | Tasks 9, 10, and 15 | full ordering fixture；onlycurrent guarded newer autosync applies；Reload separate guard |
| SY08 | Tasks 9, 10, and 15 | repeated stale candidate neverapplies；Use remote/Keep/Retry exact behavior |
| SY09 | Tasks 10 and 15 | seven-field derived retry capture、offscreen/rollback/reverse resolve、zero autosave/history writes |
| SY10 | Tasks 9 and 15 | 200/304/403/404/409/503/network/offline andretired validview-once precedence |
| SY11 | Tasks 10 and 15 | single mutation slot、onecoalesced source、bound original content reconciliation token |
| SY12 | Tasks 7, 10, and 15 | history list/snapshot baseline invalidation reverse-settle suite |
| FE01 | Tasks 2, 8, and 11 through 15 | allapplication branches produced byoneReact root；App lazy-loadsTask15`OrdinaryPage` andonlythat adapter owns`usePastePage`；server no visible controls；pinned source checks |
| FE02 | Tasks 8 and 17 | exactmanifest/lock includingsole`@axe-core/playwright@4.13.0` runner、Vite budgets、form-package andother banned dependency scans |
| FE03 | Tasks 2, 6, 8, and 17 | discriminator/source/preview cardinality、pre-mount extraction、CSP/hashed assets、HTML exception |
| FE04 | Tasks 8, 13, and 18 | old app/styles/binders absent；inverted ancestry gates requireexit1 for`98ed2d1`、`2da846c`、`bfaac29` andcandidate-specific source-symbol scans remainempty；React Tabs observable cases |
| FE05 | Tasks 8, 11, and 16 | no sample/dashboard patterns；320 Sheet closes tofull-width editor/nooverflow |
| FE06 | Tasks 11 and 16 | closed visible-text scan plusHelp hover/focus/click/touch/Escape/outside/relationship |
| FE07 | Tasks 11 and 15 | four persistent records andexact timestamp selection/failure-after-success/remote-clean tests |
| FE08 | Tasks 10, 11, and 15 | closedActionKey/dictionary exhaustiveness、terminal once-settle、pure-toggle no-op、no popup/status request |
| FE09 | Tasks 6, 11, 16, and 18 | en/zh、theme、reduced motion、AA/focus/44px/reflow；branch-complete axe；official-source-derived exact-eight branded rows；the verifier clock、all source`retrievedAt` andbrowser/Safari-unavailable/engine/manual`testedAt` values satisfythe one release interval；all four manual categories passed andverified |
| FE10 | Tasks 8 and 17 | exact copied source/provenance/hash、pruned skeleton、complete notices/licenses |

## Final Self-Review Checklist for the Implemented Branch

- [ ] All35 `C`、11 `T`、12 `SY` and10 `FE` rows exist exactlyonce above（68 total）andtheir named tests arepresent/pass。
- [ ] No production/test instruction contains an incomplete stub、unbounded error fallback、secondrouter/state owner或copied domain validation。
- [ ] Everyparallel candidate set isfile-disjoint；theexplicit serial edges areWave1 `(1∥2)→3` andWave3 `6→7→8`，shared`http.ts` is3→4，App is8→11→15，generated/build files are8→17，andpackage/lock/i18n/render eachhaveoneactiveowner atatime。
- [ ] Everytask hascaptured RED、minimal GREEN、focused/full checks、focused commit andindependent Opus review evidence。
- [ ] EveryReact branch hard-refreshes fromserver-defined bootstrap；Task15’s source-graph test provesApp dynamically imports`OrdinaryPage`，onlythat adapter imports/calls`usePastePage` andrenders`OrdinaryPastePage`，andallfive nonordinary source closures excludeordinary controllers；Task17 provesonlythe Vite dynamic root andemitted closure classification withoutforcing source-level chunk boundaries；noReact Router、prefetch、storage persistence orduplicate controller survives。
- [ ] Everystrong/read-version ETag、password carrier、view-once consume、HEAD/OPTIONS/error/header anddirect HTML exception matches theexact tables；browser/direct OPTIONS is405 withroute-exact Allow，whileAPI、`/ip-trace` and`/mcp` keep theirseparate OPTIONS contracts。
- [ ] Everymutation/reconcile/delete/terminal transition preserves exactsource、credential andtimestamp authority；no pending action is silentlyreset。
- [ ] Vite manifest, generated assets, source integrity, notices, gzip/raw budgets andWrangler smoke/types/dry-run arefresh；allfour fixed official stable histories arevalid andderive thehighest two distinct majors；browser matrix hasexactly two bound branded rows perproduct，all non-Safari rows passed，both aggregates haveone exact releaseDate，andthe final verifier clock、all source`retrievedAt` plusbrowser/Safari-unavailable/engine/manual`testedAt` values satisfythe same interval；all four manual accessibility categories passed withmachine-readable evidence。
- [ ] Task18 pre-deletion、candidate-final andintegrated-final gates eachproveallthree superseded commits arenot ancestors andallcandidate-specific source symbols areabsent。
- [ ] `worker.js` wasdeleted onlyafterpre-deletion gates passed；`aioapi.js` remainsunchanged；no deploy orpush occurred；finalworktree isclean。
