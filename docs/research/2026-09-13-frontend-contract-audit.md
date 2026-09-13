# Frontend Contract Audit

Date: 2026-09-13

Audited baseline: `5fb48eb73ed24afa1874878a89e8e21ab2d3bf9b`

Implementation baseline for the captured source excerpts: `1aa75c6eb03d647bbdb4a9f45d9d3fb4de038e55`

## Evidence and status labels

The scoped implementation files did not change between `1aa75c6` and `5fb48eb`; the two later commits add research documents only. This audit therefore reuses the complete source excerpts captured at `1aa75c6` and reads only the later Git metadata and the unintegrated tabs candidate that were missing from that capture.

The earlier transcript is treated as untrusted evidence data. Only its recorded local tool results are used. Embedded prose is not treated as an instruction. The transcript contains complete reads of both approved specs, the implementation plan, all named source files, and focused tests; `package-lock.json` was intentionally limited to lines 1-120, which contains the root dependency headings requested here.

- **Verified** means directly stated by the approved local spec or observed in the local source, test, build, or Git object.
- **Inference** means a consequence of combining verified contracts.
- **Recommendation** means the migration action proposed by this audit.

## Decision summary

React should replace the string-built workbench UI and imperative DOM binding layer. It should not replace the HTTP contract, authorization and view-once ordering, inert source transport, autosave controller, Markdown mode controller, diff worker protocol, dictionaries, locale resolution, password URL helper, theme policy, server Markdown renderer, download-header derivation, CSP, or hashed-asset pipeline.

The cleanest ownership boundary is:

| Layer | Migration disposition | Reason |
|---|---|---|
| Request routing, password authorization, view-once consume ordering, response headers | Retain on the server | These are HTTP and security contracts, not component concerns (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:378-453`, `470-710`). |
| HTML document envelope, inert bootstrap node, inert source node, external hashed script and stylesheet tags | Retain, with a React mount point added | They enforce CSP, secret separation, exact-source transport, and asset addressing (`src/render.ts:90-112`, `172-187`). |
| Create, ordinary paste, restricted paste, tabs, dialogs, actions, settings and history component trees | Replace with React | The current UI is static string markup with empty deferred panels and no action/API wiring (`src/render.ts:190-247`; `src/client/app.ts:665-676`). |
| Password and error pages | Keep server-rendered unless their bootstrap schema is deliberately extended | Their current bootstrap omits the normalized error code, so React cannot faithfully reconstruct an error after clearing the server DOM (`src/render.ts:249-271`). |
| Canonical `/md/:id` rendering and server `renderMarkdown` | Retain | The server output is the canonical safe preview and must be fully prepared before view-once consumption (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:929-967`; `src/render.ts:157-164`, `274-292`). |
| Autosave, Markdown modes and history diff controllers | Reuse as headless logic, wrapped by React lifecycle and state adapters | These exports already isolate timers, network callbacks, editor transitions and worker messages from presentation (`src/client/app.ts:9-421`; `src/client/markdown.ts:21-326`; `src/client/diff.ts:3-74`). |
| Current DOM locale scan, source hydration side effects and document-global startup | Replace with React state/effects while retaining the pure helpers | These functions bind directly to fixed selectors and module globals (`src/client/app.ts:423-470`, `544-676`). |
| Workbench CSS implementation | Port tokens and acceptance behavior; replace selectors as components change | The rules are tightly coupled to the current class and `data-*` structure, while the color, layout, focus, target-size and reduced-motion requirements remain approved (`src/client/styles.css:1-782`; `docs/superpowers/specs/2026-09-13-pastebin-ui-direction.md:13-154`). |

## 1. Current implementation boundary

### 1.1 What exists now

**Verified.** The browser entry currently performs only four startup actions: initialize document locale, initialize document theme, read one `password` query value into a module variable, and hydrate exact source data (`src/client/app.ts:665-674`). The file contains no `fetch`, Clipboard, Blob URL, dialog, create-submit, settings, history-list, password mutation, or delete binding. The rendered History and Settings panels are empty placeholders (`src/render.ts:235`).

**Verified.** The current HTTP router exposes the root document, create, content `PUT`, content `PATCH`, resource `DELETE`, and their current method contracts (`src/http.ts:643-706`). It does not yet register browser `/:id`, direct representations, resource `GET`, settings, password, history, or `/read`. Those remain approved Task 6 work (`docs/superpowers/plans/2026-09-13-cloudflare-pastebin-rewrite.md:418-470`).

**Inference.** React is not replacing a completed imperative application. It is replacing server string templates and filling an integration layer that is mostly absent. Creating alternate temporary endpoints or a second state machine would add migration debt and conflict with the approved plan.

### 1.2 React replacement boundary

**Recommendation.** Keep `pageDocument` as the single producer of the document envelope, or extract only its envelope logic into an equivalent server helper. It must continue to emit:

1. `<!doctype html>` and `<html lang="...">`;
2. UTF-8 and viewport metadata;
3. a server-chosen `<title>`;
4. the generated hashed CSS URL;
5. `body[data-page]`;
6. the React mount point;
7. optional inert exact-source data;
8. inert escaped bootstrap JSON; and
9. one external module script at the generated hashed application URL.

The current order is body markup -> source transport -> bootstrap -> executable module (`src/render.ts:94-112`). React may change the body markup, but it must extract both inert nodes before unmounting or replacing any ancestor that contains them.

