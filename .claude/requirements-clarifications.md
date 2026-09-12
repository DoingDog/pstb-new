# 需求澄清记录

状态：等待用户一次性确认。收到回复后，将把答案记录在本文件并作为 spec 的唯一产品决策来源。

回复格式可写为：`1A 2A 3A ...`。只需展开说明需要自定义的项目。未写出的项目不会擅自视为已确认。

## A. 数据一致性与 view-once

1. **view-once 的全局保证**
   - A（推荐）：增加一个 SQLite-backed Durable Object binding。每个 paste ID 对应一个 Durable Object，只保存 generation、active、consumed 等协调状态；正文、密码、历史和业务 metadata 仍全部在指定 KV namespace。由 Durable Object 串行化领取，避免 KV 的跨地域重复读取。
   - B：严格只用 KV，实现首次读取后删除，但接受跨地域并发时可能被读取多次。

2. **哪些请求触发 view-once 消费**
   - A（推荐）：第一个成功通过密码验证、且将返回正文的请求触发。包括 `/:id`、`/raw/:id`、`/html/:id`、`/md/:id`、`/file/:id`、API content read、MCP `paste_get`。`HEAD`、`OPTIONS`、错误密码、无效 format、settings mutation、delete 不触发。
   - B：任何命中 paste 的请求都触发，包括 `HEAD` 和 metadata 请求。
   - C：浏览器先显示确认页，仅 POST 确认后触发。

3. **消费与网络发送的先后顺序**
   - A（推荐）：先完成渲染和校验，再由 Durable Object 原子标记 consumed 并删除 KV，最后发送响应。连接中断时可能出现 paste 已消费但用户未完整收到内容，但不会主动发出第二份。
   - B：响应发送后才标记 consumed，降低零次交付概率，但并发或中断时可能重复交付。

4. **view-once 在首次读取前是否允许管理**
   - A（推荐）：网页不显示 edit/history/settings；API/MCP 在提供当前密码后可 update content、修改密码、修改期限、关闭或开启 view-once、delete。history content/list 均禁止，避免绕过一次性读取。
   - B：API/MCP 也只能读取一次或 delete，其他 mutation 全部禁止。
   - C：允许 API/MCP 查看 history，首次 history content 请求同时消费。

5. **custom ID 与 view-once 使用同一 Durable Object 协调器**
   - A（推荐）：所有 create 先由 ID 对应的 Durable Object 原子 reserve generation，因此并发 custom ID 创建只有一个成功；普通读取仍直读 KV。
   - B：Durable Object 只用于 view-once；custom ID 仅做 KV 存在性检查，接受并发竞争。

6. **ID 再利用**
   - A（推荐）：显式删除或自然过期后允许再次创建同一 custom ID；Durable Object generation 隔离旧状态和新 paste。
   - B：custom ID 一经使用永不允许复用。

7. **旧 KV 数据兼容**
   - A（推荐）：旧条目只有主 value 和 attached metadata 时仍可读取；第一次 mutation 时创建新 sibling metadata 和 generation，不批量迁移。
   - B：新版本只识别新 schema，旧 paste 不保证可用。

## B. 密码与受保护链接

8. **“浏览器内存”具体范围**
   - A（推荐）：只存在当前 document 的 JavaScript 变量。刷新、hard navigation、新 tab 都重新输入；同一页面内 read/edit/history/raw/html/md/file 操作只输入一次。
   - B：使用 `sessionStorage`，同 tab 刷新后仍可用，tab 关闭后清除。
   - C：使用无持久期限的 session cookie，浏览器自动附带，但同一浏览器 session 的其他 tab 也可能复用。

9. **直接打开受密码保护的 `/raw`、`/html`、`/md`、`/file`**
   - A（推荐）：初次 GET 返回 HTTP 403 的 password shell。输入密码后，shell 以同源 fetch 的 JSON body或 `X-Paste-Password` 发送明文密码，并在当前 document 内显示、渲染或下载，不把密码写入 URL、storage 或 cookie。
   - B：允许 `?password=`，直接刷新和跳转最简单，但密码进入地址栏、history、复制链接和日志。
   - C：password shell 成功后设置 session cookie，再 redirect 到原 URL。

10. **密码字符集与长度**
    - A（推荐）：1 到 128 个 visible ASCII 字符，空字符串表示不设置或清除。这样 `X-Paste-Password` 可按原文放入 HTTP header，满足“明文传输”。
    - B：允许任意 Unicode，最多 256 UTF-8 bytes。浏览器和 MCP 使用 JSON body；curl 的 header 形式只支持可安全放入 header 的密码。
    - C：不设应用长度上限，仅受 request/KV 限制。

