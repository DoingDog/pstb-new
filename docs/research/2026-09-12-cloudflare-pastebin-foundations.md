# Cloudflare pastebin foundations

## Scope and date

- **Research date:** 2026-09-12. Runtime recommendations use a tested `compatibility_date` of `2026-09-12`; Cloudflare documents compatibility dates as behavior gates rather than immutable runtime versions ([Compatibility dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)).
- **Repository target:** one server-rendered Cloudflare Worker pastebin, with paste editing, expiring storage, Markdown rendering, protected content retrieval, an optional MCP endpoint, and local tests. Hono can run directly as a Worker without React, Vite, a Node server, or an adapter for ordinary fetch requests ([Hono, Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)).
- **Evidence boundary:** this note synthesizes only the supplied primary-source research. The evidence quotations below preserve the supplied claims verbatim. No web browsing or new repository inspection was performed for this note.
- **Protocol baseline:** MCP revision `2026-07-28` is the current stable revision in the supplied research, while revisions through `2025-11-25` use legacy lifecycle and HTTP semantics ([MCP 2026-07-28: Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)).
- **Storage baseline:** Workers KV is selected for ordinary expiring pastes, but not as the authority for strict view-once consumption because Cloudflare documents KV as eventually consistent and unsuitable for atomic read/write transactions ([How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)).

## Decision table