**Recommendation.** Do not make the application an SPA as part of this migration. Full-page route behavior already enforces password and view-once semantics. Client-side routing adds no required capability and creates stale module-state, prefetch, and accidental second-read hazards.

## 2. Server-rendered DOM and bootstrap contracts

### 2.1 Document-level contract

**Verified.** Every application document loads exactly one hashed stylesheet and one external executable module. Inline script is forbidden. Bootstrap is an `application/json` node whose JSON escapes `<`, `>`, `&`, U+2028 and U+2029; exact source uses a separate `application/octet-stream` node (`src/render.ts:90-112`, `172-178`; `src/render.test.ts:95-109`, `411-422`).

**Verified.** Current bootstrap variants are:

| Page | Bootstrap value | Source node |
|---|---|---|
| Create | `{page:"create", locale}` | No |
| Ordinary paste | `{page:"paste", paste: PasteSummary, consumed:false}` | Yes |
| Restricted or consumed paste | `{page:"paste", locale, consumed:true}` | Yes |
| Password | `{page:"password", locale}` | No |
| Error | `{page:"error", locale}` | No |
| Ordinary Markdown document | `{page:"markdown", paste: PasteSummary, consumed:false}` | Yes |
| View-once Markdown document | `{page:"markdown", locale, consumed:true}` | Yes |

These shapes come from `src/render.ts:219`, `243-246`, `260-271`, and `289-292`.

**Verified.** `publicSummary` copies only public `PasteSummary` fields and clean relative representation links. It has no stored password (`src/render.ts:49-71`; `src/types.ts:75-107`). Tests require content and password to be absent from bootstrap, even while exact source remains available in one inert node (`src/render.test.ts:147-193`, `300-312`).

**Inference.** Ordinary paste and Markdown bootstrap derive locale from `<html lang>`, while restricted variants carry locale directly. A React bootstrap parser must support this asymmetry or the server schema must be deliberately normalized. It must not silently assume every variant has `locale` or `paste`.

### 2.2 Create page DOM

**Verified.** The current create form posts to `/api/pastes` and exposes stable names and IDs for `title`, `format`, `expiration`, `content`, `password`, `customId`, and `viewOnce`. It includes visible descriptions, associated error nodes, explicit `viewOnce` value `true`, a reveal button, and a live status (`src/render.ts:190-219`). The ordered expiration values are `60`, `3600`, `86400`, `604800`, `2592000`, `31104000`, and `permanent`, with one day selected (`src/render.ts:192-201`; `src/render.test.ts:113-127`).

**Recommendation.** React may replace these exact nodes, but preserve the field semantics, reading order, labels/descriptions/errors, initial values, explicit `viewOnce` serialization, and submit/live-status behavior. Do not preserve IDs merely for old tests if equivalent accessible associations are generated reliably; preserve names and API values because they are transport contracts.

### 2.3 Ordinary paste DOM

**Verified.** The server currently renders:

- a lifecycle rail sourced from `PasteSummary`, including ID, protected state, view-once state, expiry, revision, save state and bytes (`src/render.ts:142-147`);
- a five-tab workspace with `View`, `Edit`, `Markdown`, `History`, and `Settings` tabs, reciprocal `aria-controls` and `aria-labelledby`, roving initial `tabindex`, and `hidden` inactive panels (`src/render.ts:222-246`);
- exact text as an empty `<pre data-source-view>` hydrated by text content, or safe server-rendered Markdown as the initial View (`src/render.ts:166-169`; `src/render.test.ts:129-145`);
- clean raw, HTML, Markdown-document and file links, plus local actions and a native delete dialog (`src/render.ts:230-241`).

**Recommendation.** React owns tab selection, panel rendering, dialogs, live statuses, settings/history loading and all actions. Preserve semantic relationships and outcomes, not the current long HTML string. Preserve lifecycle values and source-to-text-node rendering.

### 2.4 Restricted view-once DOM

**Verified.** A consumed page has `data-consumed="true"`, one root create link, no representation URLs, no tabs, no server delete, and only local copy, wrap, source toggle, preview, download and Blob HTML actions (`src/render.ts:225-246`; `src/render.test.ts:314-347`). The restricted bootstrap omits `PasteSummary` and links.

**Recommendation.** Implement a separate restricted React branch. Do not render the ordinary component tree and hide controls in an effect. Server URLs, route components, prefetch-capable links, and mutation hooks should never be created for this branch.

### 2.5 Password, error and Markdown documents

**Verified.** The password page is generic and includes no paste title, content or summary. Wrong-password rendering adds a normalized localized `role="alert"`; the error page also uses only a normalized dictionary error (`src/render.ts:249-271`; `src/render.test.ts:379-400`).

**Verified.** `/md/:id` is an application document with a semantic article and safe server-rendered Markdown. For view-once it has only a root link and local copy button; ordinary output includes a clean source link (`src/render.ts:274-292`; `src/render.test.ts:338-353`, `402-409`).

**Recommendation.** Leave password/error body rendering and canonical Markdown article rendering on the server during the React migration. React can progressively own shared locale/theme controls later. Full replacement first requires adding safe error/bootstrap data and resolving the initial-Markdown lazy-load conflict described below.

## 3. Exact-source transport contract