11. **密码设置语义**
    - A（推荐）：未加密 paste 可直接 set；已加密 paste 的 change/clear 必须提供当前密码；新密码为空等同 clear；错误或缺少当前密码统一 403。
    - B：set/change/clear 全部通过一个 `newPassword` nullable 字段；其余规则同 A。

## C. 表示形式与 Markdown

12. **`/html/:id` 的执行能力**
    - A（推荐）：保留 HTML 源码渲染和 script 能力，但放入不含 `allow-same-origin`、不含 top-navigation 的 sandboxed iframe；可允许 scripts、forms、modals 和 user-activated popups。代码不能读取应用页面、密码变量或同源 KV API。
    - B：完全复刻旧行为，用户 HTML 作为顶层同源页面执行，可直接访问本服务 origin。
    - C：sandbox 中禁止 scripts，只渲染静态 HTML。

13. **HTML 中的外部资源**
    - A（推荐）：sandbox 内允许普通 `https:` 图片、样式和网络请求；受保护的本服务 subresource 不自动继承 paste 密码，因此会 403。
    - B：sandbox 禁止所有外部网络资源。
    - C：不做 sandbox，按 12B 的同源顶层页面处理。

14. **`/md/:id` 语法和 raw HTML**
    - A（推荐）：支持完整 GFM，包括 table、task list、strikethrough、autolink；raw HTML 显示为文本，危险 URL protocol 被拒绝。
    - B：CommonMark 加 autolink，功能更少、bundle 更小；raw HTML 仍显示为文本。
    - C：支持 GFM 和 raw HTML，再增加 sanitizer。

15. **Markdown WYSIWYG 编辑器**
    - A：OverType 2.4.2，约 39 KiB gzip，按需加载；normal mode 有即时视觉格式，但仍显示 Markdown marker、等宽固定字号、编辑态不显示图片。它最轻。
    - B（推荐，严格满足 WYSIWYG）：Milkdown Crepe，按需加载；隐藏大部分 Markdown syntax，支持 rich-text/GFM/图片，约 458 KiB gzip，切换源码时通过 Markdown parse/serialize，不能保证 byte-for-byte 保留原始排版。
    - C：TOAST UI Editor 3.2.2，内建 Markdown/WYSIWYG 切换，但仓库已 archived，不建议新采用。

16. **Markdown source 的保真标准**
    - A（推荐）：Markdown source 是 canonical。只在 visual mode 真正修改后接受编辑器重新序列化；仅切换 view 不保存、不改写。进入 visual mode 前提示可能规范化空白和 syntax。
    - B：visual mode 优先，允许每次切换都规范化 Markdown source。
    - C：要求 byte-for-byte 保真，因此仅用 OverType，不采用 AST/ProseMirror rich editor。

17. **历史的 GitHub 风格**
    - A（推荐）：左侧 revision list，右侧 unified line diff，另有完整 snapshot tab；移动端先列表后详情。大文件按需计算/加载。
    - B：只显示每次 revision 的完整 monospace snapshot，不计算 diff。
    - C：只显示 unified diff，不提供完整 snapshot。

18. **“最近 3 次编辑历史”的计数**
    - A（推荐）：当前正文之外保存最近 3 个 prior revision；每次成功的 1 秒 autosave 且内容实际变化就新增 revision。settings/password/expiry 变化不新增。
    - B：总共只显示 3 个版本，包含当前正文加 2 个 prior revision。
    - C：连续 autosave 在固定时间窗口内合并为一次历史 revision，请说明窗口。

19. **paste 的 `format`**
    - A（推荐）：创建时 `text|markdown` 只决定默认 edit/view mode；任何 paste 都可打开 `/raw`、`/html`、`/md`，正文始终是一份原始字符串。
    - B：`text` paste 禁止 Markdown visual edit 和 `/md`；`markdown` paste 禁止 `/html`。

## D. HTTP API、兼容和 MCP

20. **API 路径和 legacy compatibility**
    - A（推荐）：保留 `GET|POST /api` 创建及原 response fields；新增 `/api/pastes/:id`、`/api/pastes/:id/settings`、`/api/pastes/:id/password`、`/api/pastes/:id/history`。保留 destructive `GET /delete/:id` 兼容 alias，现代 UI 使用 `DELETE /api/pastes/:id`。
    - B：新增路径使用较短的 `/api/:id`；仍保留 legacy create。
    - C：删除 destructive GET alias，只保留 DELETE/POST。

