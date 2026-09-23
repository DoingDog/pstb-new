# Cloudflare Pastebin 完整重写设计规格

日期：2026-09-12

状态：产品决策已冻结，可直接据此编写实施计划与测试。本文件是实现、测试和验收的唯一 binding authority；[`2026-09-13-pastebin-ui-direction.md`](./2026-09-13-pastebin-ui-direction.md) 只细化本文的视觉表达，冲突时以本文为准。

修订记录：

* 2026-09-23：用户要求当日24:00前完成并部署；确因设备、环境或系统限制无法完成的测试与验证直接跳过，继续后续任务。本次发布将四类尚无实际人工/实体设备证据的 manual accessibility 验收列为明确跳过，不伪造 receipt 或修改严格 verifier；所有可执行的产品、浏览器、构建、Wrangler 和生产 smoke 验证仍须按结果记录。此例外只适用本次发布，未来发布仍按 17.13 的完整门槛执行。
* 2026-09-23：冻结 Task 16 branded capture真实性边界：Chrome/Edge GUI executable不得用`--version`取证，必须从exact executable读取`FileVersionInfo`、有效 Authenticode signer、byte length与 SHA-256；Firefox保留direct`--version`。每个Windows branded capture只允许win32，使用按environment和已验证binary SHA-256或exact version隔离的profile，共享从读取到receipt commit的单一deadline，并检测spawn后exact 1,000 ms settle interval内的error/close；root-relative Windows path不算fully-qualified absolute path。Safari只允许darwin，`/usr/bin/open`作为launcher exit 0即成功而不冒充browser process。此前全部release matrix、manual evidence和未受影响的产品contract不变。
* 2026-09-22：冻结 Task 16 Chrome VersionHistory acquisition 的 live-source兼容边界：continuation request复用完全相同的`page_token` URL并最多尝试六次；只有紧邻的成功页少于1,000条且六次均为exact`400 INVALID_ARGUMENT`时，才将vendor返回的下一token视为stale terminal token；所有其他initial/continuation失败、full-page exhaustion、malformed error和successful repeated token仍fail closed。整个`acquire-targets`的四个vendor fetch共享该次operation唯一remaining-duration deadline和AbortSignal，其中Chrome pagination与retry不得重置budget。失败response不计入source hash/count。Chrome `serving.startTime`按Google Timestamp JSON只接受UTC `Z`且fraction缺省或恰为3、6、9位；以完整9位补零precision进行identity conflict和earliest比较，再确定性截断为artifact的canonical millisecond timestamp。所有既定all-or-nothing与freshness contract不变。
* 2026-09-14：落实 canonical plan review round 1 的 binding corrections：受控 React state 保持唯一 form state方案，删除未使用的 `react-hook-form`/`@hookform/resolvers` pins；password form接受零或一个字段；加入唯一 automated axe runner `@axe-core/playwright@4.13.0`；明确 browser/direct OPTIONS 405、branded browser evidence与四类 manual accessibility release gates；补入 ordinary lazy adapter ownership。此前全部修订、既定 research choices及未受影响的 KV/password/view-once/active-HTML/API/MCP contract不变。
* 2026-09-14：落实 React/sync spec review round 3 的 R3-01..R3-02：为每个 derived-surface Retry补齐 local/source/display/host/parent/retry generation publication guard；让完整且严格验证的 terminal view-once response在 initial terminal commit恰好一次 settle originating action。此前全部修订、既定 research choices及未受影响的 KV/password/view-once/active-HTML/API/MCP contract不变。
* 2026-09-14：落实 React/sync spec review round 2 的 R2-01..R2-08：分离 Use remote、autosync、confirmed Reload与 consumed local apply guards；让完整且严格验证的 retired view-once 200优先进入 terminal；补齐 derived-surface rollback、content mutation reconciliation、Delete result table、relative expiration uncertain rewrite与 password retry credential precedence。F01-F22、既定 research choices及未受影响的 KV/password/view-once/active-HTML/API/MCP contract不变。
* 2026-09-14：落实 React/sync spec review round 1 的 F01-F22：删除 repeated-candidate 自动应用；补齐 terminal view-once、exact active deadline、local mutation failure、page-level mutation arbitration、history request invalidation、staged derived-surface apply、credential replacement、status timestamp、delete handoff与 `/md/:id` React ownership；补齐 `/read` ETag、bootstrap shape、pinned `use-mobile` source及 requirement traceability。既定 shadcn commit、Cloudflare non-push结论和所有未受影响的冻结 contract不变。
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

HTTP 路由继续使用 `hono@4`。`hono/html` 只负责最小 application document shell与 inert bootstrap/source/preview nodes，不再生成 create、paste、password、application error或 `/md/:id` wrapper的可见 markup。Markdown 服务端渲染继续使用 `micromark@4.0.2` 和 `micromark-extension-gfm@3`；visual editor 固定使用 `@milkdown/crepe@7.22.1`；unified line diff 使用 `diff@8.0.2` 的 `diffLines`；MCP 使用稳定的 `@modelcontextprotocol/server@2`。这些 backend 和 content dependencies 的既有 lockfile 解析结果保持不变，只有下列明确列出的 frontend pins 和共享 `zod` pin 可以变更。