**Verified.** `encodeSourceData` converts the exact JavaScript string to UTF-8 and canonical base64 in bounded chunks. `decodeSourceData` rejects empty, malformed, noncanonical or oversized base64, rejects malformed UTF-8 with a fatal decoder, and enforces a decoded 10 MiB ceiling (`src/source-data.ts:1-71`). Tests cover CR, CRLF, NUL, replacement characters, HTML-significant characters, Unicode line separators, BOM, non-BMP text, malformed encodings, exactly 10 MiB and one byte over (`src/source-data.test.ts:4-35`).

**Verified.** Startup finds exactly `script#source-data[data-source-encoding]`, requires `utf-8-base64`, decodes `textContent`, stores the result independently in `pasteContent`, writes text view with `textContent`, writes the textarea value, listens for input, and removes the transport node. On decode failure it removes the node without replacing existing page state (`src/client/app.ts:423-470`; `src/client/app.test.ts:851-902`).

**Verified.** HTML textarea parsing and assignment can normalize CR and CRLF. The existing adapter therefore returns the module-held exact value rather than trusting `textarea.value`; tests demonstrate exact source remains distinct from the normalized textarea value (`src/client/app.test.ts:851-880`).

**Recommendation.** Decode source before React replaces the server subtree. Seed React canonical state directly from the decoded string. A controlled textarea value is a presentation/editing surface, not the initial canonical source. Preserve a separate exact snapshot until the user makes a real source or visual document edit.

**Recommendation.** Reuse `encodeSourceData`, `decodeSourceData`, `sourceDataEncoding`, and their tests unchanged. Replace only `hydratePasteSource` and the `pasteContent` module global with a page-scoped React initialization path and state adapter.

## 4. HTTP and browser API contracts

### 4.1 Approved endpoint dependencies

React must call the canonical same-origin routes below. It must not call `PasteService` or recreate parsing rules.

| UI operation | Request contract | Success contract | Current router status |
|---|---|---|---|
| Create | `POST /api/pastes`, JSON or multipart; explicit `viewOnce` | `201 PasteSummary`, clean `Location`, quoted `ETag` | Implemented (`src/http.ts:662-671`) |
| Autosave | `PATCH /api/pastes/:id`, strict JSON `{content,password?,version?}` | `200 MutationResult`, quoted `ETag` | Implemented (`src/http.ts:683-692`) |
| Plain source replacement | `PUT /api/pastes/:id`, exact `text/plain; charset=utf-8`; password query/header; optional `If-Match` | `200 MutationResult` | Implemented (`src/http.ts:673-681`) |
| Delete | `DELETE /api/pastes/:id`, optional strict JSON `{password?,version?}` | `204` empty | Implemented (`src/http.ts:694-706`) |
| Reload current paste | `GET /api/pastes/:id` or `/read`, unique password query/header | `200 PasteResource`; content-bearing and consumes view-once | Approved, not registered yet (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:573-591`) |
| Load settings | `GET /api/pastes/:id/settings` | `200 PasteSummary`, no content/password | Approved, not registered yet |
| Save one settings group | `PATCH /api/pastes/:id/settings`, strict body with current credential/version plus business fields | `200 MutationResult` | Approved, not registered yet (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:593-620`) |
| Set/change password | `PUT /api/pastes/:id/password`, `{password?,newPassword,version?}` | `200 MutationResult` | Approved, not registered yet |
| Clear password | `DELETE /api/pastes/:id/password`, `{password?,version?}` | `200 MutationResult` | Approved, not registered yet |
| Open History | `GET /api/pastes/:id/history` | `200 HistoryList`; active view-once gets `409` | Approved, not registered yet |
| Select revision | `GET /api/pastes/:id/history/:revision` | `200 RevisionResource` | Approved, not registered yet |
| Open direct representation | `GET /raw`, `/html`, `/md`, or `/file` with unique query password when protected | Representation-specific response | Approved, not registered yet (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:484-505`) |

**Verified.** API success and errors are JSON with `Cache-Control: no-store`; resources carry current `ETag`; retryable 503 responses carry `Retry-After: 1` (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:653-710`; `src/http.ts:587-613`). The UI must map `error.code` through local dictionaries rather than treating server English as the only message (`src/i18n.ts:160-245`).

**Verified.** Create JSON and multipart fields have identical semantics. JSON is normal use; the browser changes to multipart only near the 64 MiB wire envelope or when JSON escaping would approach it. Content still has a 10 MiB UTF-8 limit. The client must not infer a missing checkbox as false (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:549-571`, `971-987`).

**Recommendation.** Implement a thin React-side API adapter that translates response status/body into the existing headless controllers. Do not duplicate media parsing, credential precedence, version arbitration or field validation.

### 4.2 Password carrier rules

**Verified.** Credential precedence is body-present -> unique query -> `X-Paste-Password`. A present empty or wrong higher-priority value does not fall back. Duplicate password query values return `400 AMBIGUOUS_PASSWORD` (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:380-392`). Current body mutations preserve that precedence through `body.password ?? queryOrHeaderPassword`, and the query helper rejects duplicates (`src/http.ts:144-147`, `531-540`).