21. **并发 edit 的 version precondition**
    - A（推荐）：browser 自动附带 version，冲突时保留 draft 并提示；curl/MCP 可不传 version，默认 last-write-wins，保持“链接+密码即可控制”。
    - B：所有 update/settings/delete 必须传当前 version，否则 428。
    - C：完全不支持 version 检查，统一 last-write-wins。

22. **MCP protocol compatibility 和工具粒度**
    - A（推荐）：使用 `@modelcontextprotocol/server` v2，同时支持 MCP `2026-07-28` modern request 和 SDK stateless legacy fallback。提供 8 个工具：`paste_create`、`paste_get`、`paste_update`、`paste_delete`、`paste_history_list`、`paste_history_get`、`paste_settings_update`、`paste_password_update`。
    - B：modern-only，拒绝 2025-era clients；工具同 A。
    - C：modern+legacy，但拆成 11 个工具，将 password set/change/clear 和 settings get/update 分开。

23. **MCP endpoint 本身的 auth**
    - A（推荐且符合原要求）：`/mcp` 无全局 token；每个 paste tool 只使用工具参数里的 paste password。仅按 MCP spec 验证存在的 `Origin`，不限制 curl/CLI 无 Origin 请求。
    - B：另加 Worker secret 作为 `/mcp` 全局 bearer token。

24. **`/ip-trace` 输出范围**
    - A（推荐，严格复刻 `aioapi.js`）：返回 `url`、`method`、request body text、全部 request headers、完整 `request.cf`，JSON pretty print，CORS `*`。
    - B：只返回 IP、country、city、colo、timezone、ASN 等筛选后的基本信息。

25. **expiration 的 API 表达和修改基准**
    - A（推荐）：UI 支持 1 minute、1 hour、1 day、1 week、1 month、1 year、permanent；API 兼容 integer seconds，并接受 `null`/`"permanent"` 与 RFC3339 absolute timestamp；相对时长从成功 update 时重新计算。
    - B：API 只接受 integer seconds，`0` 表示 permanent；修改从 update 时重新计算。
    - C：只接受 absolute RFC3339 timestamp 或 `null`。

26. **custom ID 规则**
    - A（推荐）：case-sensitive `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`；拒绝 `api`、`raw`、`html`、`md`、`file`、`delete`、`mcp`、`ip-trace`、assets、favicon、robots 和内部 sibling prefix，不允许之后改名。
    - B：允许 1 到 128 个任意 URL segment 字符，做 percent-encoding 和 Unicode normalization。

## E. 前端范围与部署输入

27. **UI 语言**
    - A：保留 English UI。
    - B（推荐）：简体中文 UI，technical format/route 名保持原样。
    - C：中英双语切换，需要额外 locale 状态和文案。

28. **主题**
    - A（推荐）：默认跟随 `prefers-color-scheme`，提供 light/dark toggle，仅存当前 document，不持久化。
    - B：只做现代 dark theme，延续旧 UI。
    - C：只跟随系统，不提供 toggle。

29. **浏览器支持范围**
    - A（推荐）：当前 Chrome、Edge、Firefox、Safari 的最近两个 major；不支持 IE/旧版 WebView。
    - B：只保证 Chromium。
    - C：请指定版本矩阵。

30. **Wrangler deployment 配置中的真实资源信息**
    - A（推荐）：binding 保持 `PASTE_DB`；先使用明显的本地/placeholder KV namespace ID 和 Worker name `cf-pastebin`，完成 `wrangler dev --local`、Vitest 和 dry-run。实际 deploy 前由使用者替换真实 ID。
    - B：请在回复中提供 Worker name、KV namespace ID、preview ID；代码直接写成可 deploy 配置。

## 用户确认，2026-09-12

原始回复：

```plaintext
1B（只允许有一个 kv 桶） 2A 3A 4A 5 不使用 6A 7A 8A 9B（如不带则直接 403） 10A 11A 12B 13A 14A 15B 16A 17A 18A 19A 20 全部规范化 21A 22A 23A 24A 25A 26A 27C 根据浏览器语言 28A 29A 30A
```

已确定的解释：

