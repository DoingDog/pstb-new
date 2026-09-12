# Cloudflare Pastebin 完整重写设计规格

日期：2026-09-12

状态：产品决策已冻结，可直接据此编写实施计划与测试。

## 1．决策优先级与术语

本规格按以下优先级解释需求：`requirements-clarifications.md` 中 2026-09-12 的用户确认与追加澄清最高，其次是原始任务，再次是[基础研究](../../research/2026-09-12-cloudflare-pastebin-foundations.md)，最后才是旧实现行为。发生冲突时，本规格已经采用更高优先级结论，不得在实现阶段重新选择。

本文中的 paste 指一条正文及其同代 metadata 和最多三个历史正文。content-bearing read 指成功返回当前正文或由当前正文生成的表示形式的请求。管理请求即使读取 KV 正文以完成校验，只要响应不含正文，就不属于 content-bearing read。

时间一律使用 UTC。对外时间是带毫秒并以 `Z` 结尾的 RFC3339 字符串，例如 `2026-09-12T08:30:00.000Z`。内部 Unix expiration 使用整数秒。

## 2．目标

1. 用 ES module Cloudflare Worker 完整替换旧 `worker.js`，保留创建、查看、raw、HTML、文件下载、标题、有效期、拖放、复制、换行、编辑和删除能力，但只提供本规格定义的 canonical routes。
2. 正文始终以 `key=<id>` 的精确 plaintext value 存在唯一的 `PASTE_DB` KV namespace 中。
3. 在同一 namespace 的 sibling keys 中实现 plaintext password、view-once、可修改 settings 和三个 prior revisions。
4. 提供普通文本编辑与 Milkdown Crepe Markdown visual/source/preview 编辑，正文仍只有一份 canonical source。
5. 提供 1 秒防抖、单 in-flight、可处理冲突且不丢草稿的 autosave。
6. 只提供现代 canonical HTTP API，并提供 MCP `2026-07-28` 与 SDK stateless legacy fallback。
7. 提供 `/ip-trace`，精确反射 `aioapi.js` 根端点所列字段。
8. 在英文与简体中文、light 与 dark、桌面与移动设备、键盘与辅助技术下完成可用界面。
9. 使用 TDD，通过 Workers Vitest、Wrangler 本地 smoke 和 Wrangler dry-run 验证。

## 3．明确不做