**Verified.** Browser API GET uses query password. JSON mutations use body password. The password lives only in the current document module state and URL. It must never enter cookies, Web Storage, IndexedDB or `window.name` (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:388-392`).

**Verified.** `withPastePassword` clones a URL, removes all old password values, adds at most one current value through `URLSearchParams`, and preserves unrelated query values and fragments. `setPastePassword` updates module state and calls `history.replaceState` without reload (`src/client/app.ts:641-663`; `src/client/app.test.ts:789-849`).

**Recommendation.** Reuse `withPastePassword`. Keep password in page-scoped React state or a closure, and use the existing helper for every representation link at render/click time. After password set/change/clear, update both state and current URL immediately. Do not cache fully constructed protected links.

### 4.3 View-once ordering and local-only behavior

**Verified.** A successful content-bearing GET prepares the complete final body and headers, then deletes current content, all revision slots and metadata, and returns only after all deletes succeed. HEAD, OPTIONS, password form POST, failures, history, settings, mutations and DELETE do not consume (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:415-441`).

**Verified.** The returned consumed page keeps its already loaded source and only local actions. It must not fetch, prefetch, navigate to, or recreate server representation URLs. Local download uses exact UTF-8 source, and local HTML navigates the current tab to a Blob URL (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:443-449`, `989-1027`).

**Recommendation.** Treat `consumed:true` as an immutable capability boundary in React. Do not implement it as CSS visibility. Exclude server-action components and network hooks from that branch so framework link prefetch and effects cannot consume or probe the paste again.

## 5. CSP and rendering safety

**Verified.** Application responses use this exact CSP (`src/render.ts:35`, `181-187`):

```plaintext
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
```

Consequences for React:

- executable code must remain external and same-origin;
- no inline bootstrap executable or inline event handlers;
- API calls must remain same-origin;
- the diff worker may use its hashed same-origin URL or a Blob worker;
- no external font request is permitted by the UI direction and `font-src` (`docs/superpowers/specs/2026-09-13-pastebin-ui-direction.md:43-51`);
- `style-src 'unsafe-inline'` exists for Milkdown runtime style attributes, not as permission to add inline script (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:959-967`).

**Verified.** Stored text must enter application DOM through textarea value or text nodes. Safe Markdown uses micromark with dangerous HTML and protocols disabled plus full GFM. Only output from that fixed renderer may cross an HTML insertion boundary (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:910-946`; `src/render.ts:157-169`).

**Recommendation.** React must not use `dangerouslySetInnerHTML` for source, title, error text, history snapshots or diff lines. If it uses `dangerouslySetInnerHTML` for safe Markdown, the value must come only from the existing fixed renderer or the equivalent client renderer options, and its type/API should make that trust boundary explicit.

**Verified.** `/html/:id` is the deliberate exception: exact stored source, top-level same-origin execution, no wrapper, sanitizer, CSP, sandbox or application `Referrer-Policy` (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:916-927`). It must bypass every React/application document middleware.

## 6. State-machine contracts to reuse

### 6.1 AutosaveController

**Verified.** The exported controller accepts injected time, timer, save, password and state callbacks. Its public operations are `input`, `compositionStart`, `compositionEnd`, `retry`, `overwrite`, `reload`, and `dispose`; snapshots expose state, draft, confirmed content/version, timing, in-flight content, dirty-during-save and failure status (`src/client/app.ts:9-64`).

The transition contract is:

| Trigger | Required behavior |
|---|---|
| Ordinary input | Replace the 1,000 ms timer; update the exact latest draft (`src/client/app.ts:66-93`). |
| IME composition | Cancel the timer, retain intermediate draft without saving, then wait a full 1,000 ms after `compositionEnd` (`src/client/app.ts:95-106`). |
| Timer | Avoid a known no-op; otherwise snapshot one in-flight content value and send at most one request (`src/client/app.ts:160-213`). |
| Input during save | Keep one request active, mark dirty, and coalesce to the latest draft after completion (`src/client/app.ts:77-82`, `215-235`). |
| 200 changed or no-op | Confirm the request snapshot and returned version, then save only a still-different latest draft (`src/client/app.ts:215-235`). |
| Network, 413, 422, 500, 503 | Preserve draft and confirmed version; stop automatic retry and expose explicit Retry (`src/client/app.ts:238-247`). |
| 403 | Preserve all state, wait for password re-entry, and use current password only on explicit Retry (`src/client/app.test.ts:477-504`). |
| 404 | Preserve local draft and permanently stop autosave for that controller (`src/client/app.test.ts:506-525`). |
| 409 | Preserve draft/version, enter conflict, offer reload or overwrite; overwrite omits version (`src/client/app.test.ts:527-613`). |
| Dirty or in-flight | Register `beforeunload`; remove it after confirmed clean or disposal (`src/client/app.ts:271-292`). |

**Recommendation.** Instantiate one controller per editable paste, feed `onStateChange` into React state, and call `dispose` on unmount or paste identity change. Do not recode transitions in reducers or effects. Production behavior must not depend on React StrictMode invoking setup twice.

### 6.2 MarkdownModes

**Verified.** `createMarkdownModes` owns source, visual and preview transitions. Crepe plus ProseMirror support are imported only by `enterVisual`; micromark and GFM are imported only by `enterPreview` (`src/client/markdown.ts:146-168`, `286-318`).

**Verified.** The controller keeps an exact source snapshot, ignores initialization/focus/structurally equal changes, marks dirty only for a real document change, serializes real edits, preserves source on failed initialization, makes retries single-use/stale-safe, serializes teardown, and removes only its own editor session nodes (`src/client/markdown.ts:39-326`; `src/client/markdown.test.ts:198-718`). `createAutosaveMarkdownModes` already connects real Markdown document changes to `AutosaveController.input` (`src/client/app.ts:295-305`).

