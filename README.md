# cf-pastebin

基于 Cloudflare Worker、单个 Workers KV namespace 和 React 的文本 paste 服务。支持自定义 ID、有效期或永久保存、密码、阅后删除、编辑与最近三个旧版本、Markdown 源码和可视化编辑；提供网页、raw、HTML、Markdown、文件下载、HTTP API 和 `/mcp` 八个工具。正文是 UTF-8 文本，最多 10 MiB，不接收二进制 paste。

## 安装与本地开发

需要 Node.js >=22.12.0 和 npm；生产部署另需有权访问现有 Worker、KV 与 custom domain 的 Cloudflare 账号。

```bash
npm ci
npm run build
npm run dev:local
```

`http://127.0.0.1:8787/` 是本地页面。`dev:local` 使用 Wrangler 的本地 KV，不连接生产 KV。没有 lint script；`npm run typecheck` 会先构建客户端再运行 TypeScript 检查。

## 测试

```bash
npx vitest run --project node src/pastes.test.ts
npx vitest run --project workers src/http.test.ts
npx playwright test test/e2e/create-password.spec.ts --project=chromium
```

先运行 `npm run build`。以上命令按 project 选择测试；不带过滤条件的 `npm test` 会运行全部 Vitest 项目，其中 Chromium 组件测试含 touch 与 accessibility 用例。Windows 上的 `npm run smoke` 也会运行全部 Vitest 项目，然后启动本地 Wrangler 验证 HTTP 路由，使用端口 8787。

## KV 与部署

`wrangler.jsonc` 指定 Worker `cf-pastebin-new`、唯一 KV binding `PASTE_DB`（现有 namespace ID `cd0ebbaba15e486a8e1071bb21e31a9f`）、唯一 custom domain `n.awsl.app`，关闭 `workers_dev`、preview URL 和域名 preview，静态资源来自 `./dist/assets`。`npm run build` 会校验这些固定值。主 KV key 是 paste ID；同一个 namespace 的 `__cfpb:meta:` 与 `__cfpb:rev:` key 存储 metadata 和历史。

发布前确认登录的是拥有上述现有资源的账号，保持 Worker name、KV ID、binding 和域名路由不变，不创建替代 namespace，也不以 `--env` 或临时路由覆盖配置。运行 `npm run build`，再运行 `npx wrangler deploy --dry-run --outdir .wrangler-dist` 检查产物；确认目标无误后才运行 `npx wrangler deploy`。发布后在 `https://n.awsl.app` 创建、读取并删除一条临时 paste 验证绑定。旧设计文档仍写有旧域名，部署以当前 `wrangler.jsonc` 和构建校验为准。

## HTTP 接口

`POST /api/pastes` 接受 JSON 或 multipart，`content` 必填。`title`、`format`（`text` 或 `markdown`）、`expiration`（至少 60 秒的整数、`"permanent"`、`null` 或带时区的 RFC3339）、`password` 和 `customId` 可选。JSON 的 `viewOnce` 可选；multipart 必须传字符串 `true` 或 `false`。默认 1 天、无密码、非阅后删除；成功返回 `201` 和含 `id`、`version`、各表示形式链接的摘要。

```bash
curl -sS -X POST http://127.0.0.1:8787/api/pastes \
  -H 'Content-Type: application/json' \
  --data '{"content":"example","expiration":86400}'
```

| 操作 | 路径与请求 |
|---|---|
| 读取正文和摘要 | `GET /api/pastes/:id`；`HEAD` 不返回正文，`GET` 可用 `If-None-Match`。 |
| 更新或删除 | `PATCH /api/pastes/:id` 发送 JSON `{"content":"new text"}`；`DELETE /api/pastes/:id` 返回 `204`。更新可带 `version`（或 `If-Match`）避免覆盖别人的修改。 |
| 设置与密码 | `GET`/`PATCH /api/pastes/:id/settings` 修改标题、格式、期限、`viewOnce`；`PUT /api/pastes/:id/password` 发送 `{"newPassword":"..."}`，`DELETE` 清除密码。 |
| 历史 | `GET /api/pastes/:id/history`；`GET /api/pastes/:id/history/:revision`，阅后删除条目不可查看历史。 |
| 网页与表示形式 | `GET /:id`、`/raw/:id`、`/html/:id`、`/md/:id`、`/file/:id`。`POST /mcp` 为 MCP 入口；`/ip-trace` 反射请求信息。 |

受保护条目的 API 读取可用 `X-Paste-Password` header，JSON mutation 或 `POST /api/pastes/:id/read` 可用 `password` 字段提供当前密码。网页和表示形式 URL 也支持 `?password=`，该明文会进入地址栏和请求记录；KV metadata 中的密码同样以明文保存。`/html/:id` 会把 paste HTML 作为同源可执行页面返回，不适合打开不可信 HTML；`/ip-trace` 会返回请求 body 和 headers。阅后删除由首次成功返回正文的请求触发，`HEAD` 不消耗；Workers KV 的最终一致性不保证跨区域并发时严格只读一次。旧 `GET|POST /api` 与 `GET /delete/:id` 不存在。