可见 application UI使用 React `createRoot`，server不提供可 hydrate的 visible controls。Vite 8.3.0 产生 external hashed ESM/CSS assets 和 manifest，Wrangler static assets 只承载这些构建产物，不是业务存储，也不改变唯一业务 binding `PASTE_DB`。初始 application bundle 包含 React shell 和所需 shadcn primitives；Crepe、browser micromark/GFM renderer 和 diff worker 继续分别 lazy load。`/md/:id`加载 read-only React shell，但不 import或启动 autosync、autosave、history、settings或 mutation controller；`/raw`、`/html`、`/file` 和 `/ip-trace`保持 non-React representation。

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
    "class-variance-authority": "0.7.1",
    "cn": "0.3.0",
    "lucide-react": "1.45.0",
    "radix-ui": "1.6.7",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "tw-animate-css": "1.4.0",
    "zod": "4.6.4"
  },
  "devDependencies": {
    "@axe-core/playwright": "4.13.0",
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

全部 form 使用受控 React state，`react-hook-form`、`@hookform/resolvers`、`useForm`、`Controller`和 `zodResolver`不属于本实现。只有未来出现受控 state 无法直接满足的具体 form/schema need，并先修改 binding spec 证明该需要时，才可考虑加入这些 packages 或 APIs。

`@axe-core/playwright@4.13.0` 是唯一直接 axe runner devDependency，只用于 Playwright accessibility acceptance，不进入 production graph。2026-09-14 npm registry metadata记录其 license为 MPL-2.0、peer dependency为 `playwright-core >=1.0.0`；lockfile必须保留该 exact version并由现有 Playwright graph满足 peer。不得增加第二个 accessibility runner。

### 4.2 最小模块与文件 ownership

| 文件或目录 | 唯一职责与 disposition |
|---|---|
| `src/index.ts` | ES module entry；先分流 `/mcp`，其余交给 Hono；注入 `env`。 |
| `src/http.ts` | 注册 canonical HTTP routes、解析 media type 与 conditional headers、调用 paste service、映射 HTTP response 和 error。 |
| `src/pastes.ts` | ID、password、expiration、version、KV key grammar、legacy migration、history ring、read、mutation 和 delete 的全部领域规则。不得从其他模块直接访问 `PASTE_DB`。 |
| `src/render.ts` | 只拥有 application shell、React mount node、safe bootstrap/source serialization、optional inert initial safe-Markdown template、application headers与 representation helpers；`/md/:id`也只由它生成 inert transport，不拥有任何可见 wrapper或 control。 |
| `src/mcp.ts` | 每个请求创建 `McpServer`，注册八个 tools，并把 paste service 结果映射为 MCP result。 |
| `index.html` | Vite build entry，只含 root和 `src/client/main.tsx` module reference，不含 product copy或 bootstrap。production build完成后不部署或提供 emitted `index.html`；runtime document只能由 `src/render.ts`生成，`/index.html`仍不成为 route。 |
| `components.json` | shadcn materialization配置，style固定 `new-york-v4`、TSX和本地 aliases；它不替代 commit provenance pin，也不在 build时访问 registry。 |
| `src/i18n.ts`、`src/source-data.ts` | 分别保留 dictionary/locale/date helpers与 exact UTF-8/base64 codec；React imports它们，不复制实现。 |
| `src/client/main.tsx` | 在 mount前一次性解析 validated discriminated bootstrap、提取 exact source与 optional server-produced safe preview、读取当前 URL password，然后调用 `createRoot`；除 delete成功的 root handoff外，page identity变化依赖 full navigation。 |
| `src/client/App.tsx` | 按 `create`、`paste`、`markdown`、`password`、`error` bootstrap variant选择唯一 lazy React page tree；ordinary、consumed与 read-only `/md`是结构不同的 branch。App不调用 ordinary hook。 |
| `src/client/pages/OrdinaryPage.tsx` | ordinary lazy branch的唯一 adapter；调用 `usePastePage`并把返回的 state/actions/panels传给 `OrdinaryPastePage`。非 ordinary branch不得 import它。 |
| `src/client/components/app-sidebar.tsx` | 从 pinned `sidebar-11` 改造的 Document Workbench sidebar；只呈现真实 document modes、metadata 与操作，不保留 sample file tree。 |
| `src/client/components/ui/{sidebar,sheet,breadcrumb,collapsible,dialog,tooltip,tabs,field,label,input,textarea,button,separator}.tsx` | 从同一 pinned registry materialize 的唯一官方 primitive source。`sidebar.tsx`删除未使用的 `SidebarMenuSkeleton` export及其 `Skeleton` import，因此不 materialize `skeleton.tsx`。未列出的 shadcn block/component 不得加入；内部 Radix composition 可保留这些 source 必需的 helper。 |
| `src/client/hooks/use-mobile.tsx` | `sidebar.tsx`唯一允许的 product hook dependency，exact source为 pinned commit中的 `apps/v4/registry/new-york-v4/hooks/use-mobile.tsx`；只负责 mobile media query。 |
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

每个由 block直接改造的 source file顶部保留一行 provenance comment，格式固定为 `Derived from shadcn-ui/ui new-york-v4/sidebar-11 at 2b3e6d4f8d9161fe5c19340dc383aade392012dd; MIT; see THIRD_PARTY_NOTICES.md.`。未修改的 registry primitive用同格式把 `sidebar-11`替换成其 exact registry component name。`src/client/hooks/use-mobile.tsx`的 comment固定为 `Derived from shadcn-ui/ui apps/v4/registry/new-york-v4/hooks/use-mobile.tsx at 2b3e6d4f8d9161fe5c19340dc383aade392012dd; MIT; see THIRD_PARTY_NOTICES.md.`。`THIRD_PARTY_NOTICES.md`必须枚举两个 original block paths、每个实际 materialized primitive path、该 hook path、`shadcn@4.21.0`和 pin commit，并明确不把已 pruning的 `skeleton.tsx`列入 copied source set；随后包含以 `Copyright (c) 2023 shadcn`开头的完整 shadcn MIT text、direct MIT/ISC notices、Apache-2.0 texts和 distributed package自带 NOTICE。source-integrity test按这组 exact paths与本地 bytes检查，不联网验证 provenance。

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
* input form `POST /:id` 使用 `application/x-www-form-urlencoded`。body只允许零或一个 `password` field；duplicate `password`或任何 unknown field返回422。零个 field时把 absent credential传给 authorization，不把它判为 schema error。成功返回 HTTP 302，`Location` 是同一路径，仅带一个由 `URLSearchParams` 生成的 `?password=...`。该 POST 不消费 view-once。
* absent或一个 present wrong/empty form password返回403并重新渲染带 inline error 的 input page。
* `GET /:id?password=`或一个 present wrong query返回403，不退回无错误 input page。任何 duplicate `password` query在既定 route、ID、coherent-read与 logical-expiry顺序后、credential comparison前统一返回 `400 AMBIGUOUS_PASSWORD`，无论 paste是否 protected，也不把其中任一值当作 credential。
* protected `/raw/:id`、`/html/:id`、`/md/:id`、`/file/:id` 只接受唯一 query password。缺失或一个 present wrong/empty credential都直接返回403 plaintext error，不接受 header替代；`/md/:id`成功时仍返回 React shell。
* unprotected paste 在确认 query 中至多有一个 `password` 后忽略其值；duplicate query同样返回 `400 AMBIGUOUS_PASSWORD`。API和所有 direct representation使用完全相同的 duplicate-query rule。

query password 有意进入 address bar、browser history、复制 URL、Cloudflare/request log，并可能进入 `Referer`。`/html/:id` 不发送 `Referrer-Policy` 来改变用户已接受的顶层 HTML 行为。

### 9.4 Password 修改与 credential replacement后的 document 状态

password mutation的 intended capability优先于用于授权它的 credential。`PUT /api/pastes/:id/password`成功 set/change时，page-scoped `pastePassword`立即改为该 request的 exact `newPassword`；`newPassword:""`或 password DELETE成功 clear时改为 null。首次 attempt因403进入 replacement flow后，`pendingCredential`只作为 retried password operation的 current `password`完成授权；validated 200证明 intended new password已提交，绝不能把该 pending old password写回 page state或 URL。成功后清除 `pendingCredential`，并用共享 unique-query helper执行 `history.replaceState`：先删除当前 URL中的全部 `password` entries，再在 committed值非 null时用 `URLSearchParams.set`写入恰好一个 encoded value，同时保留其他 query与 fragment，不 reload。其他 representation links每次从该 committed state/closure新建，不缓存旧 URL。

任何 browser request因403要求 replacement credential时，输入值先只保存在 `pendingCredential`，不得修改 `pastePassword`、当前 URL或已渲染 links。Retry只对该次 request使用 pending value。对于不修改 password的 operation，只有同一 pending value随后得到经过完整 authorization的200或304，才把它 commit为 `pastePassword`并调用上述 helper；server authorization先于304 validator comparison，因此304也是有效证明。对于 password set/change/clear，成功 response始终按上一段 commit intended `newPassword`或 null，而不是 pending value。Delete 204直接执行 root handoff并清除两种 credential，不先把 pending value写入 URL。再次403、malformed response或其他未授权结果不改变 committed credential、URL或 representation links。

该 precedence统一适用于 autosync、autosave、explicit reload、history、settings、password、delete和所有 reconciliation。literal `+`、`%`、`&`、`#`、`?`及 leading/trailing U+0020都只经 URL/URLSearchParams编码，不做手工拼接。hard refresh只能依赖 helper提交后的唯一 query，因此 successful set/change后的新 password、successful clear后的无 query以及所有新建 representation links必须使用同一 committed结果。

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
* 每个 GET route 都显式支持 HEAD。HEAD 执行 existence、schema、expiry 与 password 校验并返回同 GET 的 status 和 representation headers，不返回 body、不消费 view-once。只有 `GET|HEAD /api/pastes/:id` 为计算 strong response ETag 而序列化 selected representation bytes；其他 HEAD 不生成 representation body。Browser/direct routes `/`、`/:id`、`/raw/:id`、`/html/:id`、`/md/:id`和 `/file/:id`不注册 OPTIONS success；OPTIONS不读取、授权或消费，直接返回405。其准确 `Allow`分别为 `GET,HEAD`、`GET,HEAD,POST`及四个 direct routes的 `GET,HEAD`。API OPTIONS仍按12.5返回204，`/ip-trace` OPTIONS按第14节返回200，`/mcp` OPTIONS按15.1返回204。
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
| `/:id` | `POST` | `application/x-www-form-urlencoded`，零或一个 `password`，无 unknown field | 302 到同路径的 encoded query | 否 | 403 absent/wrong；404；415；422 duplicate/unknown/invalid form |
| `/raw/:id` | `GET`,`HEAD` | protected 时必须 unique query password | 200 exact source，`text/plain; charset=utf-8` | GET | 400、403、404、503 |
| `/html/:id` | `GET`,`HEAD` | protected 时必须 unique query password | 200 exact source，`text/html; charset=utf-8` | GET | 400、403、404、503；错误 body 是 `text/plain` |
| `/md/:id` | `GET`,`HEAD` | protected 时必须 unique query password | 200 minimal read-only React shell，内含 server-produced inert safe Markdown fragment与 exact source；`text/html; charset=utf-8`；不 mount controlled sync或发第二次 content read | GET | 400、403、404、500 render failure、503 |
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
| `/api/pastes/:id/read` | `GET`,`HEAD` | 200 `PasteResource`，`ETag: "<version>"`；HEAD无 body | GET 是 | GET credential取 query/header；读取语义等价于 resource GET，但不接受 conditional sync validator |
| `/api/pastes/:id/read` | `POST` JSON `{password?}` | 200 `PasteResource`，`ETag: "<version>"` | 是 | body credential；view-once会消费 |

API OPTIONS 返回 204 和准确 `Allow`，不发送 `Access-Control-Allow-Origin`。`/api/pastes/:id` 的 `Allow` 为 `GET,HEAD,PUT,PATCH,DELETE,OPTIONS`；OPTIONS 无 body、无 ETag，带 `Cache-Control: no-store`。create、mutation、settings、history和 `GET|HEAD|POST /api/pastes/:id/read`的每个成功 resource response都带当前 `ETag: "<version>"`。只有 `GET|HEAD /api/pastes/:id`使用12.1的 strong representation validator并处理 `If-None-Match`；`/read`不得复用该 validator或返回304。mutation 的普通失败状态为 400、403、404、409、413、415、422、503。

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
| API JSON | `Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`；create/mutation/settings/history及 `GET|HEAD|POST /api/pastes/:id/read`使用 current-version ETag，只有 `GET|HEAD /api/pastes/:id`使用 strong response ETag |
| API 304 | `ETag`、`Cache-Control: no-store`；无 body、`Content-Type`、`Content-Length` 或 trailers |
| React application shell | `Content-Type: text/html; charset=utf-8`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、本规格 16.5 的 CSP |
| raw | `Content-Type: text/plain; charset=utf-8`、`Cache-Control: no-store` |
| user HTML | `Content-Type: text/html; charset=utf-8`、`Cache-Control: no-store`；不得发送 CSP、sandbox header 或 application `Referrer-Policy` |
| Markdown React shell | 与 React application shell相同的安全 headers；body含 read-only `/md` bootstrap、exact source和 server-produced inert safe fragment，不 mount autosync或其他 server controller |
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

`/md/:id` 是 direct server route，不是 client-router route，也不是 user HTML。server在 view-once delete前的一次 coherent content read中准备 exact source、title和 fixed-renderer safe fragment，并把三者作为 inert transport放入最小 shell；React read-only `markdown` branch使用 pinned shell/primitives渲染 semantic article、title和 local copy、UTF-8 download、source/preview toggle。它不执行 source内 HTML/script，不 prefetch，不调用 API或 representation route，不启动 autosave、autosync、history、settings、delete或第二次 content read。view-once与 ordinary `/md` response使用同一 local-only client能力。

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

`'unsafe-inline'` 只为 Milkdown runtime style attributes，不允许 inline script。React shell只含 mount node、`application/json` bootstrap node，以及需要 source的 `paste`或`markdown` page的一个 `application/octet-stream` exact-source node。ordinary `paste`的 `paste.format="markdown"`、`consumed:true`的 `hasInitialMarkdownPreview=true`和 `markdown` branch的 literal `hasInitialMarkdownPreview=true`各要求恰好一个 inert `<template id="initial-markdown-preview">`；对应 false/text值要求零个，其他 page也要求零个。template内容只可来自第16.3节固定 server renderer。bootstrap把 `<`、`>`、`&`、U+2028、U+2029 escape。source和 preview在 mount前按第4.2节提取、验证 cardinality并移除 inert nodes；password永不进入 bootstrap。所有 executable script和CSS来自 Vite生成的 hashed same-origin assets。该 CSP不应用于 `/html/:id`。

## 17．React frontend、autosave 与 autosync

### 17.1 Application shell、bootstrap 与 React ownership

`/`、`/:id`和 `/md/:id`的 create、ordinary paste、consumed paste、read-only Markdown、password与 application error response只返回第16.5节的最小 shell。React 19.3.0在唯一 mount node上调用一次 `createRoot`，拥有这些 routes的全部可见 application UI；server不预先生成可见 form、article wrapper、tabs、rail、dialog、error panel或 workbench。`/raw`、`/html`、`/file`和 `/ip-trace`仍按各自 representation contract直接返回，不进入这个 root。

bootstrap 是下列 validated discriminated union，不允许 unknown field。protected password不得出现在任何 variant：

```ts
type AppBootstrap =
  | { page: "create"; locale: "en" | "zh-CN" }
  | { page: "paste"; locale: "en" | "zh-CN"; paste: PasteSummary; consumed: false }
  | {
      page: "paste"
      locale: "en" | "zh-CN"
      consumed: true
      hasInitialMarkdownPreview: boolean
    }
  | {
      page: "markdown"
      locale: "en" | "zh-CN"
      id: string
      title: string
      hasInitialMarkdownPreview: true
    }
  | { page: "password"; locale: "en" | "zh-CN"; errorCode: null | "FORBIDDEN" }
  | { page: "error"; locale: "en" | "zh-CN"; status: number; errorCode: string }
```

ordinary、consumed和 `markdown` page各有且仅有一个 inert exact-source node。ordinary page仅在 `paste.format="markdown"`时要求恰好一个 fixed-renderer preview；consumed page仅在 `hasInitialMarkdownPreview=true`时要求恰好一个；`markdown` page的 literal true要求恰好一个。对应 false/text值以及 create/password/error都要求零个。missing、duplicate或 unexpected source/preview node均为 shape failure。`main.tsx`必须先读取、验证 cardinality并移除 bootstrap/source/preview nodes，再创建 React root；decoded exact source直接成为 page-scoped canonical state，不能先经过 textarea DOM value，以免 CR/CRLF normalization。React只把 extracted preview交给第16.3节 trusted boundary，因此初始 Markdown preview不 eager-load browser renderer。bootstrap、source或 preview shape失败时，React只渲染本地化 application error，不猜测 source。

full navigation通常是 page identity boundary；唯一例外是第17.5节 delete成功后在同一 React root内切换到 create branch并用 `history.replaceState`清理地址。不得引入 React Router、通用 history route interception、link prefetch或 StrictMode side effect作为 production行为。controller setup必须可被 test中的 mount -> unmount -> mount安全重复，不产生重复 timer、listener或 request。`markdown` branch不 import或构造任何 ordinary page controller。

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

`consumed:true` 使用独立 React branch，不先构造 ordinary tree再隐藏。它只持有已返回 exact source和 local copy、wrap、raw/source toggle、按 `hasInitialMarkdownPreview`验证的 safe Markdown preview、exact UTF-8 download、top-level `text/html` Blob navigation及 create-new action。copy、wrap、toggle、download和 Blob navigation全部从同一 exact in-memory source派生。它不创建 API/network hook、server representation URL、Edit、History、Settings、delete、page mutation coordinator、autosave或 autosync controller；ordinary branch若转入 consumed，必须先 dispose这些对象并从 DOM移除所有 server controls/URLs。除已经请求或新请求的 hashed browser renderer chunk外，进入 consumed后 business request计数必须保持为零。已消费状态可以作为 document metadata直接显示，distributed semantics只在 HelpTrigger。

### 17.5 Ordinary paste modes 与 canonical state

`format=text`默认 plain read view；`format=markdown`默认使用 server shell的 inert safe preview template，不因 default mode eager-load browser micromark。template缺失或 shape无效是 application error，不以 eager import掩盖。ordinary paste提供 View、Edit、Markdown、History、Settings，以及 raw、HTML、md、file、copy、wrap、create new和 delete actions。任意 format都能进入 plaintext edit、Markdown visual/source/preview和全部 representations；format只选择 default view。

plaintext editor使用 system monospace、保留 whitespace、默认 `spellcheck=false`，read和 editor都支持 Wrap/Unwrap。copy优先使用 `navigator.clipboard.writeText`，失败后使用隐藏 textarea selection fallback；成功或失败更新 action button和 OperationStatus，不移除 action。delete由官方 Dialog确认后调用 canonical DELETE。204后先使 mutation/history/sync tokens失效并 dispose controllers与 editor，再清除 accepted/draft/source/candidate/history/password及所有派生 URL reference；随后在同一 React root切换到 create branch，执行 `history.replaceState(null, "", "/")`，并把 Last action设为不含 ID、password或原 query的 localized delete success。该 in-memory feedback保持到下一次 action或 document refresh；不写 query、history state payload或 storage，因此 hard refresh不会 replay。不得用 full navigation丢失该反馈。

protected page启动时从唯一 query读取 password到 page-scoped closure/state。所有 request显式携带当前 committed值，所有 representation URL在 render/click时重新生成；不得写 cookie、`localStorage`、`sessionStorage`、IndexedDB或 `window.name`，也不得缓存含旧 password的 URL。password-bearing representation anchor `href`、用户明确复制出的 representation link和当前 browser location是仅有的 URL-transport exceptions。bootstrap links保持 credential-free；visible text、status、inert bootstrap/source、其他 attributes、application-authored diagnostic logs和 errors不得包含 password或 protected URL。允许的 URL request仍可能按第9.3节进入 Cloudflare/request log，这是冻结的 transport风险，不得由 client另行复制记录。literal metacharacter password仍按第9.2与9.4节序列化。

React canonical state至少包含 `acceptedSource`、`draft`、`PasteSummary`、`version`及其 mutation-authority flag `versionUsable`、`contentRevision`、`updatedAt`、latest accepted response ETag、`acceptedApplyGeneration`和 `localGeneration`。`versionUsable`在 initial coherent load及任何 full authoritative 200 acceptance时为 true；authoritative `409 VERSION_CONFLICT`把它设为 false，在下一次 successful full resource Reload前不得把 retained version放入 request，也不得 dispatch versioned mutation。第17.6节明确允许的 user-confirmed Overwrite仍可省略 version执行 LWW。autosave controller中的 `lastSavedContent`是同一 canonical `acceptedSource`的别名，不允许成为独立 baseline；每次 accepted source变化必须在一个 reducer transition中同时改变两者。ordinary remote apply另有递增 `remoteApplyToken`；terminal consumption建立独立递增 `terminalLocalToken`，该 token不引用或恢复任何 ordinary controller。

remote或 selected source apply共用下述 staged surface transaction，但不得共用一个 autosync eligibility predicate。进入 transaction前按来源捕获 guard：

| 来源 | Apply-entry guard | Commit guard与成功语义 |
|---|---|---|
| valid `definitely-newer` autosync 200 | ordinary sync `requestToken`仍 current；capture的 accepted baseline与 `localGeneration`未变；`now < activeUntil`；无 composition、autosave timer/in-flight/coalesced intent、mutation slot、unresolved mutation或其他 local source work | entry transition把 validated snapshot与 guard转交给新的 `remoteApplyToken`并可 retire ordinary sync token。commit只要求该 apply token、captured baseline、draft与 `localGeneration`未变，仍 active且无 pending local source/mutation；staging自己的 `remoteApplying`和 sync-token retirement不失效 guard。成功发布 server snapshot，Autosync=`remote-applied`并在 commit instant写 `stateChangedAt`与 `appliedAt` |
| conflict中的 `Use remote` | candidate及其 capture仍存在；accepted baseline与 candidate capture完全相同，当前 `localGeneration`也等于 candidate capture；ordinary page仍 active；`draft === acceptedSource`；无 composition、autosave timer/in-flight/coalesced intent、mutation slot或 unresolved mutation。该 guard有意忽略 candidate自己造成的 Autosync=`conflict`，不得调用 `locallyClean` | action entry捕获新的 `remoteApplyToken`，在一个 transition中离开 visible conflict/设 `remoteApplying`，同时把 candidate移入该 apply transaction而不是丢弃。commit只重新检查 captured baseline、draft、`localGeneration`、active、mutation slot和 apply token；staging自身的 `remoteApplying`或已经离开 conflict不得使 guard失效。成功后 Autosync=`remote-applied`，写 `stateChangedAt`/`appliedAt`并把 `use-remote` Last action设为 succeeded |
| confirmed explicit Reload | destructive Dialog已确认；独立 `reloadRequestToken`的 unconditional resource GET已 dispatch且 token仍 current，明确省略 `If-None-Match`；dispatch时 mutation slot为空，并 capture accepted baseline、`localGeneration`和当时 exact `draft` | 不要求 autosync active或 clean，允许 dirty conflict与 inactive window。commit要求 reload token、captured baseline、captured draft及 `localGeneration`均未变、mutation slot仍空且未进入 terminal；dirty draft在 staging期间始终保留，只有 successful ordinary commit才按已确认的 destructive choice替换。成功设置 `reload-server` Last action settled time；只按 commit后的实际 active/clean状态决定 Autosync waiting/paused/inactive，不 reopen deadline |
| consumed local-only source choice | terminal capability transition已完成；terminal epoch、当前 local display generation和所选 retained exact source仍 current | entry时增加并 capture独立 `terminalLocalToken`；不检查 sync token、`activeUntil`、`locallyClean`、mutation slot或 accepted server baseline。commit只切换 terminal local display source与派生 surfaces，不发布 server version/ETag，不创建 controller或 URL，不发送 business request；successful `Use consumed response`以 `use-consumed-response`记录 Last action |

通过对应 entry guard后，transaction按以下顺序执行：

1. entry guard通过的同一 transition只增加并捕获一次对应 `remoteApplyToken`或 `terminalLocalToken`，随后捕获旧 observable generation及各 surface状态，把 validated target exact source和 optional `RemoteSnapshot`放入非公开 staging state，并分配新的 `targetApplyGeneration`。各来源表中所述 action entry与本步是同一次 token allocation，不得再次增加。read view、plaintext editor、Markdown source、draft和所有 marker在此时都不发布。
2. preview render output、diff result和可新建的 Crepe instance必须在 detached/non-current host或私有 value中准备。若某个现有 Crepe只能原位 reset，必须先同步从 mounted tree移除其 host并替换为明确标注 applying、且不声称显示 current generation的 fallback，再在 detached host操作。target的任何 byte进入 mounted host前，页面只能完整显示旧 generation，或对已清空 surface显示该 non-current fallback；不得同时可见 old与target derived content。
3. preview import或 render rejection只丢弃 detached preview并为 target generation准备“source仍可用”的 Preview Retry fallback；catch不得修改当前 preview。Crepe `reset` rejection后在独立 `try`中调用 `destroy`；无论 `destroy`成功或抛错，都同步断开 callbacks、移除整个 staged host并丢弃其引用，再在全新的 detached host recreate exact target source。recreate rejection同样清理新 host，并为 target generation准备 exact source Textarea与 Retry visual fallback。diff worker rejection会 terminate/discard该 worker，只把 immutable selected snapshot、target current source和 Retry diff fallback放入 staging。Preview、Crepe与 diff各自持有 monotonic `derivedRetryToken`，每个 mounted surface host持有在 mount、replace或 remount时递增的 `hostGeneration`。每次 derived-surface Retry开始时必须捕获 `{localGeneration,currentExactSource,currentDisplayGeneration,hostGeneration,parentApplyGeneration,parentApplyToken,derivedRetryToken}`；`parentApplyGeneration`是安装当前 fallback的 committed apply generation，`parentApplyToken`是该 parent transaction的 `remoteApplyToken`或 `terminalLocalToken` identity，`currentExactSource`与 `currentDisplayGeneration`是该 surface当时声称显示的 exact source及 generation。publish时必须重新验证全部 capture与当前值相同、当前 host仍是同一实例、fallback仍属于该 parent generation，且 retry result的 exact source仍等于 current exact source。任一 local source change、新 visual transaction、mode change或 host unmount/remount、remote apply、Reload或 consumed source choice都先增加全部现存 `derivedRetryToken`并 retire旧 attempt；同 surface更新的 Retry在启动前增加该 surface token并 retire其上一 attempt；host生命周期变化还增加 `hostGeneration`。任一检查失败时只清理 stale attempt自己的 detached host、worker和 callback；不得替换或清除当前 fallback、当前 status、draft、canonical source、accepted markers或 visible surface。late import、Crepe callback或 worker result一律按同一 publish guard丢弃。
4. 所有 mounted surfaces都已准备 target或 target-bound fallback后，重新检查该来源的 commit guard。通过时用一个 React commit原子 swap staged hosts/fallback并发布一个 generation。ordinary apply同时发布 `acceptedSource`、`lastSavedContent`、summary、version/contentRevision/updatedAt、accepted read ETag、read/plain baseline与 `acceptedApplyGeneration`，令 `draft=acceptedSource`，清除 save timer/in-flight并设 Autosave=`clean`；Reload的 captured dirty draft只在此 commit丢弃。terminal local apply只发布 local display source和 terminal generation。任何 remote transition都不调用 `AutosaveController.input`、不建立 history、不发送 save、不改变 `localGeneration`，也不更新 local-save `confirmedAt`。
5. ordinary apply若同 generation但 `contentRevision`改变，则把 history list标为 stale，保留仍可识别的 selected immutable snapshot并在下一次 History access重新 fetch descriptors；不同 generation时清空全部 history snapshot/list/diff；仅 settings marker变化时保留 settled history data。第17.10节会先 invalidate仍 in-flight的 history responses。terminal local apply不保留或重启 history controller。
6. guard在 staging中失效时先增加 apply/retry generation、断开并清理全部 staged host/worker/callback。未被触碰的 visible old generation保持原样；已经同步清空或被 reset/destroy影响的 host，从捕获的 old exact source和 immutable inputs原子 restore old generation。restore不可行或也失败时保留明确绑定 old generation的 failure fallback和可用 exact old source，不声称该 surface是 current。canonical markers、ETag和 draft不得部分推进。

自动 autosync invalidation/failure只更新 Autosync的实际 paused/inactive/error transition及其 `stateChangedAt`，不写 Last action；`Use remote`失败保留 candidate/target供同 origin的新 generation Retry apply并把该 action设为 failed；Reload invalidation/failure保留 old canonical generation与 dirty draft并把 `reload-server`设为 failed；consumed local apply失败保留 terminal source choices和原 local display，把 `use-consumed-response`设为 failed。任何 Retry apply重新执行本节全部 entry/commit、offscreen、cleanup和 generation checks，不复用失败 transaction的 host或 callback。

### 17.6 Autosave state machine

状态为 `clean`、`waiting`、`saving`、`saved`、`error`、`conflict`。`clean`表示当前 source是任一 server-loaded或 accepted baseline且没有 pending local source work，包括 initial load、explicit reload、remote apply及用户把未发送 draft改回 accepted source；`saved`只表示最近一次 local source save的200已确认且当前 draft与该 acknowledged source相同。两者都没有 pending timer。remote transition不得生成或修改 local-save `confirmedAt`。数据至少包括 `draft`、作为 `acceptedSource`别名的 `lastSavedContent`、`version`、`lastInputAt`、`dueAt`、`inFlightContent`、`dirtyWhileSaving`。

1. 初始 state 为 `clean`，`draft=lastSavedContent=acceptedSource=server content`，`version=server version`，`inFlightContent=null`，`dirtyWhileSaving=false`。initial clean没有 `confirmedAt`或 fabricated status timestamp。
2. 非 composition中的真实 user `input`以该 DOM event的 monotonic timestamp调用第17.7节 `recordUserActivity`，更新 draft，并设置 `lastInputAt=eventAt`、`dueAt=eventAt+1000`。无 in-flight 时进入 `waiting`，并用一个指向该 `dueAt` 的 timer替换旧 timer；有 in-flight时保持 `saving`，按第5步处理。programmatic reset不得走此路径。
3. `compositionstart`取消 pending autosave timer但保留 draft，并增加用于失效 sync的 `localGeneration`，但不移动 `activeUntil`。composition期间的 intermediate input更新 textarea与 draft并失效 sync，不更新 autosave的 `lastInputAt`、`dueAt`或 active deadline，也不发送 request。`compositionend`仅在提交最终 value时以该 event timestamp记录一次 user activity，并从该时刻完整等待1,000 ms。
4. timer到 `dueAt`时先清除自身。若 draft等于 `acceptedSource`，不发送并进入 `clean`。否则仅当 page-level mutation slot为空且 state不是 `conflict`时，增加 `localGeneration`、abort/invalidate sync，再 capture coordinator token与当前 accepted baseline，设置 `inFlightContent=draft`、`dirtyWhileSaving=false`、state=`saving`，然后发一个 `PATCH /api/pastes/:id`。dispatch、Retry和 network retry本身都不得修改 `activeUntil`。body固定含 `{content:inFlightContent,version}`；仅当本次 request使用的 committed或 pending credential非 null时再加入 `password`。slot非空时只标记第17.10节的一个 coalesced source intent，不并发 dispatch。
5. 任一时刻最多一个 autosave request。saving时的新 input仍按第 2 步更新 draft、`lastInputAt`与 `dueAt`，设置 `dirtyWhileSaving=true`，但不启动可在 in-flight完成前发送的第二个 request。
6. 收到 validated changed或 no-op 200且 coordinator token仍 authoritative时，在一个 transition中把 `acceptedSource`及其 `lastSavedContent`别名设为该 request的 `inFlightContent`，把 accepted generation/version、summary、`contentRevision`和 `updatedAt`设为 response值，再清空 in-flight标记并更新 `confirmedAt`。request期间发生的新 edit只留在独立 `draft`中。若 draft等于新的 `acceptedSource`，清除 timer并进入 `saved`；否则进入 `waiting`，在 page-level slot释放后按 `max(0, dueAt-now)`发送唯一一次 coalesced latest draft。mutation response的 version ETag不是 read response ETag，因此成功后清除 cached response ETag，下一次 autosync发送 unconditional GET。changed、no-op和 edit-during-save三种 acknowledgement后，equal poll都必须以新的 accepted source和 markers比较，不能读取旧 baseline。
7. 413或422已证明 request未进入 content write，释放 autosave对 page-level slot的占用并清除 timer，保留 draft、accepted source和 version，进入 `error`且不自动 retry；用户修正后可显式 Retry、copy或download draft。任何 content autosave、manual save或 Overwrite在 dispatch后遇到503、fetch rejection、无法证明未应用的500或 `mutationMayHaveApplied=true`时，不把 slot释放为普通 idle，而按第17.10.4节把原 mutation token转换为 `content-reconciliation`，保留 exact request target与后来 draft，禁止 blind mutation retry。下一次真实 user input仍按第2步更新 draft、`lastInputAt`和 `dueAt`，但 reconciliation解除前不得 dispatch。
8. 403同样保留全部 draft state，OperationStatus显示 `password-required`，并提供 inline password re-entry。输入只写 `pendingCredential`；显式 Retry只用它授权该 attempt。非 password-changing save的 authorized 200可按第9.4节 commit该 credential；wrong replacement不改变 committed credential、URL或 links。
9. 404/expired保留 exact draft，进入 terminal local-only missing state，dispose autosave、autosync、history和 mutation coordinator，移除所有 server controls与 representation URLs，只提供 local copy/download、full refresh和 create new；不尝试重建同 ID。
10. 409 version conflict保留 draft并进入 `conflict`，同时暂停 autosync。显示 Reload server、Overwrite with draft、Copy draft。Reload必须经 destructive Dialog确认，并只能在 mutation slot为空时调用同一 resource GET；ordinary response按第17.5节 confirmed Reload guard和 staged protocol替换 canonical surfaces，允许 dirty conflict与 inactive window，且 dirty draft保留到 successful commit。若 response含 `viewOnce:true`，先按第17.8节进入 terminal consumed local-only state，再用独立 `terminalLocalToken`处理已确认或需选择的 exact source，绝不恢复 mutation。Overwrite占用同一 slot，发送 latest draft并明确省略 version执行 last-write-wins；其 uncertain result仍进入第17.10.4节。没有自动 merge。
11. `error`或403状态的显式 Retry仅在 mutation slot为空、没有 content reconciliation且 draft与 accepted source不同时立即发送 latest draft，使用本次 committed或 pending credential与当前 version；它增加 ordering generation但不延长 active deadline。Retry失败仍按对应规则。
12. draft与 `lastSavedContent`不同或 mutation in-flight时注册 `beforeunload` warning；相同且无 in-flight时移除。
13. server exact no-op detection是最终依据，client comparison只用于避免 request。React只实例化一个 controller并在 unmount dispose，不在 reducer/effect中实现第二套 transitions。

### 17.7 Autosync eligibility、clock 与 request sequencing

真正非轮询的等价实现受第 3 节约束而不可行，因此只使用直接、顺序的 browser polling。不得用 open stream、socket、service worker、server loop或 Cache包装它。

clock使用可注入的 monotonic milliseconds；production用 `performance.now()`计算 deadline和 due time，用 `Date`只生成显示时间。定义：

* `activeUntil`：application完成初始 load/refresh时设为 `loadAt + 300_000`。此后只有 `recordUserActivity(activityAt)`可把它设为该真实 event timestamp `+ 300_000`，不 round、不加 grace period；
* `recordUserActivity`只由非 composition的 source `input`、committed `compositionend`/Crepe user document-change，以及 title、format、expiration、viewOnce、password或其他 settings field的 user `input`/`change` event调用。compositionstart/intermediate IME、programmatic value change、Button click、mutation dispatch、autosave due、Retry/Overwrite/Reload、response settle和 network retry都不得移动 deadline；
* `localGeneration`：初始为0；每个 source input、Crepe document-change、`compositionstart`、IME intermediate input、settings field change，以及每个 API mutation dispatch都在 capture request前增加。它只失效旧 response，增加它本身不代表 activity也不移动 deadline。programmatic remote apply、copy/download和 sync request不增加；
* `locallyClean`：只用于 ordinary autosync scheduler eligibility。它要求 draft exact等于 accepted source，且没有 composition、autosave timer、page-level mutation request、queued coalesced source save、unresolved mutation failure、sync conflict或 remote apply；不得把它复用为 conflict candidate的 `Use remote`、confirmed Reload或 consumed local apply guard；
* `syncDueAt`：下一次允许检查的 monotonic due time；initial为 `loadAt+3_000`，每次重新进入 eligible或前一次 sync settle时设为对应 instant `+3_000`，无待检查时为 null。

只有 ordinary、未 consumed paste page且 `now < activeUntil`、`locallyClean=true`、browser未 offline时才 eligible。load后不发额外 immediate GET。initial load或从 local pause、online event、Keep current、Retry恢复后，普通 due pending时 autosync state=`waiting`；settle后的 timer保留最近 outcome state；fetch in-flight时=`checking`。local work使其不 eligible时=`paused-local`，offline时=`paused-offline`，deadline到达时=`inactive`。response outcome使用第17.8至17.9节 states。规则固定如下：

1. 每个 ordinary page至多有一个 autosync timer和一个 sync fetch。scheduler在 `now < activeUntil`时把唯一 timer设到 `min(syncDueAt ?? activeUntil, activeUntil)`；因此没有 due、处于 local pause/offline/conflict或 fetch in-flight时，仍用同一个 timer守住 exact active deadline。每次 `activeUntil`或 `syncDueAt`改变都替换该 timer。
2. timer callback先清除自身。若 `now >= activeUntil`，立即设 `inactive`并记录 `stateChangedAt`，清除 ordinary-paste candidate与 conflict/source-choice state，abort并 invalidate in-flight sync，且不发 request、不安排新 timer。若尚未到 deadline但尚未到 `syncDueAt`或不 eligible，只重新 arm同一个 deadline timer；只有 due已到且全部 predicate成立时才 dispatch。
3. 任一 edit、composition event、autosave wait/save、显式 mutation dispatch或 remote apply开始都取消当前 timer并 abort/invalidate已开始的 sync fetch；随后若仍是 ordinary page且 active，重新 arm仅用于 deadline的同一 timer。retired token禁止 ordinary ordering、baseline、status或 cadence更新，但不能跳过第17.8节对已经完整交付并可严格验证的200所做的 terminal view-once precedence检查。abort若发生在 body完整可读并验证之前，则该 attempt仍只是 abort。
4. request capture `{requestToken,localGeneration,accepted generation/version/contentRevision/source,activeUntil}`，把 `syncDueAt`清为 null，并立即 arm `activeUntil` deadline timer。adapter取得200 `Response`后先读取 exact bytes并完成第17.8节 strict validation与 `viewOnce`检查，再检查 ordinary token。只有 non-view-once response的 token仍 current、capture baseline未变、仍 locally clean且 `now < activeUntil`时，response才可进入 ordinary ordering comparison；view-once terminal handling使用第17.8节独立 precedence和 token。
5. composition、dirty draft、autosave wait/in-flight/coalesced、settings/password/viewOnce/delete mutation、unresolved mutation outcome、remote apply或 sync conflict期间没有 check due；只保留 deadline timer。对应工作完成后，仅当再次 eligible才从该 completion time建立新的完整3,000 ms due。
6. sync fetch在 deadline前 settle后不立即再发。仍 eligible时设 `syncDueAt=settledAt+3_000`，然后把唯一 timer设到 `min(syncDueAt,activeUntil)`；due晚于 deadline时，deadline callback只转 inactive。slow settle、online recovery、candidate/conflict action和 Retry都走同一规则，不建立额外 retry/backoff loop。若 settle时已 inactive，retired non-view-once response不能改变任何 surface、accepted marker或 cadence；已经完整交付且严格验证的 `viewOnce:true` 200仍先执行第17.8节 terminal transition，但不能自动更新 ordinary accepted baseline。
7. 新的真实 user activity可建立新的 exact 300,000 ms window，并按当前 local/online状态重新安排；request dispatch或 Retry不能 reopen已 expired window。
8. polling只调用 `GET /api/pastes/:id`，fetch设 `cache:"no-store"`；有 accepted read ETag时显式发送 `If-None-Match`，candidate被 dismiss后 Retry的下一次 request明确省略一次 validator。password仍使用现有 unique query carrier。不得调用 status-only、settings-only或新 sync request。

### 17.8 Remote ordering 与 deterministic candidate rule

每个取得200 `Response`的 sync、Reload或 Content Reconcile attempt都按固定 precedence处理：完整读取 exact response bytes；验证 `ETag`格式并用 Web Crypto SHA-256核对 digest；strict parse `PasteResource`为 `RemoteSnapshot`；检查 `viewOnce` terminal flag；最后才检查 ordinary request ordering token与 apply guard。`RemoteSnapshot`至少含 strong response `etag`、exact `source`、完整 summary、opaque `version`、positive `contentRevision`和 RFC3339 `updatedAt`。coherent还要求 response ID与当前 path exact相同、`contentBytes`等于 source UTF-8 byte length、links符合该 ID的 clean canonical paths、timestamp可 parse且 schema2 version/contentRevision为 positive safe integer。schema2 version按最后一个 `.`分成 generation与 positive safe integer counter；`legacy`不伪造 counter。当前 accepted baseline保存同样 markers和 exact source。

只有 body完整交付并通过上述全部 strict validation后，`viewOnce:true`才有 terminal authority。transport abort、截断 body、digest mismatch、schema/identity malformed或任何未完成 body都不能触发 terminal transition；current ordinary token的此类失败进入 sync `error`，retired token的此类失败只清理该 attempt且不改变页面。任何完整且严格验证的 `viewOnce:true` 200则先执行本节 terminal capability transition，即使 edit、composition、mutation dispatch、offline或 exact active deadline已经 retire其 ordinary token。该 terminal precedence不授予 retired response ordinary baseline authority。non-view-once 200只有通过第17.7节 token/capture/active/clean guard后才进入下述 ordering comparison。

对两个 schema 2 snapshot，只有 generation相同才比较三维 marker `(versionCounter, contentRevision, updatedAt instant)`：

* remote三项都小于等于 baseline且至少一项严格小于，为 `definitely-older`；
* remote三项都大于等于 baseline且至少一项严格大于，为 `definitely-newer`；
* 三项全相等为 `marker-equal`；
* 一部分增加而另一部分减少，为 `incomparable`。

不同 generation，以及 legacy snapshot与 baseline不能 exact equality时，均为 `incomparable`。自动 source/summary apply的唯一允许分类是 `definitely-newer`；每个 capture仍有效、页面仍 active且 clean的 `definitely-newer` response都必须清除旧 candidate并按第17.5节 staged apply。source相同时仍一次性发布较新的 summary/markers/ETag，但可跳过无变化 editor的 rebuild。`marker-equal`且 exact source和所有 public summary fields相等时为 unchanged，并保存该200 strong ETag。

对 `definitely-older`、有任一 source/public-summary divergence的 `marker-equal`、所有 `incomparable`和 legacy-divergent response，规则如下：

1. 把完整 identity `{etag,version,contentRevision,updatedAt,source,summary}`连同它的 capture `{acceptedApplyGeneration,localGeneration,generation,version,contentRevision,acceptedSource}`作为 non-destructive candidate保存在 document memory，保持全部 accepted surface和 accepted ETag不变，记录本次 `checkedAt`，把 Autosync设为 `conflict`并停止 check due。candidate相同或重复任意次数都不是 freshness证据，永不自动 apply；candidate变化也只替换 retained candidate，不改变 current surface。
2. conflict显示 inline Use remote、Keep current和 Retry sync。Use remote是唯一可选择未证明较新 candidate的路径；它使用第17.5节独立 entry guard，不调用 `locallyClean`。guard通过时，一个 reducer transition捕获 candidate与 `remoteApplyToken`、离开 visible conflict并进入 staging；candidate payload在 transaction中保留到 successful publish或明确 dismissal。staging自身不能推翻已捕获 guard。若在 entry前已有 edit、composition、autosave timer/in-flight、coalesced source intent、mutation slot、baseline或 `localGeneration`变化，拒绝 action且不碰任何 surface；local activity、mutation或 baseline invalidation按第3项清除尚未进入 transaction的 candidate，stale action closure绝不能 apply。Keep current只 dismiss该 candidate和 conflict，不修改 accepted baseline、source、markers或 ETag；若仍 eligible，从 action时刻建立普通 conditional check的完整3,000 ms due。Retry sync也 dismiss candidate/conflict，但下一次 due request省略一次 `If-None-Match`；它不移动 `activeUntil`，due不早于 action后3,000 ms。
3. 未进入 staged transaction的 candidate在 abort、local source/settings activity、accepted baseline变化、offline或 terminal transition时清除。已进入 transaction的 payload只由第17.5节 apply token和 rollback规则管理。即使页面一直处于 conflict，第17.7节的唯一 deadline timer也必须在 `activeUntil`精确清除 candidate、invalidate staged apply并转 `inactive`。inactive后 Use remote不可用，Retry不能 reopen window。
4. Use remote和 Retry sync使用第17.11节 closed `ActionKey`更新 Last action；Keep current是不可失败的 pure state dismissal，不改 Last action。三者都不发 status-only request。304只证明当前 accepted ETag，保持全部 canonical state并更新 `checkedAt`。

任何完整交付且严格验证的 content-bearing 200一旦含 `viewOnce=true`，该 GET已经按第10节删除 server paste。response handler必须先执行 terminal capability transition，再做 ordering或 source choice：

1. 在 dispose前捕获 transition instant的 current local exact source，即当前 `draft`，以及 current local display/derived generation；它可以包含 retire该 sync的 edit或已经 dispatch mutation的 exact local target，不得退回旧 `acceptedSource`。若 response源自仍为 pending的 `content-reconcile`或 `reload-server`，同一步另捕获独立 `terminalOriginSettleContext={actionKey,actionAttempt,startedAt}`；该 context只保存 action identity与既有 event time，不保存 password、credential、request/response body、source、paste ID或任何 protected URL。随后立即 invalidate page mutation、history、ordinary sync和 apply tokens，abort/dispose autosave、autosync、settings/history/delete及全部 server request hooks，清除 timer/candidate/server URL objects，并从 React tree移除 Edit、History、Settings、Delete及 raw/HTML/md/file等 representation URLs。此 terminal state不可恢复 server mutation能力；token/controller disposal不得清除或 settle该独立 context。
2. disposal完成后建立独立 `terminalLocalToken`，把 current local exact source与 consumed response exact source保存在 terminal document memory。两者 exact相等时只保留一个 display source。只有 response分类为 `definitely-newer`且满足以下任一条件时，才用第17.5节 consumed local-only guard把 response source作为 selected target：其 ordinary autosync token在 strict validation时仍 current；或其 confirmed Reload独立 request token与 captured draft/baseline仍有效。exact-equal response直接保留 local source。`definitely-older`、marker-equal divergent、incomparable、legacy-divergent及任何 retired ordinary token的 response先保留 current local display。该 local apply发生在 controller disposal之后，不再依赖已销毁的 sync controller、active或 clean predicate。
3. terminal capability、retained exact source set及 initial display必须在一个 React commit发布。auto-selected response staging成功时该 commit显示 response；staging失效或 derived surface失败时仍以 current local source和明确 fallback完成 terminal capability commit，不恢复 server controls。该 commit同时以自己的 commit instant作为 `settledAt`，用第17.11节下表恰好一次 settle并清除 `terminalOriginSettleContext`；settle transition与 context消费是同一 reducer action，late callback、Keep current或后续 local apply不能再次使用它。若 origin是 background autosync，则不创建该 context，只更新并终止 Autosync自己的 state record，不写 Last action。
4. `definitely-older`、marker-equal divergent、incomparable或 legacy-divergent response不得自动替换 local source。任何 ordinary token已因 edit、composition、mutation dispatch、offline或 deadline retire的 response，即使 markers为 `definitely-newer`，也不得更新 ordinary accepted baseline或自动选择 consumed response；默认继续显示 transition时的 current local exact source，并在两者不同时提供纯 local的 Use consumed response与 Keep current。confirmed Reload的 ambiguous/older response也遵守该默认值；其 dirty draft保留为 initial display。Keep current只 dismiss source-choice，不改变 initial terminal commit已经 settled的 origin action。
5. Use consumed response增加新的 `terminalLocalToken`并以独立 `use-consumed-response` action执行第17.5节 offscreen staged transaction；successful display commit以其自己的 `settledAt`和 localized `use-consumed-response-displayed` message settle为 succeeded，token invalidation、surface failure或 rollback fallback以实际 failure instant和 localized `use-consumed-response-display-failed` message settle为 failed。它不得 reset或 resettle先前的 `reload-server`或 `content-reconcile`。token invalidation、surface failure或 Retry均只影响 terminal local display，不能重建 server version/ETag、operation、representation URL或 controller。除已经请求或新请求的 hashed renderer chunk外，进入 terminal后的 business request计数保持为零。
6. 该 precedence同样适用于 autosync、explicit Reload和第17.10.4节 content reconciliation GET。ordering、derived-surface retry、credential状态或 retired ordinary token都不能安排 verification、autosave、autosync、representation navigation或任何后续 business request。transport abort、截断或 malformed response仍按本节开头的 strict-validation control处理，不产生假的 consumed状态，也不走 terminal settle；它们按 origin operation的 ordinary failure规则 settle。

其他 non-view-once autosync 200只有 `definitely-newer`可按第17.5节 autosync guard staged apply；confirmed Reload已由 destructive confirmation选择本次 ordinary response body，不要求 ordering为 newer，但必须通过同节独立 reload guard。任一 guard失效时执行同节 rollback，不改变 accepted baseline。该规则不声称提供 CAS、global ordering或绕过 KV最多60秒以上的 cross-location staleness。

### 17.9 HTTP、offline 与 conflict recovery

sync和其他 browser request共享薄 API adapter及 OperationStatus。所有 local mutation共享第17.10节的唯一 page-level slot；sync read、explicit reload和 history read不占该 slot，但在 slot pending时均禁止 dispatch。任何 mutation dispatch前先 abort/invalidate sync，任何 sync response在 mutation开始后都因 token失效而不能进入 ordering。

* 200：先按第17.8节 strict body -> terminal view-once -> ordinary token precedence处理。current ordinary definitely-newer apply或 exact unchanged后，从 settle重新等待3,000 ms，但 scheduler仍以 `min(syncDueAt,activeUntil)`守 deadline；retired non-view-once response没有 state effect；完整且严格验证的 retired `viewOnce=true` response仍进入 terminal local-only transition，且不能继续 polling或自动推进 ordinary baseline。confirmed Reload不使用这条 autosync cadence。
* 304：记录 `unchanged`和 `checkedAt`，从 settle建立3,000 ms due，但 due晚于 active deadline时只在 deadline转 inactive，不发 request。
* 403：清除 timer/candidate，状态为 `forbidden`并记录 `stateChangedAt`，停止自动 sync；inline password Field只写 `pendingCredential`。用户选择 Retry sync后，若 `now < activeUntil`且 clean，从 action时刻完整等待3,000 ms，并只对该 request使用 pending value；Retry本身不延长 active window。该 request得到 authorized 200或304后才按第9.4节 commit credential和 URL；再次403不改 URL。已经 inactive时，Retry不得 reopen window。不得弹 password modal。
* 404：状态为 `not-found`并记录 `stateChangedAt`，永久停止当前 page的 autosave和 autosync，invalidate mutation/history requests，移除 server controls/URLs并保留已加载 source/draft供 copy/download；只允许 full refresh或 create new，不重建 ID。
* 409：无论 code，状态为 `conflict`并记录 `stateChangedAt`，保留本地与已取得 remote data，停止自动 sync；autosave `VERSION_CONFLICT`继续使用第17.6节 actions。resource GET正常不应返回409，测试仍须验证 fail-closed presentation。
* 503或其他5xx：状态为 `error`并记录本次 transition的 `stateChangedAt`，保留 state和 ETag；在线、active且 clean时没有立即 retry，只设 settle后3,000 ms due，再由唯一 timer在 `min(syncDueAt,activeUntil)`唤醒。若 due不早于 deadline则只转 inactive；Retry sync同样不能越过或延长 deadline。
* fetch rejection且 `navigator.onLine !== false`：network为 `degraded`，sync为 `error`，各自记录实际 state change time，规则同503。AbortError且 token已失效不是 error，不改变 network状态。
* `offline` event或 `navigator.onLine === false`：立即 abort/invalidate sync、清除 candidate和 check due，network=`offline`、sync=`paused-offline`，但保留唯一 active-deadline timer。`online` event只把 network设为 `online`；仍 active和 clean时从 event time建立完整3,000 ms due，否则保持对应 paused/inactive状态。不得在 online event立即 fetch。

local mutation的所有 outcome统一遵守第17.10节，不再依赖未定义的 Settings规则。所有 retry由现有 operation或一个 inline Retry/Reconcile action触发，不增加 endpoint，也不通过 modal/toast报告。

### 17.10 Page-level mutation、History、local failure 与 view-once transition

#### 17.10.1 唯一 page-level mutation coordinator

ordinary page只有一个 mutation slot，覆盖 content autosave、Retry save、Overwrite、任何 manual source save、title、format、expiration、viewOnce、password set/change/clear和 delete。每个 request在真正 dispatch时取得递增 `mutationToken`，并 capture `{acceptedApplyGeneration,generation,version,contentRevision,acceptedSource}`；每次最多一个 slot为 occupied。explicit mutation Button在 slot occupied时 disabled但保留 field draft；autosave due只保留一个 coalesced latest-source intent，slot释放后仅在 `draft !== acceptedSource`时 dispatch。summary/version/ETag或 `localGeneration`变化而 source未变化绝不能建立 content PATCH。

mutation request不互相 preempt。dispatch前增加 `localGeneration`并 abort/invalidate sync和 affected history request，但不移动 `activeUntil`。只有 unmount、404、terminal consumption、armed view-once或 delete terminal transition可以 abort并 retire occupied token；AbortSignal后仍 resolve的 mutation response按 retired token丢弃。只有 token仍 current、captured baseline未被其他 authoritative transition替换且 strict response已验证时，response才可更新 accepted version/summary/ETag。content 200按第17.6节同时更新 accepted source；metadata-only 200要求 generation/contentRevision与 captured source baseline一致，只更新 summary/version并清除 read ETag。任何 mismatch进入 reconciliation，不能把 new summary markers与 old source拼成 baseline。content write的 uncertain result不 retire原 token，而把 occupied slot转换为第17.10.4节的 `content-reconciliation`，以便后续证明仍绑定原 request target和 baseline。

普通 authoritative settle后先处理 response，再释放 slot。若仍是 ordinary、无 unresolved failure且 source dirty，才 dispatch一个 coalesced source intent；否则在 active且 clean时从 settle建立3,000 ms sync due。`content-reconciliation`只有在第17.10.4节证明 applied/not-applied、进入 conflict或 terminal transition后才按该节释放或 dispose，不得触发普通 coalesced dispatch。controllable-promise tests必须证明 autosave未 settle时 settings/password request不 dispatch，settings/password pending时 autosave最多只 coalesce一次，并且人为 late callback或 retired token即使按反序 settle也不能回退 accepted version、summary、ETag或触发 duplicate PATCH。

#### 17.10.2 History request baseline

History desktop为左 revision list、右 detail；mobile先 list，选择后进入 detail并提供 Back。detail用官方 Tabs显示 Unified diff和 Full snapshot，默认 selected revision -> current diff。list和 snapshot按第11节 lazy load；diff worker返回结构化 lines，React用 text children渲染。loading、empty、403、404、409、503和 corruption有独立 visible operation/error state，但空态 explanation放入 History HelpTrigger，不显示教学段落；失败不清空 current draft。

每个 history list与 snapshot request分别 capture递增 request token及 `{acceptedApplyGeneration,generation,version,contentRevision,acceptedSource}`。remote apply、explicit reload、任何 authoritative mutation acknowledgement、terminal consumption、armed view-once和 delete都 increment history epoch并 abort/invalidate对应 request。response只有 token、epoch和全部 captured baseline仍 exact相等时才可写入；late list不能替换或清空现有 list，late snapshot不能改变 selected revision、snapshot或 diff current side。settled immutable snapshot是否保留仍按第17.5节 generation/contentRevision规则决定；request invalidation不把 stale response当成 empty/error UI。

#### 17.10.3 Content-independent mutation outcome table

Settings包含 title、default format、expiration、view-once、password change/clear和 immutable ID。title、format、expiration、viewOnce及 password各保留独立 field draft并单独 mutation，不与 content合并。user修改这些 field时按第17.7节记录 activity；稍后的 submit、dispatch、Retry或 Reconcile不移动 deadline。relative expiration、password transport和 view-once后果等 explanation只在 HelpTrigger。

| Outcome | Draft 与 accepted state | Version、summary、ETag authority | Sync 与 recovery |
|---|---|---|---|
| validated authoritative 200 | commit对应 field；其他 field draft和 source draft不变 | metadata-only response仅在 source markers匹配时更新 summary/version；清除 strong read ETag | 释放 slot；ordinary且 active/clean时从 settle完整等待3,000 ms |
| client validation、413或422 | 保留 field draft并显示 inline field error；accepted state不变 | 不推进任何 marker或 ETag | unresolved field draft期间 paused-local；修正后可 Retry，Discard draft后可恢复 |
| 403 | 保留 field draft、source和 committed credential；记录 password-required | 不推进；replacement只进入 `pendingCredential` | pause；Retry只用 pending value授权。非 password-changing operation的 authorized 200/304可按9.4 commit该 value；password set/change/clear的200必须改为 intended `newPassword`或 null |
| 404或 logical expired | 保留 exact source和 field drafts供 local copy/download | 不推进；invalidate所有 request token | terminal not-found；移除 server controls/URLs，无同 ID retry，只允许 full refresh或 create new |
| 409 | 保留 field draft和 source，记录 server conflict details但不应用它们 | 不推进 summary/version/ETag；设 `versionUsable=false`且不采用 error details作为新 baseline | pause；提供 Reload server与 Discard field draft；只有 successful full Reload取得 authoritative version后才可 Retry。Reload是 content-bearing GET，按17.5、17.8 staged apply；若返回 viewOnce立即 terminal consumed |
| 503且明确 `mutationMayHaveApplied=false` | 保留 field draft和 source | 不推进 | pause；inline Retry可安全重发 latest intent，dispatch不延长 active window |
| 503且 `mutationMayHaveApplied=true`、flag缺失的 write failure、500或 fetch rejection | 保留 field draft、source及 request target，状态为 `reconciliation-required` | 不推测 success，不推进；立即清除 read ETag | pause且不 blind retry；只允许下述 explicit Reconcile、local copy/download或 Discard |

对 title、format、viewOnce和 expiration的 Reconcile使用已有 authorized `GET /api/pastes/:id/settings`，不增加 endpoint。response generation/contentRevision与 accepted source baseline相同时，title、format、viewOnce及 absolute/permanent expiration的 target field已出现才可把该 response作为 authoritative acknowledgement；target未出现则保留 draft并允许重新提交。content markers改变时不能只采用 summary，必须先执行 explicit full resource Reload。

relative expiration的 `{kind:"relative",seconds}` equality永远不能证明原 mutation已提交，因为相同 seconds在每次 mutation都必须从新的 `now`计算不同 `expiresAt`，且 partial pre-metadata rewrite可能保留旧 descriptor而相关 keys已有不同 physical TTL。任何 uncertain relative result在 authorized settings read后都保留 intended seconds，并由用户这次 Reconcile继续执行一次新的、完整的第7.4节 mutation：以 retry开始写 KV前的新 `now`重新 normalize `expiresAt`和单一 `physicalExpiration`，读取并 sequentially重写 current及每个 active revision，最后写 metadata，使用 read取得的 current version。只有该完整 mutation的 validated 200才 commit field与summary；descriptor equality、旧 `expiresAt`或部分 key write都不能完成 reconciliation。任一步再次失败就保持 reconciliation-required，下一次 Reconcile仍从完整 rewrite开始，不只补 metadata或某个 sibling。Reconcile的403、404、503/network分别继续走上表，不自动循环。

uncertain password set/change/clear不能从 `protected` boolean判断实际 credential。Reconcile按以下顺序执行 authorized settings read：先尝试 intended new credential，clear时先尝试无 credential；若403，再尝试原 password mutation真正 dispatch时用于 authorization的 exact credential，它可以是当时 committed值，也可以是只用于该 retry的 `pendingCredential`；两个值相同则只试一次。intended new credential得到200或304时才把 intended `newPassword` commit到 page memory、唯一 URL query和新建 representation links；clear的无 credential成功时 commit null。authorizing old/pending credential得到200或304证明 mutation未应用；因为这次 settings read本身不修改 password，才可按第9.4节把该 proved credential commit为 current state，保留 intended field draft并允许 user Retry。两者403时保留 inline输入，不改变 committed credential、URL或 links。password mutation自身的200无论是否由 pending value授权，都只能 commit intended `newPassword`或 null。

每次 Reconcile attempt只发送一个 credential，值不进入 visible text、Last action、application-authored logs或 error；允许的 request transport仍承担第9.3节所列 infrastructure log风险。任何 attempt遇到404进入 terminal not-found，遇到503/network保持 reconciliation-required。

#### 17.10.4 Content mutation reconciliation

该流程只处理 content autosave、manual save、save Retry或 Overwrite已经 dispatch后遇到503、fetch rejection、无法证明未应用的500或任意 `mutationMayHaveApplied=true`。write attempt settle时，mutation slot从 in-flight转换为 `content-reconciliation`并保留原 capture `{mutationToken,originActionKey,acceptedApplyGeneration,generation,version,contentRevision,updatedAt,acceptedSource,inFlightContent}`。`inFlightContent`是该 request的 exact target；之后的 user edit只更新独立 `draft`、`lastInputAt`和 `dueAt`，不得改写 capture或自动 dispatch。该 state下其他 mutation、autosave和 autosync都暂停。

每次 explicit Content Reconcile attempt只 dispatch一个 authorized、unconditional `GET /api/pastes/:id`：使用新的 `contentReconcileRequestToken`引用原 `mutationToken`与 capture，设置 `cache:"no-store"`，明确省略 `If-None-Match`，不调用 settings、history或新 endpoint，也不自动循环。403 settle本 attempt；用户提交 replacement后开始的新 Reconcile attempt仍只发一个同形 GET，且一次只用一个 credential。response先按第17.8节读取 exact bytes、strict validate并执行 terminal view-once precedence；non-view-once result只有在原 mutation token、reconcile token和 captured accepted baseline仍 authoritative时才能按以下顺序完成：

1. 若 server exact source等于 captured `inFlightContent`，包括 `inFlightContent === acceptedSource`的 lost no-op response，则把它作为 authoritative acknowledgement。partial content commit可先由第7.3节 server read reconciliation补齐 metadata；client随后在一个 transition中把 `acceptedSource`与 `lastSavedContent`设为 target，采用 response summary、generation/version/contentRevision/updatedAt及 strong read ETag，清除 reconciliation并释放 slot。reconcile期间产生的 later `draft`保持 exact不变；等于 target时 Autosave=`saved`并以 proof instant更新 `confirmedAt`，不等时保持 dirty并在 slot释放后按既有 coalesced/due规则处理。
2. 仅当 target source与 captured baseline source不同，且 server的 `{generation,version,contentRevision,updatedAt,source}`仍与 captured accepted baseline全部 exact相等，才证明原 content mutation未应用。接受该 read的同一 baseline markers与 strong ETag、清除 reconciliation并释放 slot，但保留 later draft和 original target；Autosave保持 retryable `error`，只允许用户以 read取得的 current version显式 Retry latest draft，不自动发送 coalesced或 original target。
3. 其他任何完整 snapshot都属于第三状态，包括 source等于 old baseline但 version/contentRevision/updatedAt已变化。把完整 response保留为 non-destructive conflict candidate，保留 original target、later draft和当前 accepted surfaces，不拼接 markers、不自动 apply或 Overwrite；释放 reconciliation slot后进入 content conflict，只提供 confirmed Reload、Overwrite、copy/download等既有显式选择。
4. 403保留 capture、target和 later draft，进入 pending-credential flow；authorized 200来自不修改 password的 Reconcile GET，因此可按第9.4节 commit proved pending credential，再继续上述 exact comparison。404进入 terminal not-found/expired。503或 fetch rejection保留 retryable reconciliation state，下一次 Content Reconcile仍只发一个 GET。unexpected 304、malformed body/ETag或其他无法严格分类的 response保持 reconciliation-required并显示 failure，不把它当 acknowledgement或触发 mutation retry。
5. 任何完整且严格验证的 `viewOnce:true` response先按第17.8节捕获不含 sensitive data的 `terminalOriginSettleContext`，再移除所有 server capability，保留 transition时 current local exact draft与 consumed response exact source，并 dispose原 mutation/reconcile tokens；不得先执行上面 source comparison或接受 server markers。initial terminal display/capability commit必须用 retained context恰好一次 settle本次 `content-reconcile`，不能因 token disposal保持 pending。edit-during-reconcile、response-lost、main-write后 metadata failure及 exact same/no-op target都按本节相同 precedence。

原 save ActionKey在 uncertain write settle时以 failed和 `failedAt`结束；每个 `content-reconcile` attempt有独立 pending/settled timestamp。第1项 proof使 Autosave记录新的 `confirmedAt`，第2项保留原 failure time，第3项记录本次 conflict transition，403/404/503/network分别使用实际 settle time；valid terminal response使用第17.11节 terminal settle table。任何结果都不得伪造原 write的 completion time。

#### 17.10.5 Delete 与 view-once terminal transitions

Delete真正 dispatch时取得独立 `mutationToken`和 captured baseline，abort/invalidate sync与 affected history，暂停 autosave并禁止其他 mutation；Button和 Last action以 `delete`进入 pending。dispatch前的 client validation或 cancelled Dialog不取得 token、不改变 controller。strict result按下表处理，不能把 proven pre-delete failure归为 uncertain execution：

| Delete result | Token、credential与 URL | Source、controllers与 server controls | Last action与 recovery |
|---|---|---|---|
| validated 204 | current token完成；不把用于 retry的 `pendingCredential`写入 URL，按 root handoff清除 committed/pending credential、query和全部 sensitive references | invalidate所有 token，dispose autosave/autosync/history/editor，清除 accepted/draft/source/candidate/history及派生 server URL，在同一 root切到 create | `delete` succeeded保留 query-independent root feedback；refresh不 replay |
| 403 `FORBIDDEN` | authorization发生在任一 KV delete前，因此证明未执行；settle并释放本 token。保留 committed credential和 URL，replacement只写 `pendingCredential` | page、exact source/draft、summary及全部 ordinary server controls保留；Autosave=`password-required`、Autosync=`forbidden`并暂停对应 request | 本 attempt failed；允许使用 pending value发起新的 explicit Delete retry。wrong retry仍不改 URL；204 retry直接走上一行 |
| 409 `VERSION_CONFLICT` | version check发生在任一 KV delete前，因此证明未执行；settle并释放 token。不得采用 error中的 `currentVersion`/`updatedAt`更新 summary。保留旧 summary snapshot但设 `versionUsable=false`，使旧 version不再进入 mutation body；pending credential不因409 commit | exact source/draft、representation与 ordinary controls保留；autosave/autosync进入 conflict pause | 本 attempt failed；提供 unconditional confirmed Reload取得完整 source/summary/new version，只有其 successful staged commit把 `versionUsable=true`后才可用新 token Retry Delete；不得用 stale version或隐式 LWW retry |
| 404 `PASTE_NOT_FOUND` | missing/logical expiry在 delete dispatch前已确定；current token终止且不 commit pending credential | 进入 terminal not-found/expired local-only state，invalidate/dispose mutation、autosave、autosync和 history，移除 server controls/URLs，保留 exact local source/draft供 copy/download | `delete` failed并显示 not-found；只允许 full refresh或 create new，不 Retry同 document |
| 503、dispatch后的 fetch rejection，或任意 response明确 `mutationMayHaveApplied=true` | execution无法证明，current token转换后立即终止；credential和当前 location不作为成功证明或改写 | 进入 `delete-uncertain` terminal state，invalidate/dispose mutation、autosave、autosync和 history，移除全部 server mutation controls与 representation URLs，保留 exact local source/draft | `delete` failed并明确 outcome uncertain；旧 document不得 blind Retry delete或重启 autosave/sync。user只可 full Reload当前 application URL建立新 document，或 create new |

把 viewOnce开启的 authoritative200或 Reconcile-confirmed response处理前，先 dispose autosave和 autosync，清除 sync timer/candidate，invalidate history和 mutation slot，再结构上切换为独立 `armed-view-once` local-only branch，移除 Edit、History、Settings、server representation URL和 server delete action；它显示 `viewOnce` metadata但不得标成 consumed，下一次 server content read才 consume的事实只在 HelpTrigger。初始 view-once的 `/:id` GET及任何 later content-bearing `viewOnce:true` response已经按第10节 consume，直接按17.8进入 `consumed:true` terminal branch。不得在 armed或 consumed branch上启动任何 server controller。

### 17.11 Persistent operation status

每个 React application page有一个 compact、persistent、non-interruptive `OperationStatus`。ordinary editor同时显示四个独立 record；不适用的页面仍显示 Network和Last action，不伪造 autosave/autosync activity。

| Record | Exact state names | Timestamp storage 与 displayed timestamp |
|---|---|---|
| Autosave | `clean`、`waiting`、`saving`、`saved`、`error`、`password-required`、`not-found`、`conflict` | `confirmedAt`只在 latest local source的authoritative200完成验证时更新；failure state的 `failedAt`是该 attempt settle instant。`saved`显示 confirmedAt；error/password-required/not-found/conflict显示 failedAt；waiting/saving只在既有 confirmedAt存在时显示它；clean不显示 timestamp。initial、reload或 remote apply的 clean不生成 confirmedAt。 |
| Autosync | `waiting`、`checking`、`unchanged`、`remote-applied`、`paused-local`、`paused-offline`、`error`、`forbidden`、`not-found`、`conflict`、`inactive` | 每次实际 state transition记录 `stateChangedAt`；initial waiting不是 transition，值为 null。`checkedAt`只在完整验证的200或304记录，`appliedAt`只在 accepted remote source完成 staged apply后记录。unchanged显示 checkedAt，remote-applied显示 appliedAt，其余 state显示本次 stateChangedAt；不存在对应 instant时不渲染 `<time>`。failure-after-success必须显示 failure的 stateChangedAt，不得继续显示旧 checkedAt。 |
| Network | `online`、`offline`、`degraded` | initial state取 `navigator.onLine`并以 application init instant作为 `changedAt`；之后它是最近一次 browser online/offline event或 fetch network outcome让 state实际改变的 UTC instant。HTTP 4xx/5xx不把 network标成 degraded；degraded后的成功 fetch改回 online并更新时间。 |
| Last action | `idle`、`pending`、`succeeded`、`failed`，另带 closed `ActionKey` | `idle`没有 action key或 timestamp；pending的 `startedAt`是实际 operation invocation/dispatch instant；success/failure的 `settledAt`是已有 request、browser API或 staged apply完成 instant。不存在 timestamp时不渲染 `<time>`。不得记录或显示 password、request body或 protected URL。 |

initial Autosave clean、initial Autosync waiting和 Last action idle都没有 event timestamp，不能用 `Date.now()`、load time、checkedAt或其他 instant填充。所有 later autosync transitions，包括 checking、pause、error、forbidden、not-found、conflict和 inactive，都记录自己的 `stateChangedAt`。

closed union固定为：

```ts
type ActionKey =
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
  | "delete"
```

| Operation family | pending | success/failure settle | reset |
|---|---|---|---|
| create、autosave/manual/retry/overwrite、history fetch、settings/password/reconcile、delete | authoritative request真正 dispatch时；排队或 disabled click不算 | operation的 authoritative transition完整提交后才 success，否则在最终 handled failure settle；password mutation须先按9.4 commit intended credential，Delete须按17.10.5对应 row完成。403 replacement的第一次403是 failure，后续Retry是同 key的新 attempt | 下一次相同 key dispatch，或明确 page transition；delete 204按17.5带到 root后由下一 action/refresh清除 |
| content-reconcile | 绑定原 mutation token的 unconditional GET真正 dispatch时 | non-view-once result在17.10.4证明为 applied、not-applied或 conflict时 success；valid terminal response按下方 terminal settle table在 initial terminal commit settle；403、404、503/network或 malformed为本 attempt failure，retryable reconciliation可用同 key启动新 attempt | 下一次 content-reconcile或 initial terminal commit之后的明确 page transition；产生该 response的 terminal transition不得 reset刚写入的 outcome |
| reload-server | confirmed GET真正 dispatch时 | non-view-once target按 reload guard staged commit时 success；valid terminal response的 definitely-newer、exact-equal、ambiguous/older及 staging failure按下方 terminal settle table；其他 request、guard、invalidation、surface staging或 rollback failure为 failed，不能在 body validation后提前 success | 下一次 reload-server或 initial terminal commit之后的明确 page transition；产生该 response的 terminal transition不得 reset刚写入的 outcome |
| copy | 调用 Clipboard API或 fallback开始时 | Clipboard Promise fulfilled/rejected，或 fallback copy command返回结果时 | 下一次 copy或 page transition |
| download | Blob/object URL准备开始时 | exact UTF-8 payload与download click成功构造/dispatch或 browser API抛错；不声称已写入磁盘 | 下一次 download或 page transition |
| use-remote | 第17.5节独立 entry guard通过并开始 staged apply时；guard拒绝不进入 pending | target generation publish时 success；entry前 local work拒绝、mid-stage invalidation、surface cleanup/restore或 Retry apply failure时 failed | 下一次 use-remote或 page transition |
| use-consumed-response | terminal-local entry guard通过并开始 staged apply时 | terminal display generation publish时 success；token invalidation、surface failure或 rollback fallback时 failed；只 settle本 attempt，不能改写 originating reload/reconcile | 下一次 use-consumed-response或 terminal page transition |
| retry-sync | action接受并建立合法 due时 | timer成功 armed即 succeeded；inactive、terminal或 predicate拒绝时 failed且不发 request | 下一次 retry-sync或 page transition |

完整交付且严格验证的 `viewOnce:true` response采用以下 terminal settle table。`settledAt`一律是 initial terminal display/capability React commit的 instant，而不是 headers到达、body读完、strict validation、token disposal或后续 source-choice instant；message key在 `en`与 `zh-CN` dictionary中表达下列固定含义：

| Origin 与 initial terminal outcome | Last action settle |
|---|---|
| `content-reconcile`保留 current local display，无论 retained consumed source是否不同 | `succeeded`；`content-reconcile-terminal-current-kept`，含义为“Content Reconcile完成，paste已 consumed，保留当前内容”，且不得声称 mutation已证明 applied或 not-applied |
| `reload-server`的 valid `definitely-newer` response完成 auto-selected staged display | `succeeded`；`reload-terminal-response-displayed`，含义为“Reload完成，已显示 consumed response” |
| 上一行的 response staging失效或 surface失败，initial commit改为 current local display与明确 fallback | `failed`；`reload-terminal-response-display-failed`，含义为“paste已 consumed，response无法显示，保留当前内容” |
| `reload-server` response与 current source exact相等，保留 current display且不启动无变化 rebuild | `succeeded`；`reload-terminal-current-unchanged`，含义为“Reload完成，paste已 consumed，当前内容未变化” |
| `reload-server`得到 `definitely-older`、marker-equal divergent、incomparable或 legacy-divergent response，initial commit保留 current display并提供 source choice | `succeeded`；`reload-terminal-current-kept-choice`，含义为“Reload完成，paste已 consumed，已保留当前内容，可选择 consumed response” |
| 上一行之后的 Keep current | 不产生 ActionKey、不更新 `settledAt`或 message；只 dismiss choice，已 settled的 `reload-server`保持不变 |
| initial current display之后的 Use consumed response | 新的 `use-consumed-response` attempt在自己的 staged display commit以 `use-consumed-response-displayed`和自己的 `settledAt`变为 `succeeded`；失败以 `use-consumed-response-display-failed`和实际 failure instant变为 `failed`。两者都不得 resettle `reload-server`或 `content-reconcile` |

terminal reducer必须消费 `terminalOriginSettleContext`并写入上述 terminal outcome；产生该 response的 initial terminal transition不触发 page-transition reset，outcome保持到下一次 action或之后的明确 page transition。不得以 reset、token disposal或 controller cleanup把 pending静默改为 idle。每个 captured `actionAttempt`最多消费一次，任一 terminal branch离开 initial commit时都不能保留该 origin的 `pending`。

HelpTrigger、Sidebar open/close、mode/tab selection、locale、theme、password reveal、Wrap/Unwrap、raw/source toggle、local source-choice的 Keep current和其他 pure React state toggle不进入 ActionKey，也不改 Last action。direct raw/HTML/md/file/create-new anchor navigation和 top-level Blob HTML navigation在 origin document内没有可观察 completion，因此不声明 success/failure，也不进入 ActionKey；representation link copy仍使用 `copy`。background autosync只更新 Autosync/Network，不占 Last action，terminal transition不会为 sync伪造 origin action。

这些 records只从既有 create/read/mutation/browser API request、autosave/autosync controller transition、上述 fallible operation及 browser `online`/`offline` events派生；没有 heartbeat、status-only request或 status timer。全部 state label和实际存在的 timestamp用当前 locale，timestamp以 `<time datetime="RFC3339">`和 `Intl.DateTimeFormat(locale,{dateStyle:"medium",timeStyle:"medium"})`显示，不做每秒 relative-time更新。四个 record共享一个 `aria-live="polite"` status boundary，并对未改变的 record保持 DOM稳定，避免一次事件重复朗读整区；validation blocking error可以另用 `role="alert"`。

只有 union中的 operation拥有 Button outcome。originating Button在 pending时显示动作本身的 pending icon/label，settle后原位显示对应 success或failure icon/label，直到同 key reset；没有 Button的 autosave/history trigger只更新 Last action与其专属 record。icon永远有可见文字或 accessible name，不能单独表达结果。该反馈不发额外 request，不自动消失，不用 Dialog、toast、snackbar或 popup。

### 17.12 i18n 与 theme

所有可见 label、HelpTrigger内容、state、button outcome和 error有 `en`和 `zh-CN`完整 dictionary，keys严格 parity。technical identifiers如 raw、HTML、Markdown、MCP、ID、version不翻译。server初始 locale用 `Accept-Language`第一个 `zh` range选择 `zh-CN`，其余为 `en`；browser以 `navigator.languages`第一个 supported language修正。manual switch立即更新 React tree、document `lang`、title、accessible names、help、state、error和 dates，只存在当前 document，不写 storage。server English error message不是唯一 UI copy。

theme control的 exact preference states为 `system`、`light`、`dark`，初始 `system`并跟随 `matchMedia("(prefers-color-scheme: dark)")`。选择 `system`时持续监听 system变化；选择 light/dark override后本 document不跟随，切回 system立即采用当前 media value。preference不持久化。根元素使用 resolved `data-theme`和 `color-scheme`。两个 resolved theme达到 WCAG 2.2 AA；不改变 `/html/:id` active document。

### 17.13 Responsive、keyboard 与 accessibility

支持发布时 Chrome、Edge、Firefox、Safari各最近两个 major。Playwright bundled Chromium、Firefox和WebKit自动验收是 engine coverage，不得记作 actual branded Chrome、Edge或Safari evidence；Playwright Firefox也不得代替 release-time branded Firefox版本行。每次 release必须另有上述四个产品各恰好两个目标 major的 machine-readable rows和版本证据。Chrome、Edge、Firefox任一 row缺失、failed或 unavailable均阻止 release。只有 actual Safari可在对应 macOS runner确实不可用时记录 `not-available`；该例外不把 Windows称为 Safari运行环境，也不替代任何 manual accessibility category。

Chrome official VersionHistory acquisition以`page_size=1000`顺序读取。每个`nextPageToken`只通过同一base query追加URL-encoded`page_token`，token非空且不得重复。Continuation遇到exact JSON`400 INVALID_ARGUMENT`可在同一URL内最多尝试六次；只有六次全部如此且紧邻的最后成功页`releases.length < 1000`时，才忽略该stale terminal token并以已成功读取的pages结束。Initial page失败、非exact error、非400、malformed body、前页恰有1,000条时的retry exhaustion或successful repeated token均exit nonzero且不写任何campaign文件。失败response不进入`responseCount`或`responseSha256`。`serving.startTime`是Google Timestamp source field：只接受Gregorian UTC`YYYY-MM-DDTHH:mm:ssZ`或小数秒恰为3、6、9位的同形字符串，不接受offset、其他precision或rollover date。Adapter把fraction右补零到9位后用于同一source ID conflict与同version earliest instant比较，再截取前三位生成artifact所需的canonical`YYYY-MM-DDTHH:mm:ss.sssZ`；不得放宽其他artifact timestamp validator。本次acquisition从一个captured`commandNow`只派生一个remaining-duration deadline；Chrome、Edge、Firefox和Safari的全部fetch共享同一timer和AbortSignal，Chrome的全部pages与retries也不得重新获得完整budget。Deadline expiry仍fail closed且不写文件。

Branded capture也从一个`commandNow`派生一个deadline，并保持同一timer和AbortSignal贯穿matrix/source读取、version或signed-PE metadata child、exact Windows browser的1,000 ms launch-settle以及receipt commit；expiry后必须退出且映射的receipt不存在；不能只靠timer callback推断期限，event loop延迟后须用monotonic clock再次检查，永不settle的action也须按deadline拒绝。同一路径capture用exclusive lock覆盖预检、commit和过期清理，并拒绝并发采集；共享AbortSignal下的receipt commit使用同步atomic rename并立即检查deadline，不能留下超时后暴露的receipt或删除另一采集的有效receipt。所有`windows-*` Chrome、Edge和Firefox capture只允许`process.platform === "win32"`，Safari capture只允许`darwin`。Chrome/Edge profile identity为verified binary SHA-256，Firefox current和previous均为exact version；self-test只能把这些profile建在其`mkdtemp` fixture内。Windows exact browser在settle interval内发生delayed `error`或`close`都失败且不得`unref`。`/usr/bin/open -a Safari`只是LaunchServices launcher：它在同一deadline内exit 0即成功，不应用browser-process settle规则。Signed-PE regression必须锁定FileVersionInfo product/version、Authenticode status、SignerCertificate simple name、positive bytes和lowercase SHA-256的实际PowerShell表达式，不能以version-resource company name替代signer identity。

* semantic heading、form、nav、main、article、button和 label；不得用 clickable `div`；每个 input有visible Label，error由 `aria-describedby`或 `aria-errormessage`关联，explanation只由 HelpTrigger关联；
* official Tabs遵守 WAI-ARIA automatic activation，Left/Right、Home/End、roving focus和正常 Tab行为；nested tab groups各自拥有 state，unmount清理；
* Sidebar Sheet和Dialog正确 initial focus、focus trap/containment、Escape、outside policy与 focus return；delete最终动作是明确 Button；
* focus indicator不移除；所有 touch target，包括 icon和 question-mark trigger，至少44×44 CSS px；
* operation feedback用 `aria-live=polite`，blocking validation/error用 `role=alert`且不随每次 keystroke重复；
* diff有 `+`、`-`、space prefix，不只靠颜色；loading有文字 state，不只靠 animation；
* `prefers-reduced-motion: reduce`取消非必要 transition、Sheet/Dialog animation和 status color transition，功能不依赖 motion；
* Crepe失败时 source Textarea和完整 draft仍可键盘操作并可 retry；large diff仍在 worker执行；
* 320 CSS px没有 page-level horizontal overflow，document/editor全宽，Sheet关闭后不留 reserved rail space；
* `@axe-core/playwright` AxeBuilder、keyboard和 focus-order checks不能替代 manual screen-reader、contrast、200% zoom/reflow与 physical-touch smoke。四类 manual evidence各自必须有 date、environment/tool exact version、tester、artifact和 `passed` status；缺失、failed或 unavailable均阻止 release。Safari `not-available` row不豁免其中任何一类，可改用实际可用的平台、辅助技术和物理 touch设备完成，但不得伪造 pass。

本次 2026-09-23 生产交付的后续用户指令允许跳过因设备、环境或系统限制无法执行的验证，并继续部署。当前会话缺少实体 touch 硬件和可核验的实际人工辅助技术操作，因此四类 manual accessibility receipt 均保持缺失，严格 `verify-release-evidence.mjs` 仍应因此返回非零；不得修改状态、冒称已通过或把自动化运行写成手工证据。此处是本次交付的显式例外，不降低后续发布的默认门槛。

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
| autosync active window | load/refresh或最近真实 source/committed IME/settings/password/expiry/title/format/viewOnce user change event后 exact 300,000 ms；dispatch、Retry和 response settle不延长；deadline callback不发 request |
| autosync cadence | eligible开始或前次 settle后 exact 3,000 ms due time；唯一 timer deadline始终为 `min(syncDueAt ?? activeUntil,activeUntil)`，最多1个 timer和1个 in-flight；无 overlap或 immediate retry |
| autosync request ceiling | 无 user activity且 request瞬时完成的单个300,000 ms window最多99次 GET，即 due time 3,000至297,000 ms；真实 request duration只会降低次数，due等于或晚于 deadline不发 request |
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
2. `src/render.test.ts`覆盖最小 React shell、全部 bootstrap discriminated variants、每个 variant的 exact inert source/preview cardinality、HTML/bootstrap escaping、full GFM、raw HTML、dangerous protocol、DOM clobber prefix、title/filename，以及 password不进入 bootstrap。ordinary text/Markdown、consumed preview true/false和 read-only `/md`分别覆盖 missing、duplicate与 unexpected preview/source nodes。删除旧 handwritten workbench exact-string assertions。
3. `src/http.test.ts`使用 `@cloudflare/vitest-plugin`与 `exports.default.fetch()`，通过 public routes验证真实 KV binding、status、headers、media types、migration、consumption和 conditional GET。Cloudflare test依据仍是[Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)与[Vitest 4 migration](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/)。
4. `src/mcp.test.ts`以 modern client pinned `2026-07-28`覆盖 discover、meta/header validation、八 tools、tool error和 SDK stateless legacy fallback。MCP行为不因 React或 browser sync改变。
5. `src/client/autosave.test.ts`保留现有完整 fake-clock suite并加入 acceptedSource acknowledgement；`src/client/paste-sync.test.ts`用同一可注入 fake monotonic clock、controllable promises、fake AbortController和 explicit online/offline events验证第17.7至17.9节每个 transition；mutation coordinator和 history request token另以 controllable responses覆盖第17.10节。不得依赖真实3秒或5分钟 sleep。
6. React component tests直接 mount `App`全部 bootstrap variants，验证 semantic roles、Tabs keyboard、Sheet/Dialog focus、HelpTrigger hover/focus/click/Escape/outside、OperationStatus、closed ActionKey、controller cleanup、staged remote apply fallback、read-only `/md`和 consumed branch exact local capabilities及零 business hooks。mount -> unmount -> mount模拟 StrictMode lifecycle但 production不依赖 StrictMode。
7. `src/build.test.ts`读取 Vite manifest和 production bytes，验证第18节 gzip/raw budgets、initial/lazy reachability、hashed filenames、无 sourcemap、没有 eager Crepe/micromark/diff、无 banned package和 duplicate browser copy；同时按 exact materialized source set检查 pinned provenance comments、`use-mobile.tsx`、pruned `SidebarMenuSkeleton`/`skeleton.tsx`、`THIRD_PARTY_NOTICES.md`及 package exact pins。
8. Playwright必须连接真实 `wrangler dev --local`进程，而不是 mocked page server。Chromium、Firefox、WebKit运行 create、password redirect、ordinary read/edit、所有 React mode refresh、read-only `/md` hard refresh、Crepe、history/diff、settings/password、copy/wrap/download、delete root handoff、view-once local-only、autosync、i18n/theme、keyboard/help和320 px journeys。`test/e2e/accessibility.spec.ts`必须直接使用 `@axe-core/playwright@4.13.0`的 `AxeBuilder`，对 create、password、error、ordinary text、ordinary Markdown、armed-view-once、consumed text、consumed Markdown、not-found、delete-uncertain和 read-only `/md`每个 application branch执行 WCAG 2 A/AA、2.1 A/AA及2.2 AA tags scan并要求零 violations。active HTML test只写 same-origin marker并确认 query visibility，不外发数据。
9. current-two-major matrix指 release时 Chrome、Edge、Firefox、Safari各最近两个 major，四个产品各有恰好两个 target rows。实际 Chrome、Edge和 Firefox必须在预置对应 branded binary的 release runner上运行并记录 runtime exact version；历史 branded binary是 release prerequisite，不由 Playwright download提供。Windows Chrome/Edge从exact executable的signed PE metadata取`ProductName`、`ProductVersion`、valid Authenticode signer、byte length和 SHA-256，不执行GUI binary的`--version`；Firefox保留exact executable direct`--version`。所有Windows branded browser以environment加verified binary SHA-256或observed exact version区分isolated profile，不得handoff到不同target的既有process；spawn后的exact 1,000ms settle interval内出现error/close必须失败且不得写capture receipt。PE path必须是drive-qualified或UNC fully-qualified absolute path，root-relative path不合格。实际 Safari只在预置目标 Safari的macOS runner上运行。bundled Chromium/Firefox/WebKit结果另记为 engine coverage，不能复用为 branded rows。Chrome、Edge、Firefox任一 row缺失或非 `passed`即失败；只有 Safari row可因对应macOS runner unavailable记为 `not-available`，但仍保留 target major/version/source evidence且不得称为pass。四类 manual accessibility rows独立要求全部`passed`。

### 19.2 必测边界与 race

既有 backend边界全部保留：content 0、1、10,485,760、10,485,761 UTF-8 bytes；multibyte/unpaired surrogate/no normalization；password visible ASCII与 query encoding；ID/reserved/case；expiration；history ring；legacy migration；view-once consume ordering；active `/html`；safe `/md`；完整 method/Allow/error/header matrix；`/ip-trace` exact reflection。

新增 release gates如下：

* strong response ETag exact SHA-256/base64url格式、200 bytes变化必变、matching strong/weak/list/`*`得到304、nonmatch 200、malformed ordinary validator 400、304 no body/content headers且 `no-store`；view-once对 valid/malformed validator都忽略并保持 GET consume、HEAD不 consume；`GET|HEAD|POST /api/pastes/:id/read`每个200都带 current-version ETag且不使用 strong validator/304；
* fake clock在 load+2,999 ms无 sync、3,000 ms恰好一个；completion+2,999无 next、+3,000一个；299,999 ms可按 predicate发，300,000 ms精确转 inactive且不得新发。source input、committed composition和每个 settings/password/expiry/title/format/viewOnce user change把 deadline设为其 eventAt+300,000；dispatch、Retry、slow settle不改变 deadline；
* edit取消 waiting timer；compositionstart与 IME intermediate input失效 sync但不延长 active window、不 save/sync，compositionend提交时延长并重新走1,000 ms autosave。slow poll、online recovery、candidate conflict和 Retry的 due晚于 deadline时，唯一 `min(syncDueAt,activeUntil)` timer只执行 inactive transition并清 candidate；
* dirty draft、autosave timer/in-flight/coalesced、settings/password/viewOnce/delete mutation和 remote apply期间零 sync；clean transition后只建立一个3,000 ms timer；
* edit/mutation在 sync in-flight时调用 abort并 invalidates token；old promise随后 resolve的 non-view-once 200不能更改 source、summary、ETag、history、status applied time或再 schedule duplicate；完整 valid `viewOnce:true` 200只允许执行 terminal capability transition并保留两份 exact source，不获 ordinary baseline/cadence authority；并发计数始终最多1；
* 304、200 exact unchanged、definitely older、definitely newer、marker-equal divergent、mixed-marker incomparable、different generation和 legacy divergent逐项比较；只有 definitely-newer自动 apply，其他 divergent response无论重复多少次都只能保留 candidate且任何 surface不变；
* stale G1在已接受G2后连续返回多次仍不能改变 source、summary、markers、ETag或 derived surface；Use remote是未证明 newer candidate的唯一 apply路径，Keep current只 dismiss candidate并恢复普通 conditional cadence，Retry下一次省略 validator；activity/offline/baseline/terminal与 exact active deadline清 candidate；
* apply guard逐来源覆盖：current ordinary autosync必须 token current、active且无 pending local source/mutation；conflict candidate的 Use remote在 candidate造成 `conflict`时仍可通过独立 guard并成功 apply，entry前的 edit、composition、autosave timer/coalesced intent、mutation或 baseline/localGeneration变化必须拒绝且不得 apply stale candidate；confirmed Reload在 inactive window与 dirty conflict均可 staged apply并把 dirty draft保留到 commit；terminal disposal后 source choice只接受独立 `terminalLocalToken`且永不恢复 server operation；
* staged apply在发布 markers/ETag前，把 preview、Crepe与 diff放在 detached/private staging，或先同步清空 affected visible host为 non-current fallback；任何 publish前时刻都没有 old/target derived mixture。注入 mid-stage edit/mutation/deadline invalidation、renderer import/render、Crepe reset、destroy-throw、recreate和 diff worker failure，断言 old generation可 restore或明确保留 old-generation failure fallback，canonical markers不部分推进，autosave和 server history count保持0。Preview、Crepe与 diff分别执行 after-local-edit和 after-mode/host-remount两组 case；每组都启动两个 Retry并让 promise/callback/worker result反序 resolve，另覆盖 remote apply、Reload、consumed source choice及 newer Retry invalidation。每个 publish前必须验证 captured `{localGeneration,currentExactSource,currentDisplayGeneration,hostGeneration,parentApplyGeneration,parentApplyToken,derivedRetryToken}`；stale result只能清理自己的 detached资源，断言 exact draft、canonical source、visible surface、accepted markers、当前 fallback/status均不回退或被清除；
* sync和 autosave各自的200/304/403/404/409/503、network rejection、AbortError、offline -> online路径；验证 stop、normal 3,000 ms retry或 explicit retry，不出现第二 retry loop；changed/no-op autosave acknowledgement都把 acceptedSource设为 inFlightContent，edit-during-save保留独立 draft，随后 equal poll不引用旧 source；
* autosync、explicit Reload或 content reconciliation收到任一完整交付且严格验证的 content-bearing `viewOnce:true` 200时，exact顺序必须是 full body -> digest/schema/identity validation -> terminal flag -> capture current local source与无 sensitive data的 origin settle context -> dispose server token/controller/control/URL -> stage selected source或 current fallback -> initial terminal display/capability commit与 origin settle；current definitely-newer autosync或仍有效的 definitely-newer Reload可通过独立 terminal-local token选择 consumed source，exact-equal保留 current source，older/equal-divergent/incomparable保留 current local与 response两个 exact sources供纯 local选择。分别让 edit、mutation dispatch和 exact deadline retire ordinary sync后再 resolve valid view-once 200，断言仍 terminal且不推进 ordinary baseline；aborted、truncated、digest/schema malformed controls不得转 consumed；之后 business request数为0；
* 用 controllable promises逐项覆盖 content reconciliation terminal response、Reload definitely-newer auto display、Reload exact-equal current retention、Reload ambiguous/older initial current display后 Keep current，以及相同 initial display后 Use consumed response。断言 initial terminal commit以自己的 instant恰好一次写 origin `settledAt`与对应 localized message，terminal branch不保留 pending；Keep current不产生第二次 settle，Use consumed response只 settle自己的 `use-consumed-response` attempt，late origin callback不能 reset或 resettle。background autosync仍只更新 Autosync/Network record，不写 Last action；
* consumed text与Markdown branch逐项操作 copy、wrap、raw/source toggle、safe preview、exact UTF-8 download和 top-level Blob HTML navigation；只有 hashed renderer chunk可请求，DOM中无 Edit/History/Settings/Delete/representation URL，所有 server controllers均 disposed；
* page mutation coordinator以 controllable promises覆盖 autosave versus title/format/expiry/viewOnce/password/delete serialization、single slot、one coalesced source intent和 retired-token反序 response；metadata-only generation/version变化但 source相同不产生 PATCH；
* content autosave、manual save与 Overwrite各自覆盖503、fetch rejection和 `mutationMayHaveApplied`后的单次 authorized unconditional GET reconciliation：response-lost target exact match作为 acknowledgement，main-write/metadata-failure经 server repair后确认，captured full baseline exact match证明未应用并只允许 explicit Retry，第三 snapshot进入 non-destructive conflict，403/404/503/network/view-once按 precedence处理；target等于 baseline的 no-op lost response仍走 target acknowledgement，edit-during-reconcile保留 later exact draft且不 blind retry；
* title/format/viewOnce、expiration和 password逐 family覆盖200、403、404、409、503/network、`mutationMayHaveApplied` true/false及 partial application；field draft保留、summary/version/ETag不猜测推进、Reconcile顺序和 sync pause/resume与17.10 table一致。Delete逐 row覆盖204 root handoff、403 pending credential与 authorized explicit retry、409 stale version不可复用且 Reload取得新 baseline后再 retry、404 terminal not-found，以及503/fetch/may-have-applied的 no-blind-retry `delete-uncertain`；每个 race断言 token、URL credential、Last action、autosave/autosync和 server controls；
* uncertain relative expiration即使 descriptor的 same target seconds相等，也必须在授权后以新 `now`重跑完整7.4 rewrite；注入 current/revision sibling部分 rewrite和 metadata write failure，最终 successful Reconcile后所有存在 keys具有同一 physical expiration及新 normalized `expiresAt`；
* password set/change/clear在 initial 403后以 pending old credential重试时，successful password mutation只 commit intended new password或 null；wrong retry不改 state/URL。覆盖 set、change、clear、hard refresh、duplicate password query normalization及 raw/HTML/md/file representation links；uncertain password reconciliation按 intended new/cleared credential后 request-dispatch authorizing credential顺序，只有 non-password-changing authorized GET可 commit proved pending value，且无 credential进入 DOM/status/application log；
* history list和 snapshot request分别在 remote apply、explicit reload、mutation acknowledgement、consumption和 delete后反序 settle，均因 token/baseline失配被丢弃，不能清空 settled state、替换 selection或对错误 current side计算 diff；
* 403 replacement credential在 non-password-changing autosync/read/mutation取得 authorized 200/304前不改变 URL/state；错误 replacement不变。proof后 unique-query helper去重 query。password set/change/clear retry的 pending value只授权，validated 200分别把 intended `newPassword`或 null交给 helper；Delete 204直接移除 query。hard refresh和 raw/HTML/md/file links对 literal metacharacters仍以最终 committed credential授权；
* `/`、ordinary text default、ordinary Markdown default、password、application error、consumed和 read-only `/md` branch可直接 hard refresh并由 React重建；从 Edit、Markdown source/visual/preview、History或 Settings发起 hard refresh时，按 `format`回到 server-defined default，使用 latest acknowledged source且无 stale state或 duplicate controller；direct `/raw`、`/html`、`/file`不 mount React，`/md` mount React但无 sync/prefetch/API/second content read；
* initial network graph含 React/shadcn shell但不含 Crepe、browser micromark/GFM或 diff；首次对应 action只加载自己的 lazy graph；所有第18节 bundle budget逐项 gate；
* provenance为 exact repository/commit/style/block/CLI，copied/adapted source comment与 `THIRD_PARTY_NOTICES.md`齐全；dependency scan无 Next.js、Vercel runtime、React Router、RSC、auth/query/chart/admin package和第二 backend；
* DOM visible-text scan允许 label/value/metadata/action/validation/error/live state，拒绝 dictionary和 fixture中列出的 explanation、warning、limitation、storage/encoding/size prose及 sample boilerplate；每条此类 copy只能在关闭的 HelpTrigger content中，触发后 keyboard/touch均可达；
* credential scan只豁免 password-bearing representation anchor `href`、明确 clipboard link output和当前 location；bootstrap links、visible text、status、inert data、其他 attributes、application-authored logs和 errors均无 credential，同时不否认允许的 request URL可进入 infrastructure logs。protected/unprotected main、API、raw/html/md/file的 duplicate password query统一400 `AMBIGUOUS_PASSWORD`，一个 wrong/empty protected credential才403；
* OperationStatus四个 records状态名与 timestamp selection准确；initial clean/waiting/idle无 `<time>`，autosync每次后续 transition有 `stateChangedAt`，200/304才有 `checkedAt`，accepted apply才有 `appliedAt`，failure-after-success显示 failure time；remote clean不改变 `confirmedAt`；locale切换只重排显示且 `<time datetime>`不变；
* closed ActionKey只覆盖17.11列出的 request或 fallible browser operation；对应 Button pending/success/failure原位 label/icon与 polite live update。terminal-origin capture只含 action identity与 event time，`content-reconcile`和 `reload-server`在 initial terminal commit按 table恰好一次 settle；Keep current不改写它，`use-consumed-response`只写自己的 attempt，任何 terminal branch无遗留 pending。Help/Sidebar/tab/mode/locale/theme/reveal/wrap/raw-source等 pure toggles及不可观测 navigation不改 Last action；copy/save/sync/network/action feedback无 Dialog、`alert()`、toast、snackbar或 transient popup；只对 destructive confirmation使用 Dialog；
* 320 px Sheet关闭后 document宽度等于 available viewport、page `scrollWidth===clientWidth`，44 px target、focus order、reduced motion、WCAG 2.2 AA contrast和 non-color diff prefixes通过。

### 19.3 完成门槛

以下命令全部 exit 0；Playwright配置负责启动或复用真实 Wrangler local server，不能把 `npx playwright test`改为 static Vite preview：

```powershell
npm ci
npm run build
npx vitest run
npx playwright test
node scripts/verify-release-evidence.mjs
npx wrangler types --check
npx wrangler deploy --dry-run --outdir .wrangler-dist
```

build/test还必须产出可机读 Vite manifest/budget assertion结果，并确认 dry-run `Total Upload`低于64 MiB、`dist/assets`低于第18节8 MiB、artifact没有 source map或 server-bundled duplicate Crepe/micromark/diff。任何 requirement ID、dictionary key、bootstrap variant或 traceability parity failure都阻止完成。所有 Task 18 release gates、legacy removal、final review和clean integration gate通过后，才执行第20.3节的一次真实 production deploy；任何较早 task、candidate或未审核 tree都不得 deploy。

## 20．Wrangler configuration、local smoke 与 production deploy

### 20.1 配置

`wrangler.jsonc` 必须满足以下完整约束：

| 字段 | 固定值或约束 |
|---|---|
| `$schema` | `node_modules/wrangler/config-schema.json` |
| `name` | `cf-pastebin-new` |
| `main` | `src/index.ts` |
| `compatibility_date` | `2026-09-12` |
| `kv_namespaces` | 恰好一个 object，只绑定 `PASTE_DB` 到现有 namespace ID `cd0ebbaba15e486a8e1071bb21e31a9f` |
| `workers_dev` | `false` |
| `preview_urls` | `false` |
| `routes` | 恰好一个 object：`{ "pattern": "b-new.awsl.app", "custom_domain": true, "previews_enabled": false }`；不声明其他 route |
| `assets.directory` | `./dist/assets` |

只声明一个 KV binding和一个 custom domain route。不设置 `nodejs_compat`，因为该 compatibility date 自动启用相应 behavior gate，但仍需在 workerd 中执行所有实际 dependency paths，[Node compatibility 说明](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#get-started)。`workers_dev:false`、`preview_urls:false`和 route-level `previews_enabled:false`必须保持，不能以临时或 fallback `workers.dev` route、preview URL或 preview deployment替代 production custom domain。

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

### 20.3 Production deploy 与线上验收

用户已完成 `npx wrangler@latest login`。只有第19.3节和 Task 18 的 pre-deletion、candidate-final、independent review、integrated-final gates全部通过，final integration worktree clean，且 `worker.js`已经按计划删除后，才从该 exact reviewed commit执行一次：

```powershell
npx wrangler whoami
npx wrangler deploy
```

真实 deploy必须是 `wrangler deploy`创建并立即投入流量的 production deployment，不使用 `wrangler versions upload`、preview alias、preview URL或其他 preview mode。它必须使用第20.1节的 checked-in配置，不传 `--env`、临时 binding、临时 route或 `workers.dev` override。若账号、zone、custom-domain、KV或 deploy权限失败，保留失败输出并停止；不得启用 `workers.dev`、新建替代 namespace或改用另一域名绕过。

Deploy成功后必须针对 `https://b-new.awsl.app`执行独立 production smoke，并记录 status、response contract和 cleanup结果：

1. `/`返回 application shell；以唯一临时 custom ID创建 paste，并验证 main read、edit和最终 delete。
2. 对 password redirect/query行为以及 `/raw/:id`、`/md/:id`、`/html/:id`、`/file/:id`逐项验证授权状态、exact body或 renderer/download contract；HTML fixture只执行无外部副作用的 marker。
3. 对 `/ip-trace`验证 URL、method、body、request headers、`request.cf`、pretty JSON和 wildcard CORS；对 `/mcp`运行 initialize、`tools/list` exact八项和一个可清理的 tool call。
4. 通过 checked-in binding、Cloudflare deployment metadata和指定 namespace ID上的临时 main key读取，确认 `PASTE_DB`实际绑定 `cd0ebbaba15e486a8e1071bb21e31a9f`；KV读取允许按第3节 eventual-consistency边界做有上限的重试。
5. 确认 deploy metadata只列 `b-new.awsl.app` custom domain，`workers_dev`为 false；若能取得账号 subdomain，还要直接请求 `cf-pastebin-new.<subdomain>.workers.dev`并确认它不提供该 Worker。
6. 删除全部临时 paste，确认 canonical read为404，并确认 main、metadata和revision sibling不再保留可读测试数据。

Production smoke失败不允许宣称发布完成。可修复的代码或配置问题回到 owning task先加 RED、review并重跑全部 final gates，再重新 deploy；不得直接在 Cloudflare dashboard产生未记录的配置漂移。项目仍不得 push。

## 21．Requirement-to-acceptance traceability

下表中的验收项都是 release gate，不是建议。

| ID | 冻结需求 | 实现位置 | 可观察验收 |
|---|---|---|---|
| C01 | 只用一个 `PASTE_DB` KV，无其他协调存储 | 3、4、6、20 | Wrangler 仅一个 KV binding；dependency/config scan 无 DO、D1、R2、Queue；KV stale-read test明确允许 duplicate |
| C02 | 第一个授权 content-bearing read 消费；HEAD/OPTIONS/错误不消费 | 10.1、12 | 10.1 所列八个 HTTP content-bearing 操作各测 first 200含 exact content、second 404；MCP `paste_get` 测 first success含 exact content、second `PASTE_NOT_FOUND` tool error；browser/direct OPTIONS 405与准确Allow且零authorization/consume，API `/ip-trace` `/mcp`各自OPTIONS及HEAD/403后仍可成功读取 |
| C03 | render/validate 后 delete，response 前完成 | 10.2 | injected render failure不 delete；delete rejection不含 content；成功事件顺序断言 render < delete < response |
| C04 | view-once content response立即进入不可恢复的 local-only React能力边界 | 10.3、17.4、17.5、17.8、17.10 | copy/wrap/raw-source/safe preview/UTF-8 download/Blob HTML逐项通过；autosync、explicit Reload与 content reconcile的 current及 edit/mutation/deadline-retired valid 200均先移除全部 server controls/URLs/hooks，再以独立 terminal-local token apply或保留两个 exact sources；action-bound response在 initial terminal commit恰好一次 settle origin且无 pending；aborted/malformed control不 terminal，之后除 hashed renderer asset外零 business request；API/MCP在首次 read前仍允许 mutation，history禁止 |
| C05 | custom ID 只做 KV checks，接受 race | 7.2 | fake concurrent negative checks可产生两个 success/last write wins，文案不声称 atomic |
| C06 | delete/expiry 后 custom ID 可复用 | 5.1、7.2 | cleanup 后同 case ID create 201；stale orphan可暂时 409 |
| C07 | legacy main+attached metadata可读，首次 mutation迁移 | 8 | seeded old entry各 representation 200；read不写；mutation生成 sibling/markers且不批量 list |
| C08 | password只在当前 document的 committed/pending page-scoped memory和允许的 URL transport | 9、17.1、17.5、17.10 | storage APIs无写入；403 pending只授权 retry，non-password operation在 authorized 200/304后才 commit proved value，password mutation 200只 commit intended new password或 null，Delete 204直接清除；wrong retry不改 state/URL，unique-query normalization、hard reload及 literal metacharacter representation links通过；unmount清理 |
| C09 | protected direct raw/html/md/file无 query直接403，duplicate query统一400 | 9.3、12.2、19.2 | 四 route missing或单一 wrong/empty query均403；correct 200；protected/unprotected main、API及四 representations的 duplicate都为 `AMBIGUOUS_PASSWORD` 400 |
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
| C25 | 六档+permanent；API四种表达；relative从每次 mutation时重算 | 5.5、6.5、7.4、17.10 | 七 UI options；integer/null/permanent/RFC3339 tests；同 relative第二次保存及 uncertain Reconcile均从新 now计算 normalized `expiresAt`，descriptor equality不作 commit proof |
| C26 | custom ID regex、case-sensitive、reserved、immutable、可复用 | 5.1 | boundary/reserved/case tests；update customId 422；`a`与`A`是不同 keys |
| C27 | English/简体中文，browser language选择，manual switch | 17.12 | navigator zh/en fixtures与 switch；visible/help/status/action全部 dictionary parity |
| C28 | `system`/`light`/`dark` document-only theme | 17.12 | matchMedia变化、三态切换与切回system通过；storage为空；new document重置；不影响 `/html` |
| C29 | 当前四浏览器最近两个 major、responsive/accessibility | 17.13、19 | Playwright三 engine另行通过；actual branded Chrome/Edge/Firefox/Safari各恰好两个 release-time major rows，Chrome/Edge/Firefox全为passed且只有Safari可not-available；320 px Sheet、keyboard、每个application branch的AxeBuilder scan及四类manual rows通过 |
| C30 | Wrangler production name、唯一 binding、仅 custom domain、禁用 workers.dev与preview、final-gate后生产部署 | 20 | config exact name/main/date/assets；只有一个 `PASTE_DB`并绑定 `cd0ebbaba15e486a8e1071bb21e31a9f`；`workers_dev:false`、`preview_urls:false`、唯一 `b-new.awsl.app` custom-domain route且 `previews_enabled:false`；local smoke、types、dry-run先通过；Task 18 final clean integration后只执行 production `wrangler deploy`，production smoke和cleanup通过 |
| C31 | 不保留 legacy API 与 destructive GET | 3、12.2 | method/path contract tests均为404/405且无 KV mutation |
| C32 | protected main GET无 password呈 React input；form POST校验并302到 query | 9.3、17.1、17.4 | GET 200 shell无 content；POST零 field与一个wrong field均403 React inline error；duplicate/unknown field 422；一个correct field 302 Location exact encoded target |
| C33 | HTML JavaScript可读取和外传 query password，用户接受 | 9.3、16.2、22 | browser test确认 `location.search` 可读；无 CSP/sandbox阻止 fetch；风险文档存在 |
| C34 | redirect后 password同时在 URL与 page-scoped memory，请求继续附带 | 9.4、17.1、17.5 | URL query存在；React actions无需再输入；API carrier含 decoded exact password |
| C35 | `/api/pastes/:id/read`全部成功 method保留 current-version ETag，strong validator只属于 resource GET | 12.1、12.5、13.2 | GET、HEAD、POST `/read`均断言 `ETag: "<version>"`且无304；只有 `GET|HEAD /api/pastes/:id`产生/比较 SHA-256 response ETag |
| T01 | 主正文 exact plaintext `key=id`，business metadata sibling | 6 | direct KV断言 main value等于 source，business fields只在 `__cfpb:meta` |
| T02 | 三个 fixed sibling ring slots且同 physical expiry | 6、11 | keys仅 slot 0/1/2；四次 save轮换；list metadata expiration全部相同 |
| T03 | plaintext editor等宽、1秒 autosave、IME、单 in-flight、coalescing | 17.5、17.6 | existing fake-clock suite、React adapter lifecycle与 browser computed font/network concurrency通过 |
| T04 | error/conflict保留 draft，autosave acknowledgement与 content reconciliation共用 exact accepted source | 7.3、17.5、17.6、17.9、17.10 | 403/404/409/413/503/offline后 React draft不变；changed/no-op/edit-during-save 200后 acceptedSource exact；lost response的 target/baseline/third-source reconciliation、partial commit和 edit-during-reconcile逐项通过，equal poll不回看旧值；same content无 KV write/history/version |
| T05 | 标题、drag/drop、copy、wrap、file和delete功能保留 | 12、17.4、17.5、17.10 | real Wrangler browser actions逐项通过；delete只发 DELETE；204先清 sensitive references，再 `replaceState`到 `/`并显示 query-independent root success，refresh不 replay |
| T06 | password覆盖每个 representation/API/history/update/settings/delete/MCP | 5.4、9、12、15 | protected route/tool matrix对 missing/wrong全为403或 tool error，正确值通过 |
| T07 | create不自动打开 | 7.2、17.4 | 201后 location仍为 `/`，无 prefetch/click；view-once main仍存在直到用户选择 link |
| T08 | 修改或 reconcile expiry使全部 related keys采用同 physical expiration | 6.5、7.4、17.10 | active history 0..3情况下 extension/shorten/permanent的 key expiration深相等；same relative seconds、partial sibling rewrite和 metadata-write failure后，successful Reconcile以新 expiresAt重写全部 keys且 physical expiration一致 |
| T09 | UI与 API不返回 stored plaintext password，只保留冻结的 explicit transport例外 | 9.2、9.3、12.3、17.1、17.5、17.11 | scan只豁免 representation anchor `href`、explicit clipboard link和 current location；bootstrap links、visible text、status、inert data、unrelated attributes、application logs/errors无 password；允许的 request URL仍可能进入 infrastructure logs；literal metacharacters正确编码 |
| T10 | local smoke 与 TDD | 19、20 | 所列 commands、real Wrangler conditional smoke和 browser journeys全部通过 |
| T11 | content、content-independent mutation与 Delete的 uncertain/proven结果有 deterministic recovery | 7.3、7.4、7.5、9.4、17.10 | content save/manual/Overwrite覆盖target/baseline/third source、403/404/503/network/view-once，terminal reconcile在 token disposal前保留 origin settle context并于 initial terminal commit恰好一次结束；title/format/viewOnce、expiry、password覆盖403/404/409/503/network/may-have-applied；password retry precedence和 relative full rewrite通过；Delete 204/403/409/404/503/fetch/may-have-applied逐 row断言 token、credential/URL、Last action、controllers与 server controls |
| SY01 | 单 KV约束下无 true non-polling equivalent，明确使用 direct browser polling | 3、17.7、22 | dependency/route/runtime scan无 SSE、WebSocket、long poll、Web Push、Event Subscription、service binding/RPC、Cache sync；requests由 browser timer直接发起 |
| SY02 | sync只在 ordinary controlled `/:id` page运行 | 17.1、17.4、17.7、17.10 | `/`、password/error、consumed view-once及 `/raw`、`/html`、`/file`、API/MCP caller均零 sync；`/md`由React渲染但无 autosync/autosave/prefetch/API/second content read |
| SY03 | active window只由 load或真实 user activity确定，exact deadline和 eligible cadence各自受一个 timer控制 | 17.7、18、19.2 | fake clock覆盖2,999/3,000、299,999/300,000、slow settle/online/candidate/Retry due越界；dispatch/retry不延长，deadline清 candidate且不发 request，99-request ceiling保持 |
| SY04 | edit/IME/draft/autosave/mutation suspend sync；in-flight abort/invalidates；无 overlap | 17.7、17.8、19.2 | controllable promise race证明 abort被调用、old non-view-once response零 state effect、完整 valid view-once仅执行 terminal precedence且不推进 ordinary baseline，timer/fetch concurrency各不超过1 |
| SY05 | 复用 resource GET的 standard conditional read与 no-store | 12.1、12.5、13、20 | strong SHA-256 ETag、If-None-Match list/weak/`*`/malformed、200/304/HEAD/OPTIONS/Allow/no-body/no-store全部通过；无新 endpoint |
| SY06 | view-once忽略 validator并保留 consume-on-body | 10、12.1 | valid或malformed `If-None-Match`的 authorized GET仍200并 consume；HEAD不 consume；无304 |
| SY07 | ordering markers、localGeneration和 exact source只允许 guarded proven-newer autosync自动 apply | 17.5、17.8、19.2 | fixtures覆盖 older/newer/equal/incomparable/different-generation/legacy；每个 current、active且无 local work的 definitely-newer autosync staged apply，失效 capture不改 accepted surface；confirmed Reload可在 dirty/inactive下按独立 guard应用 user-selected body |
| SY08 | divergent response只产生 non-destructive candidate，重复 stale response不构成 freshness | 17.5、17.8、19.2 | 已接受G2后重复G1与 repeated marker-equal/incomparable均零 surface change；Use remote在 `conflict`中使用独立 guard并原子保留 candidate进入 staging，candidate -> success及 edit/mutation-before-entry rejection通过；Keep current只 dismiss，Retry/expiry/activity规则精确 |
| SY09 | staged apply按一个 observable generation更新、restore或 invalidate每个 mounted surface且不 autosave | 17.5、17.8、19.2 | read/plain/Markdown visual-source-preview/summary/diff只在 atomic commit发布 target或 target-bound fallback；offscreen/clear-before-stage、mid-stage invalidation、Crepe destroy-throw及 renderer/diff failure均 restore old generation或明确 old-generation fallback；Preview/Crepe/diff Retry各自在 local edit后与 host remount后反序 resolve并逐项核对 `{localGeneration,currentExactSource,currentDisplayGeneration,hostGeneration,parentApplyGeneration,parentApplyToken,derivedRetryToken}`，stale result不改 draft、canonical/visible source、accepted markers或 fallback/status；save/history mutation count为0 |
| SY10 | sync明确处理200/304/403/404/409/503/network/offline及 terminal view-once precedence | 17.8、17.9、19.2 | 每种 response/event保留必要 exact source；完整 valid view-once 200即使被 edit/mutation/deadline retire仍 terminal但不获 ordinary baseline authority，aborted/malformed不 terminal；其他结果按 frozen stop、normal retry或 explicit retry转换，credential按9.4 precedence commit，无 modal/toast/status-only request |
| SY11 | 全部 page mutation共享一个 authoritative slot，uncertain content保留原 baseline token做 reconciliation | 17.6、17.10、19.2 | autosave versus settings/password/delete controllable promises证明 strict serialization、retired response不回退、最多一个 coalesced source intent；content reconciliation GET绑定原 token、target、captured baseline与 later draft，metadata-only advancement不触发 content PATCH |
| SY12 | history list/snapshot response绑定 accepted generation/version/contentRevision/source | 17.5、17.10、19.2 | remote apply、reload、mutation ack、consume、delete后的 late list/snapshot均被丢弃，不能清空 settled state、替换 selection或使用错误 current side |
| FE01 | React 19.3.0与 pinned shadcn `new-york-v4/sidebar-11`完全拥有可见 application UI | 4.1、4.2、16.3、17.1、17.2 | create/paste/password/error及 read-only `/md`均由 `createRoot` render；server shell无 visible controls/wrapper；source/provenance pin exact |
| FE02 | Vite 8.3.0 static client与 exact dependency pins，无 banned stack | 3、4.1、4.2、18 | manifest/lockfile exact；无 Next/Vercel runtime/Router/RSC/auth/query/chart/admin/second backend；all bundle gates通过 |
| FE03 | shell保留 variant-specific inert bootstrap/source/safe preview、CSP和 hashed external assets | 4.2、16.5、17.1 | ordinary/consumed/markdown的 discriminator与 preview cardinality逐项验证 missing/duplicate/unexpected；source mount前 exact decode，bootstrap无 password/content，inline executable为0，`/md`无第二 read，`/html` exception不变 |
| FE04 | old visible DOM/CSS/controller与 tabs candidate superseded | 4.2、19 | old `src/client/app.ts`、`src/client/styles.css`和 duplicate binders不存在；`bfaac29` chain未集成；React tests保留可观察 tabs keyboard cases |
| FE05 | `sidebar-11`只适配 paste Document Workbench，320 px使用 Sheet和 full-width editor | 17.2、17.13 | sample/static boilerplate为0；320 px无 page overflow或 reserved rail；no gradient/glass/decorative cards/external fonts |
| FE06 | 所有 explanation/warning/limitation只在 accessible question-mark help | 17.3、19.2 | closed-page visible text scan无 banned prose；hover/focus/click/touch/Escape/outside/name/relationship和不依赖 help的 form journey通过 |
| FE07 | 常驻 OperationStatus分开 autosave、autosync、network、last-action并只显示对应真实 event time | 17.11 | initial clean/waiting/idle无 timestamp；stateChangedAt/checkedAt/appliedAt/confirmedAt等选择准确，failure-after-success显示 failure time，remote clean不改 confirmedAt；localized `<time>`与 polite incremental announcement通过 |
| FE08 | closed ActionKey的 fallible operation有原位持久反馈，pure toggle与不可观测 navigation无伪 outcome | 17.3、17.11 | union/dictionary exhaustiveness含 content-reconcile与 use-consumed-response；non-terminal Reload/Use remote及 terminal local apply按各自 commit settle，valid terminal Reload/Reconcile在 initial terminal commit以对应 localized message恰好一次结束且无 pending；Keep current不 resettle，Use consumed response只写自己的 action；Help/Sidebar/tab/locale/theme/reveal/wrap等不改 Last action；无额外 request或 popup feedback |
| FE09 | en/zh-CN、document-only theme、reduced motion、WCAG 2.2 AA与 current-two-major matrix | 17.12、17.13、19 | dictionary parity、lang/title/date、storage空、contrast/focus/44 px/reflow、Playwright engines、branch-complete AxeBuilder scans、四类manual passed evidence及actual branded browser 8-row matrix通过 |
| FE10 | exact materialized template/dependency source set履行 license/notice义务 | 4.1、4.2、19 | adapted source和 pinned `apps/v4/registry/new-york-v4/hooks/use-mobile.tsx` provenance准确；`SidebarMenuSkeleton`与 `skeleton.tsx`不存在；`THIRD_PARTY_NOTICES.md` source set、shadcn MIT、direct MIT/ISC、Apache-2.0及 upstream NOTICE完整 |

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
17. **Autosync ordering uncertainty**：version、contentRevision、updatedAt、generation和 source comparison只允许 proven-newer response自动 apply。并发 writers可产生相等或不可比较 markers；这些 response无论重复多少次都只保留 explicit candidate，不能建立 global total order或恢复被覆盖内容。
18. **Remote view-once transition**：ordinary page发出 resource GET后，另一 client已把 paste改为 view-once时，该 GET会按 frozen consume-on-body contract消费。response到达后 page先永久移除 server能力并转 local-only；ordering不确定时只允许在内存中的两个 exact sources间选择，没有额外 metadata probe可消除该 race。

以上风险是选定单 KV、plaintext credential、same-origin executable HTML、direct browser polling与无账户模型的直接结果。实现不得用未获批准的第二存储、token、sandbox、application CSP、push service、Cache或 rate limit暗中改变这些产品决策。