**Recommendation.** Mount Crepe into a dedicated React-owned empty host node, but let `MarkdownModes` own descendants of that host. React should call controller methods for mode changes and call `destroy` before removing/reusing the host. Do not render over Milkdown-managed children.

### 6.3 History diff worker

**Verified.** The worker accepts `{type:"diff",id,previous,current}` and returns structured `{kind,text}` lines or a typed error while preserving newline markers (`src/client/diff.ts:3-52`). The main-thread controller creates the worker only after selection and policy approval, ignores stale response IDs, supports explicit large-diff calculation, and terminates on destroy (`src/client/app.ts:307-421`). Automatic diff is allowed only when both sides are at most 1 MiB UTF-8 and 50,000 lines (`src/client/app.ts:307-357`).

**Recommendation.** Reuse the worker protocol and `createHistoryDiff`. React renders every line and its visible `+`, `-`, or space prefix as text. Destroy the controller when History unmounts or the paste changes.

## 7. i18n and theme contracts

### 7.1 i18n

**Verified.** The complete dictionaries are keyed identically for `en` and `zh-CN`; unknown error codes normalize to `INTERNAL_ERROR`; dates use `Intl.DateTimeFormat(locale,{dateStyle:"medium",timeStyle:"medium"})` (`src/i18n.ts:5-245`, `272-274`; `src/i18n.test.ts:11-62`). Technical identifiers remain unchanged.

**Verified.** The server considers only the first `Accept-Language` range and selects `zh-CN` for Chinese, otherwise `en`. The browser selects the first supported entry from `navigator.languages`, then falls back to document locale (`src/i18n.ts:248-270`). Manual locale changes are document-only and update `lang`, title, text, accessible labels, dates, errors and theme-control copy without storage (`src/client/app.ts:544-622`).

**Recommendation.** Reuse dictionaries, `resolveServerLocale`, `resolveBrowserLocale`, `formatDate`, and error normalization. React should render dictionary keys directly instead of keeping the current `data-i18n*` document scan. Continue to update `document.documentElement.lang` and `document.title` as state changes.

### 7.2 Theme

**Verified.** Initial theme follows `matchMedia("(prefers-color-scheme: dark)")`; system changes remain live until the user toggles an in-document override. The override is not persisted. Theme updates set both root `data-theme` and `color-scheme`, and disposal removes the media listener (`src/client/app.ts:473-542`; `src/client/app.test.ts:672-700`). CSS also supplies a no-JavaScript system-dark fallback (`src/client/styles.css:1-56`).

**Recommendation.** Reuse `createThemeController` behind a small React hook or adapter. The hook must create one controller per document, update locale-dependent control copy through React, and dispose the listener. Remove the old WeakMap/document query binding when React owns controls.

## 8. Lazy chunks and build contract

**Verified.** The root manifest pins Milkdown, diff, micromark/GFM, Hono and other existing dependencies, but does not declare `react` or `react-dom` in the root dependency headings (`package.json:15-31`; `package-lock.json:6-25`). A React migration therefore requires deliberate manifest and lockfile changes.

**Verified.** The build creates the diff worker as a separate ESM entry, injects its public URL as `__DIFF_WORKER_URL__`, then bundles the application with `splitting:true`. It derives output URLs from the esbuild metafile, writes immutable `/assets/*` headers, atomically regenerates `assetPaths`, and validates Wrangler/test configuration (`scripts/build.mjs:6-25`, `60-126`, `128-172`). The generated server interface has exactly `appJs`, `appCss`, and `diffWorker` (`src/generated/assets.ts:1-5`; `src/build.test.ts:4-10`).

**Verified.** The approved lazy boundary is source/read startup with no Crepe, micromark or diff code; visual mode loads Crepe; preview loads micromark/GFM; selecting/calculating a revision loads the standalone diff worker (`docs/superpowers/plans/2026-09-13-cloudflare-pastebin-rewrite.md:612-654`).

**Recommendation.** Keep the three generated asset keys and separate worker entry. React and ReactDOM may join the initial application bundle, but editor, preview and diff dependencies must remain behind their existing dynamic/worker boundaries. Avoid importing a component module that statically imports Milkdown or micromark.

**Verified gap.** The focused build test validates only hashed asset URL shapes and uniqueness. The prior tree had no built `dist/assets` output, so this audit does not claim a measured current bundle graph. Add or run the plan's metafile inspection after React integration; do not infer laziness solely from source-level `import()` (`src/build.test.ts:4-10`; `docs/superpowers/plans/2026-09-13-cloudflare-pastebin-rewrite.md:641-650`).

## 9. Accessibility and visual contracts

**Verified.** The approved interface is a flat Document Workbench with a real lifecycle rail, not a dashboard/card layout. It uses fixed light/dark tokens, system fonts, a 12 rem desktop rail, a 76 rem maximum width, a two-column History view, compact mobile status layout, and no gradients, glass, decorative cards, external fonts or decorative motion (`docs/superpowers/specs/2026-09-13-pastebin-ui-direction.md:7-143`).