1. 不使用 Durable Object、D1、R2、第二个 KV namespace、Queue、锁服务或任何其他持久化协调服务。
2. 不增加 account、owner token、session、cookie、全局 MCP token、rate limit、CAPTCHA、内容审核、报表、备份或审计日志。
3. 不保留 `GET|POST /api` 创建接口、旧 response shape、`GET /delete/:id` 或任何 destructive GET。
4. 不提供 binary paste。输入是有效 Unicode scalar sequence，KV 中保存其 UTF-8 表示。
5. 不把 `format` 当作访问限制或内容类型约束。
6. 不对 `/html/:id` 使用 sandbox、sanitizer、CSP 或 script 限制。
7. 不提供超过三个 prior revisions，不保存 settings snapshot，也不把当前正文算入 history。
8. 不提供跨地域严格一次消费或 custom ID 原子预留。Workers KV 不支持这些保证，[Cloudflare 明确说明 KV 是 eventual consistency 且不适合原子 read/write transaction](https://developers.cloudflare.com/kv/concepts/how-kv-works/)。
9. 不引入 React、Vue 应用层、Vite SPA、client router、服务端 session 或通用 repository interface。

## 4．选定架构

### 4.1 运行形态

Worker 使用一个 ES module entry，导出 `export default { fetch }`。binding 只通过 `env.PASTE_DB` 取得。Cloudflare 对 module Worker、compatibility date、bundle 和运行限制的依据见[基础研究](../../research/2026-09-12-cloudflare-pastebin-foundations.md#1-cloudflare-worker-runtime-and-deployment)。

HTTP 路由和 server-rendered application HTML 使用 `hono@4` 与 `hono/html`。Markdown 服务端渲染使用 `micromark@4.0.2` 和 `micromark-extension-gfm@3`。visual editor 固定使用 `@milkdown/crepe@7.22.1`。unified line diff 使用 `diff@8.0.2` 的 `diffLines`。MCP 使用稳定的 `@modelcontextprotocol/server@2` 和 `zod@^4.2.0`。所有实际解析版本由 `package-lock.json` 固定。

浏览器代码用 `esbuild` 输出 ESM 与 hashed assets。普通页面只加载小型 `app` bundle；初始 read 与 source mode 不加载 Crepe，首次进入 visual mode 才加载 Crepe，首次进入 preview mode 才加载 micromark browser renderer，首次请求 history diff 才加载 diff worker。Wrangler static assets 只承载构建产物，不是业务存储，不改变唯一业务 binding `PASTE_DB`。

### 4.2 最小模块边界

| 文件 | 唯一职责 |
|---|---|
| `src/index.ts` | ES module entry；先分流 `/mcp`，其余交给 Hono；注入 `env`。 |
| `src/http.ts` | 注册 canonical HTTP routes、解析 media type、调用 paste service、映射 HTTP response 和 error。 |
| `src/pastes.ts` | ID、password、expiration、version、KV key grammar、legacy migration、history ring、read、mutation 和 delete 的全部领域规则。不得从其他模块直接访问 `PASTE_DB`。 |
| `src/render.ts` | application page templates、错误页、safe Markdown boundary、bootstrap JSON escaping。 |
| `src/mcp.ts` | 每个请求创建 `McpServer`，注册八个 tools，并把 paste service 结果映射为 MCP result。 |
| `src/client/app.ts` | locale、theme、页面动作、password module variable、普通文本编辑、autosave state machine。 |
| `src/client/markdown.ts` | lazy-load Crepe、visual/source/preview 同步和 client Markdown preview。 |
| `src/client/diff.ts` | lazy-load `diffLines`，在 Web Worker 中生成 unified line diff。 |

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

browser API GET 使用 query，JSON mutation 使用 body。browser 从 URL 取得 password 后把 decoded string 放在当前 document 的 module variable `pastePassword` 中；它非 null 时由每次 request 显式带上，null 时省略整个 credential field/query。不得写入 cookie、`localStorage`、`sessionStorage`、IndexedDB 或 `window.name`。

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

password set/change 成功后，`pastePassword` 立即改为新值，并用 `history.replaceState` 将当前 application page 的唯一 password query 更新为新值。clear 成功后 module variable 设为 null，并移除该 query。不得 reload。其他 representation links 每次从当前 module variable 新建，不缓存旧 URL。

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

创建 view-once paste 后，create page 只显示链接和一次性警告，不自动 navigate。

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
11. 只有打开 History tab 才 fetch list，只有选择 revision 才 fetch full snapshot。任一 side 超过 1 MiB UTF-8 或 50,000 lines 时不自动计算 diff，显示明确大小提示和“Compute diff”按钮；点击后才在 Web Worker 运行 `diffLines`。小于等于阈值时选择后自动计算。
12. diff line 通过 text nodes 输出，保留 newline marker；addition、deletion 与 unchanged 除颜色外还显示 `+`、`-`、空格前缀。不得把 snapshot 传给 `innerHTML`。

## 12．HTTP contract

### 12.1 通用规则

* URL path ID 只接受单 segment。额外 slash、空 segment 或 percent-decoded slash 不匹配资源 route。
* JSON request 必须是 `Content-Type: application/json`，允许 `charset=utf-8`。JSON object unknown fields、duplicate JSON keys、wrong primitive type均返回 422。实现使用保留 duplicate-key 信息的 parser 或在 parse 前检测 duplicate keys，不能让后值静默覆盖 credential 或 version。
* `multipart/form-data` 只用于 create。每个命名 field 必须恰好出现一次，未声明 field 返回 422。
* API JSON 与 MCP HTTP request wire body 上限 64 MiB；已知 `Content-Length` 先检查，未知长度由 counting stream 检查。content 解码后仍执行 10 MiB 限制。
* dynamic application、API 和 representation response 使用 `Cache-Control: no-store`。assets 使用 hashed filename 与 `Cache-Control: public, max-age=31536000, immutable`。
* API success/error 为 `application/json; charset=utf-8`。application pages 为 `text/html; charset=utf-8`。除 `/html/:id` 外的 browser HTML response 增加 `X-Content-Type-Options: nosniff`。
* 注册 route 的 unsupported method 返回 405 并带准确 `Allow`。不存在 route 返回 404。
* 每个 GET route 都显式支持 HEAD。HEAD 执行 existence、schema、expiry 与 password 校验并返回同 GET 的 status 和 representation headers，但不生成或返回正文、不消费 view-once。OPTIONS 不校验 password、不消费。
* 除 `/ip-trace` 外不发送 wildcard CORS。API 是 same-origin browser API，curl 不受 CORS 限制。

### 12.2 Browser 与 representation route matrix

| Route | Methods | Request | Success | 消费 | 主要非成功状态 |
|---|---|---|---|---|---|
| `/` | `GET`,`HEAD` | 无 | 200 create page，HEAD 无 body | 否 | 405；旧 `POST /` 不创建 |
| `/:id` | `GET`,`HEAD` | optional unique `password` query | 200 application view；protected 且 query absent 时为 password input page | 仅成功含正文的 GET | 400 duplicate query；403 wrong；404 missing/expired；503 incoherent |
| `/:id` | `POST` | `application/x-www-form-urlencoded`，唯一 `password` | 302 到同路径的 encoded query | 否 | 403 missing/wrong；404；415；422 duplicate/invalid form |
| `/raw/:id` | `GET`,`HEAD` | protected 时必须 unique query password | 200 exact source，`text/plain; charset=utf-8` | GET | 400、403、404、503 |
| `/html/:id` | `GET`,`HEAD` | protected 时必须 unique query password | 200 exact source，`text/html; charset=utf-8` | GET | 400、403、404、503；错误 body 是 `text/plain` |
| `/md/:id` | `GET`,`HEAD` | protected 时必须 unique query password | 200 safe rendered application document，`text/html; charset=utf-8` | GET | 400、403、404、500 render failure、503 |
| `/file/:id` | `GET`,`HEAD` | protected 时必须 unique query password | 200 exact UTF-8 bytes，`application/octet-stream` | GET | 400、403、404、503 |
| `/assets/<hash>.*` | `GET`,`HEAD` | 无 | 200 static asset | 否 | 404、405 |
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
| `/api/pastes/:id` | `GET`,`HEAD` | 200 `PasteResource`，HEAD 无 body | GET 是 | password 取 query/header；GET view-once 会消费 |
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

API OPTIONS 返回 204 和准确 `Allow`，不发送 `Access-Control-Allow-Origin`。所有 success resource response 带当前 `ETag: "<version>"`。mutation 的普通失败状态为 400、403、404、409、413、415、422、503。

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
| 400 | `BAD_REQUEST` | malformed JSON、invalid UTF-8、path/query syntax | 无 |
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

不使用 401 或 429。HTML application route 对相同状态渲染本地化 error page；direct raw/html/md/file error 使用 `text/plain; charset=utf-8` 和简短英文，不返回 JSON 或 stored content。

### 13.2 Response headers

| 响应类别 | 必须 headers |
|---|---|
| API JSON | `Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`；有 resource 时 `ETag` |
| application HTML | `Content-Type: text/html; charset=utf-8`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、本规格 16.5 的 CSP |
| raw | `Content-Type: text/plain; charset=utf-8`、`Cache-Control: no-store` |
| user HTML | `Content-Type: text/html; charset=utf-8`、`Cache-Control: no-store`；不得发送 CSP、sandbox header 或 application `Referrer-Policy` |
| Markdown HTML | application HTML headers |
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

`/raw` 和 raw/source API/MCP result 不解释 content。application DOM 只通过 textarea value 或 `textContent` 显示。`/file` 输出 source 的 UTF-8 bytes，不基于 `format` 修改 extension 或内容。

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

只有该固定 renderer 的 output 可传给 `hono/html` 的 `raw()`。stored source、title、error 和 bootstrap data 绝不能直接传 `raw()`。client preview 使用相同版本、相同 options 和 extensions，server response 仍是最终 canonical preview。

`/md/:id` 是 application-owned wrapper，不是 user HTML。它包含 semantic article、title、copy/open source actions和 safe rendered fragment，不执行 source 内的 HTML/script。

### 16.4 Milkdown canonical source rule

Markdown source 是唯一 canonical content。Crepe 的 Markdown -> AST/ProseMirror -> Markdown round trip 可能 normalize whitespace 或 syntax，[Milkdown architecture](https://github.com/Milkdown/website/blob/main/docs/guide/architecture-overview.md#markdown-transformation)。规则固定为：

1. 进入 visual mode 前保留 exact source snapshot，设置 `visualDirty=false`，显示一次当前 document 内的 normalization notice。
2. 仅 mode switch、focus、selection 或 Crepe 初始化不得调用 autosave，不得用 serializer output 覆盖 snapshot。
3. 只有 Crepe 的真实 document-change transaction 才设置 `visualDirty=true` 并触发 input timestamp。
4. 离开 visual mode 时，`visualDirty=false` 就恢复原 snapshot；为 true 才以 `getMarkdown()` 的结果更新 draft，并按 autosave state machine 保存。
5. source mode textarea 直接编辑 canonical string。preview mode只读当前 draft，不改变 draft。
6. Crepe load/initialize 失败时保留 source textarea 和完整 draft，显示可重试错误，不阻止 plain Markdown 编辑。

### 16.5 Application CSP

只对 `/`、`/:id`、password/error application pages 和 `/md/:id` 设置：

```plaintext
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
```

`'unsafe-inline'` 只为 Milkdown runtime style attributes，不允许 inline script。bootstrap 是 `application/json` data node并把 `<`、`>`、`&`、U+2028、U+2029 escape；所有 executable script 来自 hashed same-origin assets。该 CSP 不应用于 `/html/:id`。

## 17．Frontend 规格

### 17.1 Create page

页面包含：

* labeled content textarea；
* title；
* `format` 的 text/markdown control；
* 七档 expiration select；
* password input，可 reveal/hide；
* view-once checkbox 与明确并发限制说明；
* optional custom ID；
* Create button；
* locale 与 theme switches。

拖放只取第一个 item。file 时用 `File.text()` 以 UTF-8 解码；解码产生 replacement character 时仍是浏览器得到的 text，server 保存该 string。把 filename 写入 title，超出 title 规则时 client 显示错误而不截断。纯文字拖放写入 content。client 先检查 UTF-8 bytes，server 再权威校验。

submit 使用 `POST /api/pastes` JSON；接近 body envelope 或含大量 JSON escape 的 draft 改用 multipart，不改变字段语义。loading 时 disable repeated submit。201 后停留在 create document，显示 ID、summary、clean links 与 copy buttons；client 用当前 password module value为可点击 representation links添加 query。view-once 显示“打开任一表示形式会消费，其他链接随后失效”。不自动 click、prefetch 或 navigate。

### 17.2 Main view page

* `format=text` 默认 plain read view；`format=markdown` 默认 safe preview。
* ordinary paste 提供 View、Edit、Markdown、History、Settings tabs，以及 raw、html、md、file、copy、wrap、create new、delete actions。
* 任意 paste 都能进入 plaintext edit、Markdown visual/source/preview，以及全部 representations；format 只影响默认 tab。
* plaintext editor 使用 system monospace stack、保留 whitespace、关闭 spellcheck 默认值，并有 Wrap/Unwrap。read view也支持 wrap。
* copy 使用 `navigator.clipboard.writeText`；permission 或 API 失败时使用隐藏 textarea selection fallback。结果在 `aria-live` 区域报告，不移除 action。
* delete 使用 accessible confirmation dialog，确认后调用 `DELETE /api/pastes/:id`。成功后清空 document 中的 content/password references并 navigate `/`，显示 deleted query-independent notice。
* protected page启动时从唯一 query 读取 password 到 `let pastePassword`。所有应用内 representation URLs 重新 percent-encode 它。不得把 password 放进 bootstrap JSON。

### 17.3 Autosave state machine

状态为 `clean`、`waiting`、`saving`、`saved`、`error`、`conflict`。`clean` 只表示初始加载后尚无本地修改，`saved` 表示最近一次 save 已确认且当前 draft 与确认内容相同；两者都没有 pending timer。数据至少包括 `draft`、`lastSavedContent`、`version`、`lastInputAt`、`dueAt`、`inFlightContent`、`dirtyWhileSaving`。

1. 初始 state 为 `clean`，`draft=lastSavedContent=server content`，`version=server version`，`inFlightContent=null`，`dirtyWhileSaving=false`。
2. 普通 `input` 更新 draft，并设置 `lastInputAt=now`、`dueAt=now+1000`。无 in-flight 时进入 `waiting`，并用一个指向该 `dueAt` 的 timer 替换旧 timer；有 in-flight 时保持 `saving`，按第 5 步处理。
3. `compositionstart` 取消 pending timer 但保留 draft；composition 期间的 intermediate input 更新 textarea 与 draft，但不更新 `lastInputAt`、`dueAt` 或发送 request。`compositionend` 把最终 value 当作一次普通 input，并从该时刻完整等待 1,000 ms。
4. timer 到 `dueAt` 时先清除自身。若 draft 等于 `lastSavedContent`，不发送并进入 `saved`。否则仅当 `inFlightContent=null` 且 state 不是 `conflict` 时，按顺序设置 `inFlightContent=draft`、`dirtyWhileSaving=false`、state=`saving`，然后发一个 `PATCH /api/pastes/:id`。body 固定含 `{content:inFlightContent,version}`；仅当 `pastePassword !== null` 时再加入 `password:pastePassword`。
5. 任一时刻最多一个 request。saving 时的新 input 仍按第 2 步更新 draft、`lastInputAt` 与 `dueAt`，设置 `dirtyWhileSaving=true`，但不启动可在 in-flight 完成前发送的第二个 request。
6. 收到 200 changed 或 no-op 时，先把 `lastSavedContent` 设为该 request 的 `inFlightContent`，把 `version` 设为 response version，再清空 `inFlightContent` 与 `dirtyWhileSaving`。如果此时 draft 等于 `lastSavedContent`，清除 timer 并进入 `saved`；否则进入 `waiting`，在 `max(0, dueAt-now)` 后发送唯一一次 coalesced latest draft，不发送中间值。
7. network、413、422、500 或 503 清空 in-flight 标记与 timer，但保留 draft、`lastSavedContent` 和 version，进入 `error`，不自动 retry。用户可 Retry、copy 或 download draft；下一次新 input 按第 2 步重新进入 `waiting`。
8. 403 同样清空 in-flight 标记与 timer并保留全部 draft state，然后显示 password re-entry。新 password 只改 module variable；用户显式 Retry 后才立即发送当前 latest draft。
9. 404 清空 in-flight 标记与 timer，保留 draft，停止 autosave并提供 copy/download，不尝试重建同 ID。
10. 409 version conflict 清空 in-flight 标记与 timer，保留 draft并进入 `conflict`。显示 Reload server、Overwrite with draft、Copy draft。Reload 在确认后重新 GET，用 server content/version 同时替换 draft、`lastSavedContent` 和 version并进入 `clean`；Overwrite 立即发送 latest draft且明确省略 version以执行 last-write-wins。Overwrite 成功后按第 6 步处理；没有自动 merge。
11. `error` 或 403 状态的显式 Retry 仅在无 in-flight 且 draft 与 `lastSavedContent` 不同时立即发送 latest draft，使用当前 password 与 version，并执行第 4 步相同的 snapshot 和 state 更新。Retry 失败仍按对应状态规则处理。
12. draft 与 `lastSavedContent` 不同或 request in-flight 时注册 `beforeunload` warning；二者相同且无 in-flight 时移除。
13. server exact no-op detection 是最终依据，client comparison 只用于避免 request。

### 17.4 History UI

desktop 为左 revision list、右 detail；mobile 先 list，选择后进入 detail并提供 Back。detail 有 Unified diff 与 Full snapshot tabs。默认 Unified diff，比较 selected -> current。list 与 snapshot 按第 11 节 lazy load。diff worker 返回结构化 lines，main thread 用 text nodes渲染。

loading、empty、403、404、409 view-once、503 和 revision partial corruption 都有独立状态。失败不清空已加载 current draft。

### 17.5 Settings 与 view-once UI

Settings 包含 title、default format、expiration、view-once、password change/clear 与 immutable ID。每组单独 mutation，不把 content 合并。relative expiration 显示“从保存 settings 的时刻重新开始”。成功后更新 version 与 displayed expiry，不创建 history。

把 viewOnce 开启成功后，立即隐藏 Edit、History、Settings 和 delete server action，只保留当前已加载 content 的 local actions；下一次 server content read 才消费。初始就是 view-once 的 `/:id` response 已完成消费，直接渲染 restricted page。

### 17.6 i18n

所有界面文案有 `en` 和 `zh-CN` 两套完整 dictionary，technical identifiers 如 raw、HTML、Markdown、MCP、ID、version 不翻译。server 初始 locale 用 `Accept-Language` 中第一个 `zh` language range 选择 `zh-CN`，其余为 `en`；browser load 后以 `navigator.languages` 的第一个 supported language 修正。manual switch 立即更新 document `lang`、labels、status、errors、dates 和 controls，只存在当前 document，不写 storage。

日期使用 `Intl.DateTimeFormat(locale, {dateStyle:"medium",timeStyle:"medium"})`，DOM 的 `<time datetime>` 保留 RFC3339。server error code 到 locale message 的 mapping 在 client dictionary 中，不把 server English message 当唯一说明。

### 17.7 Theme

初始 theme 跟随 `matchMedia("(prefers-color-scheme: dark)")`。document 内 switch 可设 light/dark override；不持久化。未 override 时监听系统变化，override 后本 document 不跟随变化。根元素使用 `data-theme` 与 `color-scheme`。两个 theme 都达到 WCAG 2.2 AA normal-text contrast。

### 17.8 Responsive 与 accessibility

支持发布时 Chrome、Edge、Firefox、Safari 最近两个 major。验收覆盖 Chromium、Firefox 和 WebKit，另在当前 stable Edge 与 Safari 做 smoke。

* semantic headings、form、nav、main、article、button 和 label；不得用 clickable `div`。
* 所有 input 有 visible label、description、error association；password reveal 有 accessible name。
* tabs 遵守 WAI-ARIA tabs keyboard pattern，Left/Right、Home/End、Tab 行为正确。
* dialog trap focus，Escape 关闭非 destructive dialog；delete 最终动作需显式 button。
* focus indicator 不被移除；touch target 最小 44×44 CSS px。
* status 使用合适的 `aria-live=polite`；blocking error 使用 `role=alert`，不重复朗读每次 keystroke。
* diff 不只依赖颜色；loading 不只用 animation；`prefers-reduced-motion` 下禁用非必要 transition。
* Crepe 不可用时 source textarea 保持键盘可用。large diff 在 worker 中计算，避免 main thread 长时间冻结。
* mobile viewport 320 CSS px 不产生页面级 horizontal overflow；code/content 区自身可横向滚动。

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
| autosave | input/compositionend 后 1,000 ms，最多 1 in-flight |
| application logical expiration | permanent，或至少距 mutation 60 秒 |
| KV writes | 遵守 Cloudflare 同 key 最多约每秒一次写入的限制；单 browser state machine不会并发写，同 paste 多 client 仍可能竞争 |

Worker upload 必须低于 64 MiB uncompressed，top-level startup 低于 1 秒，isolate memory 低于 128 MiB。CPU、request body 和 subrequest limit 取决于实际 Cloudflare plan，[Worker limits](https://developers.cloudflare.com/workers/platform/limits/)。最大 content 的 JSON parse、Markdown render、Crepe load 和 diff 都必须在目标 plan 实测；达到应用 size limit不代表所有 plan 都有足够 CPU 完成 expensive representation。

正确性关键 KV `put`/`delete` 都在 request path await，不交给 `ctx.waitUntil()`。large values sequential read/write，避免同时持有四个 10 MiB revisions。Markdown response 没有业务层输出 size cap，但仍受 isolate memory 与 CPU 限制。

## 19．TDD 与 verification strategy

### 19.1 测试层次

1. `src/pastes.test.ts` 使用最小 in-memory KV fake，先写 failing tests，再实现 ID、password、expiration、version、key grammar、legacy projection、ring rotation、no-op 与每一个 injected read/write/delete failure ordering。
2. `src/render.test.ts` 覆盖 HTML escaping、bootstrap escaping、full GFM、raw HTML、dangerous protocol、DOM clobber prefix、title/filename。
3. `src/http.test.ts` 使用 `@cloudflare/vitest-plugin` 与 `exports.default.fetch()`，通过 public routes 验证真实 KV binding、status、headers、media types、migration 和 consumption。Cloudflare 当前推荐的 test path 见[Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)与[Vitest 4 migration](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/)。
4. `src/mcp.test.ts` 以 modern client pinned `2026-07-28` 覆盖 discover、meta/header validation、八 tools、tool error；再跑 SDK stateless legacy initialize fallback。覆盖 GET/DELETE 405、Origin absent/same/cross。
5. `src/client/*.test.ts` 把 autosave scheduler 与 state transitions 作为 pure functions测 fake clock：debounce、IME、one in-flight、coalescing、no-op、403、404、409、5xx、draft preservation。
6. Playwright 对 Chromium、Firefox、WebKit 运行 create、password redirect、edit、Crepe mode、history、copy、wrap、delete、view-once、i18n、theme、keyboard 和 mobile viewport。HTML active-content test 使用只写 test marker 的 script，确认 top-level same-origin execution与 query visibility，不向外部发送数据。
7. actual stable Edge 与 Safari 最近两个 major release matrix执行 manual smoke，记录 browser version 与结果。

### 19.2 必测边界

* content 0、1、10,485,760、10,485,761 UTF-8 bytes；multibyte code points；unpaired surrogate；无 normalization。
* password U+0020、U+007E、leading/trailing space、`+%&#?` query encoding、128/129 chars、missing/wrong/empty、change/clear。
* ID 最短/最长、case distinction、所有 reserved case variants、internal prefix、invalid percent path、concurrent custom create simulation。
* expiration 六档、arbitrary integer、permanent 两种输入、absolute offsets、exact 60-second edge、past、missing timezone、near-expiry mutation与同 physical expiration。
* history 0 到 4 saves、ring overwrite、settings no revision、exact no-op、slot missing/mismatch、10 MiB lazy behavior。
* legacy valid metadata、`createdAt + expiration * 1000` expiry、missing fields、expired、migration content/settings/password、legacy/schema mixed state，以及缺字段的新格式 marker fail closed。
* view-once 每种 content route、password failure、HEAD、OPTIONS、invalid Markdown request、delete partial failure、两 region stale-read fake。
* `/html` exact body、无 CSP、script 运行、external URL未被 rewrite、query可读。
* `/md` tables、tasks、strikethrough、autolinks、raw HTML、`javascript:`、`data:`、malformed links。
* method matrix、Allow、ETag、If-Match、duplicate JSON/query fields、415、413、503 Retry-After。
* `/ip-trace` body、all headers、full cf、pretty JSON、wildcard CORS、local `{}`。

### 19.3 完成门槛

以下命令全部 exit 0；任何 skip 只允许 browser matrix 中当前机器不存在的 actual Safari，并由 WebKit 自动化覆盖：

```powershell
npm ci
npm run build
npx vitest run
npx playwright test
npx wrangler types --check
npx wrangler deploy --dry-run --outdir .wrangler-dist
```

还需检查 dry-run 输出的 `Total Upload` 低于 64 MiB，且 artifact 中没有 server-side bundling 进来的重复 Crepe 或 diff copy。

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
| C04 | view-once UI 无 edit/history/settings；API/MCP mutation允许，history禁止 | 10.3、17.5、15 | UI controls absent；settings/update/password/delete成功；history 409/tool error |
| C05 | custom ID 只做 KV checks，接受 race | 7.2 | fake concurrent negative checks可产生两个 success/last write wins，文案不声称 atomic |
| C06 | delete/expiry 后 custom ID 可复用 | 5.1、7.2 | cleanup 后同 case ID create 201；stale orphan可暂时 409 |
| C07 | legacy main+attached metadata可读，首次 mutation迁移 | 8 | seeded old entry各 representation 200；read不写；mutation生成 sibling/markers且不批量 list |
| C08 | password 当前 document module variable | 9、17 | storage APIs无写入；same document操作复用；新 tab/hard reload从 URL或重新输入取得，不靠 storage |
| C09 | protected direct raw/html/md/file无 query直接 403 | 9.3、12.2 | 四 route missing query均 403 plaintext；wrong 403；correct 200 |
| C10 | visible ASCII 1..128，empty set/clear语义 | 5.4、9 | U+0020/U+007E与128通过，control/129失败；new empty清除 |
| C11 | unprotected可 set；protected change/clear需 current password | 5.4、12.6、15.10 | API与 MCP 的 set/change/clear正反测试 |
| C12 | `/html/:id` 顶层同源可执行、不 sandbox | 16.2 | response exact stored source；script写 marker；window origin等于 Worker origin；无 wrapper |
| C13 | HTML 可加载 external resources | 16.2 | test resource request发生，server不 rewrite；browser mixed-content policy保持默认 |
| C14 | full GFM，raw HTML与危险 protocol关闭 | 16.3 | table/task/strike/autolink render；script tag为文字；javascript/data URL不可执行 |
| C15 | lazy Milkdown Crepe 与分离的 source/preview | 4、16.4、17 | 初始与 source/preview network无 Crepe chunk；首次 visual才加载 Crepe；首次 preview只加载 micromark renderer；visual editing可保存 |
| C16 | source canonical；mode switch alone不保存 | 16.4 | byte-sensitive Markdown仅切换后 KV/version/history不变；visual actual edit可 normalize并保存 |
| C17 | revision list、unified diff、snapshot、large lazy | 11、17.4 | 三 UI区存在；selected->current diff；阈值以上未点击不计算 |
| C18 | 三个 prior successful content saves，settings不进 history | 11、7.3 | 四次 edit后只列最新三 prior；settings/password/expiry/no-op count不变 |
| C19 | format只控制 default mode，所有表示形式可用 | 5.3、17.2 | text与 markdown paste都能 raw/html/md/file及两种 editor |
| C20 | 只保留现代 canonical API | 12 | `POST /api/pastes` 201；`GET|POST /api` 和 `/delete/:id` 404；DELETE canonical成功 |
| C21 | browser optional version处理冲突；curl/MCP可 LWW | 7.6、17.3 | stale browser PATCH 409且 draft留存；省略 version可覆盖 |
| C22 | MCP v2、2026-07-28、stateless legacy fallback、八 tools | 15 | pinned modern discover/calls通过；legacy initialize fallback通过；tools/list exact八个 |
| C23 | `/mcp` 无 global token；仅 present Origin验证 | 15.1 | no Origin POST可用；same Origin可用；cross/null 403；无 bearer secret配置 |
| C24 | `/ip-trace` 反射 url/method/body/all headers/full cf，pretty JSON，CORS `*` | 14 | fixture深相等，indent为2，headers/cf未筛选，ACAO为 `*` |
| C25 | 六档+permanent；API四种表达；relative从 mutation时重算 | 5.5、6.5 | 七 UI options；integer/null/permanent/RFC3339 tests；同 relative第二次保存期限从新 now算 |
| C26 | custom ID regex、case-sensitive、reserved、immutable、可复用 | 5.1 | boundary/reserved/case tests；update customId 422；`a`与`A`是不同 keys |
| C27 | English/简体中文，browser language选择，manual switch | 17.6 | navigator zh/en fixtures与 switch；全部可见 code有两套文案 |
| C28 | system theme与 document-only toggle | 17.7 | matchMedia两态；toggle后storage为空；new document重置 |
| C29 | 当前四浏览器最近两个 major、responsive/accessibility | 17.8、19 | Playwright三 engine、Edge/Safari smoke、320 px、keyboard、axe/manual checks通过 |
| C30 | Wrangler name、唯一 binding、开发 placeholder | 20 | config exact name/main/date/assets；只有一个 `PASTE_DB`，开发 ID 为明确 placeholder；local smoke 与 dry-run exit 0；不执行 deploy |
| C31 | 不保留 legacy API 与 destructive GET | 3、12.2 | method/path contract tests均为404/405且无 KV mutation |
| C32 | protected main GET无 password呈 input；form POST校验并302到 query | 9.3 | GET 200无 content；wrong POST 403；correct POST 302 Location exact encoded target |
| C33 | HTML JavaScript可读取和外传 query password，用户接受 | 9.3、16.2、22 | browser test确认 `location.search` 可读；无 CSP/sandbox阻止 fetch；风险文档存在 |
| C34 | redirect 后 password同时在 URL与 module variable，请求继续附带 | 9.4、17.2 | URL query存在；module actions无需再输入；API carrier含 decoded exact password |
| T01 | 主正文 exact plaintext `key=id`，business metadata sibling | 6 | direct KV断言 main value等于 source，business fields只在 `__cfpb:meta` |
| T02 | 三个 fixed sibling ring slots且同 physical expiry | 6、11 | keys仅 slot 0/1/2；四次 save轮换；list metadata expiration全部相同 |
| T03 | plaintext editor等宽、1 秒 autosave、IME、单 in-flight、coalescing | 17.3 | fake-clock state tests与 browser computed font/network concurrency通过 |
| T04 | error/conflict保留 draft与 exact no-op | 7.3、17.3 | 403/404/409/413/503后 textarea不变；same content无 KV write/history/version |
| T05 | 标题、drag/drop、copy、wrap、file和delete功能保留 | 12、17 | browser actions逐项通过；delete只发 DELETE |
| T06 | password覆盖每个 representation/API/history/update/settings/delete/MCP | 5.4、9、12、15 | protected route/tool matrix对 missing/wrong全为403或 tool error，正确值通过 |
| T07 | create不自动打开 | 7.2、17.1 | 201 后 location仍为 `/`，view-once main仍存在直到用户选择 link |
| T08 | 修改 expiry使全部 related keys采用同 physical expiration | 6.5、7.4 | active history 0..3情况下 extension/shorten/permanent的 key expiration深相等 |
| T09 | UI与 API 不返回 stored plaintext password | 12.3、17 | response snapshot scan无 metadata password；URL/body transport例外按规格可见 |
| T10 | local smoke 与 TDD | 19、20 | 所列 commands与 smoke assertions全部通过 |

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

以上风险是选定单 KV、plaintext credential、same-origin executable HTML 与无账户模型的直接结果。实现不得用未获批准的第二存储、token、sandbox、CSP 或 rate limit暗中改变这些产品决策。
