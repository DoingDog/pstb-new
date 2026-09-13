# Cloudflare Pastebin 完整重写设计规格

日期：2026-09-12

状态：产品决策已冻结，可直接据此编写实施计划与测试。本文件是实现、测试和验收的唯一 binding authority；[`2026-09-13-pastebin-ui-direction.md`](./2026-09-13-pastebin-ui-direction.md) 只细化本文的视觉表达，冲突时以本文为准。

修订记录：

* 2026-09-13：根据用户补充要求和四份 2026-09-13 研究报告，将可见 application UI 全部改为 React 19.3.0 与固定的 shadcn/ui `new-york-v4/sidebar-11` 来源，改用 Vite 8.3.0 静态 client build；加入普通 paste 受控页的顺序轮询、strong response ETag、eventual-consistency rollback guard、常驻 operation status、hidden help 和相应 release gates；明确废止原 handwritten DOM/CSS workbench 与未集成 tabs candidate。未在本记录点名的 backend、KV、password、view-once、active HTML、MCP 和 `/ip-trace` 冻结决定保持不变。

## 1．决策优先级与术语

本规格按以下优先级解释需求：2026-09-13 用户补充要求最高，其次是 `requirements-clarifications.md` 中 2026-09-12 的用户确认与追加澄清，再次是原始任务、[Cloudflare browser sync 研究](../../research/2026-09-13-cloudflare-browser-sync-constraints.md)、[React template selection](../../research/2026-09-13-react-template-selection.md)、[frontend contract audit](../../research/2026-09-13-frontend-contract-audit.md)、[paste UI survey](../../research/2026-09-13-pastebin-ui-survey.md)和[基础研究](../../research/2026-09-12-cloudflare-pastebin-foundations.md)，最后才是旧实现行为。发生冲突时，本规格已经采用更高优先级结论，不得在实现阶段重新选择。

本文中的 paste 指一条正文及其同代 metadata 和最多三个历史正文。content-bearing read 指成功返回当前正文或由当前正文生成的表示形式的请求。管理请求即使读取 KV 正文以完成校验，只要响应不含正文，就不属于 content-bearing read。

时间一律使用 UTC。对外时间是带毫秒并以 `Z` 结尾的 RFC3339 字符串，例如 `2026-09-12T08:30:00.000Z`。内部 Unix expiration 使用整数秒。

## 2．目标

1. 用 ES module Cloudflare Worker 完整替换旧 `worker.js`，保留创建、查看、raw、HTML、文件下载、标题、有效期、拖放、复制、换行、编辑和删除能力，但只提供本规格定义的 canonical routes。
2. 正文始终以 `key=<id>` 的精确 plaintext value 存在唯一的 `PASTE_DB` KV namespace 中。
3. 在同一 namespace 的 sibling keys 中实现 plaintext password、view-once、可修改 settings 和三个 prior revisions。
4. 提供普通文本编辑与 Milkdown Crepe Markdown visual/source/preview 编辑，正文仍只有一份 canonical source。
5. 提供 1 秒防抖、单 in-flight、可处理冲突且不丢草稿的 autosave；在受控 ordinary paste page 上提供精确 active window、3 秒间隔、单 in-flight 的 browser polling autosync，并阻止 stale KV response 回滚页面。
6. 用 React 19.3.0 和固定来源的 shadcn/ui `new-york-v4/sidebar-11` 全面接管 application 的可见 UI，以 Vite 8.3.0 构建 hashed static assets；Worker 只返回最小 application shell 和 inert data transport。
7. 只提供现代 canonical HTTP API，并提供 MCP `2026-07-28` 与 SDK stateless legacy fallback。
8. 提供 `/ip-trace`，精确反射 `aioapi.js` 根端点所列字段。
9. 在英文与简体中文、light 与 dark、桌面与移动设备、键盘与辅助技术下完成可用界面，且说明、警告、限制和常识性提示只通过可访问的 question-mark help trigger 按需显示。
10. 使用 TDD，通过 Workers Vitest、React component tests、Playwright、Wrangler 本地 smoke 和 Wrangler dry-run 验证。

## 3．明确不做