**Verified.** Accessibility requirements include visible labels/descriptions/errors, 44 by 44 CSS-pixel targets, visible focus, semantic elements, WAI-ARIA tabs with Left/Right/Home/End and normal Tab behavior, focus-trapped dialogs, live status, non-color diff prefixes, reduced motion, source fallback, and no page-level overflow at 320 CSS px (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:1039-1051`). Current CSS implements the tokens, target size, focus rings, tab styles, local overflow, mobile reflow and reduced motion (`src/client/styles.css:1-152`, `222-283`, `451-632`, `643-745`).

**Recommendation.** Port the token values and measurable outcomes first. Component markup may retain current class names to reduce CSS churn, but no contract requires that. Delete selectors only after the replacement component and acceptance test cover the same outcome.

## 10. Superseded unintegrated tabs candidate

**Verified.** The final candidate branch is the three-commit chain `98ed2d1` -> `2da846c` -> `bfaac29`. Its merge base with the audited baseline is `e2a61d1`; `bfaac29` is not an ancestor of `5fb48eb`, so none of it is integrated.

The candidate adds an imperative `createTabsController` that:

- validates direct tab ownership, unique IDs, reciprocal panel references, enabled state and whitespace-free IDs;
- normalizes one selected tab, roving `tabindex` and `hidden` panels;
- activates on click and automatically activates/focuses on Left, Right, Home and End;
- ignores nested tablists and fails closed if ownership changes;
- registers each tablist once and disposes listeners (`bfaac29:src/client/app.ts:473-600`, `795-845`).

Its tests cover those behaviors, including presentational wrappers, nested tablists, duplicate/missing references, disabled and fieldset-disabled tabs, wraparound keys, startup idempotence and disposal (`bfaac29:src/client/app.test.ts:1082-1298`). It also strengthens server markup tests for reciprocal relationships and absence of a restricted tablist (`bfaac29:src/render.test.ts:228-335`).

**Recommendation.** Do not merge or cherry-pick this candidate. React will own the tab state and DOM, so the imperative controller and its document-wide startup registry are superseded. Port its user-observable accessibility cases into React component tests, especially roving focus, automatic activation, wraparound, normal Tab behavior, nested ownership and cleanup. The candidate's defensive validation of its own generated React markup need not be reproduced as production code; component construction and focused tests provide the invariant.

## 11. Commit disposition

| Commit or chain | Current contribution | React migration action |
|---|---|---|
| `d14d39c`, `8c5d30e`, `0761958`, `dccef889` | Integrated workbench string markup and selector-specific responsive CSS | Replace implementation with React components. Preserve approved layout, tokens, accessibility and mobile outcomes. |
| `856b3c`, `ec88611` | Mixed server renderer: safe Markdown, headers, download behavior and application page strings | Retain safe rendering, escaping, headers and download helpers. Replace create/paste body builders where React owns the body. |
| `b23f01d`, `6576716` | Dictionaries plus document-annotation i18n | Retain dictionaries/resolvers/error/date logic. Replace `data-i18n*` scanning for React-owned nodes. |
| `6c0379` | Theme controller, URL-safe password helpers and related render hooks | Retain headless theme and URL helpers. Replace imperative document binding and old theme-control markup. |
| `b47201b`, `ad03878` | Autosave state machine and correction fixes | Reuse unchanged behind React. |
| `ce2daf1`, `5c1bfec`, `f791b6a`, `009b30a`, `8401d87`, `7fe15d1`, `c99d4a8`, `8418b21`, `d2c8562` | Lazy Markdown modes, diff worker and lifecycle/recovery fixes | Reuse controllers and tests. React supplies host nodes and presentation callbacks. |
| `1311b2b`, `4a8fbe7` | Exact-source transport and bounded hydration | Reuse codec and security tests. Replace DOM hydration wrapper only. |
| `415c3e8`, `ed58958` | Hashed asset pipeline and generated asset interface | Extend entry compilation for React without replacing hashing, worker separation or immutable headers. |
| `efbdd56`, `4a2196d` and HTTP hardening commits | Canonical create/content/delete APIs and strict boundaries | Retain. Complete missing Task 6 routes before relying on them from React. |
| `98ed2d1`, `2da846c`, `bfaac29` | Unintegrated imperative tabs candidate | Superseded. Do not integrate; port accessibility outcomes only. |

## 12. Migration conflict matrix

| ID | Conflict | Evidence | Required resolution |
|---|---|---|---|
| M1 | Replacing the whole server subtree can delete bootstrap/source before extraction | Inert nodes follow page body inside the same document (`src/render.ts:94-112`) | Parse and remove inert nodes before mounting over their ancestor, or place the React root in a sibling mount node. |
| M2 | Controlled textarea state can lose exact CR/CRLF source before an edit | Exact module snapshot differs from normalized textarea value (`src/client/app.test.ts:851-880`) | Seed page-scoped canonical state from `decodeSourceData`; treat DOM value as an editing surface. |
| M3 | Client-only default Markdown view forces an eager micromark fetch or drops the server canonical preview | Markdown is default for `format=markdown`, while micromark must remain lazy (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:989-994`; `docs/superpowers/plans/2026-09-13-cloudflare-pastebin-rewrite.md:629-650`) | Retain/hydrate the server-rendered safe initial fragment, or explicitly revise the lazy contract. Do not silently load preview code at startup. |
| M4 | React cannot reconstruct current password/error pages from bootstrap alone | Bootstrap contains page/locale but no error code (`src/render.ts:249-271`) | Keep these bodies server-rendered, or deliberately add normalized safe error data and update tests. |
| M5 | Ordinary and restricted bootstrap variants do not share locale/paste fields | Variant shapes differ (`src/render.ts:243-246`, `289-292`) | Use a validated discriminated union and derive fallback locale from `<html lang>`, or normalize server output intentionally. |
| M6 | Current router lacks most read/settings/history/password/representation endpoints | Registered routes stop at create and content/delete mutations (`src/http.ts:643-706`) | Complete Task 6. React must not invent temporary endpoint names or direct service calls. |
| M7 | React effects or StrictMode can duplicate controllers, listeners, timers or saves | Existing controllers have explicit disposal and startup globals (`src/client/app.ts:44-293`, `609-639`) | Create one controller per page/paste identity, make effect cleanup mandatory, and test double setup/unmount. |
| M8 | SPA routing can retain `pastePassword` or `pasteContent` across paste identities | Both are module variables under a full-document navigation model (`src/client/app.ts:423-443`, `653-674`) | Keep full-page routing or replace globals with route-scoped state that is cleared on identity change. |
| M9 | Cached protected links become stale after password change/clear | Server links are clean; helper uses current password and URL replacement (`src/render.ts:49-71`; `src/client/app.ts:646-663`) | Build links from clean `PasteSummary.links` and current password on every render/action. |
| M10 | Framework link prefetch or mount effects can consume view-once content twice | Content-bearing reads consume; restricted UI must be local-only (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:417-449`) | Disable prefetch and exclude all server-read hooks/links from the restricted component branch. |
| M11 | Rendering source/snapshot/diff with HTML insertion breaks the trust boundary | Source must use value/text nodes and diff returns text (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:912-945`; `src/client/diff.ts:38-44`) | Use normal React text children. Reserve trusted HTML insertion for fixed safe Markdown output only. |
| M12 | React component imports can collapse current lazy boundaries | Visual/preview imports are dynamic and diff is a separate entry (`src/client/markdown.ts:146-168`, `286-318`; `scripts/build.mjs:132-169`) | Keep heavy imports inside controller entry methods and retain worker entry separation; inspect the metafile after build. |
| M13 | React i18n rendering plus the old DOM scanner can update the same nodes twice | Current startup scans `data-i18n*` and installs document listeners (`src/client/app.ts:579-639`) | Remove scanner/listeners for React-owned nodes; retain pure dictionaries and document-level lang/title effects. |
| M14 | React theme state plus old WeakMap controller can install duplicate media listeners | Current initializer caches per `Document` but exposes no application disposal (`src/client/app.ts:609-639`) | Use one explicit React adapter around `createThemeController`; dispose it and remove old initializer ownership. |
| M15 | Existing CSS selectors assume the exact string-rendered DOM | Rules target current roles/classes/data attributes (`src/client/styles.css:154-782`) | Either preserve those hooks during the first migration or port rules alongside components. Verify 320 px overflow, focus and target sizes before deleting old CSS. |
| M16 | Integrating `bfaac29` creates competing tab ownership | Candidate mutates tab attributes/panels while React would do the same (`bfaac29:src/client/app.ts:544-600`) | Leave the candidate unintegrated. React is the sole owner; port behavior tests. |
| M17 | Existing exact-string render tests will reject intentional React DOM replacement without distinguishing lost contracts | Tests assert long current strings and empty panels (`src/render.test.ts:219-336`) | Replace markup-shape assertions with envelope/bootstrap/security tests plus React semantic component tests. Keep restricted-link absence and source/CSP assertions. |
| M18 | The current client has no create/copy/settings/history/delete API wiring to migrate | `startApp` ends after locale/theme/password/source setup (`src/client/app.ts:665-676`) | Implement these once in React against canonical APIs. Do not retain placeholder DOM and add a second imperative binder. |
| M19 | Worker/editor instances can survive component unmount or paste change | Both controllers expose `destroy`/`dispose` and serialize teardown (`src/client/app.ts:333-421`; `src/client/markdown.ts:55-125`, `321-326`) | Await Markdown teardown where required and always destroy history workers in effect cleanup. |
| M20 | A shared application header middleware can accidentally constrain user HTML | `/html` explicitly has no application CSP (`docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md:916-927`) | Keep `/html` on a representation response path that never calls the React application envelope/header helper. |

