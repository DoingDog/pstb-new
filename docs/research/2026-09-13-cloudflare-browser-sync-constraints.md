# Cloudflare browser synchronization under a single-KV constraint

**Report date:** 2026-09-13

**Source access date:** 2026-09-13 for every source cited below

**Evidence basis:** Recovered from the prior research transcript only. No web request was repeated for this report.

## Scope and frozen constraints

This report evaluates automatic synchronization among browser-controlled paste pages with:

- one Workers KV namespace as the only application storage;
- no Durable Objects, D1, R2, Queues, Pub/Sub, second KV namespace, account token, session token, global token, or other persistent coordination service;
- no server component other than the Worker;
- a save exactly 3,000 ms after the latest local edit, with each newer edit restarting the timer;
- synchronization active for exactly 300,000 ms after open/refresh or the latest local edit;
- Workers KV eventual consistency accepted.

The project source and existing API contract were intentionally not inspected. Compatibility with an existing `ETag` contract is therefore unknown. Recommendations that depend on such a contract are conditional.

### Evidence labels

- **Verified fact** means the prior transcript captured the cited official source text or an official-source search result containing the stated fact.
- **Inference** means the conclusion follows from verified facts but is not stated verbatim by Cloudflare or a standards publisher.
- **Recommendation** specifies the minimum design that follows from the facts and frozen constraints.
- All inline source links and all entries in the source inventory were accessed on 2026-09-13.

## Decision

**Inference:** A reliable, truly non-polling equivalent does not exist under the frozen constraints.

A correct push design needs both of these capabilities:

1. A mutation-triggered event that tells server code a paste changed without periodically rereading KV.
2. A reliable coordination point that maps the changed paste to every currently subscribed browser connection.