1. 不使用 Durable Object、D1、R2、第二个 KV namespace、Queue、锁服务或任何其他持久化协调服务。
2. 不增加 account、owner token、session、cookie、全局 MCP token、rate limit、CAPTCHA、内容审核、报表、备份或审计日志。
3. 不保留 `GET|POST /api` 创建接口、旧 response shape、`GET /delete/:id` 或任何 destructive GET。
4. 不提供 binary paste。输入是有效 Unicode scalar sequence，KV 中保存其 UTF-8 表示。
5. 不把 `format` 当作访问限制或内容类型约束。
6. 不对 `/html/:id` 使用 sandbox、sanitizer、CSP 或 script 限制。
7. 不提供超过三个 prior revisions，不保存 settings snapshot，也不把当前正文算入 history。
8. 不提供跨地域严格一次消费或 custom ID 原子预留。Workers KV 不支持这些保证，[Cloudflare 明确说明 KV 是 eventual consistency 且不适合原子 read/write transaction](https://developers.cloudflare.com/kv/concepts/how-kv-works/)。
9. 不引入 Next.js、Vercel runtime、React Router、React Server Components、client-side route interception、auth/query/chart/admin packages、第二个 backend、服务端 session 或通用 repository interface。React application 使用现有 full-document routes，不是 client-routed SPA。
10. 不以 SSE、WebSocket、long polling、Web Push、KV/Workers Event Subscriptions、service binding/RPC 或 Cache 冒充等价的非轮询同步。这些选项在一个 KV、无其他协调存储的约束下不能同时提供 mutation discovery 和可靠 subscriber coordination；server-side periodic KV reads 仍是 polling。

## 4．选定架构

### 4.1 运行形态与固定依赖

Worker 使用一个 ES module entry，导出 `export default { fetch }`。binding 只通过 `env.PASTE_DB` 取得。Cloudflare 对 module Worker、compatibility date、bundle 和运行限制的依据见[基础研究](../../research/2026-09-12-cloudflare-pastebin-foundations.md#1-cloudflare-worker-runtime-and-deployment)。

HTTP 路由继续使用 `hono@4`。`hono/html` 只负责最小 application document shell、inert bootstrap/source nodes 和 `/md/:id` 的 safe Markdown document wrapper，不再生成 create、paste、password 或 application error 的可见 workbench markup。Markdown 服务端渲染继续使用 `micromark@4.0.2` 和 `micromark-extension-gfm@3`；visual editor 固定使用 `@milkdown/crepe@7.22.1`；unified line diff 使用 `diff@8.0.2` 的 `diffLines`；MCP 使用稳定的 `@modelcontextprotocol/server@2`。这些 backend 和 content dependencies 的既有 lockfile 解析结果保持不变，只有下列明确列出的 frontend pins 和共享 `zod` pin 可以变更。

可见 application UI使用 React `createRoot`，server不提供可 hydrate的 visible controls。Vite 8.3.0 产生 external hashed ESM/CSS assets 和 manifest，Wrangler static assets 只承载这些构建产物，不是业务存储，也不改变唯一业务 binding `PASTE_DB`。初始 application bundle 包含 React shell 和所需 shadcn primitives；Crepe、browser micromark/GFM renderer 和 diff worker 继续分别 lazy load。`/raw`、`/html`、`/md`、`/file` 和 `/ip-trace` 不加载 React autosync controller。

shadcn/ui source identity 固定如下，不能用 live registry output 替换 pin：

* repository `shadcn-ui/ui`；
* commit `2b3e6d4f8d9161fe5c19340dc383aade392012dd`；
* style `new-york-v4`；
* block `sidebar-11`；
* `shadcn@4.21.0` 只在首次 materialize 或按同一 pin 重建 source 时运行，不是 production dependency，也不得在普通 build 中联网运行。

新增和更新的 frontend package 必须使用下列 exact versions，不使用 range：

```json
{
  "dependencies": {
    "@hookform/resolvers": "5.9.1",
    "class-variance-authority": "0.7.1",
    "cn": "0.3.0",
    "lucide-react": "1.45.0",
    "radix-ui": "1.6.7",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "react-hook-form": "7.88.0",
    "tw-animate-css": "1.4.0",
    "zod": "4.6.4"
  },
  "devDependencies": {
    "@tailwindcss/vite": "4.3.3",
    "@types/node": "26.4.1",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.1",
    "tailwindcss": "4.3.3",
    "typescript": "7.0.2",
    "vite": "8.3.0"
  }
}
```

已有 test、Worker、Milkdown、Markdown、diff、Hono 和 MCP packages 仍按 lockfile 固定；不得以本表为理由删除它们。Node build environment 最低为 `22.12.0`。不直接增加 `clsx` 或 `tailwind-merge`，`cn@0.3.0` 是该 shadcn release 的固定直接 dependency。

### 4.2 最小模块与文件 ownership

| 文件或目录 | 唯一职责与 disposition |
|---|---|
| `src/index.ts` | ES module entry；先分流 `/mcp`，其余交给 Hono；注入 `env`。 |
| `src/http.ts` | 注册 canonical HTTP routes、解析 media type 与 conditional headers、调用 paste service、映射 HTTP response 和 error。 |
| `src/pastes.ts` | ID、password、expiration、version、KV key grammar、legacy migration、history ring、read、mutation 和 delete 的全部领域规则。不得从其他模块直接访问 `PASTE_DB`。 |
| `src/render.ts` | 只拥有 application shell、React mount node、safe bootstrap/source serialization、optional inert initial safe-Markdown template、application headers、safe `/md` wrapper与 representation helpers；不拥有 React页面 controls。 |
| `src/mcp.ts` | 每个请求创建 `McpServer`，注册八个 tools，并把 paste service 结果映射为 MCP result。 |
| `index.html` | Vite build entry，只含 root和 `src/client/main.tsx` module reference，不含 product copy或 bootstrap。production build完成后不部署或提供 emitted `index.html`；runtime document只能由 `src/render.ts`生成，`/index.html`仍不成为 route。 |
| `components.json` | shadcn materialization配置，style固定 `new-york-v4`、TSX和本地 aliases；它不替代 commit provenance pin，也不在 build时访问 registry。 |
| `src/i18n.ts`、`src/source-data.ts` | 分别保留 dictionary/locale/date helpers与 exact UTF-8/base64 codec；React imports它们，不复制实现。 |
| `src/client/main.tsx` | 在 mount前一次性解析 validated discriminated bootstrap、提取 exact source与 optional server-produced safe preview、读取当前 URL password，然后调用 `createRoot`；page identity变化依赖 full navigation。 |
| `src/client/App.tsx` | 按 `create`、`paste`、`password`、`error` bootstrap variant选择唯一可见 React page tree；ordinary与 consumed paste是结构不同的 branch。 |
| `src/client/components/app-sidebar.tsx` | 从 pinned `sidebar-11` 改造的 Document Workbench sidebar；只呈现真实 document modes、metadata 与操作，不保留 sample file tree。 |
| `src/client/components/ui/{sidebar,sheet,breadcrumb,collapsible,dialog,tooltip,tabs,field,label,input,textarea,button,separator}.tsx` | 从同一 pinned registry materialize 的唯一官方 primitive source。未列出的 shadcn block/component 不得加入；内部 Radix composition 可保留这些 source 必需的 helper。 |
| `src/client/components/{HelpTrigger,OperationStatus}.tsx` | 分别实现统一 question-mark help interaction，以及 autosave、autosync、network、last-action 四栏常驻状态。 |
| `src/client/api.ts` | same-origin fetch、password carrier、response/error decoding、AbortSignal 和 response ETag 的薄 adapter；不复制 server validation 或 domain rules。 |
| `src/client/autosave.ts` | 从旧 `src/client/app.ts` 抽出的已验证 autosave controller 与 Markdown autosave adapter，不含 DOM 查询或可见 markup。 |
| `src/client/paste-sync.ts` | ordinary paste polling scheduler、candidate comparison、generation invalidation 和 recovery state；不得被 create/password/error/consumed/representation branches import 或启动。 |
| `src/client/bootstrap.ts` | 复用 exact source codec、bootstrap validation、page-local password URL helpers；在 React state 建立后移除 inert nodes。 |
| `src/client/theme.ts` | 复用 document-only system/light/dark controller，以 React hook 包装并负责 dispose。 |
| `src/client/markdown.ts` | 保留 headless Crepe source/visual/preview controller及 dynamic imports；React 只提供 host 和 state callbacks。 |
| `src/client/history.ts`、`src/client/diff.ts` | 前者保留 headless history/diff lifecycle，后者作为独立 Vite Web Worker entry 运行 `diffLines`。 |
| `src/client/index.css` | Tailwind 4 import、pinned shadcn tokens、Document Workbench tokens、Crepe/prose/diff 必需规则和 reduced-motion override。旧 `src/client/styles.css` 必须删除，不保留 selector-compatible 的第二套 visible UI。 |
| `vite.config.ts` | React/Tailwind static client build、hashed output、manifest、lazy chunk 和 diff worker边界。不得配置 dev proxy、SSR、RSC 或 application router。 |
| `scripts/build.mjs`、`src/generated/assets.ts` | build orchestration 和 server-consumed Vite manifest projection；只暴露实际 hashed application JS/CSS/worker assets，不重新 bundle client。 |
| `THIRD_PARTY_NOTICES.md` | 包含 copied shadcn/ui 的 MIT copyright/permission notice、direct MIT/ISC notices，以及 Apache-2.0 licenses和 dependency 自带 NOTICE。无需 in-product credit。 |

每个由 block直接改造的 source file顶部保留一行 provenance comment，格式固定为 `Derived from shadcn-ui/ui new-york-v4/sidebar-11 at 2b3e6d4f8d9161fe5c19340dc383aade392012dd; MIT; see THIRD_PARTY_NOTICES.md.`。未修改的 registry primitive可用同格式把 `sidebar-11`替换成其 exact registry component name。`THIRD_PARTY_NOTICES.md`还必须列出两个 original block paths、materialized component names、`shadcn@4.21.0`、pin commit，以及以 `Copyright (c) 2023 shadcn`开头的完整 shadcn MIT text；随后包含 direct MIT/ISC notices、Apache-2.0 texts和 distributed package自带 NOTICE。build不读取 network验证 provenance。

`src/client/app.ts`中已验证的 headless logic必须按上表抽出；之后删除该旧 entry及其中 handwritten visible markup、document-wide selector binding、duplicate locale/theme ownership和 placeholder panel handlers。`src/client/styles.css`删除，由 `index.css`和 component utilities完全取代。Vite emitted `index.html`在 manifest projection完成后从 deploy tree移除，Wrangler assets目录只含 hashed assets。未集成的 `98ed2d1` -> `2da846c` -> `bfaac29` imperative tabs candidate 明确 superseded，不得 merge、cherry-pick 或移植 controller；只把它的 user-observable keyboard cases改写成 React Tabs tests。

测试文件与被测模块对应。不得添加单实现 interface、factory 或第二套路由层。`McpServer` 的 per-request factory 是 SDK 所要求的例外。[SDK v2 的 web-standard handler 会按请求创建 fresh server](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md)。

### 4.3 请求分流顺序

1. 精确匹配 `/mcp`，执行 method 与 Origin guard 后交给 MCP handler。
2. 其余请求进入 Hono。路由注册顺序为 `/`、`/ip-trace`、`/assets/*`、`/api/*`、`/raw/:id`、`/html/:id`、`/md/:id`、`/file/:id`、`/:id`、最终 404。
3. 不使用 pathname prefix 手工截取 ID。Hono path parameter 解码失败返回 400。
4. `/api` 和 `/delete/:id` 没有兼容 handler，落入 404。

## 5．领域值与输入规范

### 5.1 ID

`id` 是 case-sensitive ASCII，必须完整匹配：

```regex
^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$
```

长度为 1 至 64 个 ASCII 字符。custom ID 另外按 ASCII case-insensitive 方式拒绝以下保留 segment：

```plaintext
api raw html md file delete mcp ip-trace assets favicon favicon.ico robots robots.txt
```

即 `Api`、`RAW` 也被拒绝。任何以 `__cfpb` 开头的候选也被拒绝，即使当前 regex 已经使其不可达。ID 创建后不可改名；任何 update body 中的 `id` 或 `customId` 都按 unknown field 拒绝。

自动 ID 使用 `crypto.randomUUID()` 生成 lowercase UUID v4。每次生成后执行同 custom ID 相同的 existence checks，最多重试五次，第五次仍冲突时返回 `503 ID_GENERATION_FAILED`。

### 5.2 正文

1. `content` 必须是有效 Unicode scalar sequence，不允许 unpaired UTF-16 surrogate。
2. 不做 Unicode normalization、line-ending conversion、trim 或末尾换行增删。
3. 创建与更新均要求 UTF-8 byte length 为 `1..10_485_760`，即最多 10 MiB。
4. equality 使用完整 string equality。只有每个 Unicode scalar 和顺序都相同才是 no-op。
5. KV value 只写 content，不写 JSON envelope。Cloudflare 的单 value 上限为 25 MiB，本产品的 10 MiB 上限低于它，[限制依据](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)。

### 5.3 title、format、viewOnce

* `title` 默认 `""`，最多 200 个 Unicode scalar，不得包含 U+0000 至 U+001F 或 U+007F。保留其余字符与前后空格。
* `format` 只能是 `text` 或 `markdown`，默认 `text`。它只决定 `GET /:id` 的默认显示和编辑 mode。
* `viewOnce` 是 boolean，默认 `false`。

### 5.4 password

* 新 password 为 `""` 时表示不保护或 clear；非空时必须为 1 至 128 个 visible ASCII 字符，即每个 code point 位于 U+0020 至 U+007E。
* metadata 中存 `password: null|string`。不 hash、不 encrypt、不另存 verifier。
* 已保护 paste 的所有 content、representation、API、history、update、settings、password、delete 和 MCP 操作都先校验当前 password。除 9.3 明确定义的 `GET /:id` 缺少 query 时返回 password input page 外，missing 与 wrong 都返回 403。未保护 paste 忽略通过合法单一 carrier 提供的 password，ID 本身即授予完整控制。
* 未保护 paste 可直接 set；已保护 paste 的 change 与 clear 都要求当前 password；新值 `""` clear。

### 5.5 expiration 输入

`ExpirationInput` 是以下四种之一：

1. integer seconds，必须 `Number.isSafeInteger` 且不小于 60，并且以 mutation `now` 计算后的 UTC instant 不晚于 `9999-12-31T23:59:59.999Z`；超过该可表示 RFC3339 上界时返回 422；
2. JSON `null`；
3. exact lowercase string `"permanent"`；
4. 含 `Z` 或显式 numeric offset 的 RFC3339 timestamp。

`null` 和 `"permanent"` 都规范化为 permanent。RFC3339 必须 round-trip 为唯一 UTC instant，leap second、无 timezone、无效日期和距校验时刻少于 60 秒的值均返回 422。integer 是相对时长；只有 mutation 明确提供该字段时，才以该次 mutation 开始写 KV 前捕获的 `now` 重新计算。字段缺省时保留原 `expiresAt`，普通 content save 不延长 logical lifetime。

UI 只提供以下固定值：

| 显示 | integer seconds |
|---|---:|
| 1 minute | 60 |
| 1 hour | 3600 |
| 1 day | 86400 |
| 1 week | 604800 |
| 1 month | 2592000 |
| 1 year | 31104000 |
| permanent | `null` |

API 和 MCP 可接受其他符合规则的 integer seconds 或 absolute timestamp。

## 6．KV key grammar 与 schema

### 6.1 Keys

对一个合法 `<id>`，只允许以下业务 keys：

```plaintext
<id>
__cfpb:meta:<id>
__cfpb:rev:<id>:0
__cfpb:rev:<id>:1
__cfpb:rev:<id>:2
```

* `<id>`：当前正文 plaintext。
* `__cfpb:meta:<id>`：唯一 business metadata JSON。
* 三个 `__cfpb:rev` keys：prior revision plaintext ring slots。
* 不创建 lock、reservation、tombstone、index、queue 或 journal key。
* 删除时始终对全部五个 keys 执行 delete，不依赖 history count。

所有 key 长度均低于 KV 的 512-byte 上限，[KV key/value/attached metadata 限制](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)。

### 6.2 当前正文的 attached metadata

当前正文 value 保持精确 plaintext。只在 KV attached metadata 中存以下技术 marker，不存 password、title 或其他 business state：

```json
{
  "kind": "cfpb/content",
  "schemaVersion": 2,
  "generation": "0f72b785-c5d3-4f89-b77f-b881e78e3e16",
  "contentRevision": 4,
  "savedAt": "2026-09-12T08:30:00.000Z",
  "byteLength": 1234,
  "commit": {
    "versionCounter": 7,
    "previous": {
      "revision": 3,
      "slot": 2,
      "savedAt": "2026-09-12T08:20:00.000Z",
      "supersededAt": "2026-09-12T08:30:00.000Z",
      "byteLength": 1200
    }
  }
}
```

新建 paste 的 `commit` 是 `null`。每次 content change 后，它描述最近一次 save，供 metadata-last partial failure reconciliation 使用。序列化后必须小于等于 1,024 bytes；不符合固定 schema 即视为 storage corruption。

### 6.3 Business metadata sibling

`__cfpb:meta:<id>` 的 value 是 UTF-8 JSON，exact schema 如下：

```json
{
  "schemaVersion": 2,
  "generation": "0f72b785-c5d3-4f89-b77f-b881e78e3e16",
  "id": "example",
  "title": "Example",
  "format": "markdown",
  "password": "plain text",
  "viewOnce": false,
  "createdAt": "2026-09-12T08:00:00.000Z",
  "updatedAt": "2026-09-12T08:30:00.000Z",
  "currentSavedAt": "2026-09-12T08:30:00.000Z",
  "expiresAt": "2026-09-13T08:30:00.000Z",
  "expiration": {
    "kind": "relative",
    "seconds": 86400
  },
  "physicalExpiration": 1789288200,
  "versionCounter": 7,
  "contentRevision": 4,
  "contentBytes": 1234,
  "createdCountry": "US",
  "history": {
    "nextSlot": 0,
    "entries": [
      {
        "revision": 3,
        "slot": 2,
        "savedAt": "2026-09-12T08:20:00.000Z",
        "supersededAt": "2026-09-12T08:30:00.000Z",
        "byteLength": 1200
      }
    ]
  }
}
```

约束如下：

* `generation` 是创建或 legacy migration 时生成的 UUID v4，并与正文及 revisions marker 相等。
* permanent 时 `expiresAt`、`physicalExpiration` 均为 `null`，`expiration` 为 `{"kind":"permanent"}`。
* absolute 时 `expiration` 为 `{"kind":"absolute"}`。
* `versionCounter` 从 1 开始，每次实际 business mutation 加 1；完全 no-op 与内部 reconciliation 不增加。
* 对外 `version` 是 `${generation}.${versionCounter}`。未迁移 legacy entry 的对外 version 是 exact string `legacy`。
* `contentRevision` 从 1 开始，只在 content 实际变化时加 1。
* `history.entries` 按 `revision` descending，长度 `0..3`，每个 slot 唯一。
* metadata JSON UTF-8 serialized size 上限为 16 KiB。固定 schema 正常情况下远低于该值；超出或 unknown field 视为 corruption。
* 新建只记录 `createdCountry = request.cf?.country ?? null`。旧 attached metadata 的 `ip` 不迁移，也不在新 schema 中保存。

### 6.4 Revision slot attached metadata

revision value 是该版本的完整 plaintext content。attached metadata schema 为：

```json
{
  "kind": "cfpb/revision",
  "schemaVersion": 2,
  "generation": "0f72b785-c5d3-4f89-b77f-b881e78e3e16",
  "revision": 3,
  "savedAt": "2026-09-12T08:20:00.000Z",
  "supersededAt": "2026-09-12T08:30:00.000Z",
  "byteLength": 1200
}
```

读取 snapshot 时必须同时验证 key slot、generation、revision、timestamps 和 byteLength 与 `history.entries` descriptor 一致。descriptor 不存在时返回 404；descriptor 存在但 slot 缺失或 marker 不一致时返回 503，不猜测内容归属。

### 6.5 Physical expiration

一次 mutation 只计算一个 `physicalExpiration`，并把完全相同的值用于当前正文、metadata sibling 和所有存在的 revision slots。permanent 的全部 `put` 都省略 expiration。

对非永久 paste：

```plaintext
physicalExpiration = ceil(max(parse(expiresAt), now + 60_000) / 1000)
```

logical access 始终按 `expiresAt` 判断。`now >= expiresAt` 时，即使 KV 仍返回 value，也先执行五 key cleanup 并返回 404。使用 `max(..., now + 60_000)` 是为了让临近到期时的 mutation 仍满足 Cloudflare 要求 expiration 至少在未来 60 秒；它最多只延长 physical cleanup，不延长 logical access。[KV expiration 的 60 秒要求](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)。

若 mutation 计算出的 physical expiration 与 metadata 中不同，必须重新 `put` 当前正文和每个 active revision，再提交 metadata。这样一次成功 mutation 结束后，全部存在 keys 的 physical expiration 相同。

## 7．读取、创建、mutation 与故障顺序

### 7.1 一般读取与 generation 校验

每次业务读取按以下次序：

1. 用 `getWithMetadata(id, { type: "text" })` 读取当前正文和技术 marker，并读取 metadata sibling。
2. 当前正文不存在时返回 404。metadata-only orphan 不自动删除，避免 stale read 下误删另一地域刚创建的数据。
3. 正文 attached metadata 只要出现 `kind`、`schemaVersion`、`generation`、`contentRevision`、`savedAt`、`byteLength` 或 `commit` 任一新格式字段，就必须完整符合 6.2 的 schema 2 marker，且 sibling metadata 必须存在、schema 正确并具有相同 generation；否则返回 `503 STORAGE_INCONSISTENT`，不得按 unprotected legacy entry 处理。
4. 只有未出现上述新格式字段时才进入 legacy read 规则。若同时看见 schema 2 sibling，说明 migration 或 propagation 未收敛，返回 503。
5. 校验 logical expiration。已到期则 awaited delete 全部五个 keys，返回 404。
6. 校验 password。只有通过后才能返回 metadata、content 或执行 mutation。
7. 对 content read，确认 route 与 representation 已完全验证后，才把步骤 1 已读取的正文放入 response body 或用于生成最终表示。

跨地域可能同时看到同一代的全部 stale keys，因此 generation 不能解决完整 stale snapshot。它只阻止把不同代或 partial write 的正文与 metadata 拼接。

### 7.2 创建

创建步骤固定为：

1. 完整验证 media type、body、所有字段、content bytes、custom ID 和 expiration。
2. 对候选 ID 精确检查五个 keys。任意 key 可见即视为 occupied。custom ID 返回 409；自动 ID 重新生成。
3. 生成 `generation`、timestamps、初始 marker 和 metadata。初始 `versionCounter=1`、`contentRevision=1`、`history.entries=[]`、`nextSlot=0`。
4. 先 `put` metadata sibling，再 `put` 当前正文及 marker，二者使用同一 physical expiration。
5. 两次写都成功后才返回 201。创建响应不含正文，不 redirect，不自动打开任何 view。
6. metadata 成功而正文失败时，awaited delete metadata 和三个 revision keys，再返回 `503 STORAGE_WRITE_FAILED`。cleanup 也失败时仍返回 503，并设置 `details.mutationMayHaveApplied=true`。

metadata-first 降低同一 location 暂时把 protected 新正文当成 legacy 的机会；KV propagation 不保证写入顺序，schema 2 marker 的 fail-closed 规则承担最终保护。

custom ID 没有原子 reserve。两个并发 create 都可能通过 negative existence check，随后 last write wins，且两方都可能收到 201。该限制不可在本架构内消除。

### 7.3 Content save 与 history ring

一次实际 content change 固定执行：

1. 读取当前 coherent state，校验 password 和 optional version。
2. 新 content 与当前 content 完全相等时返回 200 `changed:false`，不写 KV、不加 version、不写 history。
3. 选择 `slot=history.nextSlot`。准备 old current descriptor，并将旧正文写入该 revision slot。
4. 如 physical expiration 需要变化，先依次重写其他 active revision slots，使其使用新 expiration。
5. 写新正文，attached marker 的 `contentRevision` 加 1，`commit` 记录本次 versionCounter 与 previous descriptor。
6. 最后写 metadata：删除原来占用目标 slot 的 descriptor，插入旧 current descriptor，截断为最新三个，`nextSlot=(slot+1)%3`，并更新 content fields、version 和 timestamps。
7. 三类写全部成功后返回 200。每个 browser autosave、API content update 和 MCP `paste_update` 都走同一过程，因此都产生 prior revision；settings/password/expiration/viewOnce/delete 不产生 revision。

写 revision slot 优先保护当前正文；若后续正文写失败，最坏情况是被覆盖的最旧 history slot 丢失，当前正文不变。写正文成功而 metadata 失败时，响应 503，正文可能已经变化。

读取发现 `main.contentRevision = metadata.contentRevision + 1` 且 main `commit.previous` 与目标 revision marker 一致时，服务可 awaited 重写 metadata 完成 reconciliation。它保留当次读到的 password、title、format、viewOnce 和 expiration fields，应用 commit 中的 history/content fields，并把 `versionCounter` 设为当前 metadata 与 commit 两者的较大值。该 repair 不新增 version。其他 revision 差值、缺 marker 或无法证明 previous content 时返回 503，不自动覆盖任何正文。

### 7.4 Settings 与 password mutation

不改变 expiration 且当前 physical expiration 仍可被 KV 接受时，title、format、viewOnce 或 password 的 mutation 只写 metadata sibling。写成功即为一个 KV key 上的完整 commit。

显式修改 expiration，或临近 logical expiry导致 physical expiration 必须后移时，按以下顺序：

1. sequentially 读取并重写当前正文与 active revision values，使用同一个新 physical expiration；目标为 permanent 时不传 expiration。
2. 最后写包含新 logical/physical expiration 和其他 business fields 的 metadata。
3. 任一前置写失败则 metadata 不变并返回 503。metadata 写失败时返回 503，部分 content keys 可能已采用新 physical expiration。缩短期限时这可能造成正文比旧 metadata 更早被 KV 删除；response 的 `details.mutationMayHaveApplied=true` 要求 client 重新 GET settings。

API 不提供把 content 与 settings/password 合在一个 mutation 的 schema，避免伪装成跨 key atomic update。

### 7.5 Delete

授权与 optional version 校验通过后：

1. delete 当前正文；
2. 并行 delete 三个 revision slots；
3. delete metadata sibling；
4. 全部 fulfilled 后返回 204。

任何 delete rejection 返回 503 且 `mutationMayHaveApplied=true`。delete missing key 本身不是 ownership proof，[KV delete 对 missing key 也成功且传播可能延迟](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/)。因此先读取并授权，再执行上述顺序。已不存在或 logical expired 的 paste 返回 404。重复 DELETE 在第一次成功后返回 404。

### 7.6 Last-write-wins 与 version

browser 的所有 mutation 都带当前 `version`。curl 和 MCP 可省略，省略即 last-write-wins。

JSON mutation 的 `version` 是 string。HTTP 也接受 `If-Match: "<version>"`。若两者同时存在且不同，返回 400；一致则使用该值。`If-Match: *`、weak ETag 和 comma list 均返回 400。DELETE 可从 JSON body 或 `If-Match` 提供 version。

提供的 version 与当前不完全相等时返回 `409 VERSION_CONFLICT`，body 只给 `currentVersion` 和 `updatedAt`，不隐式返回 current content。KV eventual consistency 仍可能让两个地域都看到旧 version 并接受并发写，因此 version 是 best-effort conflict detection，不是 CAS。

## 8．Legacy entry 读取与按需迁移

legacy entry 是 `key=<id>` 有 plaintext value，sibling metadata 不可见，且正文 attached metadata 没有 7.1 所列任何新格式字段。旧 attached metadata 可以没有，也可以包含旧 `worker.js` 的 `country`、`createdAt`、`ip`、`title`、`expiration`；其他非新格式字段忽略。任何新格式字段存在但 marker 不完整时均 fail closed 为 503。

### 8.1 Legacy read projection

* `title`：合法 string 且符合新 title 约束时保留，否则 `""`。
* `format="text"`、`password=null`、`viewOnce=false`、history empty。
* `createdAt`：有效 finite epoch milliseconds 时规范化为 RFC3339；否则为 `null`，只在 legacy read response 允许 null。
* `expiresAt`：`createdAt` 是 epoch milliseconds，legacy `expiration` 是 seconds；两者都有效时取 `createdAt + expiration * 1000`，否则为 `null`。若已到期则 cleanup 后 404。
* `createdCountry`：两位 ASCII country code 时保留，否则 null。
* legacy `ip` 不返回、不迁移。
* `version="legacy"`。

legacy read 不写 KV，不批量扫描，不改变 attached metadata。

### 8.2 第一次 mutation

DELETE 直接清理五个 keys，不创建 sibling。其他第一次 mutation 执行：

1. 要求 optional version 缺省或 exact `legacy`。
2. 生成 generation 与 schema 2 state；已知 legacy timestamps/expiry 尽量保留，未知 `createdAt` 取 mutation `now`，未知 expiry 转 permanent。
3. content change 时将 legacy current 写入 slot 0，new current 的 `contentRevision=2`，history 含 revision 1，`nextSlot=1`。非 content mutation 的 `contentRevision=1`，history empty。
4. 先写 schema 2 metadata，再重写当前正文附带 schema 2 marker。若有 revision，按 content-save 顺序在正文之前写。
5. 所有存在 keys 使用一次计算的相同 physical expiration。
6. 成功 response 的 version 为 `${generation}.1`。该迁移本身与用户 mutation合并，只增加一次 version。

看到 legacy main 与 schema 2 sibling 的中间状态时 fail closed 为 503。由于 KV stale read，刚设置 password 或 viewOnce 后，另一地域仍可能短时读取到完整旧 legacy state；单 KV 无法消除该窗口，此项列入接受风险。

## 9．Password transport、优先级与 URL 编码

### 9.1 API credential precedence

对允许多种 credential carrier 的 API route，选择顺序固定为：

1. JSON 或 form body 中显式存在的 `password`；
2. URL 中唯一的 `password` query parameter；
3. `X-Paste-Password` request header。

高优先级 carrier 一旦存在，即使是 empty 或 wrong，也不 fallback。低优先级值被忽略。两个同名 query parameters 返回 `400 AMBIGUOUS_PASSWORD`。`X-Paste-Password` 按 HTTP parser 提供的 field value 原样比较；password 以 leading/trailing U+0020 开始或结束时必须用 body 或 query，避免 HTTP optional whitespace 规范化。

browser API GET使用 query，JSON mutation使用 body。browser从 URL取得 password后把 decoded string放在当前 document的 page-scoped in-memory `pastePassword` state/closure中；它非 null时由每次 request显式带上，null时省略整个 credential field/query。不得写入 cookie、`localStorage`、`sessionStorage`、IndexedDB或 `window.name`。

MCP 只使用 tool argument `password`。它不读取 URL password。representation routes 按 9.3 的专用规则，只接受 query password。

### 9.2 Query serialization

所有 browser link 和 redirect 必须用 `URL` 与 `URLSearchParams.set("password", password)` 生成，不做字符串拼接。query 按 UTF-8 percent encoding 传输；server 以 URL Standard 解码后比较 plaintext。U+0020 serialization 为 `+`，literal `+` 必须为 `%2B`，`%` 为 `%25`，`&` 为 `%26`，`#` 为 `%23`，`?` 为 `%3F`。

percent encoding 只是 URL wire representation，不是 password encryption。生产流量仍由 HTTPS transport 保护；应用层保存与比较 decoded plaintext。

### 9.3 Browser page 与 direct representation

* `GET /:id` 发现 protected paste 且 query 中完全没有 `password` 时，返回 200 password input page，不返回 title、format、expiry、content 或 protected 状态之外的信息。
* input form `POST /:id` 使用 `application/x-www-form-urlencoded`，server 校验 body password。成功返回 HTTP 302，`Location` 是同一路径，仅带一个由 `URLSearchParams` 生成的 `?password=...`。该 POST 不消费 view-once。
* form password missing/wrong 返回 403 并重新渲染带 inline error 的 input page。
* `GET /:id?password=`、duplicate query 或 wrong query 返回 403，不退回无错误 input page。
* protected `/raw/:id`、`/html/:id`、`/md/:id`、`/file/:id` 只接受唯一 query password。缺失或 wrong 都直接返回 403 plaintext error，不渲染 shell，不接受 header 替代。
* unprotected paste 在确认 query 中至多有一个 `password` 后忽略其值；duplicate query 仍返回 400。

query password 有意进入 address bar、browser history、复制 URL、Cloudflare/request log，并可能进入 `Referer`。`/html/:id` 不发送 `Referrer-Policy` 来改变用户已接受的顶层 HTML 行为。

### 9.4 Password 修改后的 document 状态

password set/change成功后，page-scoped `pastePassword`立即改为新值，并用 `history.replaceState`将当前 application page的唯一 password query更新为新值。clear成功后 state设为 null并移除该 query。不得 reload。其他 representation links每次从当前 state/closure新建，不缓存旧 URL。

## 10．View-once 状态序列

### 10.1 会消费的操作

首次成功授权并将返回当前正文的以下操作消费：

* `GET /:id`；
* `GET /raw/:id`、`GET /html/:id`、`GET /md/:id`、`GET /file/:id`；
* `GET /api/pastes/:id`；
* `GET|POST /api/pastes/:id/read`；
* MCP `paste_get`。

`HEAD`、`OPTIONS`、password form POST、missing/wrong password、invalid representation、settings/password/content mutation、history 请求和 DELETE 不消费。view-once active 时 history list/get 在授权后返回 409，不读取 revision body。

### 10.2 消费顺序

content-bearing handler 必须严格执行：

1. parse route、method、ID、query/body 和 representation；
2. coherent KV read，校验 schema、generation、logical expiry、password；
3. 完整生成最终 body 和 headers。Markdown 在此阶段完成 micromark render，HTML 与 file headers 在此阶段完成校验；任何 render/validation error 不消费；
4. delete 当前正文；
5. 并行 delete 三个 revision slots；
6. delete metadata sibling；
7. 所有 delete fulfilled 后才构造并返回已准备好的 response。

任一 delete rejection 时不返回正文，返回 503 `CONSUME_FAILED`，并标记 `mutationMayHaveApplied=true`。因此连接中断或 delete partial failure可能造成零次完整交付。先发送 response 再删除被禁止。

### 10.3 UI 与 mutation

创建 view-once paste 后，create page只显示 content-related result、links和 actions；一次性后果与 distributed limitation放在 View once question-mark HelpTrigger中，不自动 navigate。

通过 `/:id` 消费后返回的 page 不显示 edit、history、settings 或 server-side delete。它保留已返回正文，并提供不再访问服务器的 copy、wrap、raw text toggle、safe Markdown preview、UTF-8 file download 和 top-level HTML blob navigation。后者从当前内存正文创建 `text/html` Blob 并在当前 tab navigate；direct `/html/:id` 仍是取得 canonical same-origin route 行为的方式。通过任一 direct representation 或 API/MCP 先消费后，其他 server route 预期为 404。

首次读取前，已授权 API/MCP 可更新 content、password、expiry、format、title、viewOnce，或 delete。把 `viewOnce` 改为 false 后普通规则生效。把普通 paste 改为 true 不追溯消费已经完成的旧 read；下一次 content-bearing read 才消费。

### 10.4 无法保证的并发语义

KV read-then-delete 不建立全球 ownership。两个 region 可能都读到 stale current state、都通过 password、都 delete，并都返回正文。delete 的传播和 negative lookup cache 也可能延迟。此行为是明确接受的平台限制，不得在文档或 UI 中声称 globally exactly once。

## 11．History 与 revision 语义

1. history 只含 current 之前最近三个 successful content saves。
2. content 第一次创建是 revision 1，但在被下一次 actual content change 替代前不出现在 history。
3. save current revision `N` 时，把它放入 `nextSlot`，new current 是 `N+1`。满三个后覆盖最旧 slot。
4. settings、password、expiry、viewOnce、title、format 和 exact content no-op 都不创建 revision。title/format mutation 属于 settings。
5. API、MCP 和 browser autosave 的 content change 使用相同规则。
6. history list newest first，只返回 descriptors，不返回正文。没有 pagination，因为最多三个。
7. history get 以 positive decimal revision number 定位 descriptor。`01`、`+1`、fraction 和超出 safe integer 的 path 都返回 400。
8. history snapshot 是 content-only，不含当时 title、password、expiry、format 或 viewOnce。
9. ordinary paste 的 history read 不改变 current、不创建新 history、不消费。view-once active 时始终返回 409。
10. UI 选择一个 revision 后，将该 snapshot 与 current content 比较。unified diff 方向固定为 selected revision -> current；snapshot tab 显示 selected revision 全文。
11. 只有打开 History tab 才 fetch list，只有选择 revision 才 fetch full snapshot。任一 side 超过 1 MiB UTF-8 或 50,000 lines 时不自动计算 diff；可直接显示 bytes/lines metadata与“Compute diff”动作，阈值原因只在 question-mark HelpTrigger中。点击后才在 Web Worker运行 `diffLines`。小于等于阈值时选择后自动计算。
12. diff line 通过 text nodes 输出，保留 newline marker；addition、deletion 与 unchanged 除颜色外还显示 `+`、`-`、空格前缀。不得把 snapshot 传给 `innerHTML`。

## 12．HTTP contract

### 12.1 通用规则与 conditional read

* URL path ID 只接受单 segment。额外 slash、空 segment 或 percent-decoded slash 不匹配资源 route。
* JSON request 必须是 `Content-Type: application/json`，允许 `charset=utf-8`。JSON object unknown fields、duplicate JSON keys、wrong primitive type均返回 422。实现使用保留 duplicate-key 信息的 parser 或在 parse 前检测 duplicate keys，不能让后值静默覆盖 credential 或 version。
* `multipart/form-data` 只用于 create。每个命名 field 必须恰好出现一次，未声明 field 返回 422。
* API JSON 与 MCP HTTP request wire body 上限 64 MiB；已知 `Content-Length` 先检查，未知长度由 counting stream 检查。content 解码后仍执行 10 MiB 限制。
* dynamic application shell、API 和 representation response，包括 304 与所有 error，使用 `Cache-Control: no-store`。Vite assets 使用 content-hashed filename 与 `Cache-Control: public, max-age=31536000, immutable`。
* API success/error 为 `application/json; charset=utf-8`。React application shell 和 `/md` document 为 `text/html; charset=utf-8`。除 `/html/:id` 外的 browser HTML response 增加 `X-Content-Type-Options: nosniff`。
* 注册 route 的 unsupported method 返回 405 并带准确 `Allow`。不存在 route 返回 404。
* 每个 GET route 都显式支持 HEAD。HEAD 执行 existence、schema、expiry 与 password 校验并返回同 GET 的 status 和 representation headers，不返回 body、不消费 view-once。只有 `GET|HEAD /api/pastes/:id` 为计算 strong response ETag 而序列化 selected representation bytes；其他 HEAD 不生成 representation body。OPTIONS 不校验 password、不消费。
* 除 `/ip-trace` 外不发送 wildcard CORS。API 是 same-origin browser API，curl 不受 CORS 限制。

`GET|HEAD /api/pastes/:id` 是 autosync 唯一 read route，不增加 sync endpoint、query mode、SSE 或 socket interface。它的 conditional contract 固定如下：

1. 对 ordinary paste，先完成 coherent read、logical expiration 与 password authorization，再按与 200 完全相同的 deterministic JSON serializer生成 `PasteResource` UTF-8 bytes。response ETag 是这些 exact bytes 的 SHA-256 base64url digest，无 padding，格式为 `"sha256-<43 base64url chars>"`。它是 representation 的 strong validator，不是 JSON `version` mutation token，不能作为 `If-Match` value。
2. Ordinary request 的 `If-None-Match` 按 RFC 9110 entity-tag list grammar解析。允许单独的 `*`、OWS、comma-separated strong 或 weak entity-tags；`*` 与 list 混用、空 member、unclosed quote、invalid opaque-tag character 或任何其他 malformed syntax 返回 `400 BAD_REQUEST`。GET comparison 使用标准 weak comparison，因此任一 list member与当前 strong ETag opaque value相同，或 `*` 且资源存在时，返回 304。
3. 304 不含 body、`Content-Type`、`Content-Length` 或 trailers；它只带当前 `ETag`、`Cache-Control: no-store` 和平台自动 headers。304 不属于 content-bearing read，不创建 history、不 mutation、不消费。
4. 不匹配或没有 validator 时返回 200 `PasteResource` 和当前 strong ETag。HEAD 使用相同选择与 comparison，匹配可返回 304，不匹配返回 200 headers-only。
5. View-once resource 完全忽略 `If-None-Match`，包括 malformed value。授权 GET 仍按第 10 节准备完整 200 body并 consume；HEAD 返回普通 200 headers-only且不 consume。conditional header 绝不能把 view-once GET 转为 304、提前证明存在或绕过 consume-on-body semantics。
6. Authorization、404、storage 503 和 view-once状态判断先于 ordinary validator parse，因此不存在或未授权资源不会通过 validator error暴露额外信息。200、304 和 error全部 `no-store`；不得使用 Cache API 缓存该 route。
7. `version`、`contentRevision`、`updatedAt` 仍在 `PasteResource` 中承担 mutation conflict与 stale-order判断。Create/mutation/settings response 中既有 `ETag: "<version>"` 保持 mutation-token语义；只有本 read route 的 ETag 是上述 response validator。

### 12.2 Browser 与 representation route matrix

| Route | Methods | Request | Success | 消费 | 主要非成功状态 |
|---|---|---|---|---|---|
| `/` | `GET`,`HEAD` | 无 | 200 minimal React create shell，HEAD 无 body | 否 | 405；旧 `POST /` 不创建 |
| `/:id` | `GET`,`HEAD` | optional unique `password` query | 200 minimal React paste shell；protected 且 query absent 时为 React password shell | 仅成功含正文的 GET | 400 duplicate query；403 wrong；404 missing/expired；503 incoherent |
| `/:id` | `POST` | `application/x-www-form-urlencoded`，唯一 `password` | 302 到同路径的 encoded query | 否 | 403 missing/wrong；404；415；422 duplicate/invalid form |
| `/raw/:id` | `GET`,`HEAD` | protected 时必须 unique query password | 200 exact source，`text/plain; charset=utf-8` | GET | 400、403、404、503 |
| `/html/:id` | `GET`,`HEAD` | protected 时必须 unique query password | 200 exact source，`text/html; charset=utf-8` | GET | 400、403、404、503；错误 body 是 `text/plain` |
| `/md/:id` | `GET`,`HEAD` | protected 时必须 unique query password | 200 server-produced safe Markdown document，`text/html; charset=utf-8`；不 mount React controlled sync | GET | 400、403、404、500 render failure、503 |
| `/file/:id` | `GET`,`HEAD` | protected 时必须 unique query password | 200 exact UTF-8 bytes，`application/octet-stream` | GET | 400、403、404、503 |
| `/assets/<hash>.*` | `GET`,`HEAD` | 无 | 200 Vite static asset | 否 | 404、405 |
| `/api` | 无 | 任意 | 无 | 否 | 404，确认 legacy create 已删除 |
| `/delete/:id` | 无 | 任意 | 无 | 否 | 404，确认 destructive GET 已删除 |

`/file/:id` 的 `Content-Disposition` 为：

```plaintext
attachment; filename="paste-<id>.txt"; filename*=UTF-8''<encoded-filename>
```

encoded filename 取 title，空 title 用 `paste-<id>.txt`。派生 filename 把 `/`、`\` 替换为 `_`，移除尾部 U+0020 与 `.`；结果为空时使用 fallback。`filename*` 按 RFC5987 UTF-8 percent encoding，ASCII fallback 始终是 `paste-<id>.txt`。

### 12.3 API resource schemas

`PasteSummary`：

```json
{
  "id": "example",
  "title": "Example",
  "format": "markdown",
  "viewOnce": false,
  "protected": true,
  "createdAt": "2026-09-12T08:00:00.000Z",
  "updatedAt": "2026-09-12T08:30:00.000Z",
  "expiresAt": "2026-09-13T08:30:00.000Z",
  "expiration": { "kind": "relative", "seconds": 86400 },
  "version": "0f72b785-c5d3-4f89-b77f-b881e78e3e16.7",
  "contentRevision": 4,
  "contentBytes": 1234,
  "createdCountry": "US",
  "links": {
    "view": "/example",
    "raw": "/raw/example",
    "html": "/html/example",
    "markdown": "/md/example",
    "file": "/file/example"
  }
}
```

links 永不包含 password。legacy projection 的 `createdAt` 可为 null，其余 schema 相同，`version="legacy"`。API 永不返回 plaintext stored password，只返回 `protected`。

`PasteResource` 是 `PasteSummary` 加 `content`。`MutationResult` 是：

```json
{
  "changed": true,
  "paste": { "id": "example", "version": "generation.8" }
}
```

实际 `paste` 是完整 `PasteSummary`。no-op 时 `changed=false`。

### 12.4 Create API

`POST /api/pastes` 接受两种 media type。

JSON body：

```json
{
  "content": "required",
  "title": "",
  "format": "text",
  "expiration": 86400,
  "password": "",
  "viewOnce": false,
  "customId": "optional"
}
```

`content` 必填；其余采用所示 defaults。`customId` 缺省时自动生成。

`multipart/form-data` fields 为同名字段。`content`、`title`、`password`、`customId` 是 string；`format` 是 exact string；`expiration` 用 decimal integer、`permanent`、empty string 表示 permanent，或 RFC3339；`viewOnce` 只能是 `true` 或 `false`。不得把 checkbox missing 暗自解释为 false，client 必须显式发送。

成功返回 201 `PasteSummary`，带 `Location: /<id>` 和 `ETag: "<version>"`。不返回 content，不 redirect。状态还包括 409 custom ID occupied、413 content 或 wire body 超限、415 media type、422 schema、503 KV failure。

### 12.5 API route matrix

| Route | Methods与media type | Success response | 是否 content-bearing | 说明 |
|---|---|---|---|---|
| `/api/pastes` | `POST` JSON 或 multipart | 201 `PasteSummary` | 否 | canonical create |
| `/api/pastes/:id` | `GET`,`HEAD` | ordinary 为 200 `PasteResource` 或 matching `If-None-Match` 的 304；HEAD 无 body | 200 GET 是，304/HEAD 否 | password 取 query/header；strong response ETag按 12.1；GET view-once忽略 validator并 consume |
| `/api/pastes/:id` | `PUT` `text/plain; charset=utf-8` | 200 `MutationResult` | 否 | body 全部是 new content；password 用 query/header；optional `If-Match` |
| `/api/pastes/:id` | `PATCH` JSON `{content,password?,version?}` | 200 `MutationResult` | 否 | browser autosave canonical path |
| `/api/pastes/:id` | `DELETE` optional JSON `{password?,version?}` | 204 empty | 否 | 无 body 时 password 用 query/header |
| `/api/pastes/:id/settings` | `GET`,`HEAD` | 200 `PasteSummary` | 否 | view-once 也允许；不返回 content/password |
| `/api/pastes/:id/settings` | `PATCH` JSON | 200 `MutationResult` | 否 | body 见 12.6 |
| `/api/pastes/:id/password` | `PUT` JSON | 200 `MutationResult` | 否 | set/change，body 见 12.6 |
| `/api/pastes/:id/password` | `DELETE` JSON | 200 `MutationResult` | 否 | clear；已 unprotected 时 no-op |
| `/api/pastes/:id/history` | `GET`,`HEAD` | 200 `HistoryList` | 否 | view-once 返回 409 |
| `/api/pastes/:id/history/:revision` | `GET`,`HEAD` | 200 `RevisionResource` | 否 | view-once 返回 409 |
| `/api/pastes/:id/read` | `GET`,`HEAD` | 200 `PasteResource` | GET 是 | GET credential 取 query/header；等价于 resource GET |
| `/api/pastes/:id/read` | `POST` JSON `{password?}` | 200 `PasteResource` | 是 | body credential；view-once 会消费 |

API OPTIONS 返回 204 和准确 `Allow`，不发送 `Access-Control-Allow-Origin`。`/api/pastes/:id` 的 `Allow` 为 `GET,HEAD,PUT,PATCH,DELETE,OPTIONS`；OPTIONS 无 body、无 ETag，带 `Cache-Control: no-store`。create、mutation、settings 和 history success resource继续带 `ETag: "<version>"`；resource GET/HEAD 改用 12.1 的 strong response ETag。mutation 的普通失败状态为 400、403、404、409、413、415、422、503。

### 12.6 Settings 与 password API body

settings PATCH strict schema：

```json
{
  "password": "current credential when protected",
  "version": "optional opaque version",
  "title": "optional",
  "format": "optional text|markdown",
  "expiration": "optional ExpirationInput",
  "viewOnce": "optional boolean"
}
```

至少一个 business field 必须存在。只提供 password/version 返回 422。任何 supplied relative expiration 即使 seconds 与原值相同，也重新计算 `expiresAt`，因此是实际 mutation。supplied permanent 在已经 permanent 时，以及 supplied absolute 与当前 normalized instant 相同时，可为 no-op。

password PUT：

```json
{
  "password": "current credential when protected",
  "newPassword": "required, empty clears",
  "version": "optional opaque version"
}
```

password DELETE strict schema 为 `{password?,version?}`，语义等同 `newPassword:""`。password change 后 response 的 `protected` 反映新状态。

### 12.7 History API schemas

```json
{
  "id": "example",
  "currentRevision": 4,
  "currentVersion": "generation.7",
  "revisions": [
    {
      "revision": 3,
      "savedAt": "2026-09-12T08:20:00.000Z",
      "supersededAt": "2026-09-12T08:30:00.000Z",
      "byteLength": 1200
    }
  ]
}
```

`RevisionResource`：

```json
{
  "id": "example",
  "revision": 3,
  "savedAt": "2026-09-12T08:20:00.000Z",
  "supersededAt": "2026-09-12T08:30:00.000Z",
  "byteLength": 1200,
  "content": "exact prior content"
}
```

## 13．HTTP error model 与 header matrix

### 13.1 API error envelope

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "The paste changed after this page loaded.",
    "details": {
      "currentVersion": "generation.8",
      "updatedAt": "2026-09-12T08:31:00.000Z"
    }
  }
}
```

`details` 仅在下表列出时出现。message 固定英文，UI 根据 code 本地化，不显示 server stack。

| HTTP | code | 条件 | details |
|---:|---|---|---|
| 400 | `BAD_REQUEST` | malformed JSON、invalid UTF-8、path/query syntax，或 ordinary resource read 的 malformed `If-None-Match` | 无 |
| 400 | `AMBIGUOUS_PASSWORD` | duplicate password query | 无 |
| 400 | `AMBIGUOUS_VERSION` | body 与 `If-Match` 不同或 ETag syntax 无效 | 无 |
| 403 | `FORBIDDEN` | protected paste 的 password missing/wrong | 无 |
| 404 | `PASTE_NOT_FOUND` | main missing 或 logical expired | 无 |
| 404 | `REVISION_NOT_FOUND` | history 中无该 revision | 无 |
| 409 | `ID_CONFLICT` | custom ID 的任一相关 key 可见 | `{id}` |
| 409 | `VERSION_CONFLICT` | supplied version stale | `{currentVersion,updatedAt}` |
| 409 | `VIEW_ONCE_HISTORY_FORBIDDEN` | active view-once history list/get | 无 |
| 413 | `CONTENT_TOO_LARGE` | content 超过 10 MiB | `{maxBytes:10485760}` |
| 413 | `REQUEST_TOO_LARGE` | JSON/MCP wire body 超过 64 MiB | `{maxBytes:67108864}` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | route 不接受该 Content-Type | `{accepted}` |
| 422 | `VALIDATION_FAILED` | semantic schema、ID、title、password、expiration 或 empty content 错误 | field errors array |
| 500 | `RENDER_FAILED` | safe Markdown renderer unexpected failure | 无 |
| 500 | `INTERNAL_ERROR` | 未分类 server defect | 无 |
| 503 | `STORAGE_READ_FAILED` | KV read rejection | `{retryable:true}` |
| 503 | `STORAGE_WRITE_FAILED` | create/mutation write rejection | `{retryable:true,mutationMayHaveApplied}` |
| 503 | `STORAGE_INCONSISTENT` | schema/generation/revision state 无法安全组合 | `{retryable:true}` |
| 503 | `CONSUME_FAILED` | view-once delete 未全部完成 | `{retryable:true,mutationMayHaveApplied:true}` |
| 503 | `ID_GENERATION_FAILED` | 五次自动 ID 均 occupied | `{retryable:true}` |

不使用401或429。HTML application route对相同状态返回带 safe error bootstrap的最小 shell，由 React渲染本地化 error page；direct raw/html/md/file error使用 `text/plain; charset=utf-8`和简短英文，不返回 JSON或 stored content。

### 13.2 Response headers

| 响应类别 | 必须 headers |
|---|---|
| API JSON | `Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`；create/mutation/settings/history resource 使用 version ETag，`GET|HEAD /api/pastes/:id` 使用 strong response ETag |
| API 304 | `ETag`、`Cache-Control: no-store`；无 body、`Content-Type`、`Content-Length` 或 trailers |
| React application shell | `Content-Type: text/html; charset=utf-8`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、本规格 16.5 的 CSP |
| raw | `Content-Type: text/plain; charset=utf-8`、`Cache-Control: no-store` |
| user HTML | `Content-Type: text/html; charset=utf-8`、`Cache-Control: no-store`；不得发送 CSP、sandbox header 或 application `Referrer-Policy` |
| Markdown HTML | 与 React application shell 相同的安全 headers，但 body 为 server-produced safe document且不 mount autosync |
| file | `Content-Type: application/octet-stream`、`Content-Disposition`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff` |
| 302 password redirect | `Location`、`Cache-Control: no-store` |
| 405 | 对应 media type、`Allow`、`Cache-Control: no-store` |
| retryable 503 | 对应 media type、`Retry-After: 1`、`Cache-Control: no-store` |
| hashed asset | 正确 asset media type、`Cache-Control: public, max-age=31536000, immutable` |

## 14．`/ip-trace`

`/ip-trace` 对 `GET`、`HEAD`、`POST`、`PUT`、`PATCH`、`DELETE`、`OPTIONS` 都注册同一个 handler。除 HTTP 对 HEAD 自动移除 body 外，成功状态均为 200，body 使用 `JSON.stringify(value, null, 2)`，无末尾追加字段：

```json
{
  "url": "https://example.com/ip-trace?x=1",
  "method": "POST",
  "data": "exact request body text",
  "headers": {
    "header-name": "value"
  },
  "cf": {
    "full": "request.cf object"
  }
}
```

实现与已读 [`aioapi.js`](../../../aioapi.js) 根逻辑一致：`data = await request.clone().text()`，`headers = Object.fromEntries(request.headers)`，`cf = Object.fromEntries(Object.entries(request.cf ?? {}))`。不筛选、redact、rename 或汇总 `request.cf` 与 headers。本地没有 `request.cf` 时返回 `{}`，使 local smoke 可运行。

response headers：

```plaintext
Content-Type: application/json; charset=utf-8
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS
Cache-Control: no-store
```

不发送 `Access-Control-Allow-Credentials`。该端点有意反射 Authorization、Cookie 和其他敏感 request headers 与 body，调用者自行承担披露风险。

## 15．MCP protocol 与八个 tools

### 15.1 Mounting 与 wire behavior

1. endpoint 精确为 `/mcp`。`POST` 交给 `createMcpHandler`；`GET` 与 `DELETE` 返回 405；不存在 standalone SSE GET、session termination、resumability、`Last-Event-ID` 或 `Mcp-Session-Id`。
2. 使用 SDK v2 默认 stateless legacy fallback，不传 `{legacy:"reject"}`。modern request 支持 MCP `2026-07-28`、`server/discover`、request-scoped capabilities、required `_meta` 和 mirrored headers。legacy `initialize` 路径由 SDK fallback 处理，但不建立跨请求 server state。[modern version 与 Streamable HTTP 规则](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)及[SDK protocol version behavior](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)。
3. 每个 POST 创建 fresh `McpServer` 并注册相同八个 tools。任何 request identity、capability 或 password 都不放 module global。
4. `Content-Type`、`Accept`、JSON/SSE response、protocol errors、`-32020`、`-32021`、`-32022` 与 modern header/body matching 交给 SDK。已解析但 unavailable modern method 按 spec 返回 HTTP 404 与 JSON-RPC `-32601`。[MCP errors](https://modelcontextprotocol.io/specification/2026-07-28/schema#errors)。
5. 不设置全局 bearer token。paste password 只来自对应 tool input。
6. Origin header absent 时直接通过。存在时必须能 parse，且 normalized `Origin` exact 等于 `new URL(request.url).origin`；`Origin: null`、cross-origin 或多个 values 返回 HTTP 403，再进入 SDK 前结束。CLI/curl 没有 Origin 时可用。SDK 不自行验证 Origin，[安全边界依据](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md#protect-against-dns-rebinding)。
7. `OPTIONS /mcp` 在相同 Origin rule 后返回 204，`Allow: POST,OPTIONS`。不开放 wildcard CORS。
8. `tools/list` 顺序固定为本节列出的顺序，无 pagination 需要时不返回 cursor。所有 tools cache TTL 为 0，因为 paste 可变且 view-once 不可缓存。

### 15.2 通用 tool result

每个成功 call 同时返回：

```json
{
  "content": [{"type":"text","text":"<structuredContent 的 compact JSON>"}],
  "structuredContent": {"ok":true}
}
```

`text` 与 `structuredContent` 表示同一数据。correctable domain failure 不使用 JSON-RPC error，而返回 `isError:true`：

```json
{
  "content": [{"type":"text","text":"{\"ok\":false,\"error\":{...}}"}],
  "structuredContent": {
    "ok": false,
    "error": {"code":"FORBIDDEN","message":"Password is missing or incorrect."}
  },
  "isError": true
}
```

malformed tool arguments、unknown tool 和 protocol failure 由 SDK 产生 JSON-RPC error。每个 tool 注册 strict Zod 4 input 与 success/error discriminated-union output schema。[SDK 要求 tool schema 与 structuredContent 一致](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#calling-tools)。

### 15.3 `paste_create`

Input：

```json
{
  "content": "string, 1..10 MiB UTF-8",
  "title": "optional string, default empty",
  "format": "optional text|markdown, default text",
  "expiration": "optional ExpirationInput, default 86400",
  "password": "optional visible ASCII string, default empty",
  "viewOnce": "optional boolean, default false",
  "customId": "optional custom ID"
}
```

Success：`{"ok":true,"paste":<PasteSummary>}`。不返回 content，不读取、不消费、不自动打开。domain errors 与 HTTP create 同 code。

### 15.4 `paste_get`

Input：

```json
{
  "id": "required ID",
  "password": "optional current plaintext password",
  "representation": "optional source|raw|html|markdown|file, default source"
}
```

Success：

```json
{
  "ok": true,
  "paste": "<PasteSummary>",
  "representation": "markdown",
  "mediaType": "text/html; charset=utf-8",
  "content": "returned representation string",
  "fileName": null
}
```

`source` 与 `raw` 返回 exact source，media type 为 `text/plain; charset=utf-8`。`html` 返回 exact source，media type 为 `text/html; charset=utf-8`。`markdown` 返回 safe rendered HTML。`file` 返回 exact source string、`application/octet-stream` 和派生 `fileName`。调用是 content-bearing；view-once 在 result 交给 SDK 前按第 10 节删除。

### 15.5 `paste_update`

Input：

```json
{
  "id": "required ID",
  "content": "required new content",
  "password": "optional current password",
  "version": "optional opaque version"
}
```

Success：`{"ok":true,"changed":true|false,"paste":<PasteSummary>}`。只修改 content；不得接受 title、format、expiration、viewOnce 或 newPassword。actual change 建立 history。

### 15.6 `paste_delete`

Input：

```json
{
  "id": "required ID",
  "password": "optional current password",
  "version": "optional opaque version"
}
```

Success：`{"ok":true,"id":"example","deleted":true}`。调用 delete 五个 keys；view-once 也允许。

### 15.7 `paste_history_list`

Input：`{"id":"required ID","password":"optional current password"}`。

Success：`{"ok":true,"history":<HistoryList>}`。不接受 cursor/limit，因为最多三个。view-once 返回 `VIEW_ONCE_HISTORY_FORBIDDEN` tool error。

### 15.8 `paste_history_get`

Input：

```json
{
  "id": "required ID",
  "revision": "required positive safe integer",
  "password": "optional current password"
}
```

Success：`{"ok":true,"revision":<RevisionResource>}`。普通 paste 不消费；view-once 返回 tool error。

### 15.9 `paste_settings_update`

Input：

```json
{
  "id": "required ID",
  "password": "optional current password",
  "version": "optional opaque version",
  "title": "optional",
  "format": "optional text|markdown",
  "expiration": "optional ExpirationInput",
  "viewOnce": "optional boolean"
}
```

至少一个 business setting。Success 与 `paste_update` 相同，不建立 history。view-once 在首次 read 前允许。

### 15.10 `paste_password_update`

Input：

```json
{
  "id": "required ID",
  "password": "optional current password",
  "newPassword": "required visible ASCII or empty to clear",
  "version": "optional opaque version"
}
```

Success 与 `paste_update` 相同，不建立 history。未保护可 set，已保护 change/clear 先校验 current password。

## 16．HTML 与 Markdown rendering boundary

### 16.1 Raw 与 file

`/raw` 和 raw/source API/MCP result 不解释 content。React application 只通过 controlled Textarea value或普通 text children显示 source、snapshot和 diff，不把这些值传给 HTML insertion API。`/file` 输出 source 的 UTF-8 bytes，不基于 `format` 修改 extension 或内容。

### 16.2 User HTML

`/html/:id` response body 就是 stored source，不加 doctype、wrapper、title、script、style 或 escaping。它是顶层 same-origin executable document：

* script、form、popup、navigation、fetch、XHR、WebSocket、external stylesheet/image/script 等按浏览器默认能力工作；server 不过滤 URL 或 protocol，HTTP mixed-content 等仍由浏览器自身执行。
* 不使用 iframe 或 sandbox。
* 不使用 sanitizer。
* 不发送 CSP。
* protected URL 保留 plaintext password query，因此 user JavaScript 可读 `location.search`，可读取并外传 password，也可使用该 origin 调用 paste API。
* 同一 origin 下的用户 HTML 可能进行 phishing、读取它本来就知道 ID/password 的资源或影响同 origin 信任。此为用户明确接受的能力。

application CSP 绝不能被共享 middleware 加到该 response。

### 16.3 Safe Markdown

服务端唯一 renderer：

```js
micromark(source, {
  allowDangerousHtml: false,
  allowDangerousProtocol: false,
  extensions: [gfm()],
  htmlExtensions: [gfmHtml()]
})
```

使用 `micromark-extension-gfm` 的完整 `gfm()` 与 `gfmHtml()`，支持 tables、task lists、strikethrough、autolink literal 和完整扩展集合。保留默认 `clobberPrefix`，不设为空。raw HTML 作为文字输出，危险 link/image protocol 不进入可执行 URL。[micromark security defaults](https://github.com/micromark/micromark/blob/main/packages/micromark/readme.md)与[full GFM extension](https://github.com/micromark/micromark-extension-gfm/blob/main/readme.md)。

只有该固定 renderer 的 output 可传给 `hono/html` 的 `raw()`，或进入 React 中专门接收该 renderer output 的 trusted safe-Markdown boundary。stored source、title、error、history、diff 和 bootstrap data 绝不能进入该 boundary。client preview 使用相同版本、相同 options 和 extensions，server response 仍是最终 canonical preview。

`/md/:id` 是 server-produced application-owned wrapper，不是 user HTML。它包含 semantic article、title、copy/open source actions和 safe rendered fragment，不执行 source 内的 HTML/script，不 mount React workbench或 controlled sync。

### 16.4 Milkdown canonical source rule

Markdown source 是唯一 canonical content。Crepe 的 Markdown -> AST/ProseMirror -> Markdown round trip 可能 normalize whitespace 或 syntax，[Milkdown architecture](https://github.com/Milkdown/website/blob/main/docs/guide/architecture-overview.md#markdown-transformation)。规则固定为：

1. 进入 visual mode 前保留 exact source snapshot，设置 `visualDirty=false`；normalization explanation 只能放入 Markdown mode label旁的 question-mark `HelpTrigger`，不得直接显示 notice。
2. 仅 mode switch、focus、selection 或 Crepe 初始化不得调用 autosave，不得用 serializer output 覆盖 snapshot。
3. 只有 Crepe 的真实 document-change transaction 才设置 `visualDirty=true` 并触发 input timestamp。
4. 离开 visual mode 时，`visualDirty=false` 就恢复原 snapshot；为 true 才以 `getMarkdown()` 的结果更新 draft，并按 autosave state machine 保存。
5. source mode textarea 直接编辑 canonical string。preview mode只读当前 draft，不改变 draft。
6. Crepe load/initialize 失败时保留 source textarea 和完整 draft，显示可重试错误，不阻止 plain Markdown 编辑。

### 16.5 Application CSP

只对 `/`、`/:id` 的 React create/paste/password/error shell 和 `/md/:id` safe document设置：

```plaintext
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
```

`'unsafe-inline'` 只为 Milkdown runtime style attributes，不允许 inline script。React shell只含 mount node、`application/json` bootstrap node、paste page的 `application/octet-stream` exact-source node，以及 `format=markdown` paste可选的 inert `<template id="initial-markdown-preview">`；该 template内容只可来自第16.3节固定 server renderer。bootstrap把 `<`、`>`、`&`、U+2028、U+2029 escape。source和 preview在 mount前按第4.2节提取并移除 inert nodes；password永不进入 bootstrap。所有 executable script和CSS来自 Vite生成的 hashed same-origin assets。该 CSP不应用于 `/html/:id`。

## 17．React frontend、autosave 与 autosync

### 17.1 Application shell、bootstrap 与 React ownership

`/` 和 `/:id` 的 create、ordinary paste、consumed paste、password 与 application error response只返回第 16.5 节的最小 shell。React 19.3.0 在唯一 mount node 上调用一次 `createRoot`，拥有全部可见 application UI；server 不预先生成可见 form、tabs、rail、dialog、error panel 或 workbench。`/raw`、`/html`、`/md`、`/file` 和 `/ip-trace` 仍按各自 representation contract直接返回，不进入这个 root。

bootstrap 是下列 validated discriminated union，不允许 unknown field。protected password不得出现在任何 variant：

```ts
type AppBootstrap =
  | { page: "create"; locale: "en" | "zh-CN" }
  | { page: "paste"; locale: "en" | "zh-CN"; paste: PasteSummary; consumed: false }
  | { page: "paste"; locale: "en" | "zh-CN"; consumed: true }
  | { page: "password"; locale: "en" | "zh-CN"; errorCode: null | "FORBIDDEN" }
  | { page: "error"; locale: "en" | "zh-CN"; status: number; errorCode: string }
```

ordinary 和 consumed paste各有且仅有一个 inert exact-source node；`format=markdown`时另有一个由 fixed server renderer产生的 inert initial preview template，其他 page不得有。`main.tsx`必须先读取、验证和移除 bootstrap/source/preview nodes，再创建 React root；decoded exact source直接成为 page-scoped canonical state，不能先经过 textarea DOM value，以免 CR/CRLF normalization。React只把 extracted preview交给第16.3节 trusted boundary，因此 Markdown default view不 eager-load browser renderer。bootstrap、source或 preview shape失败时，React只渲染本地化 application error，不猜测 source。full navigation是 page identity boundary；不使用 React Router、history route interception、link prefetch或 StrictMode side effect作为 production行为。controller setup必须可被 test中的 mount -> unmount -> mount安全重复，不产生重复 timer、listener或 request。

### 17.2 Pinned template adaptation

以第 4.1 节的 `sidebar-11` source为 shell，保留 `SidebarProvider`、`SidebarInset`、`SidebarTrigger`、`SidebarRail`、Sheet mobile path、Breadcrumb、Separator和 Collapsible composition。把 upstream recursive sample file data全部替换成真实 paste mode、metadata和 action groups；不保留 sample filename、folder、change count、repository path、logo、account/team control或 placeholder link。

界面必须是 paste Document Workbench，不是 generic SaaS dashboard：

* desktop sidebar/lifecycle area只显示当前 document的真实 ID、protected、viewOnce、expiry、content revision、byte size、autosave和 autosync state，以及可用 modes/actions；document/editor占主要宽度；
* Breadcrumb只表达 `Paste > <id>` 或 create/password/error的实际位置；
* `View`、`Edit`、`Markdown`、`History`、`Settings` 使用官方 Tabs；sidebar disclosure只组织相同真实 destinations，不生成第二套 state ownership；
* 小于 `48rem` 时采用 upstream Sidebar的 Sheet。320 CSS px 下 Sheet宽度为 `min(18rem, 100vw)`，关闭后 document/editor占完整 viewport宽度；选择 destination后关闭 Sheet；
* page没有横向 overflow，只有 editor、code和 diff viewport可以局部横向滚动；
* 不使用 gradient、glass、decorative card、card-inside-card、external font、illustration、meaningless metric/sample data、oversized hero、通用 dashboard header或 visible static boilerplate。普通结构不用 shadow；Dialog/Sheet只使用 upstream必要 elevation。

### 17.3 Visible copy 与 question-mark help

可直接显示的文字只限于：content相关 label和 value、document metadata、actions、validation/error、以及 live operation state。任何 explanation、warning、limitation、encoding/storage/size prose、common-knowledge hint或操作原理都不得直接出现在页面，包括 view-once distributed semantics、exact storage、UTF-8、10 MiB、relative expiration、active HTML、password URL exposure、Markdown normalization、autosave和 autosync原理。它们放在相关 label旁的统一 question-mark `HelpTrigger` 中。placeholder不得承担 label或 explanation职责。

`HelpTrigger` 使用官方 controlled Tooltip，并满足：

1. trigger是显示 `?` 的 semantic Button，最小 44×44 CSS px，具有本地化 accessible name `Help: <field or action>`，tooltip content有稳定 ID，trigger以 `aria-describedby` 关联；关联 field也可以共享该 description ID；
2. pointer hover或 keyboard focus打开；click/touch切换 pinned open；未 pinned时 pointer leave和 focus leave关闭；Escape或 outside pointer interaction始终关闭并清除 pinned；再次 click关闭；
3. tooltip不取得正常 Tab stop，trigger仍在自然 keyboard order；关闭后 focus留在或返回 trigger；
4. help只补充说明，不含完成 form或 action所需的唯一 control、value或错误，不看 help也能完成操作；
5. 同一时刻只打开一个 help，locale切换时已打开内容原位更新。

validation和 server error可以直接显示，因为它们说明当前失败及恢复动作。Delete、discard local draft、Reload server和其他会丢失数据的既有 confirmation可使用 Dialog；connectivity、save、sync、copy、download、create或其他 action feedback绝不使用 Dialog、`alert()`、toast、snackbar或 transient popup。

### 17.4 Create、password、error 与 consumed pages

Create page用 Field、Label、Input、Textarea、Button和必要的 Tabs/Separator提供 content、title、`format`、七档 expiration、password reveal、view-once、optional custom ID、Create、locale和theme controls。限制与后果只在对应 HelpTrigger。拖放只取第一个 item。file 时用 `File.text()`；filename写入 title，违反 title规则时显示 validation error而不截断。纯文字拖放写入 content。client先检查 UTF-8 bytes，server仍做权威校验。

submit 使用 `POST /api/pastes` JSON；接近 wire envelope或大量 JSON escaping会逼近它时改用 multipart，字段语义不变。pending时禁止重复 submit。201 后不 navigate、不 click、不 prefetch，仍在 create React tree内显示 paste ID、summary、clean representation links及 copy actions；links在 render/click时用当前 page password和 `URLSearchParams`生成。view-once后果和 distributed limitation只存在 View once HelpTrigger，不生成 visible warning paragraph。

Password page由 React渲染一个 labeled password Input、reveal Button、Submit和 inline error；bootstrap不包含 title、format、expiry、content或其他 protected summary。form仍按 9.3 POST，成功302 full navigation。Application error page由 safe `status`和 normalized `errorCode`在本地 dictionary中渲染，不显示 stack或未清理 server message。

`consumed:true` 使用独立 React branch，不先构造 ordinary tree再隐藏。它只持有已返回 exact source和 local copy、wrap、raw text toggle、safe Markdown preview、UTF-8 download、top-level Blob HTML navigation及 create-new action；不创建 network hook、server representation URL、Edit、History、Settings、delete或 autosync controller。已消费状态可以作为 document metadata直接显示，distributed semantics只在 HelpTrigger。

### 17.5 Ordinary paste modes 与 canonical state

`format=text`默认 plain read view；`format=markdown`默认使用 server shell的 inert safe preview template，不因 default mode eager-load browser micromark。template缺失或 shape无效是 application error，不以 eager import掩盖。ordinary paste提供 View、Edit、Markdown、History、Settings，以及 raw、HTML、md、file、copy、wrap、create new和 delete actions。任意 format都能进入 plaintext edit、Markdown visual/source/preview和全部 representations；format只选择 default view。

plaintext editor使用 system monospace、保留 whitespace、默认 `spellcheck=false`，read和 editor都支持 Wrap/Unwrap。copy优先使用 `navigator.clipboard.writeText`，失败后使用隐藏 textarea selection fallback；成功或失败更新 action button和 OperationStatus，不移除 action。delete由官方 Dialog确认后调用 canonical DELETE；成功后清除 React state、controller、source、candidate和 password reference，再 full navigate `/`。

protected page启动时从唯一 query读取 password到 page-scoped closure/state。所有 request显式携带当前值，所有 representation URL在 render/click时重新生成；不得写 cookie、`localStorage`、`sessionStorage`、IndexedDB或 `window.name`，也不得缓存含旧 password的 URL。

React canonical state至少包含 `acceptedSource`、`draft`、`PasteSummary`、`version`、`contentRevision`、`updatedAt`、latest accepted response ETag和 `localGeneration`。remote apply是一个 batched state transition，必须同时：

* 更新 `acceptedSource`、summary、version/contentRevision/updatedAt markers、accepted read ETag、read view与 plaintext editor baseline，并通过 controller的 non-input reload path同步 `draft=lastSavedContent`、清除 save timer/in-flight、设 autosave=`clean`而不更新 confirmedAt；
* 更新 Markdown exact source snapshot、source mode、visual document与 preview；若 Crepe已 mount，使用不会发出 user document-change callback的 programmatic reset，无法可靠 suppress时先 destroy再以新 source创建，并以 `remoteApplying` guard阻止 autosave；
* 更新已选择 diff的 current side并按 size policy重新计算；
* 同 generation但 `contentRevision`改变时把 history list标为 stale，保留仍可识别的 selected immutable snapshot并在下一次 History access重新 fetch descriptors；不同 generation时清空全部 history snapshot/list/diff；仅 settings marker变化时保留 history；
* 不调用 `AutosaveController.input`，不建立 history，不发送 save，不改变 `localGeneration`。

### 17.6 Autosave state machine

状态为 `clean`、`waiting`、`saving`、`saved`、`error`、`conflict`。`clean` 只表示初始加载后尚无本地修改，`saved` 表示最近一次 save 已确认且当前 draft 与确认内容相同；两者都没有 pending timer。数据至少包括 `draft`、`lastSavedContent`、`version`、`lastInputAt`、`dueAt`、`inFlightContent`、`dirtyWhileSaving`。

1. 初始 state 为 `clean`，`draft=lastSavedContent=server content`，`version=server version`，`inFlightContent=null`，`dirtyWhileSaving=false`。
2. 普通 `input` 更新 draft，并设置 `lastInputAt=now`、`dueAt=now+1000`。无 in-flight 时进入 `waiting`，并用一个指向该 `dueAt` 的 timer 替换旧 timer；有 in-flight 时保持 `saving`，按第 5 步处理。
3. `compositionstart` 取消 pending timer 但保留 draft；composition 期间的 intermediate input 更新 textarea 与 draft，但不更新 autosave的 `lastInputAt`、`dueAt` 或发送 request。`compositionend` 把最终 value当作一次普通 input，并从该时刻完整等待 1,000 ms。
4. timer到 `dueAt`时先清除自身。若 draft等于 `lastSavedContent`，不发送并进入 `saved`。否则仅当 `inFlightContent=null`且 state不是 `conflict`时，先记录一次 local mutation dispatch：增加 `localGeneration`、设置 `activeUntil=dispatchAt+300_000`并 abort/invalidate任何 sync；再 capture该 generation，设置 `inFlightContent=draft`、`dirtyWhileSaving=false`、state=`saving`，然后发一个 `PATCH /api/pastes/:id`。body固定含 `{content:inFlightContent,version}`；仅当 `pastePassword !== null`时再加入 `password:pastePassword`。
5. 任一时刻最多一个 autosave request。saving时的新 input仍按第 2 步更新 draft、`lastInputAt`与 `dueAt`，设置 `dirtyWhileSaving=true`，但不启动可在 in-flight完成前发送的第二个 request。
6. 收到 200 changed或 no-op时，先把 `lastSavedContent`设为该 request的 `inFlightContent`，把 `version`、summary、`contentRevision`和 `updatedAt`设为 response值，再清空 in-flight标记。若 `localGeneration`仍等于 request capture且 draft等于 `lastSavedContent`，清除 timer并进入 `saved`；否则进入 `waiting`，在 `max(0, dueAt-now)` 后发送唯一一次 coalesced latest draft。mutation response的 version ETag不是 read response ETag，因此成功后清除 cached response ETag，下一次 autosync发送 unconditional GET。
7. network、413、422、500或503清空 autosave in-flight与 timer，但保留 draft、`lastSavedContent`和 version，进入 `error`，不自动 retry。用户可 Retry、copy或download draft；下一次新 input按第 2 步重新进入 `waiting`。
8. 403同样保留全部 draft state，OperationStatus显示 `password-required`，并提供 inline password re-entry。新 password只改 page state；用户显式 Retry后才立即发送 latest draft。
9. 404保留 draft，停止 autosave和 autosync，提供 copy/download，不尝试重建同 ID。
10. 409 version conflict保留 draft并进入 `conflict`，同时暂停 autosync。显示 Reload server、Overwrite with draft、Copy draft。Reload必须经 destructive Dialog确认后调用同一 resource GET；成功用 server content和 markers替换全部 canonical surfaces。Overwrite立即发送 latest draft并明确省略 version执行 last-write-wins。没有自动 merge。
11. `error`或403状态的显式 Retry仅在无 in-flight且 draft与 `lastSavedContent`不同时立即发送 latest draft，使用当前 password与 version。Retry失败仍按对应规则。
12. draft与 `lastSavedContent`不同或 mutation in-flight时注册 `beforeunload` warning；相同且无 in-flight时移除。
13. server exact no-op detection是最终依据，client comparison只用于避免 request。React只实例化一个 controller并在 unmount dispose，不在 reducer/effect中实现第二套 transitions。

### 17.7 Autosync eligibility、clock 与 request sequencing

真正非轮询的等价实现受第 3 节约束而不可行，因此只使用直接、顺序的 browser polling。不得用 open stream、socket、service worker、server loop或 Cache包装它。

clock使用可注入的 monotonic milliseconds；production用 `performance.now()`计算 deadline和 due time，用 `Date`只生成显示时间。定义：

* `activeUntil`：application完成初始 load/refresh时设为 `loadAt + 300_000`；之后每个真实 local edit event和每次 local mutation dispatch都直接设为该 activity time `+ 300_000`；不 round、不加 grace period；
* `localGeneration`：初始为0；每个 source input、Crepe document-change、`compositionstart`、IME intermediate input，以及每个 API mutation dispatch都在 capture request前各加1。API mutation包括 automatic autosave、Retry/Overwrite、settings/password/viewOnce/delete。programmatic remote apply、copy/download和 sync request不增加；
* `locallyClean`：draft exact等于最后一次 acknowledged source，且没有 composition、autosave timer、autosave/mutation request、queued coalesced save、sync conflict或 remote apply；
* `syncDueAt`：每次进入 eligible状态或前一次 sync settle时的 monotonic time `+ 3_000`。

只有 ordinary、未 consumed paste page且 `now < activeUntil`、`locallyClean=true`、browser未 offline时才 eligible。load后不发额外 immediate GET；在初始 clean state安排一次 `loadAt + 3_000`的 timer。initial load或从 local pause、online event、explicit Retry恢复后，普通 timer pending时 autosync state=`waiting`；settle后的3,000 ms timer保留最近 outcome state，candidate verification timer保留 `candidate-observed`；fetch in-flight时=`checking`。local work使其不 eligible时=`paused-local`，offline时=`paused-offline`，deadline到达时=`inactive`。response outcome使用第17.8至17.9节 states。规则固定如下：

1. 每次只存在一个 sync timer和最多一个 sync fetch。timer以 `max(0, syncDueAt-now)`安排，callback先清除自身并重新检查全部 predicate；callback运行晚且 `now >= activeUntil`时不得发 request。
2. 任一 edit、`compositionstart`、IME input、autosave wait/save、显式 mutation dispatch或 remote apply开始都取消 sync timer。若 sync fetch已开始，调用其 `AbortController.abort()`并立即使 captured request token失效；即使 transport仍 resolve，也不得读取或应用结果。
3. request capture `{requestToken, localGeneration, accepted marker, activeUntil}`。只有 token仍 current、generation与 baseline未变、仍 locally clean且 active时，response才可进入第 17.8 节比较。
4. composition、dirty draft、autosave wait/in-flight/coalesced、settings/password/viewOnce/delete mutation、remote apply或 conflict期间不安排 sync。对应工作完成后，仅当再次 eligible才从该 completion time开始新的完整 3,000 ms等待。
5. sync fetch settle后不在同一 callback立即再发。只有仍 eligible时才设 `syncDueAt=settledAt+3_000`并安排一次。network retry也走这一条，不建立额外 retry/backoff loop。
6. 到 `activeUntil`时取消 waiting timer；in-flight response在 settle时若 `now >= activeUntil`只可更新 network outcome，不得应用 content或安排下一次。新的 local edit或 mutation activity建立新的 exact 300,000 ms window，待 clean后再完整等待3,000 ms。
7. polling只调用 `GET /api/pastes/:id`，fetch设 `cache:"no-store"`；有 accepted read ETag时显式发送 `If-None-Match`，无 ETag或需要验证 quarantined candidate时省略。password仍使用现有 unique query carrier。不得调用 status-only、settings-only或新 sync request。

### 17.8 Remote ordering 与 deterministic candidate rule

每个成功200先作为 `RemoteSnapshot`验证，至少含 strong response `etag`、exact `source`、完整 summary、opaque `version`、positive `contentRevision`和 RFC3339 `updatedAt`。adapter先读取 exact response bytes，验证 `ETag`格式并用 Web Crypto SHA-256核对 digest，再 strict parse `PasteResource`。coherent还要求 response ID与当前 path exact相同、`contentBytes`等于 source UTF-8 byte length、links符合该 ID的 clean canonical paths、timestamp可 parse且 schema2 version/contentRevision为 positive safe integer；任一失败进入 sync `error`并停止到 explicit Retry，不进入 ordering comparison。schema2 version按最后一个 `.`分成 generation与 positive safe integer counter；`legacy`不伪造 counter。当前 accepted baseline保存同样 markers和 exact source。

对两个 schema 2 snapshot，只有 generation相同才比较三维 marker `(versionCounter, contentRevision, updatedAt instant)`：

* remote三项都小于等于 baseline且至少一项严格小于，为 `definitely-older`；记录 valid check并把 autosync state设为 `unchanged`，但忽略 response，不替换 accepted ETag、summary或任一 surface；
* remote三项都大于等于 baseline且至少一项严格大于，为 `definitely-newer`；
* 三项全相等为 `marker-equal`；
* 一部分增加而另一部分减少，为 `incomparable`。

不同 generation，以及 legacy snapshot与 baseline不能 exact equality时，均为 `incomparable`。`marker-equal`且 exact source和所有 public summary fields相等时为 unchanged，并把该200 strong ETag保存为 accepted read ETag；source相同的 `definitely-newer`仍应用 summary/marker和 ETag但不重建 editor。source或 public summary有 divergence的 `marker-equal`，以及所有 `incomparable`，执行下列稳定候选规则，不静默 overwrite：

1. 第一次看到 divergent snapshot时，把完整 identity `{etag,version,contentRevision,updatedAt,source,summary}`保存在 memory quarantine，保持当前 UI，不更新 accepted ETag，把 autosync state设为 `candidate-observed`并更新 checkedAt，然后在 settle后按正常规则等待3,000 ms。
2. candidate verification request明确省略 `If-None-Match`。只有下一次 eligible、完整等待后的成功200与 quarantined identity逐字段和逐 code unit完全相同，并且 baseline、`localGeneration`和 clean状态均未变，candidate才是 stable repeated remote candidate；此时按第17.5节一次性 remote apply并在 status记录 `remote-applied`。
3. 第二个成功200若回到 accepted baseline，清除 candidate并记录 unchanged；若是 definitely-newer，清除 candidate并正常 apply；若仍 divergent但 identity不同，进入 non-destructive `sync-conflict`，保留本地 UI和最新 remote candidate，停止自动 sync。
4. error、abort、local activity、baseline变化或 offline清除 quarantine，之后重新从第一次 observation开始；304不能确认 candidate，因为 verification request不发送 validator。
5. `sync-conflict`提供 inline Use remote、Keep current和 Retry sync。Use remote只在仍 clean且 generation/baseline未变时应用 retained candidate；Keep current丢弃 candidate并保持 autosync停止，直到下一次 local mutation成功或 full refresh；Retry sync清除 candidate/conflict，只有仍 active和 clean时才从 action时刻完整等待3,000 ms，本身不延长 active window。三个 action都更新 last-action state，不发 status-only request。
6. 若200 snapshot显示 `viewOnce=true`，该 GET已按第10节在 server consume。`definitely-newer`时立即 remote apply并切到 consumed local-only branch；equal/incomparable divergence不能再次读取确认，立即进入 non-destructive `sync-conflict`并保留 candidate供 Use remote。两种情况都永久 dispose当前 autosync，绝不安排 verification或后续 request。

`definitely-newer`只在 request capture仍有效且页面仍 clean时应用；否则丢弃并等 local work结束后的新 request。304保持全部 canonical state，只更新 check timestamp。该规则不声称提供 CAS、global ordering或绕过 KV最多60秒以上的 cross-location staleness。

### 17.9 HTTP、offline 与 conflict recovery

sync和其他 browser request共享薄 API adapter及 OperationStatus，不共享 in-flight slot；但任何 content/settings/password mutation pending都会让 sync不 eligible，因此同一 page不会让 sync read与 local mutation重叠。

* 200：按第17.8节处理；ordinary remote apply或 unchanged后，从 settle重新等待3,000 ms；response为 `viewOnce=true`时按专用规则停止，不能继续 polling。
* 304：记录 `unchanged`和 check time，从 settle重新等待3,000 ms。
* 403：清除 timer/candidate，状态为 `forbidden`，停止自动 sync；在现有 inline password Field修正 current page password后，用户选择 Retry sync。若 `now < activeUntil`且 clean，从 action时刻完整等待3,000 ms；Retry sync本身不延长 active window，已经 inactive时须等下一次 local edit/mutation activity。不得弹 password modal。
* 404：状态为 `not-found`，永久停止当前 page的 autosave和 autosync，保留已加载 source/draft供 copy/download；只允许 full refresh或 create new，不重建 ID。
* 409：无论 code，状态为 `conflict`，保留本地与已取得 remote data，停止自动 sync；autosave `VERSION_CONFLICT`继续使用第17.6节 actions。resource GET正常不应返回409，测试仍须验证 fail-closed presentation。
* 503或其他 5xx：状态为 `error`，保留 state和 ETag；在线、active且 clean时没有立即 retry，只按 settle后3,000 ms的唯一 normal timer再试。若已 inactive则停止；Retry sync只重建同样3,000 ms timer。
* fetch rejection且 `navigator.onLine !== false`：network为 `degraded`，sync为 `error`，规则同503。AbortError且 token已因 local activity失效不是 error，不改变 network状态。
* `offline` event或 `navigator.onLine === false`：立即 abort/invalidate sync、取消 timer、清除 candidate，network=`offline`、sync=`paused-offline`。`online` event只把 network设为 `online`；仍 active和 clean时从 event time完整等待3,000 ms，否则保持对应 paused/inactive状态。不得在 online event立即 fetch。

local mutation的403、404、409、503和 network行为继续遵守第17.6及对应 Settings规则。所有 retry由现有 operation或一个 Retry action触发，不增加 endpoint，也不通过 modal/toast报告。

### 17.10 History、Settings 与 view-once transition

History desktop为左 revision list、右 detail；mobile先 list，选择后进入 detail并提供 Back。detail用官方 Tabs显示 Unified diff和 Full snapshot，默认 selected revision -> current diff。list和 snapshot按第11节 lazy load；diff worker返回结构化 lines，React用 text children渲染。loading、empty、403、404、409、503和 corruption有独立 visible operation/error state，但空态 explanation放入 History HelpTrigger，不显示教学段落；失败不清空 current draft。

Settings包含 title、default format、expiration、view-once、password change/clear和 immutable ID。每组单独 mutation，不与 content合并。relative expiration、password transport、view-once后果等解释只在 HelpTrigger。mutation dispatch增加 `localGeneration`、扩展 `activeUntil`、abort/invalidate sync并在 pending期间暂停它；成功更新 summary/version，清除 read ETag，并在 clean时重新等待3,000 ms，不创建 history。

把 viewOnce开启成功后，立即 dispose autosave和 autosync，清除 sync timer/candidate，结构上切换为独立的 `armed-view-once` local-only branch，移除 Edit、History、Settings和 server delete action；它显示 `viewOnce` metadata但不得标成 consumed，下一次 server content read才 consume的事实只在 HelpTrigger。初始 view-once的 `/:id` GET已经按第10节 consume，直接以 `consumed:true` branch渲染。不得在这两个 branch上启动 sync。

### 17.11 Persistent operation status

每个 React application page有一个 compact、persistent、non-interruptive `OperationStatus`。ordinary editor同时显示四个独立 record；不适用的页面仍显示 Network和Last action，不伪造 autosave/autosync activity。

| Record | Exact state names | Timestamp meaning |
|---|---|---|
| Autosave | `clean`、`waiting`、`saving`、`saved`、`error`、`password-required`、`not-found`、`conflict` | `confirmedAt`只在 latest local source的200 response完成验证时更新；failure state另存 `failedAt`为该 attempt settle的实际 UTC instant。waiting/saving保留上一次 confirmedAt，不把 dispatch time称为 saved time。 |
| Autosync | `waiting`、`checking`、`unchanged`、`candidate-observed`、`remote-applied`、`paused-local`、`paused-offline`、`error`、`forbidden`、`not-found`、`conflict`、`inactive` | `checkedAt`在有效200或304完成验证时更新；`appliedAt`只在 remote state完成 batched apply时更新。candidate observation算 checked，不算 applied。 |
| Network | `online`、`offline`、`degraded` | initial state取 `navigator.onLine`并以 application init instant作为 `changedAt`；之后它是最近一次 browser online/offline event或 fetch network outcome让 state实际改变的 UTC instant。HTTP 4xx/5xx不把 network标成 degraded；degraded后的成功 fetch改回 online并更新 time。 |
| Last action | `idle`、`pending`、`succeeded`、`failed`，另带固定 action key | `idle`没有 action key或 timestamp；pending的 `startedAt`是 click/submit dispatch instant；success/failure的 `settledAt`是现有 request或 browser API完成 instant。不得记录或显示 password、request body或 protected URL。 |

这些 records只从既有 create/read/mutation/browser API request、autosave/autosync controller transition、Button action及 browser `online`/`offline` events派生；没有 heartbeat、status-only request或 status timer。全部 state label和 timestamp用当前 locale，timestamp以 `<time datetime="RFC3339">`和 `Intl.DateTimeFormat(locale,{dateStyle:"medium",timeStyle:"medium"})`显示，不做每秒 relative-time更新。四个 record共享一个 `aria-live="polite"` status boundary，并对未改变的 record保持 DOM稳定，避免一次事件重复朗读整区；validation blocking error可以另用 `role="alert"`。

每个 action Button在 pending时显示动作本身的 pending icon/label，settle后原位显示对应 success或failure icon/label，直到下一次同 action或 page state使其重置；同时更新 Last action。icon永远有可见文字或 accessible name，不能单独表达结果。该反馈不发额外 request，不自动消失，不用 Dialog、toast、snackbar或 popup。

### 17.12 i18n 与 theme

所有可见 label、HelpTrigger内容、state、button outcome和 error有 `en`和 `zh-CN`完整 dictionary，keys严格 parity。technical identifiers如 raw、HTML、Markdown、MCP、ID、version不翻译。server初始 locale用 `Accept-Language`第一个 `zh` range选择 `zh-CN`，其余为 `en`；browser以 `navigator.languages`第一个 supported language修正。manual switch立即更新 React tree、document `lang`、title、accessible names、help、state、error和 dates，只存在当前 document，不写 storage。server English error message不是唯一 UI copy。

theme control的 exact preference states为 `system`、`light`、`dark`，初始 `system`并跟随 `matchMedia("(prefers-color-scheme: dark)")`。选择 `system`时持续监听 system变化；选择 light/dark override后本 document不跟随，切回 system立即采用当前 media value。preference不持久化。根元素使用 resolved `data-theme`和 `color-scheme`。两个 resolved theme达到 WCAG 2.2 AA；不改变 `/html/:id` active document。

### 17.13 Responsive、keyboard 与 accessibility

支持发布时 Chrome、Edge、Firefox、Safari最近两个 major。自动验收覆盖 Chromium、Firefox和WebKit，另在可用的 current stable Edge和Safari做 smoke。

* semantic heading、form、nav、main、article、button和 label；不得用 clickable `div`；每个 input有visible Label，error由 `aria-describedby`或 `aria-errormessage`关联，explanation只由 HelpTrigger关联；
* official Tabs遵守 WAI-ARIA automatic activation，Left/Right、Home/End、roving focus和正常 Tab行为；nested tab groups各自拥有 state，unmount清理；
* Sidebar Sheet和Dialog正确 initial focus、focus trap/containment、Escape、outside policy与 focus return；delete最终动作是明确 Button；
* focus indicator不移除；所有 touch target，包括 icon和 question-mark trigger，至少44×44 CSS px；
* operation feedback用 `aria-live=polite`，blocking validation/error用 `role=alert`且不随每次 keystroke重复；
* diff有 `+`、`-`、space prefix，不只靠颜色；loading有文字 state，不只靠 animation；
* `prefers-reduced-motion: reduce`取消非必要 transition、Sheet/Dialog animation和 status color transition，功能不依赖 motion；
* Crepe失败时 source Textarea和完整 draft仍可键盘操作并可 retry；large diff仍在 worker执行；
* 320 CSS px没有 page-level horizontal overflow，document/editor全宽，Sheet关闭后不留 reserved rail space；
* automated axe、keyboard和 focus-order checks不能替代 manual screen-reader、contrast、zoom/reflow与 touch smoke。

## 18．Limits 与资源预算

| 项目 | 应用限制或行为 |
|---|---|
| current content | 1 至 10,485,760 UTF-8 bytes |
| prior revisions | 最多 3 个，每个最多 10,485,760 bytes |
| 单 paste plaintext 上限 | current 加 history 最多 40 MiB，分布在 4 个 KV values |
| business metadata | 最多 16 KiB JSON value |
| attached metadata | 每 key 最多 1,024 bytes，固定 marker 需低于此值 |
| custom ID | 1 至 64 ASCII chars并符合 regex |
| password | empty clear，或 1 至 128 visible ASCII chars |
| title | 0 至 200 Unicode scalars，无 control chars |
| API/MCP wire body | 64 MiB |
| API history list | 最多 3，无 pagination |
| autosave | input/compositionend 后 exact 1,000 ms due time，最多 1 in-flight |
| autosync active window | load/refresh或最近 local edit/mutation activity后 exact 300,000 ms；deadline本身不发 request |
| autosync cadence | eligible开始或前次 settle后 exact 3,000 ms due time，最多1个 timer和1个 in-flight；无 overlap或 immediate retry |
| autosync request ceiling | 无 edit且 request瞬时完成的单个300,000 ms window最多99次 GET，即 due time 3,000至297,000 ms；真实 request duration只会降低次数 |
| initial React JavaScript | production build的 entry及其静态 imports合计不超过250 KiB gzip level 9；不得含 Crepe、browser micromark/GFM或 diff worker code |
| initial CSS | application initial CSS合计不超过80 KiB gzip level 9；无 external font/image request |
| lazy browser Markdown | initial server-produced preview不请求；首次 client-side preview/recompute才请求，相关新 chunks合计不超过150 KiB gzip level 9 |
| lazy Crepe | 首次 visual mode才请求，相关新 chunks合计不超过1.5 MiB gzip level 9 |
| diff worker | 首次允许计算 diff才请求，worker entry及 imports合计不超过60 KiB gzip level 9 |
| static client output | 不部署 source map；`dist/assets`全部 files合计不超过8 MiB uncompressed，且每个 filename content-hashed |
| application logical expiration | permanent，或至少距 mutation 60 秒 |
| KV writes | 遵守 Cloudflare 同 key 最多约每秒一次写入的限制；单 browser state machine不会并发写，同 paste 多 client 仍可能竞争 |

bundle budget由 Node `zlib.gzipSync` level 9对 production file bytes测量；按 Vite manifest/metafile计算 initial与各 lazy reachability集合，共享 chunk只在对应集合计一次。超出任一项即 build/test失败，不能用 package distribution size代替。template source、license和禁止依赖另由第19节检查。

Worker upload 必须低于64 MiB uncompressed，top-level startup低于1秒，isolate memory低于128 MiB。CPU、request body和 subrequest limit取决于实际 Cloudflare plan，[Worker limits](https://developers.cloudflare.com/workers/platform/limits/)。最大 content的 JSON parse、strong ETag SHA-256、Markdown render、Crepe load和 diff都必须在目标 plan实测；达到 application size limit不表示每个 plan都有足够 CPU或 browser memory完成 expensive representation。

正确性关键 KV `put`/`delete` 都在 request path await，不交给 `ctx.waitUntil()`。large values sequential read/write，避免同时持有四个10 MiB revisions。conditional GET仍执行 coherent KV read并构造 exact validator；304减少 body bytes，不减少 Worker request，也不保证减少 KV read。Markdown response没有业务层输出 size cap，但仍受 isolate memory与 CPU限制。

## 19．TDD 与 verification strategy

### 19.1 测试层次

1. `src/pastes.test.ts`继续使用最小 in-memory KV fake，先写 failing tests，再实现 ID、password、expiration、version、key grammar、legacy projection、ring rotation、no-op与每一个 injected read/write/delete failure ordering。
2. `src/render.test.ts`覆盖最小 React shell、bootstrap discriminated union、exact inert source、Markdown-only inert safe preview template、HTML/bootstrap escaping、full GFM、raw HTML、dangerous protocol、DOM clobber prefix、title/filename，以及 password不进入 bootstrap。删除旧 handwritten workbench exact-string assertions。
3. `src/http.test.ts`使用 `@cloudflare/vitest-plugin`与 `exports.default.fetch()`，通过 public routes验证真实 KV binding、status、headers、media types、migration、consumption和 conditional GET。Cloudflare test依据仍是[Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)与[Vitest 4 migration](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/)。
4. `src/mcp.test.ts`以 modern client pinned `2026-07-28`覆盖 discover、meta/header validation、八 tools、tool error和 SDK stateless legacy fallback。MCP行为不因 React或 browser sync改变。
5. `src/client/autosave.test.ts`保留现有完整 fake-clock autosave suite；`src/client/paste-sync.test.ts`用同一可注入 fake monotonic clock、controllable promises、fake AbortController和 explicit online/offline events验证第17.7至17.9节每个 transition。不得依赖真实3秒或5分钟 sleep。
6. React component tests直接 mount `App`各 bootstrap variant，验证 semantic roles、Tabs keyboard、Sheet/Dialog focus、HelpTrigger hover/focus/click/Escape/outside、OperationStatus、controller cleanup、remote batched apply和 consumed branch无 network hook。mount -> unmount -> mount模拟 StrictMode lifecycle但 production不依赖 StrictMode。
7. `src/build.test.ts`读取 Vite manifest和 production bytes，验证第18节 gzip/raw budgets、initial/lazy reachability、hashed filenames、无 sourcemap、没有 eager Crepe/micromark/diff、无 banned package和 duplicate browser copy；同时检查 pinned provenance comments、`THIRD_PARTY_NOTICES.md`及 package exact pins。
8. Playwright必须连接真实 `wrangler dev --local`进程，而不是 mocked page server。Chromium、Firefox、WebKit运行 create、password redirect、ordinary read/edit、所有 React mode refresh、Crepe、history/diff、settings/password、copy/wrap/download、delete、view-once local-only、autosync、i18n/theme、keyboard/help和320 px journeys。active HTML test只写 same-origin marker并确认 query visibility，不外发数据。
9. current-two-major matrix指 release时 Chrome、Edge、Firefox、Safari各最近两个 major。CI自动跑对应可获得的 Playwright engine versions；actual current stable Edge与Safari做 manual smoke并记录 exact version。机器不存在的 actual Safari是唯一允许 skip的 manual row，仍必须有 WebKit覆盖。

### 19.2 必测边界与 race

既有 backend边界全部保留：content 0、1、10,485,760、10,485,761 UTF-8 bytes；multibyte/unpaired surrogate/no normalization；password visible ASCII与 query encoding；ID/reserved/case；expiration；history ring；legacy migration；view-once consume ordering；active `/html`；safe `/md`；完整 method/Allow/error/header matrix；`/ip-trace` exact reflection。

新增 release gates如下：

* strong response ETag exact SHA-256/base64url格式、200 bytes变化必变、matching strong/weak/list/`*`得到304、nonmatch 200、malformed ordinary validator 400、304 no body/content headers且 `no-store`；view-once对 valid/malformed validator都忽略并保持 GET consume、HEAD不 consume；
* fake clock在 load+2,999 ms无 sync、3,000 ms恰好一个；completion+2,999无 next、+3,000一个；299,999 ms可按 predicate发，300,000 ms不得新发；每次 local edit/mutation将 deadline精确改为 activity+300,000；
* edit取消 waiting timer；compositionstart与每个 IME intermediate input延长 active window但不 save/sync；compositionend重新走1,000 ms autosave，save settle后再完整等待3,000 ms sync；
* dirty draft、autosave timer/in-flight/coalesced、settings/password/viewOnce/delete mutation和 remote apply期间零 sync；clean transition后只建立一个3,000 ms timer；
* edit/mutation在 sync in-flight时调用 abort并 invalidates token；即使 old promise随后200 resolve也不能更改 source、summary、ETag、history、status applied time或再 schedule duplicate；并发计数始终最多1；
* 304、200 unchanged、definitely older、definitely newer、marker-equal divergent、mixed-marker incomparable、different generation和 legacy divergent的逐项比较；older永不回滚，newer只在同 generation capture且 clean时一次性 apply；
* divergent candidate第一次 quarantine、第二次 identical unconditional200 apply、candidate变化进入 non-destructive conflict、error/abort/activity清除 candidate；Use remote、Keep current、Retry sync按精确 stop/resume规则；
* remote apply同时更新 canonical source、summary、read、plain baseline、Markdown source/visual/preview和 selected diff current side，标记或清除 history metadata，且 autosave call count和 server history count不增加；
* sync和 autosave各自的200/304/403/404/409/503、network rejection、AbortError、offline -> online路径；验证 stop、normal 3,000 ms retry或 explicit retry，不出现第二 retry loop；
* `/`、ordinary text default、ordinary Markdown default、password、application error和 consumed branch可直接 hard refresh并由 React重建；从 Edit、Markdown source/visual/preview、History或 Settings发起 hard refresh时，按 `format`回到 server-defined default，使用 latest acknowledged source且无 stale state或 duplicate controller；direct `/raw`、`/html`、`/md`、`/file`不 mount sync；
* initial network graph含 React/shadcn shell但不含 Crepe、browser micromark/GFM或 diff；首次对应 action只加载自己的 lazy graph；所有第18节 bundle budget逐项 gate；
* provenance为 exact repository/commit/style/block/CLI，copied/adapted source comment与 `THIRD_PARTY_NOTICES.md`齐全；dependency scan无 Next.js、Vercel runtime、React Router、RSC、auth/query/chart/admin package和第二 backend；
* DOM visible-text scan允许 label/value/metadata/action/validation/error/live state，拒绝 dictionary和 fixture中列出的 explanation、warning、limitation、storage/encoding/size prose及 sample boilerplate；每条此类 copy只能在关闭的 HelpTrigger content中，触发后 keyboard/touch均可达；
* OperationStatus四个 records状态名、`confirmedAt`、`failedAt`、`checkedAt`、`appliedAt`、`changedAt`、`startedAt`和 `settledAt`含义准确；locale切换重排显示但 `<time datetime>`不变；password和 protected URL不在 DOM/status；
* button pending/success/failure原位 label/icon与 polite live update；copy/save/sync/network/action feedback无 Dialog、`alert()`、toast、snackbar或 transient popup；只对 destructive confirmation使用 Dialog；
* 320 px Sheet关闭后 document宽度等于 available viewport、page `scrollWidth===clientWidth`，44 px target、focus order、reduced motion、WCAG 2.2 AA contrast和 non-color diff prefixes通过。

### 19.3 完成门槛

以下命令全部 exit 0；Playwright配置负责启动或复用真实 Wrangler local server，不能把 `npx playwright test`改为 static Vite preview：

```powershell
npm ci
npm run build
npx vitest run
npx playwright test
npx wrangler types --check
npx wrangler deploy --dry-run --outdir .wrangler-dist
```

build/test还必须产出可机读 Vite manifest/budget assertion结果，并确认 dry-run `Total Upload`低于64 MiB、`dist/assets`低于第18节8 MiB、artifact没有 source map或 server-bundled duplicate Crepe/micromark/diff。任何 requirement ID、dictionary key、bootstrap variant或 traceability parity failure都阻止完成。

## 20．Wrangler configuration 与 local smoke

### 20.1 配置

`wrangler.jsonc` 必须满足以下完整约束：

| 字段 | 固定值或约束 |
|---|---|
| `$schema` | `node_modules/wrangler/config-schema.json` |
| `name` | `cf-pastebin` |
| `main` | `src/index.ts` |
| `compatibility_date` | `2026-09-12` |
| `kv_namespaces` | 恰好一个 object，只绑定 `PASTE_DB`；开发配置使用明显的 placeholder `11111111111111111111111111111111`，实际 deploy 前由使用者替换为真实 namespace ID |
| `assets.directory` | `./dist/assets` |

只声明一个 KV binding。不设置 `nodejs_compat`，因为该 compatibility date 自动启用相应 behavior gate，但仍需在 workerd 中执行所有实际 dependency paths，[Node compatibility 说明](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#get-started)。

### 20.2 PowerShell local smoke

先 build/test，再启动只使用 local binding 的 Wrangler：

```powershell
npm ci
npm run build
npx vitest run
$server = Start-Process -FilePath "npx.cmd" -ArgumentList "wrangler","dev","--local","--port","8787","--show-interactive-dev-session=false" -PassThru
try {
  $base = "http://127.0.0.1:8787"
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    if ([DateTime]::UtcNow -ge $deadline) { throw "Wrangler readiness timed out after 30 seconds" }
    Start-Sleep -Milliseconds 200
    try { $ready = (Invoke-WebRequest "$base/" -UseBasicParsing).StatusCode -eq 200 } catch { $ready = $false }
  } until ($ready)

  $created = curl.exe -sS -X POST "$base/api/pastes" -H "Content-Type: application/json" --data-binary '{"content":"smoke","title":"smoke.txt","expiration":60}' | ConvertFrom-Json
  if ((curl.exe -sS "$base/raw/$($created.id)") -ne "smoke") { throw "raw smoke failed" }

  $resource = Invoke-WebRequest "$base/api/pastes/$($created.id)" -UseBasicParsing
  $etag = [string]$resource.Headers.ETag
  if ($resource.StatusCode -ne 200 -or -not $etag.StartsWith('"sha256-')) { throw "resource ETag smoke failed" }
  $notModified = Invoke-WebRequest "$base/api/pastes/$($created.id)" -Headers @{"If-None-Match"=$etag} -SkipHttpErrorCheck -UseBasicParsing
  if ($notModified.StatusCode -ne 304 -or $notModified.RawContentLength -ne 0 -or $notModified.Headers.'Cache-Control' -ne 'no-store') { throw "conditional GET smoke failed" }

  $once = curl.exe -sS -X POST "$base/api/pastes" -H "Content-Type: application/json" --data-binary '{"content":"once","password":"a+b %25","viewOnce":true,"expiration":60}' | ConvertFrom-Json
  $encoded = [uri]::EscapeDataString("a+b %25")
  $first = Invoke-WebRequest "$base/raw/$($once.id)?password=$encoded" -UseBasicParsing
  if ($first.StatusCode -ne 200 -or $first.Content -cne "once") { throw "view-once first read failed" }
  $secondCode = curl.exe -sS -o $null -w "%{http_code}" "$base/raw/$($once.id)?password=$encoded"
  if ($secondCode -ne "404") { throw "view-once second read failed" }

  $trace = curl.exe -sS -X POST "$base/ip-trace" -H "X-Smoke: yes" --data-binary "trace" | ConvertFrom-Json
  if ($trace.data -ne "trace" -or $trace.headers.'x-smoke' -ne "yes") { throw "ip-trace smoke failed" }
} finally {
  if (-not $server.HasExited) { taskkill.exe /PID $server.Id /T /F | Out-Null }
}

npx wrangler types --check
npx wrangler deploy --dry-run --outdir .wrangler-dist
```

server readiness loop 使用脚本内的 30-second deadline；超时后执行 finally，并终止完整 Wrangler process tree。`--local` 不允许 remote binding。

## 21．Requirement-to-acceptance traceability

下表中的验收项都是 release gate，不是建议。

| ID | 冻结需求 | 实现位置 | 可观察验收 |
|---|---|---|---|
| C01 | 只用一个 `PASTE_DB` KV，无其他协调存储 | 3、4、6、20 | Wrangler 仅一个 KV binding；dependency/config scan 无 DO、D1、R2、Queue；KV stale-read test明确允许 duplicate |
| C02 | 第一个授权 content-bearing read 消费；HEAD/OPTIONS/错误不消费 | 10.1、12 | 10.1 所列八个 HTTP content-bearing 操作各测 first 200含 exact content、second 404；MCP `paste_get` 测 first success含 exact content、second `PASTE_NOT_FOUND` tool error；HEAD/OPTIONS/403 后仍可成功读取 |
| C03 | render/validate 后 delete，response 前完成 | 10.2 | injected render failure不 delete；delete rejection不含 content；成功事件顺序断言 render < delete < response |
| C04 | view-once React branch无 edit/history/settings/sync；API/MCP mutation允许，history禁止 | 10.3、17.4、17.10、15 | branch不构造对应 controls/hooks/URLs；settings/update/password/delete成功；history 409/tool error |
| C05 | custom ID 只做 KV checks，接受 race | 7.2 | fake concurrent negative checks可产生两个 success/last write wins，文案不声称 atomic |
| C06 | delete/expiry 后 custom ID 可复用 | 5.1、7.2 | cleanup 后同 case ID create 201；stale orphan可暂时 409 |
| C07 | legacy main+attached metadata可读，首次 mutation迁移 | 8 | seeded old entry各 representation 200；read不写；mutation生成 sibling/markers且不批量 list |
| C08 | password只在当前 document的 page-scoped memory和 URL | 9、17.1、17.5 | storage APIs无写入；same document操作复用；unmount清理；新 tab/hard reload从 URL或重新输入取得，不靠 storage |
| C09 | protected direct raw/html/md/file无 query直接 403 | 9.3、12.2 | 四 route missing query均 403 plaintext；wrong 403；correct 200 |
| C10 | visible ASCII 1..128，empty set/clear语义 | 5.4、9 | U+0020/U+007E与128通过，control/129失败；new empty清除 |
| C11 | unprotected可 set；protected change/clear需 current password | 5.4、12.6、15.10 | API与 MCP 的 set/change/clear正反测试 |
| C12 | `/html/:id` 顶层同源可执行、不 sandbox | 16.2 | response exact stored source；script写 marker；window origin等于 Worker origin；无 wrapper |
| C13 | HTML 可加载 external resources | 16.2 | test resource request发生，server不 rewrite；browser mixed-content policy保持默认 |
| C14 | full GFM，raw HTML与危险 protocol关闭 | 16.3 | table/task/strike/autolink render；script tag为文字；javascript/data URL不可执行 |
| C15 | React initial shell与 lazy Milkdown Crepe、source/preview分离 | 4、16.4、17.5、18 | initial graph无 Crepe/browser micromark/diff；首次 visual才加载 Crepe，首次非初始 preview才加载 renderer；visual editing可保存；budgets通过 |
| C16 | source canonical；mode switch alone不保存 | 16.4 | byte-sensitive Markdown仅切换后 KV/version/history不变；visual actual edit可 normalize并保存 |
| C17 | revision list、unified diff、snapshot、large lazy | 11、17.10 | 三 UI区存在；selected->current diff；阈值以上未点击不计算 |
| C18 | 三个 prior successful content saves，settings不进 history | 11、7.3 | 四次 edit后只列最新三 prior；settings/password/expiry/no-op count不变 |
| C19 | format只控制 default mode，所有表示形式可用 | 5.3、17.5 | text与 markdown paste都能 raw/html/md/file及两种 editor |
| C20 | 只保留现代 canonical API | 12 | `POST /api/pastes` 201；`GET|POST /api` 和 `/delete/:id` 404；DELETE canonical成功 |
| C21 | browser optional version处理冲突；curl/MCP可 LWW | 7.6、17.6 | stale browser PATCH 409且 draft留存；省略 version可覆盖 |
| C22 | MCP v2、2026-07-28、stateless legacy fallback、八 tools | 15 | pinned modern discover/calls通过；legacy initialize fallback通过；tools/list exact八个 |
| C23 | `/mcp` 无 global token；仅 present Origin验证 | 15.1 | no Origin POST可用；same Origin可用；cross/null 403；无 bearer secret配置 |
| C24 | `/ip-trace` 反射 url/method/body/all headers/full cf，pretty JSON，CORS `*` | 14 | fixture深相等，indent为2，headers/cf未筛选，ACAO为 `*` |
| C25 | 六档+permanent；API四种表达；relative从 mutation时重算 | 5.5、6.5 | 七 UI options；integer/null/permanent/RFC3339 tests；同 relative第二次保存期限从新 now算 |
| C26 | custom ID regex、case-sensitive、reserved、immutable、可复用 | 5.1 | boundary/reserved/case tests；update customId 422；`a`与`A`是不同 keys |
| C27 | English/简体中文，browser language选择，manual switch | 17.12 | navigator zh/en fixtures与 switch；visible/help/status/action全部 dictionary parity |
| C28 | `system`/`light`/`dark` document-only theme | 17.12 | matchMedia变化、三态切换与切回system通过；storage为空；new document重置；不影响 `/html` |
| C29 | 当前四浏览器最近两个 major、responsive/accessibility | 17.13、19 | Playwright三 engine、actual Edge/Safari smoke、320 px Sheet、keyboard、axe/manual checks通过 |
| C30 | Wrangler name、唯一 binding、开发 placeholder | 20 | config exact name/main/date/assets；只有一个 `PASTE_DB`，开发 ID 为明确 placeholder；local smoke 与 dry-run exit 0；不执行 deploy |
| C31 | 不保留 legacy API 与 destructive GET | 3、12.2 | method/path contract tests均为404/405且无 KV mutation |
| C32 | protected main GET无 password呈 React input；form POST校验并302到 query | 9.3、17.1、17.4 | GET 200 shell无 content；wrong POST 403 React inline error；correct POST 302 Location exact encoded target |
| C33 | HTML JavaScript可读取和外传 query password，用户接受 | 9.3、16.2、22 | browser test确认 `location.search` 可读；无 CSP/sandbox阻止 fetch；风险文档存在 |
| C34 | redirect后 password同时在 URL与 page-scoped memory，请求继续附带 | 9.4、17.1、17.5 | URL query存在；React actions无需再输入；API carrier含 decoded exact password |
| T01 | 主正文 exact plaintext `key=id`，business metadata sibling | 6 | direct KV断言 main value等于 source，business fields只在 `__cfpb:meta` |
| T02 | 三个 fixed sibling ring slots且同 physical expiry | 6、11 | keys仅 slot 0/1/2；四次 save轮换；list metadata expiration全部相同 |
| T03 | plaintext editor等宽、1秒 autosave、IME、单 in-flight、coalescing | 17.5、17.6 | existing fake-clock suite、React adapter lifecycle与 browser computed font/network concurrency通过 |
| T04 | error/conflict保留 draft与 exact no-op | 7.3、17.6、17.9 | 403/404/409/413/503/offline后 React draft不变；same content无 KV write/history/version |
| T05 | 标题、drag/drop、copy、wrap、file和delete功能保留 | 12、17.4、17.5、17.10 | real Wrangler browser actions逐项通过；delete只发 DELETE |
| T06 | password覆盖每个 representation/API/history/update/settings/delete/MCP | 5.4、9、12、15 | protected route/tool matrix对 missing/wrong全为403或 tool error，正确值通过 |
| T07 | create不自动打开 | 7.2、17.4 | 201后 location仍为 `/`，无 prefetch/click；view-once main仍存在直到用户选择 link |
| T08 | 修改 expiry使全部 related keys采用同 physical expiration | 6.5、7.4 | active history 0..3情况下 extension/shorten/permanent的 key expiration深相等 |
| T09 | UI与 API 不返回 stored plaintext password | 12.3、17.1、17.5、17.11 | bootstrap/DOM/status/response scan无 metadata password；URL/body transport例外按规格可见 |
| T10 | local smoke 与 TDD | 19、20 | 所列 commands、real Wrangler conditional smoke和 browser journeys全部通过 |
| SY01 | 单 KV约束下无 true non-polling equivalent，明确使用 direct browser polling | 3、17.7、22 | dependency/route/runtime scan无 SSE、WebSocket、long poll、Web Push、Event Subscription、service binding/RPC、Cache sync；requests由 browser timer直接发起 |
| SY02 | sync只在 ordinary controlled `/:id` page运行 | 17.1、17.4、17.7、17.10 | `/`、password/error、consumed view-once及 `/raw`、`/html`、`/md`、`/file`、API/MCP caller均为零 sync request |
| SY03 | active window exact 300,000 ms，eligible idle cadence exact 3,000 ms | 17.7、18、19.2 | fake clock覆盖2,999/3,000和299,999/300,000边界、activity deadline reset、completion-based next due及99-request ceiling |
| SY04 | edit/IME/draft/autosave/mutation suspend sync；in-flight abort/invalidates；无 overlap | 17.7、19.2 | controllable promise race证明 abort被调用、old response零 state effect、timer/fetch concurrency各不超过1 |
| SY05 | 复用 resource GET的 standard conditional read与 no-store | 12.1、12.5、13、20 | strong SHA-256 ETag、If-None-Match list/weak/`*`/malformed、200/304/HEAD/OPTIONS/Allow/no-body/no-store全部通过；无新 endpoint |
| SY06 | view-once忽略 validator并保留 consume-on-body | 10、12.1 | valid或malformed `If-None-Match`的 authorized GET仍200并 consume；HEAD不 consume；无304 |
| SY07 | version、contentRevision、updatedAt、localGeneration和 exact source阻止 rollback | 17.5、17.8、19.2 | marker partial-order fixtures覆盖 older/newer/equal/incomparable/different-generation/legacy；older或 localGeneration改变前 capture的 response不能改任何 surface |
| SY08 | divergent response需要 deterministic repeated candidate或 non-destructive conflict | 17.8 | first quarantine；第二次 exact full200才 apply；candidate变化 conflict；Use remote/Keep current/Retry sync stop-resume均通过 |
| SY09 | remote apply更新每个 canonical surface且不 autosave | 17.5、17.8 | read/plain/Markdown visual-source-preview/summary/diff同时改变，history invalidation正确，save和 history mutation count为0 |
| SY10 | sync明确处理200/304/403/404/409/503/network/offline | 17.9、19.2 | 每种 response/event保留 source并按 frozen stop、normal retry或 explicit retry行为转换，无 modal/toast和 status-only request |
| FE01 | React 19.3.0与 pinned shadcn `new-york-v4/sidebar-11`完全拥有可见 application UI | 4.1、4.2、17.1、17.2 | create/paste/password/error均由 `createRoot` render；server shell无 visible controls；source/provenance pin exact |
| FE02 | Vite 8.3.0 static client与 exact dependency pins，无 banned stack | 3、4.1、4.2、18 | manifest/lockfile exact；无 Next/Vercel runtime/Router/RSC/auth/query/chart/admin/second backend；all bundle gates通过 |
| FE03 | shell保留 inert bootstrap/source/safe-initial-preview、CSP和 hashed external assets | 4.2、16.5、17.1 | source在 mount前 exact decode，preview只来自 fixed renderer，bootstrap escaped且无 password/content，inline executable为0，application CSP与 `/html` exception不变 |
| FE04 | old visible DOM/CSS/controller与 tabs candidate superseded | 4.2、19 | old `src/client/app.ts`、`src/client/styles.css`和 duplicate binders不存在；`bfaac29` chain未集成；React tests保留可观察 tabs keyboard cases |
| FE05 | `sidebar-11`只适配 paste Document Workbench，320 px使用 Sheet和 full-width editor | 17.2、17.13 | sample/static boilerplate为0；320 px无 page overflow或 reserved rail；no gradient/glass/decorative cards/external fonts |
| FE06 | 所有 explanation/warning/limitation只在 accessible question-mark help | 17.3、19.2 | closed-page visible text scan无 banned prose；hover/focus/click/touch/Escape/outside/name/relationship和不依赖 help的 form journey通过 |
| FE07 | 常驻 OperationStatus分开 autosave、autosync、network、last-action并精确定义时间 | 17.11 | exact state union、timestamp event meaning、localized `<time>`、polite incremental announcement及 password absence通过 |
| FE08 | action button原位持久反馈，无 popup式 operation feedback | 17.3、17.11 | pending/succeeded/failed icon+label与 status同一 outcome；无额外 backend call、toast/snackbar/`alert()`；Dialog只用于 destructive confirmation |
| FE09 | en/zh-CN、document-only theme、reduced motion、WCAG 2.2 AA与 current-two-major matrix | 17.12、17.13、19 | dictionary parity、lang/title/date、storage空、contrast/focus/44 px/reflow、Playwright engines和 actual browser记录通过 |
| FE10 | template和 dependencies履行 license/notice义务 | 4.1、4.2、19 | adapted source provenance comments与 `THIRD_PARTY_NOTICES.md`包含 shadcn MIT、direct MIT/ISC、Apache-2.0及 upstream NOTICE；不要求 visible credit |

## 22．明确接受的风险与平台限制

1. **View-once duplicate**：跨地域并发或 stale cache 可让多个授权请求都获得正文。名称只表达产品意图，不是 global exactly-once guarantee。
2. **零次完整交付**：render 完成后先 delete，再发送；client disconnect、delete partial failure或 response failure可能使 paste 已消失而用户未完整收到。
3. **Custom ID race**：existence check 与 writes 非原子。并发相同 custom ID create 可互相覆盖，双方都可能收到 success。
4. **Eventual mutation visibility**：content、password、viewOnce、delete、expiry 和 version 在其他 region 最多延迟 60 秒或更久。刚改 password 后 stale region 可能继续接受旧 password；legacy migration window甚至可能短时看到旧 unprotected state。
5. **Multi-key partial write**：current、metadata 和 revisions 没有 transaction。规定的 ordering、generation marker和有限 reconciliation只减少错误组合，不能保证所有 failure后完整 rollback。最旧 revision可在 failed save 中丢失；缩短 expiry 的 partial mutation可提早造成 data loss。
6. **Last-write-wins**：省略 version的 curl/MCP mutation有意覆盖当前值。即使带 version，eventual consistency 也不提供 CAS。
7. **Stale ID reuse**：delete/expiry 后 ID 可重用，但 negative/positive cache和旧 generation传播可造成暂时 409、503，极端情况下完整 stale old generation仍可被读到。
8. **Plaintext password**：password 明文存在 sibling metadata、JSON/form/MCP body或 URL query。它可能进入 browser history、address bar、clipboard、Referer、Cloudflare/request logs、proxy和监控系统。无 hash、encryption或 owner recovery。
9. **Executable same-origin HTML**：任意 `/html/:id` script 与 origin 同权，可读取 query password、发起网络请求、制作 phishing UI，并调用它掌握 credential 的 API。无 sandbox、sanitizer、CSP 或 isolation origin。
10. **`/ip-trace` disclosure**：端点有意回显全部 request headers、body与 `request.cf`，包括调用者发送的 secrets。
11. **No abuse controls**：没有 rate limit、account、quota、moderation、reporting 或 global MCP auth。Cloudflare account和 KV quotas是唯一外部上限。
12. **Large document cost**：一个 paste 最多占约 40 MiB plaintext KV storage；content save可写两个 10 MiB values；expiry mutation可重写四个 values。10 MiB Markdown render、Crepe与 diff可能超过低配 plan CPU或浏览器内存舒适范围。
13. **Physical expiry lag**：logical expiry由应用严格执行，但 KV physical deletion是 eventual。临近到期 mutation可把 physical deadline后移最多满足 60 秒 minimum；orphan bytes可能短时存在但不得被授权读取。
14. **No backup或恢复**：成功 delete、view-once consume、ring overwrite和expiry不可恢复。
15. **Browser variation**：download filename、clipboard permission、blob navigation、IME 与 complex editor accessibility受浏览器行为影响；本规格以声明的 release matrix为验收范围。
16. **Polling cost与 detection lag**：每个持续 active且 clean的 tab最多按第18节发出99次 GET；304仍消耗 Worker request且通常仍需 KV read。remote change先受 KV最多60秒或更久的 visibility delay，再受至多一个完成后3秒间隔；没有实时或最大通知时限保证。
17. **Autosync ordering uncertainty**：version、contentRevision、updatedAt、generation和 source comparison只阻止明确 stale response直接回滚。并发 writers可产生相等或不可比较 markers；repeated candidate与 explicit conflict不会建立 global total order或恢复被覆盖的内容。
18. **Remote view-once transition**：ordinary page发出 resource GET后，另一 client已把 paste改为 view-once时，该 GET会按 frozen consume-on-body contract消费。response到达后 page立即停止 sync并转 local-only或 conflict；没有额外 metadata probe可在一个 GET、无 status-only接口的约束下消除这个 race。

以上风险是选定单 KV、plaintext credential、same-origin executable HTML、direct browser polling与无账户模型的直接结果。实现不得用未获批准的第二存储、token、sandbox、application CSP、push service、Cache或 rate limit暗中改变这些产品决策。