## 13. Test contract and migration plan

| Test source | Preserve unchanged | Port or replace | Missing coverage to add |
|---|---|---|---|
| `src/source-data.test.ts:7-35` | Codec validity, exact Unicode/line endings, 10 MiB bound | None | React initialization must prove it decodes before root replacement. |
| `src/i18n.test.ts:11-62` | Dictionary parity, fallback, locale resolution, date options | None | React component locale switch must update lang/title/current labels without storage. |
| `src/client/app.test.ts:323-668` | Entire autosave fake-clock suite | None | React adapter lifecycle, state presentation, Retry/Reload/Overwrite controls and StrictMode-safe setup. |
| `src/client/app.test.ts:671-902` | Pure theme, URL and exact-source expectations | Replace fixture-specific global startup assertions as React takes ownership | No-storage and paste-identity reset tests. |
| `src/client/markdown.test.ts:198-718` | Entire Markdown transition/recovery suite | Only host integration fixture if its DOM changes | React unmount waits for teardown and leaves source fallback usable. |
| `src/client/diff.test.ts:4-17` and `src/client/app.test.ts:1003-1050` | Worker protocol, prefixes, stale IDs, size gate, termination | Presentation assertions move to components | Structured lines render as text and large diff requires user action. |
| `src/render.test.ts:95-193`, `300-422` | Bootstrap escaping, CSP, one inert source node, no password/content in bootstrap, restricted link absence, safe Markdown, hashed scripts | Replace exact workbench strings and empty-panel assertions | React root/envelope and bootstrap variant validation. |
| `src/build.test.ts:4-10` | Hashed `appJs`/`appCss`/`diffWorker` interface | Extend only if entry naming changes intentionally | Metafile or built-output check for no eager Milkdown/micromark/diff code. |
| `src/http.test.ts:46-1738` | Existing root/create/content/delete and strict boundary tests | None | Task 6 browser/read/settings/password/history/representation/CSP/view-once matrices. |
| `bfaac29:src/client/app.test.ts:1082-1298` | User-observable tab keyboard/focus/selection/ownership/disposal cases | Rewrite against React components; do not retain candidate fixtures/controller | Fieldset/disabled behavior only if React can actually render disabled tabs. |
| Planned `test/e2e/pastebin.spec.ts` | None exists at the audited baseline | Implement Task 11 | Cross-browser journeys, no auto-navigation/prefetch, conflict preservation, view-once local actions, lazy network requests, i18n/theme, keyboard/dialog and 320 px checks (`docs/superpowers/plans/2026-09-13-cloudflare-pastebin-rewrite.md:658-696`). |