Workers KV supplies eventually consistent reads and writes, but the captured KV Event Subscriptions page lists only `namespace.created` and `namespace.deleted`, and those events are delivered through Cloudflare Queues. It does not list key `put`, update, or delete events. Queues are also excluded. [S16: KV Event Subscriptions](https://developers.cloudflare.com/kv/platform/event-subscriptions/) [S17: Queue Event Subscriptions](https://developers.cloudflare.com/queues/event-subscriptions/)

An ordinary Worker cannot supply the missing coordinator from mutable global memory. Cloudflare states that isolates are not necessarily long-lived, advises against mutable global state, and gives no guarantee that two user requests reach the same or different Worker instance. [S3: How Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/)

A long-lived connection changes the transport only. Without a KV mutation event or shared coordinator, the Worker must periodically call `get()` or `getWithMetadata()` to discover changes. Sending the result over long polling, SSE, WebSocket, or a hypothetical WebTransport session remains polling performed behind an open connection.

### True push and hidden polling

For this report:

- **True push** is delivery caused by the mutation event itself, with no periodic browser GET and no periodic server-side KV read used to discover that mutation.
- **Hidden polling** is a Worker loop that periodically reads KV and emits over an already-open HTTP stream or socket when the returned value differs.

Web Push is true push at the browser transport layer, but it does not fit the frozen system. It uses a push service, permission, a `PushSubscription` endpoint and keys, and application-server-triggered delivery. The W3C draft also says push usually has higher latency than direct communication and is primarily suited to cases without an active communication channel. [S24: W3C Push API](https://www.w3.org/TR/push-api/)

If per-browser push endpoints and keys were allowed to be persisted and an external push service were allowed as a coordination/delivery dependency, an application write could initiate fan-out. That interpretation conflicts with the explicit ban on session/global tokens and other coordination services. It would still not provide an exact active-page synchronization deadline because the standard permits offline storage and later delivery and describes push as higher latency.

## Capability comparison

| Option | Verified capability | Required discovery or coordination | Result under the frozen constraints |
| --- | --- | --- | --- |
| Browser polling | A browser can issue repeated HTTP GET requests; each Worker invocation can read KV. KV is designed for high read volume but is eventually consistent. [S1](https://developers.cloudflare.com/workers/platform/limits/) [S12](https://developers.cloudflare.com/kv/concepts/how-kv-works/) | The browser timer initiates every check. No subscriber registry is needed. | **Supported and recommended.** It is polling, but it is the minimum correct mechanism. |
| Conditional GET with `ETag` | HTTP defines `If-None-Match` for conditional retrieval and `304 Not Modified` when the selected representation matches. A 304 has no representation content. Cloudflare Cache API can evaluate `If-None-Match` against a cached response's `ETag`. [S9](https://developers.cloudflare.com/workers/runtime-apis/cache/) [S21](https://www.rfc-editor.org/rfc/rfc9110.txt) | The browser still initiates a request. Unless a valid edge cache answers, the Worker still reads KV to determine the current validator. | **Supported as a conditional optimization.** It reduces unchanged response bytes, not notification latency, request count, or necessarily KV reads. Existing-contract support is unverified. |
| Long polling | HTTP-triggered Workers have no hard duration limit while the client remains connected. Work can be canceled after disconnect or response completion. [S1](https://developers.cloudflare.com/workers/platform/limits/) | The open invocation must reread KV on a timer because there is no key-change event. | **Rejected as a non-polling equivalent.** It moves checks into one long request, consumes KV operations within one invocation, and adds reconnect/failure handling without creating push. |
| Server-Sent Events | Workers can return a `ReadableStream` and stream response data after headers. Cloudflare's `EventSource` runtime object is a receiver that connects over HTTP to an event server; it is not a server-side subscriber registry. [S7](https://developers.cloudflare.com/workers/runtime-apis/streams/) [S8](https://developers.cloudflare.com/workers/runtime-apis/eventsource/) | A browser-facing SSE endpoint can be inferred from streamed HTTP support, but its Worker must poll KV to know when to emit. Cross-instance fan-out still lacks coordination. | **Rejected as a non-polling equivalent.** It is one-way streaming transport over hidden server-side polling. |
| WebSocket | Workers accept inbound WebSockets with `WebSocketPair`, can receive events, and can send messages. The initial upgrade counts as a Worker request; messages routed through an ordinary Worker do not count as requests. [S5](https://developers.cloudflare.com/workers/runtime-apis/websockets/) [S2](https://developers.cloudflare.com/workers/platform/pricing/) | Cloudflare says multi-connection applications need a single point of coordination and identifies Durable Objects for that role. Ordinary Worker isolates cannot safely hold the global subscriber set. [S5](https://developers.cloudflare.com/workers/runtime-apis/websockets/) [S19](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) | **Rejected.** A socket attached to one isolate cannot reliably receive writes handled by another isolate. Having every socket read KV periodically is hidden polling. |
| WebTransport | The captured Cloudflare protocol table lists inbound HTTP/HTTPS, WebSockets, HTTP/3, and SMTP; it does not list WebTransport. [S4](https://developers.cloudflare.com/workers/reference/protocols/) | Even a supported bidirectional transport would still require a KV mutation event and a cross-instance subscriber coordinator. | **Rejected.** Unsupported status is an inference from the protocol inventory, not an explicit Cloudflare statement. The transport would not fix discovery or coordination anyway. |
| Web Push | The W3C Push API provides asynchronous delivery through a push service, including delivery while the page or user agent is inactive. Subscription creates an endpoint and key material, requests push permission, and can require an application-server key. [S24](https://www.w3.org/TR/push-api/) | The application must retain active subscriptions and credentials, decide which subscriptions correspond to a paste, and send through external push services. Ordinary delivery is associated with a worker; the draft also defines declarative messages that may avoid service-worker involvement. | **Rejected.** It violates the token/coordination restrictions, does not match page-only active-window semantics, and has no exact low-latency guarantee. It is genuine push, but not a valid implementation here. |
| Workers RPC and service bindings | Service bindings let one Worker invoke another privately by HTTP or RPC. A binding call counts toward subrequest limits; one request chain permits at most 32 Worker invocations. A `WorkerEntrypoint` class instance lasts only for its invocation and is stateless. [S10](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) [S11](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) | They need another Worker invocation and still provide neither a browser channel nor persistent subscriber state. | **Rejected.** Worker-to-Worker invocation is not browser notification or coordination. |
| KV key watch/change notification | The official read page exposes `get()` and `getWithMetadata()`. The captured KV events page lists namespace creation and deletion events only. [S15](https://developers.cloudflare.com/kv/api/read-key-value-pairs/) [S16](https://developers.cloudflare.com/kv/platform/event-subscriptions/) | A key-level mutation callback would be required, but none was captured. | **Rejected.** The absence of a supported key watch is an inference from the documented method and event inventories, reinforced by official-domain searches that returned no KV watch result. |
| Cloudflare Event Subscriptions | Cloudflare products can publish structured account events to a Queue. For KV, the captured available event types are `namespace.created` and `namespace.deleted`. [S16](https://developers.cloudflare.com/kv/platform/event-subscriptions/) [S17](https://developers.cloudflare.com/queues/event-subscriptions/) [S18](https://developers.cloudflare.com/queues/event-subscriptions/manage-event-subscriptions/) | Requires a Queue and an applicable event type. | **Rejected twice.** Queue is forbidden, and the listed KV events do not report paste-key mutations. |
| Workers Builds Event Subscriptions | The retrieved page concerns Worker build events and delivery to notification/webhook destinations. [S20](https://developers.cloudflare.com/workers/ci-cd/builds/event-subscriptions/) | A build event is unrelated to a runtime KV value mutation. | **Rejected as irrelevant to data synchronization.** |
| Cache API | Cache API entries are local to the originating data center and do not replicate to other data centers. It honors `ETag` for `If-None-Match` evaluation. [S9](https://developers.cloudflare.com/workers/runtime-apis/cache/) | Cache lookup is request-driven and supplies no browser notification. Correct invalidation would still require learning that KV changed. | **Optimization only.** A cache hit may avoid a KV read at one data center, but it cannot provide global coordination or push and can add staleness. |

## Verified Cloudflare limits and semantics

### Worker execution and connection lifetime

- HTTP-triggered Workers have no hard duration limit while the client remains connected. The Worker can continue processing, issuing subrequests, and streaming a response. When the client disconnects or the response completes, associated work may be canceled; `ctx.waitUntil()` can extend work for up to 30 seconds. [S1](https://developers.cloudflare.com/workers/platform/limits/)
- Waiting on network operations, including KV reads, does not count as CPU time. CPU time is 10 ms per HTTP request on Free. Paid defaults to 30 seconds and can be configured to 5 minutes. [S1](https://developers.cloudflare.com/workers/platform/limits/)
- Memory is 128 MB per isolate. One isolate may handle concurrent requests, but isolates can be evicted and are not reliable persistent state containers. [S1](https://developers.cloudflare.com/workers/platform/limits/) [S3](https://developers.cloudflare.com/workers/reference/how-workers-works/)
- Free allows 100,000 Worker requests per day. The current limits page reports no Paid platform request cap; the pricing page includes 10 million requests per month and then charges $0.30 per additional million. [S1](https://developers.cloudflare.com/workers/platform/limits/) [S2](https://developers.cloudflare.com/workers/platform/pricing/)
- The Workers limits page reports 50 subrequests per Free invocation and 10,000 per Paid invocation, configurable higher on Paid. It separately reports internal-service subrequests at 1,000 on Free and the configured limit on Paid. KV methods are Cloudflare-service subrequests. [S1](https://developers.cloudflare.com/workers/platform/limits/)
- At most six outgoing connections per invocation may simultaneously be waiting for response headers. A KV `get`, `put`, `list`, or `delete` is included while waiting. A connection stops counting against this six-connection establishment limit once headers arrive. [S1](https://developers.cloudflare.com/workers/platform/limits/)
- A WebSocket upgrade to a Worker is charged as one request. WebSocket messages routed through an ordinary Worker do not count as requests. Inbound messages are limited to 32 MiB. [S2](https://developers.cloudflare.com/workers/platform/pricing/) [S5](https://developers.cloudflare.com/workers/runtime-apis/websockets/)

**Evidence gap:** The captured sources did not state a separate maximum lifetime for an inbound ordinary-Worker WebSocket. The general HTTP duration rule is verified, but this report does not turn it into an uncited WebSocket lifetime guarantee. Connection longevity would not repair the coordination defect.

### Worker instance state

Cloudflare's exact captured statements include:

> "A given isolate has its own scope, but isolates are not necessarily long-lived."
>
> "Because there is no guarantee that any two user requests will be routed to the same or a different instance of your Worker, Cloudflare recommends you do not use or mutate global state."

[S3: How Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/)

**Inference:** An in-memory `Map<pasteId, Set<WebSocket>>` or SSE subscriber list can be a best-effort optimization inside one isolate, but it cannot be the correctness mechanism. A write request can reach a different instance, and the isolate holding connections can be evicted.

Cloudflare's WebSocket documentation states that applications coordinating multiple connections need a single point of coordination and identifies Durable Objects. Durable Objects can coordinate thousands of clients per instance and can hibernate while clients remain connected. [S5](https://developers.cloudflare.com/workers/runtime-apis/websockets/) [S19](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

**Inference:** Durable Objects demonstrate the missing platform role. They are not a recommendation because the frozen constraints exclude them.

### Workers KV consistency, limits, and cost

Cloudflare's captured KV documentation states:

> "Your data is not sent automatically to every location's cache."
>
> "Changes may take up to 60 seconds or more to be visible in other global network locations as their cached versions of the data time out."

It also says visibility at the write location is usually immediate but not guaranteed, and negative lookups are cached. [S12: How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

Relevant limits and behavior are:

- Same-key writes are limited to one per second on Free and Paid. Value size is limited to 25 MiB. [S13](https://developers.cloudflare.com/kv/platform/limits/)
- `get()` returns the value or `null`; `getWithMetadata()` returns value and metadata in one API call. The documented configurable `cacheTtl` minimum is 30 seconds and default is 60 seconds. Cloudflare advises against `cacheTtl` for frequently updated data that must be observed shortly after remote writes. [S15](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)
- The KV-specific limits page reports 1,000 operations per Worker invocation on both Free and Paid. This conflicts with the newer general Workers limits page's higher Paid internal-subrequest limit. The conservative design ceiling is therefore 1,000 KV operations per invocation until Cloudflare reconciles the two pages. [S13](https://developers.cloudflare.com/kv/platform/limits/) [S1](https://developers.cloudflare.com/workers/platform/limits/)
- Free includes 100,000 KV reads and 1,000 writes per day. Paid includes 10 million reads per month, then $0.50 per million, and 1 million writes per month, then $5.00 per million. Reads that return no key still count as operations. [S14](https://developers.cloudflare.com/kv/platform/pricing/)

**Inference:** Polling faster than 60 seconds can reduce detection delay after a new value becomes visible at the serving location, but no polling interval can override KV's documented possibility of 60 seconds or more of cross-location staleness. After KV exposes the new value, sequential polling adds up to approximately one polling interval of detection delay.

### Conditional HTTP and cache behavior

RFC 9110 says:

> "If-None-Match is primarily used in conditional GET requests to enable efficient updates of cached information with a minimum amount of transaction overhead."

When `If-None-Match` is false for GET or HEAD, the origin sends `304 Not Modified`. A 304 ends after its header section and cannot contain content or trailers. [S21: RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.txt)

Cloudflare's Cache API honors an `ETag` on a cached response when evaluating `If-None-Match`. Cache API contents do not replicate outside their originating data center. [S9](https://developers.cloudflare.com/workers/runtime-apis/cache/)

**Inference:** A conditional GET that reaches Worker code still counts as a Worker request. If the Worker reads KV to derive or retrieve the current validator, it still consumes a KV read even when the response is 304. `ETag` primarily saves response bytes here. A valid Cache API entry can avoid Worker/KV work in some request paths, but its data-center locality and lack of mutation notification make it unsuitable as the correctness layer.

## Minimum correct synchronization protocol

This protocol preserves the exact debounce and active-window requirements, prevents stale asynchronous responses from overwriting a newer local edit, and makes the remaining eventual-consistency behavior explicit.

Let:

- `activeUntil` be the exclusive deadline for synchronization;
- `editGeneration` be an integer incremented on every local input;
- `dirty` mean local content differs from the last acknowledged save;
- `etag` be the latest validator received from the server, if the existing API supports one;
- `P` be the product-selected poll interval;
- `pollInFlight` enforce at most one GET at a time.

### Browser state machine

1. **Open or refresh**
   - Set `activeUntil = now + 300000`.
   - Perform one immediate GET.
   - Store any returned `ETag` with the representation.

2. **Local edit**
   - Increment `editGeneration`.
   - Mark the editor `dirty`.
   - Set `activeUntil = editTime + 300000`.
   - Cancel the prior save timer.
   - Start a new timer for exactly 3,000 ms.
   - A newer edit must cancel and restart that timer. No earlier timer may write.

3. **Debounced save**
   - When the 3,000 ms timer fires, capture both the current content and `editGeneration`, then send the existing write request.
   - Mark the editor clean only if the write succeeds and `editGeneration` still equals the captured generation. A later edit keeps the editor dirty and owns a newer timer.
   - If the write response provides the new representation validator, store it only for the generation that was saved.
   - Do not claim atomic compare-and-swap from Workers KV. `If-Match` can be used only if the existing API already defines conflict handling backed by an actually atomic mechanism. No such mechanism was verified under these constraints.

4. **Sequential polling while active**
   - Start no new GET when `now >= activeUntil`.
   - Never overlap polls. Schedule the next check only after the current request settles and only if the active deadline remains in the future.
   - Send `If-None-Match: <etag>` when a stable validator is available.
   - Capture `editGeneration` when the GET starts.
   - On `304`, keep the current representation and validator.
   - On `200`, store the returned validator. Apply remote content to the editor only if it is still clean and `editGeneration` has not changed since the GET started. Otherwise retain the remote result as pending or discard it and fetch again after the local save. Never overwrite dirty local input.
   - On transient failure, wait until the next normal poll opportunity while active. Do not create a second overlapping retry loop.

5. **Deadline**
   - At `activeUntil`, cancel the poll timer and start no further poll. A new local edit creates a new deadline exactly 300,000 ms after that edit.

### Server GET contract when `ETag` is supported

For the exact representation returned by GET, the server needs one stable opaque validator. It can be a persisted revision or a deterministic validator for the returned representation. `getWithMetadata()` can retrieve a KV value and its metadata together, but using metadata would require the existing write contract to maintain that validator. [S15](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)

The response pattern is:

```plaintext
GET without a matching If-None-Match
-> 200 OK
-> ETag: "<opaque-validator>"
-> representation body

GET with a matching If-None-Match
-> 304 Not Modified
-> ETag: "<opaque-validator>"
-> no representation body
```

This follows RFC 9110. [S21](https://www.rfc-editor.org/rfc/rfc9110.txt)

**Contract gap:** The local API was not inspected, so the report does not assert that it currently emits validators, accepts `If-None-Match`, or can change response headers without compatibility work. If it cannot, keep the same sequential active-window polling and return 200; the browser can compare the fetched representation before applying it.

### Poll interval and cost

No remote-change detection target was supplied, so choosing `P` would invent a product requirement. Select the slowest interval that meets the desired detection bound after KV makes a write visible.

For one uninterrupted five-minute active window with an immediate first GET:

```plaintext
Worker requests per active tab ≈ 1 + 300 / P
KV reads per active tab ≈ 1 + 300 / P
```

The second estimate assumes each GET reaches Worker code and performs one KV lookup. Conditional 304 responses do not change those counts by themselves. Both expressions are calculations, not Cloudflare limits. Actual counts depend on request duration, deadline-boundary handling, cache hits, retries, and edits that extend `activeUntil`.

## Correctness boundary

The recommended protocol guarantees only the behavior available under the frozen constraints:

- exact client-side 3,000 ms debounce;
- exact client-side five-minute activity deadline;
- sequential remote checks without overlapping requests;
- no asynchronous poll response overwrites a newer dirty edit;
- standards-compliant conditional GET if the API supports it.

It cannot guarantee:

- notification without polling;
- a maximum cross-location visibility time, because KV documents 60 seconds or more;
- total ordering of concurrent writers;
- atomic conflict detection or compare-and-swap;
- lossless real-time fan-out to every active tab.

A requirement for any of those guarantees changes the frozen architecture. Cloudflare's captured documentation identifies Durable Objects as the coordination primitive for multiple live connections, but Durable Objects are outside this report's allowed design.

## Recovered evidence excerpts

The following quotations were present in the prior transcript and are the load-bearing official statements:

| Topic | Captured quotation | Source |
| --- | --- | --- |
| Worker affinity | "There is no guarantee that any two user requests will be routed to the same or a different instance of your Worker." | [S3](https://developers.cloudflare.com/workers/reference/how-workers-works/) |
| Worker lifetime | "A given isolate has its own scope, but isolates are not necessarily long-lived." | [S3](https://developers.cloudflare.com/workers/reference/how-workers-works/) |
| HTTP duration | "There is no hard limit on duration for HTTP-triggered Workers. As long as the client remains connected, the Worker can continue processing, making subrequests, and streaming a response body." | [S1](https://developers.cloudflare.com/workers/platform/limits/) |
| KV propagation | "Changes may take up to 60 seconds or more to be visible in other global network locations as their cached versions of the data time out." | [S12](https://developers.cloudflare.com/kv/concepts/how-kv-works/) |
| KV cache suitability | "`cacheTtl` is not recommended if your data is updated often and you need to see updates shortly after they are written." | [S15](https://developers.cloudflare.com/kv/api/read-key-value-pairs/) |
| WebSocket coordination | "If your application needs to coordinate among multiple WebSocket connections ... you will need clients to send messages to a single-point-of-coordination." | [S5](https://developers.cloudflare.com/workers/runtime-apis/websockets/) |
| RPC state | "A new instance of the class is created every time the Worker is called ... the class instance only lasts for the duration of the invocation." | [S11](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) |
| Push latency | "Push messages usually have higher latency than direct communications and they can also be subject to restrictions on use." | [S24](https://www.w3.org/TR/push-api/) |
| Conditional GET | "If-None-Match is primarily used in conditional GET requests to enable efficient updates of cached information with a minimum amount of transaction overhead." | [S21](https://www.rfc-editor.org/rfc/rfc9110.txt) |

## Retrieval outcomes and evidence gaps

- The prior agent's first ten-page Cloudflare fetch exceeded the response-size limit, was persisted, and was then read through all 4,340 lines. Its individual relevant pages were later extracted or refetched where needed.
- A seven-page Cloudflare fetch also exceeded the inline limit. The important KV events, Queue events, Worker lifecycle, Durable Object, WebSocket, and pricing pages were refetched individually or extracted from the persisted result.
- Selector-based fetches of the HTML versions of RFC 9110 and RFC 6455 failed. Publisher-owned `.txt` URLs succeeded and were read in full.
- WHATWG SSE selector extraction returned headings only. A search result captured the `text/event-stream` wire-format reference, while Cloudflare's EventSource and Streams pages supplied the platform facts used here. No claim about exact automatic reconnection timing is made.
- The W3C Push API and Service Workers sources were fetched and read. The Push API source is a Working Draft, and this report preserves its distinction between ordinary worker-associated delivery and declarative push.
- The W3C WebTransport selector extraction returned only the abstract and introduction headings. No WebTransport protocol detail is needed for the decision. More importantly, no explicit Cloudflare statement saying "WebTransport is unsupported" was captured. Unsupported status remains an inference from Cloudflare's supported-protocol table.
- Official-domain searches returned no Cloudflare-native Web Push documentation and no KV key-watch documentation. Search absence alone is not treated as proof. The conclusion instead relies on the captured method/event inventories and the stated constraints.
- The captured Cloudflare Workers and KV limits pages disagree on the Paid per-invocation ceiling relevant to KV. This report uses the stricter KV-specific 1,000-operation figure rather than resolving the discrepancy without new research.
- The existing application API, cache headers, authentication model, and conflict behavior were not inspected. `ETag` support and safe write preconditions remain project-specific gaps.
- No captured source promises an exact remote-change detection SLA, and the request supplied no desired poll interval. The report leaves `P` as a product decision.

## Source inventory

Every URL below is an official Cloudflare page or a standard owned by its publisher. Access date for every row is 2026-09-13.

| ID | Exact official URL | Retrieval outcome | Used for |
| --- | --- | --- | --- |
| S1 | [https://developers.cloudflare.com/workers/platform/limits/](https://developers.cloudflare.com/workers/platform/limits/) | Full page captured and extracted. | Duration, CPU, memory, request, subrequest, and connection limits. |
| S2 | [https://developers.cloudflare.com/workers/platform/pricing/](https://developers.cloudflare.com/workers/platform/pricing/) | Full relevant section captured and extracted. | Paid request pricing and WebSocket request/message accounting. |
| S3 | [https://developers.cloudflare.com/workers/reference/how-workers-works/](https://developers.cloudflare.com/workers/reference/how-workers-works/) | Full page captured. | Isolate lifetime, distributed routing, and global-state warning. |
| S4 | [https://developers.cloudflare.com/workers/reference/protocols/](https://developers.cloudflare.com/workers/reference/protocols/) | Full short page captured. | Supported inbound/outbound protocol inventory. |
| S5 | [https://developers.cloudflare.com/workers/runtime-apis/websockets/](https://developers.cloudflare.com/workers/runtime-apis/websockets/) | Full page captured. | `WebSocketPair`, events, 32 MiB inbound limit, and coordination guidance. |
| S6 | [https://developers.cloudflare.com/workers/examples/websockets/](https://developers.cloudflare.com/workers/examples/websockets/) | Full page captured in the initial batch. | Worker WebSocket server example; corroborating source. |
| S7 | [https://developers.cloudflare.com/workers/runtime-apis/streams/](https://developers.cloudflare.com/workers/runtime-apis/streams/) | Full page captured. | Streaming response support and request-context lifetime. |
| S8 | [https://developers.cloudflare.com/workers/runtime-apis/eventsource/](https://developers.cloudflare.com/workers/runtime-apis/eventsource/) | Full page captured. | Worker `EventSource` receiver behavior. |
| S9 | [https://developers.cloudflare.com/workers/runtime-apis/cache/](https://developers.cloudflare.com/workers/runtime-apis/cache/) | Full page captured and relevant passages extracted. | Data-center-local cache and conditional `ETag` evaluation. |
| S10 | [https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) | Full page captured and limits extracted. | Worker-to-Worker scope, subrequest accounting, 32-invocation chain limit. |
| S11 | [https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) | Full page captured and lifecycle passage extracted. | Per-invocation stateless `WorkerEntrypoint`. |
| S12 | [https://developers.cloudflare.com/kv/concepts/how-kv-works/](https://developers.cloudflare.com/kv/concepts/how-kv-works/) | Full page captured. | Hybrid replication, eventual consistency, stale and negative caching. |
| S13 | [https://developers.cloudflare.com/kv/platform/limits/](https://developers.cloudflare.com/kv/platform/limits/) | Full page captured. | Same-key write rate, per-invocation operations, value size, `cacheTtl` minimum. |
| S14 | [https://developers.cloudflare.com/kv/platform/pricing/](https://developers.cloudflare.com/kv/platform/pricing/) | Full page captured. | KV read/write quotas, prices, and missing-key read accounting. |
| S15 | [https://developers.cloudflare.com/kv/api/read-key-value-pairs/](https://developers.cloudflare.com/kv/api/read-key-value-pairs/) | Full page captured. | `get`, `getWithMetadata`, `cacheTtl`, bulk read, and operation behavior. |
| S16 | [https://developers.cloudflare.com/kv/platform/event-subscriptions/](https://developers.cloudflare.com/kv/platform/event-subscriptions/) | Full page captured. | Available KV events: namespace creation and deletion. |
| S17 | [https://developers.cloudflare.com/queues/event-subscriptions/](https://developers.cloudflare.com/queues/event-subscriptions/) | Full page captured. | Event delivery into Queues. |
| S18 | [https://developers.cloudflare.com/queues/event-subscriptions/manage-event-subscriptions/](https://developers.cloudflare.com/queues/event-subscriptions/manage-event-subscriptions/) | Full page captured. | Queue subscription creation and management requirement. |
| S19 | [https://developers.cloudflare.com/durable-objects/best-practices/websockets/](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) | Full page captured. | Multiple-client coordination and WebSocket hibernation. |
| S20 | [https://developers.cloudflare.com/workers/ci-cd/builds/event-subscriptions/](https://developers.cloudflare.com/workers/ci-cd/builds/event-subscriptions/) | Full page captured in the initial batch. | Build-event scope, distinguished from KV data mutations. |
| S21 | [https://www.rfc-editor.org/rfc/rfc9110.txt](https://www.rfc-editor.org/rfc/rfc9110.txt) | HTML selector fetch failed; publisher-owned text succeeded and was read in full. | `ETag`, `If-None-Match`, and 304 semantics. |
| S22 | [https://www.rfc-editor.org/rfc/rfc6455.txt](https://www.rfc-editor.org/rfc/rfc6455.txt) | HTML selector fetch failed; publisher-owned text succeeded and was read in full. | WebSocket two-way connection semantics; corroborating source. |
| S23 | [https://html.spec.whatwg.org/multipage/server-sent-events.html](https://html.spec.whatwg.org/multipage/server-sent-events.html) | Selector fetch returned headings only; official search snippet captured `text/event-stream`. | SSE standard identity and wire-format corroboration; detailed reconnect claims omitted. |
| S24 | [https://www.w3.org/TR/push-api/](https://www.w3.org/TR/push-api/) | Working Draft captured and read. | Push service, subscription, permission, endpoints, keys, delivery, and latency. |
| S25 | [https://www.w3.org/TR/service-workers/](https://www.w3.org/TR/service-workers/) | Captured and read with the Push API batch. | Service-worker lifecycle context; corroborating source. |
| S26 | [https://www.w3.org/TR/webtransport/](https://www.w3.org/TR/webtransport/) | Selector extraction returned headings only. | WebTransport standard identity only; no platform-support claim derived from it. |