1. 只使用一个 `PASTE_DB` KV namespace，不增加 Durable Object、第二个 KV namespace、D1 或其他协调存储。view-once 使用 KV read-then-delete，明确接受 KV eventual consistency 下跨地域并发可能重复读取。
2. view-once 由第一个成功通过密码验证且返回正文的请求触发；`HEAD`、`OPTIONS`、错误密码、无效 format、settings mutation、delete 不触发。
3. 先完成表示形式的渲染和校验，再删除主 KV、metadata sibling 和 history siblings，最后发送响应。连接中断时允许出现已经删除但未完整交付。
4. view-once 网页不显示 edit/history/settings；首次读取前，API/MCP 提供当前密码后可更新正文、密码、期限、view-once 设置和删除；history list/content 全部禁止。
5. 不使用 Durable Object 做 custom ID 串行化。custom ID 只做同一 KV namespace 的存在性检查，接受并发竞争。
6. 显式删除或自然过期后允许复用 custom ID。
7. 旧主 value 加 attached metadata 的条目继续可读，第一次 mutation 时迁移到 sibling schema。
8. 密码只存在当前 document 的 JavaScript 变量；刷新、hard navigation、新 tab 后重新输入。
9. 受保护的 representation URL 允许 `?password=<明文>`；不带 password 时直接返回 403，不提供 password shell。此选择明确接受密码进入地址栏、browser history、复制 URL、Cloudflare/request log 和 `Referer` 的风险。
10. 密码为 1 到 128 个 visible ASCII 字符；空字符串表示不设置或清除。
11. 未保护 paste 可直接 set password；已保护 paste 的 change/clear 必须提供当前密码；空新密码表示 clear。
12. `/html/:id` 完全复刻旧行为，用户 HTML 作为顶层同源页面执行，不使用 sandbox。
13. `/html/:id` 允许外部 `https:` 资源和网络请求。
14. `/md/:id` 使用完整 GFM；raw HTML 转义为文本，拒绝危险 URL protocol。
15. 使用 Milkdown Crepe，按需加载；接受约 458 KiB gzip 和 visual round-trip 可能规范化 Markdown source。
16. Markdown source 是 canonical；只有 visual mode 发生真实修改后才接受重新序列化，单纯切换 mode 不保存或改写。
17. history 使用 revision list、unified line diff 和完整 snapshot tab，大文件按需加载。
18. 当前正文之外保留最近 3 个 prior revision；每次正文发生实际变化且 autosave 成功就新增 revision；settings/password/expiry 不新增。
19. `format` 只决定默认 mode；所有 paste 都支持 raw、html、md 等 representation。
20. 只保留现代规范化 API：canonical create 为 `POST /api/pastes`，资源路由为 `/api/pastes/:id` 及其 settings/password/history 子路由；删除 legacy `GET|POST /api` create contract、旧 response shape 和 destructive `GET /delete/:id`。`/raw`、`/html`、`/md`、`/file` 与 `/:id` 的功能继续保留。
21. browser 自动附带 version 并处理冲突；curl/MCP 可省略，默认 last-write-wins。
22. 使用 `@modelcontextprotocol/server` v2，同时支持 MCP `2026-07-28` 和 stateless legacy fallback；采用 8 个工具。
23. `/mcp` 不设置全局 token；各工具只验证 paste password；仅验证存在的 `Origin`。
24. `/ip-trace` 严格返回 `aioapi.js` 根功能的 `url`、`method`、request body、全部 headers 和完整 `request.cf`，CORS `*`。
25. expiration UI 提供原六档和 permanent；API 接受 integer seconds、`null`、`"permanent"` 和 RFC3339；相对期限从成功修改时计算。
26. custom ID 使用 case-sensitive `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`，拒绝全部内部 route 和 sibling prefix，创建后不可改名。
27. UI 提供简体中文和 English，根据 `navigator.language` 自动选择，并允许手动切换。
28. 主题默认跟随 `prefers-color-scheme`，提供 light/dark toggle，仅存当前 document。
29. 支持当前 Chrome、Edge、Firefox、Safari 最近两个 major。
30. binding 保持 `PASTE_DB`，Worker name 使用 `cf-pastebin`，配置 placeholder KV namespace ID，完成本地测试和 dry-run，部署前由使用者替换。

### 追加澄清

31. API compatibility：仅现代 API。使用 `POST /api/pastes` 和 `/api/pastes/:id` 子路由；不保留 legacy `GET|POST /api` 或 destructive `GET /delete/:id`。
32. 受保护的 `/:id` 未携带 password 时返回输入页；用户提交明文 password 后，服务端以 HTTP 302 redirect 到带 password query parameter 的目标页面。
33. `/html/:id?password=...` 允许顶层同源用户 JavaScript 读取和外传 query 中的明文 password。用户明确接受该行为，不使用 sandbox，也不为 `/html` 禁止 query password。
34. 第 8 项的“只存 JavaScript 变量”受第 32 项覆盖：通过 redirect 后，password 同时存在 URL query、browser history 和当前 document JavaScript 变量。页面内 API 请求继续附带同一明文 password。