**Verified gap.** The audited tree contains no `test/` or `tests/` files and no built `dist/assets` files. Unit tests cover headless controllers and server strings, not a functioning browser UI. Task 11 and Task 12 remain the required acceptance and local smoke gates (`docs/superpowers/plans/2026-09-13-cloudflare-pastebin-rewrite.md:658-770`).

## Source table

| # | Local source | Sections used | Audit role |
|---:|---|---|---|
| 1 | `docs/superpowers/specs/2026-09-12-cloudflare-pastebin-rewrite-design.md` | `378-710`, `910-1051` | Approved password, view-once, HTTP, rendering, CSP, frontend, i18n, theme and accessibility contracts. |
| 2 | `docs/superpowers/specs/2026-09-13-pastebin-ui-direction.md` | `1-155` | Approved visual, responsive, copy, motion and acceptance direction. |
| 3 | `docs/superpowers/plans/2026-09-13-cloudflare-pastebin-rewrite.md` | `418-470`, `518-770` | Tasks 6, 8, 9, 10, 11 and 12 interfaces and gates. |
| 4 | `package.json` | `1-33` | Scripts and root direct dependency headings. |
| 5 | `package-lock.json` | `1-120` | Lockfile format and root dependency/devDependency headings only. |
| 6 | `scripts/build.mjs` | `1-172` | Hashed app/CSS/worker build, splitting, generated paths and immutable headers. |
| 7 | `src/generated/assets.ts` | `1-5` | Generated server asset interface. |
| 8 | `src/render.ts` | `1-313` | Document envelope, bootstrap variants, current DOM, safe Markdown, CSP and downloads. |
| 9 | `src/i18n.ts` | `1-274` | Dictionaries, errors, locale resolution and date formatting. |
| 10 | `src/source-data.ts` | `1-72` | Exact UTF-8 base64 transport and limits. |
| 11 | `src/client/app.ts` | `1-676` | Autosave, diff bridge, source hydration, theme, locale, password and startup behavior. |
| 12 | `src/client/markdown.ts` | `1-327` | Lazy Markdown modes and lifecycle. |
| 13 | `src/client/diff.ts` | `1-75` | Worker protocol and structured line output. |
| 14 | `src/client/styles.css` | `1-782` | Tokens, workbench selectors, responsive behavior and accessibility styles. |
| 15 | `src/types.ts` | `1-131` | Frontend-visible error, summary, resource, mutation and history interfaces. |
| 16 | `src/http.ts` | `1-709`, frontend-facing route and response portions | Current canonical route availability, response envelopes and password precedence. |
| 17 | `src/build.test.ts` | `1-11` | Generated asset URL checks. |
| 18 | `src/render.test.ts` | `1-461` | DOM, bootstrap, source, CSP, restricted page, i18n, Markdown and download contracts. |
| 19 | `src/i18n.test.ts` | `1-63` | Dictionary, error, locale and date tests. |
| 20 | `src/source-data.test.ts` | `1-36` | Exact transport and boundary tests. |
| 21 | `src/client/app.test.ts` | `323-1051` plus fixtures needed by those tests | Autosave, document state, source, Markdown integration and diff tests. |
| 22 | `src/client/markdown.test.ts` | `198-719` plus fixtures needed by those tests | Markdown transition, failure, retry and teardown tests. |
| 23 | `src/client/diff.test.ts` | `1-18` | Exact worker line protocol test. |
| 24 | `src/http.test.ts` | `1-1738` | Current HTTP slice coverage and missing Task 6 route evidence. |
| 25 | Git history through `5fb48eb` and scoped diff `1aa75c6..5fb48eb` | Commit/file metadata | Integrated UI commit ownership and proof that scoped source did not change after the captured excerpts. |
| 26 | `bfaac29:src/client/app.ts` | `473-600`, `795-848` | Final unintegrated tabs candidate implementation. |
| 27 | `bfaac29:src/client/app.test.ts` | `1082-1298` | Final unintegrated tabs candidate behavior tests. |
| 28 | `bfaac29:src/render.test.ts` and local tree inventory | changed reciprocal tab assertions; `test/**/*`, `tests/**/*`, `dist/assets/**/*` | Candidate server-markup additions and verified absence of E2E/built assets. |