| Domain | Decision | Status and source-backed reason |
|---|---|---|
| Worker format | Use one ES module Worker with `export default { async fetch(request, env, ctx) { ... } }`. | Selected. Module Workers receive bindings through `env`, lifecycle methods through `ctx`, and can reuse an execution context across requests ([Migrate from Service Workers to ES Modules](https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/)). |
| Build and deploy | Use Wrangler's default esbuild bundling, pin Wrangler in the lockfile, inspect `npx wrangler deploy --dry-run --outdir dist`, and use `wrangler deploy` for the first release. | Selected. Wrangler resolves package imports and emits one entrypoint by default; `wrangler versions upload` accepts ES modules and cannot perform a new project's first upload ([Bundling](https://developers.cloudflare.com/workers/wrangler/bundling/), [Deployment management](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/#service-worker-syntax)). |
| Runtime compatibility | Set `compatibility_date = "2026-09-12"` only after testing and omit redundant positive `nodejs_compat` flags. | Selected. Dates on or after `2026-08-04` automatically enable the behavior of `nodejs_compat` and `nodejs_compat_v2`, while Node compatibility remains a subset of Node.js ([Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#get-started)). |
| HTTP application | Use Hono for paste routes and `hono/html` for the initial server-rendered view layer; do not add React or Vite. | Selected because the planned surface has several method/path combinations, parameterized routes, shared response handling, and untrusted values; Hono supports those route forms and server-rendered HTML on Workers ([Hono, Routing](https://hono.dev/docs/api/routing), [Hono, html Helper](https://hono.dev/docs/helpers/html)). |
| Paste storage | Store ordinary content and small non-secret metadata in one KV entry through `put(..., { metadata, expiration })`. | Selected when serialized metadata is at most 1,024 bytes. One KV value may be at most 25 MiB, and attached metadata may be at most 1,024 bytes after JSON serialization ([Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)). |
| Sibling metadata | Do not create a sibling metadata key by default. If one becomes necessary, use the same absolute `expiration`, await both writes, and handle every partial state. | Conditional. Two `put()` calls succeed independently, and multi-key reads do not acquire transactional snapshot semantics ([Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/), [Read key-value pairs](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)). |
| Strict view-once | Use a Durable Object as the consume authority; do not implement read-then-delete or a consumed flag in KV. | Selected if strict single-consumption is a requirement. Cloudflare explicitly directs workloads requiring atomic operations or read/write transactions away from KV and toward Durable Objects ([How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)). |
| Markdown renderer | Use `micromark` plus `micromark-extension-gfm-autolink-literal`, with `allowDangerousHtml: false` and `allowDangerousProtocol: false` set explicitly. | Selected. Those defaults escape raw HTML and drop unsafe link/image protocols, while the narrow extension adds bare URL and email syntax without the full GFM feature graph ([micromark README](https://github.com/micromark/micromark/blob/main/packages/micromark/readme.md), [GFM autolink literal extension](https://github.com/micromark/micromark-extension-gfm-autolink-literal/blob/main/readme.md)). |
| Browser editor | Trial pinned, self-hosted OverType `2.4.2`, loaded only on the editor page, and save `editor.getValue()`. | Provisional. OverType keeps a textarea as the Markdown source of truth and provides normal edit, raw Markdown, and preview modes, but it is a hybrid overlay with visible markers, fixed-size monospace text, and no rendered images in edit mode ([OverType view modes](https://github.com/panphora/overtype#view-modes), [OverType limitations](https://github.com/panphora/overtype#limitations)). |
| Password gate | Keep the entered password in a module-scoped browser variable for the lifetime of the current document; send it on each same-origin protected fetch in `Authorization`; re-prompt after reload or a new tab. | Selected. Script can set `Authorization`, normal hyperlinks cannot add author-defined headers, and `sessionStorage` survives reloads and can be copied to an opener-created tab ([Using the Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#setting_headers), [Links](https://html.spec.whatwg.org/multipage/links.html#following-hyperlinks), [Window: sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)). |
| Protected downloads | Fetch authorized bytes, create a temporary blob URL, activate a same-document download link, and revoke the blob URL when no longer needed. | Selected. Blob URLs represent in-memory bytes and can be navigated or downloaded; exact download behavior can vary by browser and user settings ([blob: URLs](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob), [`<a>` download](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a#download)). |
| MCP server | Use stable `@modelcontextprotocol/server` v2 with `createMcpHandler`, one fresh `McpServer` per request, `/mcp` path restriction, Host and Origin guards, and endpoint authentication. Set `{ legacy: "reject" }` unless legacy client support becomes an explicit requirement. | Selected as a modern, stateless endpoint. The v2 handler serves web-standard runtimes, modern requests are request-scoped, and its guards and auth context are separate responsibilities ([Serve on web-standard runtimes](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md), [Sessions, state, and scaling](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md)). |
| Local development and tests | Use `wrangler dev --local`, `vitest@^4.1.0`, `@cloudflare/vitest-plugin`, the checked-in Wrangler config, and `exports.default.fetch()` integration tests. | Selected. Wrangler runs the Worker locally in `workerd`, while the current plugin loads Wrangler bindings and replaces the old pool package and deprecated `SELF.fetch()` path ([Local development](https://developers.cloudflare.com/workers/local-development/), [Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/), [Vitest 4 migration](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/)). |

## Sourced constraints by domain

### 1. Cloudflare Worker runtime and deployment

**Evidence, verbatim:**

> Cloudflare documents both formats, but an ES module Worker uses a default-exported handler object, while service-worker syntax uses addEventListener("fetch") and event.respondWith(). In module Workers, bindings are provided through env and lifecycle methods such as waitUntil are on ctx. Cloudflare says module Workers can reuse a JavaScript execution context across requests, while global bindings in service-worker Workers require a new context for each request.
>
> Source: [Migrate from Service Workers to ES Modules](https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/)

> The current Worker upload limit is 64 MiB uncompressed on both Free and Paid plans. There is no compressed-size limit; Wrangler’s Total Upload value is the measured value. A Worker must parse and execute top-level code within a separate 1-second startup limit.
>
> Source: [Limits, Worker size](https://developers.cloudflare.com/workers/platform/limits/#worker-size)

> A compatibility date enables backward-incompatible runtime changes up to and including that date. Cloudflare recommends setting a new project to the current date and testing before later date updates. The date changes behavior gates, but does not freeze all runtime updates; old dates remain supported.
>
> Source: [Compatibility dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)

> Node compatibility is a subset, not a Node.js process. Cloudflare provides native full or partial implementations, non-functional import-only stubs, and Wrangler-injected unenv polyfills. Stub or polyfilled methods may do nothing or throw an unenv not-implemented error even though import or require succeeds.
>
> Source: [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#supported-nodejs-apis)

Constraints and consequences:

- Keep the default bundler enabled. Wrangler traverses imports, resolves packages in `package.json`, emits one JavaScript entrypoint, and prefers a conditional export named `workerd`; because Wrangler's pre-1.0 esbuild version may change in a Wrangler minor release, pin the exact Wrangler resolution in the lockfile ([Bundling](https://developers.cloudflare.com/workers/wrangler/bundling/)).
- Do not use `--no-bundle` to preserve source layout. That switch disables Wrangler's processing, minification, and Node.js polyfill injection, so it is valid only when another build already produces the complete deployable artifact ([Disable bundling](https://developers.cloudflare.com/workers/wrangler/bundling/#disable-bundling)).
- Use ordinary static imports for JavaScript, npm modules, `.txt`, `.html`, `.sql`, `.bin`, and `.wasm`; Wrangler has native module handling for those asset types ([Including non-JavaScript modules](https://developers.cloudflare.com/workers/wrangler/bundling/#including-non-javascript-modules)).
- Add `find_additional_modules` and explicit module rules only if the implementation introduces variable-based dynamic imports or deliberately unbundled lazy modules; normal static imports need no custom rule ([Configuration, bundling](https://developers.cloudflare.com/workers/wrangler/configuration/#bundling)).
- Perform the initial release with `wrangler deploy`; later staged releases may use `wrangler versions upload` and `wrangler versions deploy`, which require ES module syntax ([Deployment management](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/#service-worker-syntax)).
- Treat 64 MiB as an uncompressed deployment ceiling and 1 second as the top-level startup ceiling; inspect Wrangler's `Total Upload` and avoid expensive module-scope initialization ([Limits, Worker size](https://developers.cloudflare.com/workers/platform/limits/#worker-size)).
- Treat parsing, Markdown conversion, compression, and cryptography as CPU work. HTTP CPU time is 10 ms per request on Workers Free; Workers Paid defaults to 30 seconds and may be configured up to 300,000 ms, while network waiting does not count as CPU time ([Limits, CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)).
- Confirm the actual usage model before applying headline Paid limits because legacy Bundled remains capped at 50 subrequests and 50 ms CPU for HTTP requests, while Unbound follows current Workers Paid limits ([Limits, Unbound and Bundled](https://developers.cloudflare.com/workers/platform/limits/#unbound-and-bundled-plan-limits)).
- Count redirects and library-generated fetches against the subrequest budget. Free allows 50 subrequests per invocation, Paid defaults to 10,000, and only six outgoing connections may wait for response headers at one time; consume or cancel response bodies promptly ([Limits, subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests)).
- Do not derive upload acceptance from the Workers billing plan alone. Request-body limits depend on the Cloudflare account plan, headers are capped at 128 KB each, and URLs at 16 KB; the application limit must also remain within KV's lower 25 MiB value ceiling ([Limits, request and response](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits), [KV write limits](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)).
- Stream large bodies rather than calling `arrayBuffer()`, `text()`, or `json()` for the whole payload. Workers do not impose a response-body size limit, but an isolate has 128 MB of memory and CDN cache object limits still apply ([Limits, request and response](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits)).
- Do not treat an open HTTP connection as unlimited execution capacity. An HTTP-triggered Worker has no hard wall-time limit while the client remains connected, but CPU and subrequest ceilings remain; after completion or disconnect, `ctx.waitUntil()` extends associated work for at most 30 seconds ([Limits, duration](https://developers.cloudflare.com/workers/platform/limits/#duration)).
- Always include `compatibility_date` in Wrangler configuration and API upload metadata. An API upload that omits it defaults to `2021-11-02` ([Compatibility dates via API](https://developers.cloudflare.com/workers/configuration/compatibility-dates/#via-the-cloudflare-api)).
- With `compatibility_date = "2026-09-12"`, omit positive `nodejs_compat` and `nodejs_compat_v2` flags; a complete deliberate opt-out requires both `no_nodejs_compat` and `no_nodejs_compat_v2` ([Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#get-started)).
- A successful bundle or import does not prove a Node-dependent package works. Exercise the actual methods every dependency executes because some APIs are partial implementations, import-only stubs, or `unenv` polyfills ([Supported Node.js APIs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#supported-nodejs-apis)).

### 2. Workers KV data model and consistency

**Evidence, verbatim:**

> A KV key is limited to 512 bytes, a value to 25 MiB, and metadata attached through `put(..., { metadata })` to 1,024 bytes after JSON serialization. A key cannot be empty or exactly `.` or `..`.
>
> Source: [Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)

> Workers KV is eventually consistent. A change is usually visible immediately where it was made, but that is not guaranteed. Other locations may continue to see an older value for 60 seconds or more while caches expire; negative lookups are cached too.
>
> Source: [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

> Cloudflare explicitly says KV is not suitable when atomic operations or reading and writing in one transaction are required, and recommends Durable Objects when stronger consistency guarantees are needed.
>
> Source: [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

Constraints and consequences:

- Use one KV key for an ordinary paste whenever its non-secret metadata serializes to at most 1,024 bytes. `getWithMetadata()` then retrieves the content and its attached metadata together, and one expiration and one delete govern the entry ([Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/), [Read key-value pairs](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)).
- Reject content above the chosen product limit before `put()`, and make that limit no greater than the 25 MiB KV value ceiling; validate the UTF-8 byte length rather than JavaScript string length ([Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)).
- Await every `put()` and `delete()` promise. `put()` creates or replaces one entry, while a paste and sibling metadata entry remain two independently successful operations ([Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/), [Delete key-value pairs](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/)).
- KV-native expiration cannot target less than 60 seconds in the future. If two keys are unavoidable, calculate one Unix epoch timestamp and pass the identical `expiration` to both rather than issuing separate relative TTL calculations ([Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)).
- Do not describe `getWithMetadata()` as a join across sibling keys. Its single-key form joins one value only with metadata attached to that same entry; its array form can fetch up to 100 keys but has no documented transactional snapshot guarantee ([Read key-value pairs](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)).
- Do not infer consumption ownership from delete success. Deleting a missing key also succeeds, and deletion propagation can lag across Cloudflare locations ([Delete key-value pairs](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/)).
- Do not implement strict view-once as KV read-then-delete, a KV lock, or a shared consumed flag. Concurrent or geographically separated viewers can observe stale data, and the same KV key accepts at most one write per second with concurrent last-write-wins behavior ([How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)).
- Treat strict consumption as one authoritative atomic decision in a Durable Object. Any KV copy remains an eventually consistent projection, not proof that the content is still consumable ([How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)).
- Use `list()` only for maintenance or enumeration. It returns at most 1,000 keys per page, requires cursor-driven pagination, and can return an empty page while `list_complete` is false because deleted or expired entries are skipped ([List keys](https://developers.cloudflare.com/kv/api/list-keys/)).

### 3. MCP revision 2026-07-28 and TypeScript SDK v2

**Evidence, verbatim:**

> Modern MCP has no initialization or negotiation handshake. Every request declares its version, and every modern server MUST implement `server/discover`. A client MAY discover first or send another request immediately and recover from `-32022 UnsupportedProtocolVersion`.
>
> Source: [MCP 2026-07-28: Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)

> Every modern request requires `params._meta["io.modelcontextprotocol/protocolVersion"]` and `params._meta["io.modelcontextprotocol/clientCapabilities"]`. `params._meta["io.modelcontextprotocol/clientInfo"]` is recommended but optional. Capabilities are request-scoped and MUST NOT be inferred from an earlier request.
>
> Source: [MCP 2026-07-28: RequestMetaObject](https://modelcontextprotocol.io/specification/2026-07-28/schema#requestmetaobject)

> Modern Streamable HTTP exposes one endpoint that accepts POST. Each JSON-RPC request or notification uses its own POST. A request receives either one `application/json` response or a request-scoped `text/event-stream` response. Standalone GET, protocol sessions, DELETE termination, and resumability were removed; a modern-only server SHOULD answer GET and DELETE with `405 Method Not Allowed`.
>
> Source: [MCP 2026-07-28: Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)

> For Cloudflare Workers, `createMcpHandler(factory)` returns the web-standard `{ fetch }` default-export shape. The factory creates a fresh `McpServer` per request. No Node adapter or body middleware is required.
>
> Source: [TypeScript SDK v2: Serve on web-standard runtimes](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md)

> `createMcpHandler` does not validate `Host` or `Origin` and does not authenticate a token. The protocol requires validation of any incoming `Origin` to prevent DNS rebinding. The SDK provides `hostHeaderValidationResponse` and `originValidationResponse`; authenticated context is passed as the second argument to `handler.fetch`.
>
> Source: [TypeScript SDK v2: Security and auth](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md#protect-against-dns-rebinding)

Constraints and consequences:

- Install `@modelcontextprotocol/server` from the stable v2 line, not v1 `@modelcontextprotocol/sdk`; v2 is the line for the `2026-07-28` specification and uses the split server package ([Official MCP TypeScript SDK README](https://github.com/modelcontextprotocol/typescript-sdk)).
- Build the endpoint with `createMcpHandler(factory, { legacy: "reject" })` unless support for 2025-era clients is explicitly required. The default is stateless legacy fallback, and a v2 client without `versionNegotiation` still exercises legacy `initialize` behavior ([Protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)).
- For modern-only behavior, route only POST to `/mcp`, and return 405 for GET and DELETE. Do not mint or persist `Mcp-Session-Id`, do not implement standalone GET streams or DELETE termination, and do not use `Last-Event-ID` ([Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).
- Keep the endpoint request-scoped. `createMcpHandler` creates a new server from the factory for each HTTP request and retains no cross-request protocol state; reusable stateless caches may remain at module scope, while application persistence belongs in external storage ([Sessions, state, and scaling](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md)).
- Register tools inside the factory. Use public SDK result shapes and let the handler inject wire-only `resultType`, `ttlMs`, and `cacheScope`; configure `ServerOptions.cacheHints` only if a nonzero cache lifetime is correct ([Supporting protocol revision 2026-07-28](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)).
- Require `Content-Type: application/json` on POST; parameters such as `charset=utf-8` are accepted. Let `createMcpHandler` enforce this and modern mirrored-header rules rather than duplicating lower-level validation ([TypeScript SDK v2 migration, HTTP and headers](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md#http--headers)).
- Modern clients must send both `application/json` and `text/event-stream` in `Accept` and accept either response form for a JSON-RPC request ([Streamable HTTP, Sending Messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#sending-messages)).
- Modern POST headers must mirror the body through `MCP-Protocol-Version`, `Mcp-Method`, and, for named operations such as `tools/call`, `Mcp-Name`; annotated tool inputs may also require matching `Mcp-Param-*` headers ([Streamable HTTP, Request Metadata](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#request-metadata)).
- Implement `server/discover` through the SDK path, do not require `initialize`, and treat current request metadata as authoritative. An unsupported revision returns `-32022` with requested and supported versions ([MCP 2026-07-28: Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)).
- Keep `tools/list` deterministic for the same authorization and underlying data, support its optional cursor, and let the SDK encode current cache fields on the wire ([MCP 2026-07-28: Listing tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#listing-tools)).
- Register every tool with an input schema and return at least `content`; if an output schema exists, return conforming `structuredContent`, while the SDK adds `resultType` ([MCP 2026-07-28: Calling tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#calling-tools)).
- Separate protocol failures from actionable tool failures. Unknown tools and malformed request parameters use JSON-RPC errors, while correctable API or domain failures return successful `tools/call` results with `isError: true` ([MCP 2026-07-28: Tool error handling](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling)).
- Use the narrow error code: `-32700` parse error, `-32600` invalid request, `-32601` unavailable method, `-32602` invalid params, `-32603` unexpected internal error, `-32020` header mismatch, `-32021` required capability missing, and `-32022` unsupported version ([MCP 2026-07-28: Errors](https://modelcontextprotocol.io/specification/2026-07-28/schema#errors)).
- Return HTTP 404 with a JSON-RPC `-32601` body for a parsed but unavailable modern method, and preserve the request ID; modern version, capability, and mirrored-header failures use HTTP 400 with their JSON-RPC error bodies ([Streamable HTTP, Protocol Version Header](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#protocol-version-header)).
- Run SDK-related Node tooling on Node.js 20 or newer. If Zod is selected for MCP-bound schemas, use Zod `>=4.2.0`; do not add AJV or explicit `jsonSchemaValidator` configuration for the normal Worker path because the SDK selects `@cfworker/json-schema` there ([TypeScript SDK v2 migration, packaging and schemas](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)).
- Apply `hostHeaderValidationResponse` and `originValidationResponse` before `handler.fetch`, authenticate independently, and pass `{ authInfo }` as the second argument. An absent `Origin` passes the Origin helper and therefore does not replace authentication ([Serve on web-standard runtimes, security and auth](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md#protect-against-dns-rebinding)).
- Verify modern behavior with `versionNegotiation: { mode: { pin: "2026-07-28" } }`; use `mode: "auto"` only when fallback interoperability is part of the requirement ([Protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)).
- Implement the legacy `initialize` -> `notifications/initialized` sequence only if legacy compatibility is deliberately enabled; it belongs to revision `2025-11-25`, not the modern request model ([MCP 2025-11-25: Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)).

### 4. Browser-side Markdown editor

**Evidence, verbatim:**

> The repository has no editor or frontend dependency incumbent. C:\Users\user\Downloads\cf-pastebin\worker.js generates the page, CSS, and browser JavaScript inline, and line 271 uses a native textarea; the repository has no package.json.
>
> Source: [Supplied repository observation](file:///C:/Users/user/Downloads/cf-pastebin/worker.js#L24-L279)

> OverType uses one textarea as the single source of truth and provides built-in normal edit, plain raw Markdown, and read-only preview modes through showNormalEditMode(), showPlainTextarea(), and showPreviewMode(); getValue() and setValue() operate on raw Markdown.
>
> Source: [OverType README, View Modes and Architecture](https://github.com/panphora/overtype#view-modes)

> OverType is a visual overlay, not a conventional contenteditable rich-text editor. Its official limitations require visible Markdown markers, monospace and fixed-size text, and omit rendered images in edit mode.
>
> Source: [OverType README, Limitations](https://github.com/panphora/overtype#limitations)

Constraints and consequences:

- Trial OverType `2.4.2` because it was maintained as of the research date, keeps raw Markdown as the textarea value, and ships ESM, CJS, IIFE, and Web Component builds suitable for a no-framework page ([OverType release commit](https://github.com/panphora/overtype/commit/61c08e5a526f5ede5755a87b004fa85c5c9b3cd6), [jsDelivr manifest](https://data.jsdelivr.com/v1/package/npm/overtype@2.4.2/flat)).
- Pin and self-host `dist/overtype.min.js`; the supplied artifact measurement is 133,251 bytes for that file, while Bundlephobia estimated 140,588 bytes minified and 38,699 bytes gzip ([jsDelivr manifest](https://data.jsdelivr.com/v1/package/npm/overtype@2.4.2/flat)).
- Load the editor asset only on the Markdown editing route and submit `editor.getValue()` as the stored Markdown. Mode switching does not require a Markdown-to-document-model round trip ([OverType view modes](https://github.com/panphora/overtype#view-modes)).
- Do not call OverType conventional hidden-syntax WYSIWYG. Adoption requires explicit acceptance of visible Markdown markers, monospace fixed-size editing, and no rendered images in edit mode ([OverType limitations](https://github.com/panphora/overtype#limitations)).
- Do not adopt TOAST UI Editor for new work. Although it is MIT-licensed, framework-independent, and has built-in Markdown/WYSIWYG switching, GitHub marks it archived, with its latest release at `3.2.2` from 2023 ([TOAST UI README](https://github.com/nhn/tui.editor/blob/master/README.md#why-toast-ui-editor), [TOAST UI repository metadata](https://api.github.com/repos/nhn/tui.editor)).
- TOAST UI's `changeMode`, `getMarkdown`, and `setMarkdown` APIs preserve Markdown as an interchange format, not a documented byte-for-byte source guarantee; its supplied Bundlephobia estimate was 545,724 bytes minified and 161,735 bytes gzip before CSS ([TOAST UI TypeScript API](https://github.com/nhn/tui.editor/blob/master/apps/editor/types/editor.d.ts), [TOAST UI Bundlephobia estimate](https://bundlephobia.com/api/size?package=%40toast-ui%2Feditor%403.2.2)).
- Keep Milkdown Crepe as the fallback only when hidden syntax, proportional rich text, or rendered inline images are mandatory. Milkdown is maintained and its Crepe API exposes Markdown, but raw whole-document source mode requires host code around `getMarkdown()` and `replaceAll()` ([Milkdown repository metadata](https://api.github.com/repos/Milkdown/milkdown), [Using Crepe](https://github.com/Milkdown/website/blob/main/docs/guide/using-crepe.md)).
- Do not promise lexical preservation after a Milkdown rich-text round trip because it parses Markdown through a Remark AST and ProseMirror document before serializing Markdown again ([Milkdown architecture](https://github.com/Milkdown/website/blob/main/docs/guide/architecture-overview.md#markdown-transformation)).
- Default Crepe adds a bundler and dependencies including Kit, Vue, CodeMirror, and KaTeX; the supplied Bundlephobia estimate was 1,475,906 bytes minified and 458,245 bytes gzip before optional language chunks ([Crepe package manifest](https://github.com/Milkdown/milkdown/blob/main/packages/crepe/package.json), [Crepe Bundlephobia estimate](https://bundlephobia.com/api/size?package=%40milkdown%2Fcrepe%407.22.1)).

### 5. Markdown rendering and XSS boundary

**Evidence, verbatim:**

> `micromark` is safe by default: raw HTML is rendered as text because `allowDangerousHtml` defaults to `false`, and unsafe link/image protocols are dropped because `allowDangerousProtocol` defaults to `false`. Its link allowlist is relative URLs plus `http`, `https`, `irc`, `ircs`, `mailto`, and `xmpp`; images allow relative URLs plus `http` and `https`.
>
> Source: [micromark README, Options and Security](https://github.com/micromark/micromark/blob/main/packages/micromark/readme.md)

> Bare `https://`, `www.`, and email links are not a core CommonMark feature. `micromark-extension-gfm-autolink-literal` adds exactly that syntax and HTML serialization; its documentation says the construct always produces safe links. The extension is ESM-only, `sideEffects: false`, and MIT-licensed.
>
> Source: [micromark GFM autolink literal extension](https://github.com/micromark/micromark-extension-gfm-autolink-literal/blob/main/readme.md)

> Current Marked has no `html: false` option. Its HTML renderer returns raw HTML tokens unchanged, its documentation says output is not sanitized, and the former `sanitize` and `sanitizer` options were removed in v8.
>
> Source: [Marked advanced options](https://marked.js.org/using_advanced#old-options)

Constraints and consequences:

- Use the smallest safe rendering set for the stated requirement:

```js
import { micromark } from "micromark";
import {
  gfmAutolinkLiteral,
  gfmAutolinkLiteralHtml,
} from "micromark-extension-gfm-autolink-literal";

export function renderMarkdown(markdown) {
  return micromark(markdown, {
    allowDangerousHtml: false,
    allowDangerousProtocol: false,
    extensions: [gfmAutolinkLiteral()],
    htmlExtensions: [gfmAutolinkLiteralHtml()],
  });
}
```

  The explicit flags preserve micromark's safe defaults, and the extension adds bare URL and email conversion without enabling full GFM ([micromark README](https://github.com/micromark/micromark/blob/main/packages/micromark/readme.md), [GFM autolink literal extension](https://github.com/micromark/micromark-extension-gfm-autolink-literal/blob/main/readme.md)).
- Never pass untrusted Markdown source directly to Hono's `raw()`. If `hono/html` must embed rendered Markdown, call `raw()` only on output produced by the fixed `renderMarkdown()` boundary above; Hono documents that `raw()` emits unchanged content and makes escaping the caller's responsibility ([Hono, html Helper](https://hono.dev/docs/helpers/html), [micromark security](https://github.com/micromark/micromark/blob/main/packages/micromark/readme.md)).
- Do not add a sanitizer while this exact micromark configuration and only documented safe extensions remain in place. Revisit that decision before enabling arbitrary HTML, `allowDangerousProtocol`, a renderer that emits user-controlled HTML, or an extension with different security properties ([micromark security](https://github.com/micromark/micromark/blob/main/packages/micromark/readme.md)).
- Add `micromark-extension-gfm` only if tables, footnotes, strikethrough, task lists, and the other bundled GFM features become product requirements; it pulls six feature extensions and requires both `gfm()` and `gfmHtml()` ([micromark full GFM extension](https://github.com/micromark/micromark-extension-gfm/blob/main/readme.md)).
- If full GFM is enabled, retain its default DOM-clobbering prefix and never set `clobberPrefix` to an empty string or allow user-controlled label markup ([micromark full GFM extension](https://github.com/micromark/micromark-extension-gfm/blob/main/readme.md)).
- `markdown-it` remains a safe fallback with `{ html: false, linkify: true }`; its URL policy rejects several dangerous schemes but permits unknown schemes, so micromark's allowlist is the more conservative policy for untrusted paste links ([markdown-it safety guide](https://github.com/markdown-it/markdown-it/blob/master/docs/safety.md)).
- `markdown-it` supplies ESM and browser builds with six runtime dependencies and ordinary CommonMark plus selected extensions, not a single exact-GitHub-parity mode ([markdown-it package metadata](https://github.com/markdown-it/markdown-it/blob/master/package.json), [markdown-it syntax extensions](https://github.com/markdown-it/markdown-it/blob/master/README.md#syntax-extensions)).
- Do not use Marked without a Worker-compatible sanitizer after rendering. Marked passes raw HTML through, and its current URL helper applies `encodeURI` without rejecting dangerous schemes ([Marked advanced options](https://marked.js.org/using_advanced#old-options), [Marked URL helper](https://github.com/markedjs/marked/blob/master/src/helpers.ts)).
- Marked's zero runtime dependencies and default GFM support do not outweigh the sanitizer requirement for untrusted content, even though Marked `18.0.12` was current and maintained in the supplied research ([Marked package metadata](https://github.com/markedjs/marked/blob/master/package.json), [Marked 18.0.12 release](https://github.com/markedjs/marked/releases/tag/v18.0.12)).
- Treat published package sizes only as directional. Core micromark is described as about 14 KB and both micromark packages are ESM-only and tree-shakeable, but the actual Worker artifact must be measured through Wrangler's dry run ([micromark package metadata](https://github.com/micromark/micromark/blob/main/packages/micromark/package.json), [Wrangler bundling](https://developers.cloudflare.com/workers/wrangler/bundling/)).
- Maintenance did not disqualify micromark or markdown-it on the research date: their official repositories were unarchived and had current pushes, although micromark core's latest release was `4.0.2` from 2025 ([micromark repository metadata](https://api.github.com/repos/micromark/micromark), [markdown-it repository metadata](https://api.github.com/repos/markdown-it/markdown-it)).

### 6. Local development and testing

**Evidence, verbatim:**

> `wrangler dev` starts a local Miniflare-backed server, executes the Worker locally in `workerd`, and exposes it at `localhost:8787` by default. Bindings from the Wrangler configuration are locally simulated unless a binding is explicitly configured as remote.
>
> Source: [Cloudflare Workers: Local development](https://developers.cloudflare.com/workers/local-development/)

> Cloudflare recommends the Workers Vitest integration for most Workers tests. The current package is `@cloudflare/vitest-plugin`, it requires Vitest `^4.1.0`, runs tests locally using Miniflare, and provides Workers runtime APIs and bindings.
>
> Source: [Cloudflare Workers: Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)

> `SELF` and `env` imports from `cloudflare:test` are deprecated. Current integration tests import `exports` and `env` from `cloudflare:workers`; `exports.default.fetch()` replaces `SELF.fetch()`.
>
> Source: [Migrate from Vitest 3 to Vitest 4](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/)

Constraints and consequences:

- Keep `wrangler.jsonc` as the single source of truth for `main`, `compatibility_date`, and the `PASTES` KV binding; local code receives the binding through `env.PASTES` ([Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)).
- Configure Vitest with `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })` in the Vite `plugins` array, and omit Miniflare overrides until a test-only binding or behavior is necessary ([Write your first test](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)).
- Use `exports.default.fetch()` for the main HTTP integration layer. It runs in the same isolate and context as the test runner, so add Cloudflare's auxiliary Worker pattern only if separate-global-scope behavior itself needs testing ([Workers SDK unit and integration example](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/basics-unit-integration-self)).
- Verify request-to-KV behavior through public PUT/POST and GET routes with `exports.default.fetch()`; Cloudflare's current fixture covers status and body assertions without a separate direct-Miniflare layer ([KV, R2, and Cache tests](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/kv-r2-caches)).
- Seed KV directly only when setup cannot use the public route, by importing `env` from `cloudflare:workers`; Workers Vitest storage is isolated per test file and is not the state previously created by `wrangler dev` ([Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)).
- Use `npx wrangler dev --local --port 8787 --show-interactive-dev-session=false` for a smoke server that cannot reach any `remote: true` binding. The process remains long-running and must be supervised and terminated by the harness ([Local development](https://developers.cloudflare.com/workers/local-development/)).
- Accept default local persistence under `.wrangler/state` unless a separate directory is required. When using `--persist-to`, pass the same path to both `wrangler dev` and every local KV command ([Adding local data](https://developers.cloudflare.com/workers/local-development/local-data/)).
- Use explicit one-shot checks: `npx vitest run`, `npx wrangler types --check`, and `npx wrangler deploy --dry-run --outdir dist`; Vitest documents `vitest run` as non-watch execution, and Wrangler returns useful status for type freshness and dry-run compilation ([Vitest CLI](https://vitest.dev/guide/cli), [Local development](https://developers.cloudflare.com/workers/local-development/)).
- Do not install `@cloudflare/vitest-pool-workers` in a new setup. The plugin replaces it; the codemod is only for an existing pool-workers migration ([Migrate to Vitest plugin](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/)).
- Do not add direct Miniflare alongside the plugin for ordinary tests. Direct Miniflare keeps the test in Node.js, requires lifecycle management through `ready`, `dispatchFetch()`, and `dispose()`, and is justified only for lower-level runner or isolate control ([Writing tests with Miniflare](https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/)).

### 7. HTTP application structure

**Evidence, verbatim:**

> Hono runs directly as a Cloudflare Worker and can be exported as the module's fetch handler; its official starter uses Wrangler and TypeScript without requiring a frontend framework.
>
> Source: [Hono, Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)

> The `hono/html` tagged template renders server-side HTML, supports reusable functions, and reserves `raw()` for deliberately unescaped output.
>
> Source: [Hono, html Helper](https://hono.dev/docs/helpers/html)

> Hono's validator can validate form, JSON, query, header, path parameter, and cookie inputs, but the documentation explicitly calls it “very thin” and recommends third-party validators for richer schemas.
>
> Source: [Hono, Validation](https://hono.dev/docs/guides/validation)

Constraints and consequences:

- Use normal `import { Hono } from "hono"` first. Treat `hono/tiny` as a later measured optimization; Hono reports zero runtime dependencies and an under-12-kB tiny preset, but that is not this application's measured bundle ([Hono repository README](https://github.com/honojs/hono/blob/main/README.md)).
- Use Hono method handlers and path parameters for the editor, create, shell, protected-content, and error routes. Hono routes and middleware execute in registration order, so register specific routes before wildcard fallbacks ([Hono, Routing](https://hono.dev/docs/api/routing)).
- Use `hono/html` initially. Do not add JSX, `jsxRenderer`, streaming, Suspense, or layout middleware until the page has enough genuine component or layout reuse to justify `.tsx` and JSX configuration ([Hono, JSX](https://hono.dev/docs/guides/jsx), [Hono, html Helper](https://hono.dev/docs/helpers/html)).
- Use Hono's thin validator for one paste string, its required check, content type, and explicit byte-size limit. Do not add a general schema library solely for that form ([Hono, Validation](https://hono.dev/docs/guides/validation)).
- Use `app.request()` for direct route tests. Adopt `testClient()` only if typed request calls add value, because route-specific inference depends on chained route definitions ([Hono, Testing Helper](https://hono.dev/docs/helpers/testing)).
- Keep Wrangler as the only build pipeline. Cloudflare recommends the Vite plugin when a project already uses Vite or needs its transformations, HMR, and plugin pipeline, while direct Wrangler fits a project without Vite ([Wrangler versus Vite](https://developers.cloudflare.com/workers/local-development/wrangler-vs-vite/)).
- Do not copy Cloudflare's featured Hono plus React SPA template for this use case. Its official support does not make React or Vite a Worker platform requirement ([Cloudflare Workers, Hono](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/), [Hono, Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)).
- Do not create an SPA shell, client router, or hydration layer for one server-rendered editor. Cloudflare describes an SPA as client-rendered output with JavaScript bundles, fallback routing, client resources, and client API fetches, all of which are unnecessary for the basic paste form ([Single Page Application](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)).
- A framework-free `fetch` handler remains the shorter fallback only if the final product collapses to one fixed GET and one fixed POST; Cloudflare's own example routes that scale with `new URL(request.url)` and a pathname condition ([Cloudflare Workers React guide, API Worker](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/#add-your-api-worker)).

### 8. Per-tab, memory-only password gate

**Evidence, verbatim:**

> `sessionStorage` is partitioned by origin and top-level browsing context, and its page session survives reloads and restores until the tab or window closes.
>
> Source: [Window: sessionStorage property](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)

> An HTML hyperlink follows its serialized `href` URL through the navigation algorithm. `<a>` exposes URL, target, download, relation, and referrer controls, but no author-defined request-header field.
>
> Source: [Links, WHATWG HTML Standard](https://html.spec.whatwg.org/multipage/links.html#following-hyperlinks)

> Fetch's `navigate` mode is reserved for document navigation. Supplying `mode: "navigate"` to the script-facing `Request` constructor throws a `TypeError`.
>
> Source: [Fetch Standard, Request class](https://fetch.spec.whatwg.org/#request-class)

> Blob URLs can represent fetched in-memory bytes, can be navigated to, and can trigger downloads. Their backing object remains available until revoked or the creating document unloads.
>
> Source: [blob: URLs](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob)

Constraints and consequences:

- Serve public, secret-free shell routes such as `GET /p/:id`, `/p/:id/raw`, `/p/:id/html`, and `/p/:id/file`; each shell prompts in its own document before requesting protected bytes. Normal links and open-in-new-tab actions must target those shell routes, not the protected endpoint ([Links](https://html.spec.whatwg.org/multipage/links.html#following-hyperlinks)).
- Use one protected same-origin endpoint: `GET /api/p/:id/content?representation=raw|html|file`. Send `Authorization: Bearer <base64url(UTF-8(password), no padding)>` on each fetch; `Authorization` is the standard request header for credentials and is script-settable ([Authorization header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Authorization), [Using the Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#setting_headers)).
- Treat the base64url value only as reversible, header-safe transport encoding, not as password protection. The server-side password verification and secret-storage design is a missing domain in this research packet.
- Return `401` plus `WWW-Authenticate: Bearer realm="paste"` for missing or wrong credentials, without protected content; the `Authorization` header is defined for credentials granting access to protected resources ([Authorization header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Authorization)).
- Keep the password in a module-scoped JavaScript variable only. Do not store it in `sessionStorage`, `localStorage`, `window.name`, or a URL; strict volatile-only storage means reload, hard navigation, and a separately opened tab require another prompt ([Window: sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage), [Web storage](https://html.spec.whatwg.org/multipage/webstorage.html#the-sessionstorage-attribute)).
- Use History API routing only if same-document view changes must retain the in-memory value. Browser session history otherwise records pages visited by the tab or frame ([History API](https://developer.mozilla.org/en-US/docs/Web/API/History_API)).
- Never accept the password in a query parameter. A query is part of the URL, same-origin referrers can include its path and query under the default policy, and a URL navigation becomes browser history state; `Referrer-Policy: no-referrer` suppresses one disclosure path but does not remove the credential from the URL, copied link, address bar, or history ([Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy), [Referer](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referer), [History API](https://developer.mozilla.org/en-US/docs/Web/API/History_API)).
- Keep the shell and protected API on the same origin and do not redirect protected requests across origins. `Authorization` is not CORS-safelisted, cross-origin use requires preflight and explicit `Access-Control-Allow-Headers: Authorization`, and browsers strip the header on a cross-origin redirect ([Access-Control-Allow-Headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Headers), [Authorization header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Authorization)).
- Raw view: authorized fetch -> read text -> place it in a text-only DOM node. Do not navigate directly to the protected endpoint because hyperlinks and address-bar navigation cannot add the in-memory header ([Links](https://html.spec.whatwg.org/multipage/links.html#following-hyperlinks)).
- Markdown HTML view: authorized fetch -> render the safe micromark output inside the shell. Do not enable arbitrary stored HTML until its separate sandbox and active-content policy is defined ([micromark security](https://github.com/micromark/micromark/blob/main/packages/micromark/readme.md)).
- File view: authorized fetch -> `Response.blob()` -> temporary blob URL -> `<a download>` -> revoke after the browser no longer needs it. Exact save, prompt, open, and filename behavior varies across browsers and user settings ([blob: URLs](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob), [`<a>` download](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a#download)).
- Do not open an already-created blob URL as the product's new-tab action because it displays already-fetched bytes without prompting in the destination document; link to the public shell route instead ([blob: URLs](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob)).
- Do not assume HTML subresources inherit the parent authorized fetch. Scripts, styles, images, frames, and media are separate requests, so protected dependencies require their own application-controlled fetches; the minimal HTML boundary is self-contained content ([Fetch Standard, request destinations](https://fetch.spec.whatwg.org/#destination-table)).

## Architecture consequences

### Worker entry and routing

Use one ES module entry and one small top-level dispatcher:

1. Parse the request URL once. Requests to `/mcp` go through pathname and method checks, Host validation, Origin validation, authentication, and then `mcpHandler.fetch(request, { authInfo })` ([Serve on web-standard runtimes](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md), [MCP security and auth](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md#protect-against-dns-rebinding)).
2. All paste UI and data requests go to `app.fetch(request, env, ctx)` on one Hono application; Hono runs directly on Workers and supports ordered method/path routing ([Hono, Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers), [Hono, Routing](https://hono.dev/docs/api/routing)).
3. Keep reusable immutable parser configuration at module scope, but do not keep request identity, MCP capabilities, passwords, or consumption state in isolate globals because MCP metadata is request-scoped and Worker execution contexts can be reused ([MCP RequestMetaObject](https://modelcontextprotocol.io/specification/2026-07-28/schema#requestmetaobject), [Migrate to module Workers](https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/)).

### Paste route surface

Implement only the routes needed by the selected browser contract:

- `GET /`: render the create/editor page with `hono/html` and lazy-load the self-hosted OverType asset only on this route ([Hono, html Helper](https://hono.dev/docs/helpers/html), [OverType jsDelivr manifest](https://data.jsdelivr.com/v1/package/npm/overtype@2.4.2/flat)).
- `POST /p`: accept the paste field, verify its type and required status, calculate UTF-8 bytes, enforce a product limit no greater than 25 MiB, and write one awaited KV entry with small non-secret metadata and one absolute expiration ([Hono, Validation](https://hono.dev/docs/guides/validation), [KV write limits](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)).
- `GET /p/:id`, `/p/:id/raw`, `/p/:id/html`, `/p/:id/file`: return only the public shell and never the protected bytes ([Links](https://html.spec.whatwg.org/multipage/links.html#following-hyperlinks)).
- `GET /api/p/:id/content`: require `Authorization`, accept only `representation=raw|html|file`, and return `401` without content for missing or wrong credentials ([Authorization header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Authorization)).
- `POST /mcp`: delegate through the guarded modern SDK handler; `GET /mcp` and `DELETE /mcp` return 405 in the modern-only posture ([MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).
- Register a final Hono fallback after all specific routes because route and middleware order is significant ([Hono, Routing](https://hono.dev/docs/api/routing)).

### Storage and consumption flow

- Ordinary paste: Hono validation -> one `env.PASTES.put(key, content, { metadata, expiration })` -> later `getWithMetadata()` -> response. This stays within one KV entry's lifecycle and avoids an independently inconsistent sibling ([Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/), [Read key-value pairs](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)).
- Optional oversized metadata: two awaited writes with one absolute expiration -> reads tolerate paste-only, metadata-only, stale, and missing states -> cleanup awaits both deletes. This is failure-tolerant coordination, not a transaction ([Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/), [Delete key-value pairs](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/), [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)).
- Strict view-once: request -> Durable Object authority -> one atomic consume decision -> optional KV cleanup or projection. Do not serve a KV hit before the authority approves consumption ([How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)).
- Expiration: reject TTLs below 60 seconds, calculate one absolute expiration for every related key, and treat observed deletion time as eventually consistent across locations ([Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/), [Delete key-value pairs](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/)).

### Rendering boundary

- Stored bytes remain Markdown. Normal edit, source, and preview mode read and write that same Markdown value through OverType ([OverType view modes](https://github.com/panphora/overtype#view-modes)).
- Raw representation returns the stored Markdown with `text/plain; charset=utf-8`; browser code assigns it to `textContent`, not HTML ([Using the Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#setting_headers)).
- HTML representation means Markdown rendered by the fixed micromark configuration. Raw stored HTML remains disabled because Marked-style pass-through or Hono `raw()` on untrusted source would cross the selected safety boundary ([micromark security](https://github.com/micromark/micromark/blob/main/packages/micromark/readme.md), [Hono, html Helper](https://hono.dev/docs/helpers/html)).
- File representation returns the original selected media type and a `Content-Disposition: attachment` response, which browser code converts to a temporary blob URL for download ([blob: URLs](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob), [`<a>` download](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a#download)).

### Limit interactions

- Application upload validation must satisfy both the account-plan request-body ceiling and KV's 25 MiB value ceiling; the lower selected application ceiling controls ([Limits, request and response](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits), [KV write limits](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)).
- Streaming protects the 128 MB isolate memory ceiling but does not bypass CPU, subrequest, or KV value limits ([Limits, request and response](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits), [Limits, CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time), [KV write limits](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)).
- `ctx.waitUntil()` is suitable only for bounded post-response work that fits its 30-second extension; correctness-critical KV writes and deletes must be awaited in the request path ([Limits, duration](https://developers.cloudflare.com/workers/platform/limits/#duration), [Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/), [Delete key-value pairs](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/)).

## Selected dependencies

| Dependency | Role | Selection reason |
|---|---|---|
| `hono` | Worker routing, thin form validation, server-rendered HTML. | It runs directly on Cloudflare Workers, has zero runtime dependencies, exposes focused subpaths, and avoids React/Vite for this route count ([Hono README](https://github.com/honojs/hono/blob/main/README.md), [Hono, Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)). |
| `micromark` | Markdown-to-HTML renderer. | ESM-only, Worker-compatible, raw HTML off by default, and unsafe protocols off by default ([micromark package metadata](https://github.com/micromark/micromark/blob/main/packages/micromark/package.json), [micromark security](https://github.com/micromark/micromark/blob/main/packages/micromark/readme.md)). |
| `micromark-extension-gfm-autolink-literal` | Bare URLs, `www.` links, and emails. | It adds the requested direct-link behavior without tables, task lists, footnotes, or the full GFM extension graph ([GFM autolink literal extension](https://github.com/micromark/micromark-extension-gfm-autolink-literal/blob/main/readme.md)). |
| `@modelcontextprotocol/server` v2 | Stateless modern MCP endpoint. | It is the stable SDK line for MCP `2026-07-28`, and `createMcpHandler` supplies the web-standard Worker handler and fresh per-request `McpServer` factory ([SDK README](https://github.com/modelcontextprotocol/typescript-sdk), [Serve on web-standard runtimes](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md)). |
| Zod `^4.2.0`, only when MCP tool schemas are added | MCP input/output schemas. | SDK v2 supports Standard Schema and documents Zod `>=4.2.0`; Zod v3 is unsupported ([SDK v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)). |
| OverType `2.4.2`, pinned self-hosted browser asset | Hybrid visual/source/preview Markdown editing. | It is maintained, keeps a textarea as source of truth, and ships a self-contained IIFE considerably smaller than the evaluated full rich-text alternatives ([OverType release](https://github.com/panphora/overtype/commit/61c08e5a526f5ede5755a87b004fa85c5c9b3cd6), [OverType view modes](https://github.com/panphora/overtype#view-modes), [jsDelivr manifest](https://data.jsdelivr.com/v1/package/npm/overtype@2.4.2/flat)). |
| `wrangler`, exact resolution pinned by the lockfile | Build, local server, type generation, dry-run, and deployment. | Wrangler bundles npm imports by default and exposes the exact upload artifact through dry-run output ([Wrangler bundling](https://developers.cloudflare.com/workers/wrangler/bundling/)). |
| `vitest@^4.1.0` and `@cloudflare/vitest-plugin` | Worker unit and fetch integration tests. | This is Cloudflare's current recommended test integration and provides runtime APIs and configured bindings in local Miniflare/workerd execution ([Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)). |

Do not add React, Vite, AJV, a standalone sanitizer, or direct Miniflare in the initial dependency set; each is unnecessary under the selected Hono, micromark, SDK Worker-validator, and Vitest plugin paths ([Wrangler versus Vite](https://developers.cloudflare.com/workers/local-development/wrangler-vs-vite/), [micromark security](https://github.com/micromark/micromark/blob/main/packages/micromark/readme.md), [SDK v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md), [Writing tests with Miniflare](https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/)).

## Rejected alternatives

| Alternative | Decision and reason |
|---|---|
| Service-worker syntax | Rejected. Module syntax provides `env` and `ctx`, reuses execution contexts, and is required by `wrangler versions upload` ([Migrate to module Workers](https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/), [Deployment management](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/#service-worker-syntax)). |
| `wrangler deploy --no-bundle` | Rejected. It removes import processing, minification, and Node polyfill injection without replacing them with another build pipeline ([Disable bundling](https://developers.cloudflare.com/workers/wrangler/bundling/#disable-bundling)). |
| React/Vite SPA | Rejected. One server-rendered editor does not need client routing, hydration, an SPA fallback, or Vite's plugin pipeline ([Single Page Application](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/), [Wrangler versus Vite](https://developers.cloudflare.com/workers/local-development/wrangler-vs-vite/)). |
| Bare `fetch` pathname branches | Rejected for the current planned route surface because Hono already supplies ordered method routing, path parameters, shared handling, and safe HTML helpers; reconsider only if the application collapses to one fixed GET and POST ([Hono, Routing](https://hono.dev/docs/api/routing), [Cloudflare API Worker example](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/#add-your-api-worker)). |
| Hono JSX and `jsxRenderer` | Deferred. The initial page does not require component, nested-layout, streaming, Suspense, or ErrorBoundary machinery ([Hono, JSX](https://hono.dev/docs/guides/jsx)). |
| Sibling KV metadata key by default | Rejected. It creates two independent writes, visibility timelines, expirations, and deletes without transactionality ([Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/), [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)). |
| KV read-then-delete for strict view-once | Rejected. Eventual consistency, cached negative and stale reads, idempotent delete, and one-write-per-second behavior cannot establish one consumer ([How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [Delete key-value pairs](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/), [Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)). |
| TOAST UI Editor | Rejected for new adoption because the repository is archived despite its strong built-in Markdown/WYSIWYG mode fit ([TOAST UI repository metadata](https://api.github.com/repos/nhn/tui.editor), [TOAST UI README](https://github.com/nhn/tui.editor/blob/master/README.md#why-toast-ui-editor)). |
| Milkdown Crepe as the default editor | Rejected for the initial implementation because whole-document source mode requires host synchronization and the default package has a much larger dependency and bundle profile; retain it as the fallback for strict hidden-syntax rich editing ([Using Crepe](https://github.com/Milkdown/website/blob/main/docs/guide/using-crepe.md), [Crepe package manifest](https://github.com/Milkdown/milkdown/blob/main/packages/crepe/package.json), [Crepe Bundlephobia estimate](https://bundlephobia.com/api/size?package=%40milkdown%2Fcrepe%407.22.1)). |
| Full `micromark-extension-gfm` | Deferred until the product requires its six bundled feature families; direct links alone use the narrower extension ([micromark full GFM extension](https://github.com/micromark/micromark-extension-gfm/blob/main/readme.md), [GFM autolink literal extension](https://github.com/micromark/micromark-extension-gfm-autolink-literal/blob/main/readme.md)). |
| `markdown-it` | Rejected for the default renderer because micromark offers a stricter allowlist and a narrower direct-link feature graph; `markdown-it` remains a safe fallback with HTML disabled ([markdown-it safety guide](https://github.com/markdown-it/markdown-it/blob/master/docs/safety.md), [micromark security](https://github.com/micromark/micromark/blob/main/packages/micromark/readme.md)). |
| Marked without sanitizer | Rejected. Current Marked passes raw HTML through, has no `html: false` option, and does not reject URL schemes in `cleanUrl` ([Marked advanced options](https://marked.js.org/using_advanced#old-options), [Marked URL helper](https://github.com/markedjs/marked/blob/master/src/helpers.ts)). |
| `sessionStorage` password persistence | Rejected under the strict memory-only requirement because it survives reloads/restores and can be copied to a newly created auxiliary context from its opener ([Window: sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage), [Web storage](https://html.spec.whatwg.org/multipage/webstorage.html#the-sessionstorage-attribute)). |
| Password in URL query | Rejected because the query enters the addressable URL, same-origin referrers can include it, and navigation records it in session history ([Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy), [Referer](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referer), [History API](https://developer.mozilla.org/en-US/docs/Web/API/History_API)). |
| Direct protected `<a href>` | Rejected because an anchor cannot attach the document's in-memory `Authorization` header, and script-facing `fetch` cannot request `mode: "navigate"` ([Links](https://html.spec.whatwg.org/multipage/links.html#following-hyperlinks), [Fetch Request class](https://fetch.spec.whatwg.org/#request-class)). |
| MCP v1 `@modelcontextprotocol/sdk` | Rejected. New MCP `2026-07-28` server work uses the stable split v2 server package ([Official SDK README](https://github.com/modelcontextprotocol/typescript-sdk)). |
| MCP session map, `Mcp-Session-Id`, GET stream, DELETE termination, or `Last-Event-ID` | Rejected for the modern endpoint because those belong to older sessionful transport semantics, while current MCP is request-scoped ([MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [Sessions, state, and scaling](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md)). |
| Direct Miniflare plus `node --test` | Rejected for ordinary coverage because the current Vitest plugin already runs Worker code and configured bindings locally; direct Miniflare is reserved for lower-level lifecycle or separate-runner control ([Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/), [Writing tests with Miniflare](https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/)). |

## Conservative conflict resolutions

1. **Node compatibility is automatic, but not complete.** Omit redundant positive flags for `2026-09-12`, then test every dependency's executed Node API path; successful bundling is not runtime proof ([Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#get-started), [Supported Node.js APIs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#supported-nodejs-apis)).
2. **Worker responses have no size cap, but memory and cache do.** Stream where possible and enforce the lower application and KV limits; never buffer based on the absence of a response-body ceiling ([Limits, request and response](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits), [KV write limits](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)).
3. **Equal KV expirations align deadlines, but not commits or visibility.** Prefer attached metadata; when sibling keys are unavoidable, model partial and stale states explicitly ([Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/), [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)).
4. **KV is suitable for expiring pastes, but not strict consumption.** Keep ordinary pastes in KV and move only the consume authority to a Durable Object when strict view-once is required ([How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)).
5. **OverType is lightweight and source-preserving, but not conventional WYSIWYG.** Trial it only if visible syntax and edit-mode limitations are acceptable; otherwise pay the Milkdown host-code and bundle cost rather than mislabeling the experience ([OverType limitations](https://github.com/panphora/overtype#limitations), [Using Crepe](https://github.com/Milkdown/website/blob/main/docs/guide/using-crepe.md)).
6. **micromark output is safe under the selected closed configuration, while Hono `raw()` is intentionally unescaped.** Never pass stored source to `raw()`; pass only output from the fixed renderer and reopen the sanitizer decision if its options or extensions change ([micromark security](https://github.com/micromark/micromark/blob/main/packages/micromark/readme.md), [Hono, html Helper](https://hono.dev/docs/helpers/html)).
7. **Modern MCP removes sessions, while the SDK defaults to legacy fallback.** Select `{ legacy: "reject" }` because no legacy-client requirement is supplied, and test with a client pinned to `2026-07-28` ([Protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md), [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).
8. **Strict in-memory credentials conflict with reload continuity and native direct navigation.** Keep the password only in the current document, re-prompt after a new document, and make public shell URLs the navigable surface ([Window: sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage), [Links](https://html.spec.whatwg.org/multipage/links.html#following-hyperlinks)).
9. **Hono is more code than two pathname checks, but the selected route surface is larger than two fixed routes.** Use Hono now; remove it if the final implementation truly reduces to one GET and one POST ([Hono, Routing](https://hono.dev/docs/api/routing), [Cloudflare API Worker example](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/#add-your-api-worker)).
10. **An open HTTP stream avoids a wall-time cutoff, but not CPU or subrequest ceilings.** Do not use streaming as a substitute for CPU budgeting or bounded post-response work ([Limits, duration](https://developers.cloudflare.com/workers/platform/limits/#duration), [Limits, CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time), [Limits, subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests)).

## Missing domains

The following domains have no supplied primary URL. They remain undecided and must not be inferred from adjacent research:

- **Paste identifier generation and enumeration resistance:** no algorithm, entropy target, collision policy, or disclosure model was supplied.
- **Server-side password security:** no password KDF, verifier format, encryption-at-rest design, Worker secret binding, rotation plan, or timing-attack guidance was supplied.
- **Durable Object design:** the supplied KV source recommends Durable Objects for stronger consistency, but no Durable Object API, transaction, placement, storage, pricing, or failure-recovery research was supplied.
- **Abuse controls:** no rate limiting, bot defense, quota, moderation, content reporting, or denial-of-service policy was supplied.
- **Arbitrary HTML security:** the Markdown renderer is covered, but sandboxing, CSP, active content, protected subresources, and user-authored HTML execution policy were not researched. Keep arbitrary HTML disabled.
- **Product retention and deletion policy:** no default TTL, maximum TTL, legal retention, backup, erasure, or audit requirements were supplied.
- **Observability and incident response:** no logging, analytics, metrics, tracing, redaction, alerting, or emergency disablement requirements were supplied.
- **MCP tool contract:** no pastebin tool names, authorization scopes, schemas, pagination policy, or cache lifetime was supplied. Select the SDK foundation now, but do not invent the tool surface.
- **Accessibility and browser support target:** no required browsers, assistive-technology baseline, keyboard behavior, or mobile support matrix was supplied.
- **Production application size limit:** platform ceilings are supplied, but no product-owned maximum paste size is supplied. Choose and document a lower limit before implementation.
- **Migration compatibility:** the supplied repository observation identifies the current inline Worker surface, but no current route, data, key, or URL compatibility contract was supplied, and this synthesis did not rescan repository source.

## Unresolved empirical checks

| Check | Pass condition | Source basis |
|---|---|---|
| Wrangler artifact | `npx wrangler deploy --dry-run --outdir dist` reports an uncompressed upload below 64 MiB, and inspection finds no unintended dependency or asset. | Wrangler's `Total Upload` is the measured uncompressed value ([Worker size limits](https://developers.cloudflare.com/workers/platform/limits/#worker-size), [Bundling](https://developers.cloudflare.com/workers/wrangler/bundling/)). |
| Startup profile | The bundled Worker parses and completes top-level initialization within the separate one-second startup limit. | Cloudflare applies a one-second startup ceiling independent of upload size ([Worker size limits](https://developers.cloudflare.com/workers/platform/limits/#worker-size)). |
| Target plan | Record the account plan, Workers billing plan, and legacy usage model; verify request-body, CPU, and subrequest ceilings against that exact combination. | Request size follows the Cloudflare account plan, while CPU/subrequest limits vary by Workers plan and legacy model ([Request and response limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits), [CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time), [Unbound and Bundled limits](https://developers.cloudflare.com/workers/platform/limits/#unbound-and-bundled-plan-limits)). |
| CPU and memory | Exercise maximum accepted pastes through validation, password verification, Markdown rendering, raw view, file response, and MCP calls without exceeding target CPU or 128 MB isolate memory. | CPU excludes network wait, while whole-body buffering counts against isolate memory ([CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time), [Request and response limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits)). |
| Node-dependent code paths | Every selected dependency's real import and executed methods work in `workerd`; no path reaches a stub or unimplemented `unenv` method. | Node imports may succeed while invoked methods do nothing or throw ([Supported Node.js APIs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#supported-nodejs-apis)). |
| Paste byte limit | Choose a product maximum no greater than 25 MiB and verify exact-boundary UTF-8 byte cases through the public create route. | KV values are capped at 25 MiB ([Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)). |
| Metadata envelope | Serialize representative metadata and verify it remains at or below 1,024 bytes; otherwise decide whether to reduce it or accept sibling-key partial states. | Attached metadata is capped after JSON serialization ([Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)). |
| Expiration | Verify the UI rejects TTLs below 60 seconds, related keys receive one identical epoch expiration, and stale reads are handled without claiming synchronous deletion. | KV has a 60-second minimum expiration target and eventual propagation ([Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/), [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)). |
| Strict view-once | After Durable Object research and implementation, issue concurrent reads from multiple locations and prove exactly one authorized consume result; KV must not be the deciding read. | Cloudflare says KV cannot supply the required atomic transaction ([How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)). |
| OverType acceptance | Test representative Markdown, paste/undo, source/edit/preview transitions, focus, selection, mobile keyboards, accessibility, large documents, and the visible-marker/no-inline-image limitations. | OverType's official architecture and limitations make this a provisional UX choice ([OverType view modes](https://github.com/panphora/overtype#view-modes), [OverType limitations](https://github.com/panphora/overtype#limitations)). |
| Editor asset | Vendor the pinned `2.4.2` artifact, verify its integrity and loading under the final CSP, and measure transferred bytes from the editor route rather than relying on Bundlephobia. | Published artifacts and Bundlephobia are not the final production Worker/page build ([jsDelivr manifest](https://data.jsdelivr.com/v1/package/npm/overtype@2.4.2/flat)). |
| Markdown security corpus | Test raw HTML, dangerous and unknown protocols, entities, malformed links, autolinks, and every enabled extension; prove only the fixed renderer output reaches `raw()`. | The no-sanitizer decision is conditional on micromark's safe options and extension behavior ([micromark security](https://github.com/micromark/micromark/blob/main/packages/micromark/readme.md), [GFM autolink extension](https://github.com/micromark/micromark-extension-gfm-autolink-literal/blob/main/readme.md)). |
| Link policy | Decide whether relative, `mailto`, IRC, XMPP, and GFM-generated `http://` links are acceptable, or add a stricter HTTPS-only product policy. | micromark's default safe list is broader than HTTPS-only ([micromark security](https://github.com/micromark/micromark/blob/main/packages/micromark/readme.md)). |
| Password behavior | In each target browser, prove one prompt per live document, another prompt after reload and new-tab shell navigation, no credential in storage/URL/history, 401 on direct protected navigation, and header stripping on cross-origin redirect. | These behaviors follow the selected memory-only and `Authorization` contract ([Window: sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage), [Authorization header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Authorization), [Links](https://html.spec.whatwg.org/multipage/links.html#following-hyperlinks)). |
| Blob download | Test filename, save/open prompt, revocation timing, cancellation, and large-file memory behavior in each supported browser. | Browser and user settings can vary download behavior, and blob URLs live until revoked or document unload ([`<a>` download](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a#download), [blob: URLs](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob)). |
| HTML dependencies | Confirm HTML representation is micromark output or otherwise self-contained; any protected scripts, styles, images, media, or frames need a separately designed authenticated loading path. | Subresources are independent fetches and do not inherit the parent's `Authorization` header ([Fetch request destinations](https://fetch.spec.whatwg.org/#destination-table)). |
| MCP modern wire path | Test with a v2 client pinned to `2026-07-28`, covering `server/discover`, required `_meta`, mirrored headers, JSON and SSE acceptance, 405 GET/DELETE, 404 `-32601`, 400 `-32020/-32021/-32022`, tool errors, and no session state. | A default v2 client still exercises legacy initialization unless version negotiation is configured ([Protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md), [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)). |
| MCP legacy requirement | Identify actual clients before retaining stateless legacy fallback; if none require it, keep `{ legacy: "reject" }`. | `createMcpHandler` defaults to dual-era stateless behavior, while modern-only behavior is explicit ([Protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)). |
| Host, Origin, and auth | Define exact allowed hosts/origins and auth scopes, then test missing, malformed, and hostile values before handler delegation. | `createMcpHandler` does not perform Host, Origin, or token authentication itself ([MCP SDK security and auth](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md#protect-against-dns-rebinding)). |
| Local checks | `npx vitest run`, `npx wrangler types --check`, local KV seed/get, and a supervised `wrangler dev --local` HTTP smoke all exit successfully without contacting remote bindings. | These are the supplied one-shot and deterministic local paths ([Vitest CLI](https://vitest.dev/guide/cli), [Local development](https://developers.cloudflare.com/workers/local-development/), [Adding local data](https://developers.cloudflare.com/workers/local-development/local-data/)). |

## Source list

### Cloudflare Worker runtime and deployment

- [Migrate from Service Workers to ES Modules](https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/)
- [Deployment management](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/#service-worker-syntax)
- [Wrangler bundling](https://developers.cloudflare.com/workers/wrangler/bundling/)
- [Wrangler configuration, bundling](https://developers.cloudflare.com/workers/wrangler/configuration/#bundling)
- [Including non-JavaScript modules](https://developers.cloudflare.com/workers/wrangler/bundling/#including-non-javascript-modules)
- [Disable bundling](https://developers.cloudflare.com/workers/wrangler/bundling/#disable-bundling)
- [Worker size and startup limits](https://developers.cloudflare.com/workers/platform/limits/#worker-size)
- [CPU time limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
- [Subrequest limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
- [Request and response limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits)
- [Duration limits](https://developers.cloudflare.com/workers/platform/limits/#duration)
- [Compatibility dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)
- [Compatibility dates via API](https://developers.cloudflare.com/workers/configuration/compatibility-dates/#via-the-cloudflare-api)
- [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#get-started)
- [Supported Node.js APIs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#supported-nodejs-apis)
- [Unbound and Bundled plan limits](https://developers.cloudflare.com/workers/platform/limits/#unbound-and-bundled-plan-limits)

### Workers KV

- [Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)
- [Read key-value pairs](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)
- [Delete key-value pairs](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/)
- [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [List keys](https://developers.cloudflare.com/kv/api/list-keys/)

### MCP and TypeScript SDK v2

- [MCP 2026-07-28: Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP 2026-07-28: RequestMetaObject](https://modelcontextprotocol.io/specification/2026-07-28/schema#requestmetaobject)
- [TypeScript SDK v2: Protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)
- [MCP 2025-11-25: Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP 2026-07-28: Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [Streamable HTTP: Sending Messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#sending-messages)
- [TypeScript SDK v2 migration: HTTP and headers](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md#http--headers)
- [Streamable HTTP: Request Metadata](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#request-metadata)
- [TypeScript SDK v2: Sessions, state, and scaling](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md)
- [MCP 2026-07-28: Listing tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#listing-tools)
- [TypeScript SDK v2: Supporting 2026-07-28](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)
- [MCP 2026-07-28: Calling tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#calling-tools)
- [MCP 2026-07-28: Tool error handling](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling)
- [MCP 2026-07-28: Errors](https://modelcontextprotocol.io/specification/2026-07-28/schema#errors)
- [Streamable HTTP: Protocol Version Header](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#protocol-version-header)
- [Official MCP TypeScript SDK README](https://github.com/modelcontextprotocol/typescript-sdk)
- [TypeScript SDK v2: Serve on web-standard runtimes](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md)
- [TypeScript SDK v2: Security and auth](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md#protect-against-dns-rebinding)
- [TypeScript SDK v2 migration: Packaging and schemas](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)

### Browser editor

- [Supplied repository observation](file:///C:/Users/user/Downloads/cf-pastebin/worker.js#L24-L279)
- [TOAST UI Editor README](https://github.com/nhn/tui.editor/blob/master/README.md#why-toast-ui-editor)
- [TOAST UI Editor TypeScript API](https://github.com/nhn/tui.editor/blob/master/apps/editor/types/editor.d.ts)
- [TOAST UI Editor repository metadata](https://api.github.com/repos/nhn/tui.editor)
- [TOAST UI Editor Bundlephobia estimate](https://bundlephobia.com/api/size?package=%40toast-ui%2Feditor%403.2.2)
- [Milkdown repository metadata](https://api.github.com/repos/Milkdown/milkdown)
- [Milkdown: Using Crepe](https://github.com/Milkdown/website/blob/main/docs/guide/using-crepe.md)
- [Milkdown architecture](https://github.com/Milkdown/website/blob/main/docs/guide/architecture-overview.md#markdown-transformation)
- [Milkdown Crepe package manifest](https://github.com/Milkdown/milkdown/blob/main/packages/crepe/package.json)
- [Milkdown Crepe Bundlephobia estimate](https://bundlephobia.com/api/size?package=%40milkdown%2Fcrepe%407.22.1)
- [OverType 2.4.2 release commit](https://github.com/panphora/overtype/commit/61c08e5a526f5ede5755a87b004fa85c5c9b3cd6)
- [OverType view modes](https://github.com/panphora/overtype#view-modes)
- [OverType limitations](https://github.com/panphora/overtype#limitations)
- [OverType 2.4.2 jsDelivr manifest](https://data.jsdelivr.com/v1/package/npm/overtype@2.4.2/flat)

### Markdown rendering

- [micromark README](https://github.com/micromark/micromark/blob/main/packages/micromark/readme.md)
- [micromark package metadata](https://github.com/micromark/micromark/blob/main/packages/micromark/package.json)
- [micromark GFM autolink literal extension](https://github.com/micromark/micromark-extension-gfm-autolink-literal/blob/main/readme.md)
- [micromark full GFM extension](https://github.com/micromark/micromark-extension-gfm/blob/main/readme.md)
- [markdown-it safety guide](https://github.com/markdown-it/markdown-it/blob/master/docs/safety.md)
- [markdown-it package metadata](https://github.com/markdown-it/markdown-it/blob/master/package.json)
- [markdown-it syntax extensions](https://github.com/markdown-it/markdown-it/blob/master/README.md#syntax-extensions)
- [Marked advanced options](https://marked.js.org/using_advanced#old-options)
- [Marked URL helper](https://github.com/markedjs/marked/blob/master/src/helpers.ts)
- [Marked package metadata](https://github.com/markedjs/marked/blob/master/package.json)
- [markdown-it repository metadata](https://api.github.com/repos/markdown-it/markdown-it)
- [Marked 18.0.12 release](https://github.com/markedjs/marked/releases/tag/v18.0.12)
- [micromark repository metadata](https://api.github.com/repos/micromark/micromark)

### Local development and tests

- [Cloudflare Workers: Local development](https://developers.cloudflare.com/workers/local-development/)
- [Cloudflare Workers: Adding local data](https://developers.cloudflare.com/workers/local-development/local-data/)
- [Cloudflare Workers: Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Workers: Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Cloudflare Workers: Write your first test](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)
- [Cloudflare Workers: Migrate from Vitest 3 to Vitest 4](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/)
- [Cloudflare Workers: Migrate to Vitest plugin](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/)
- [Workers SDK unit and integration fixture](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/basics-unit-integration-self)
- [Cloudflare Workers: Writing tests with Miniflare](https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/)
- [Vitest CLI](https://vitest.dev/guide/cli)
- [Workers SDK KV, R2, and Cache fixture](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/kv-r2-caches)

### Hono and application structure

- [Hono, Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Cloudflare Workers React guide, API Worker](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/#add-your-api-worker)
- [Hono, Routing](https://hono.dev/docs/api/routing)
- [Hono, html Helper](https://hono.dev/docs/helpers/html)
- [Hono, JSX](https://hono.dev/docs/guides/jsx)
- [Hono, Validation](https://hono.dev/docs/guides/validation)
- [Hono, Testing Helper](https://hono.dev/docs/helpers/testing)
- [Hono repository README](https://github.com/honojs/hono/blob/main/README.md)
- [Cloudflare Workers: Wrangler versus Vite](https://developers.cloudflare.com/workers/local-development/wrangler-vs-vite/)
- [Cloudflare Workers: Single Page Application](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [Cloudflare Workers: Hono](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/)

### Browser and HTTP password mechanics

- [Window: sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)
- [WHATWG Web storage](https://html.spec.whatwg.org/multipage/webstorage.html#the-sessionstorage-attribute)
- [Using the Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#setting_headers)
- [Authorization header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Authorization)
- [Access-Control-Allow-Headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Headers)
- [WHATWG Links](https://html.spec.whatwg.org/multipage/links.html#following-hyperlinks)
- [Fetch Standard, Request class](https://fetch.spec.whatwg.org/#request-class)
- [Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy)
- [Referer header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referer)
- [History API](https://developer.mozilla.org/en-US/docs/Web/API/History_API)
- [blob: URLs](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob)
- [`<a>` download](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a#download)
- [Fetch Standard, request destination table](https://fetch.spec.whatwg.org/#destination-table)
