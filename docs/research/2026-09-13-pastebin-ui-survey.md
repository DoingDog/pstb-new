# Paste-product UI and interaction survey

**Access date:** 2026-09-13

**Scope:** established open-source paste and clipboard products, using only project repositories, project-owned documentation, and official live demos.

**Products:** PrivateBin, Hastebin/Haste, MicroBin, Wastebin, Rustypaste, Opengist, and Pastefy. Opengist and Pastefy were added because their official repositories are verifiable and their multi-file, revision, folder, and preview patterns materially extend the required set.

## Method and evidence labels

- **[V] Verified:** stated by a project-owned source or directly present in version-pinned source or a live official page.
- **[I] Inference:** a bounded conclusion from cited primary evidence. It is not asserted as a documented product guarantee.
- **[R] Recommendation:** an adoption decision for a document workbench, not a claim about a surveyed product.
- **[U] Unknown:** the surveyed primary sources did not establish the point.

Repository source is pinned to the release named for each product when one was available. “Current commit” means the default-branch head observed on the access date; it is recency evidence, not proof of project health or support quality. Live pages were inspected as markup and rendered content, not from screenshots. No local application code, Cloudflare runtime material, secondary article, or general React template was used. This report does not select or recommend a React template.

Negative findings are narrow. “No history UI verified,” for example, means the released documentation and the create/view source inspected for this survey did not expose one. It does not prove that no deployment, extension, API, or later version can provide it.

## Executive findings

- **[I] No surveyed product is a direct reference implementation for the complete frozen password, strict view-once, and active-HTML contract.** PrivateBin and Wastebin provide the closest password plus one-time disclosure patterns, but their rendered-content paths sanitize markup. Rustypaste expressly prevents combining protected and one-shot uploads. Pastefy encrypts in the browser, but its released data model has expiry rather than view-once and its HTML preview is sanitized and script-disabled.
- **[R] Reuse Wastebin’s two-step one-time reveal interaction and PrivateBin’s pre-load confirmation wording, then enforce the transition atomically on the server.** Wastebin 3.7.2 fixed a race that could leak a burned paste, direct evidence that view-once is a transaction/concurrency property as well as a dialog design ([Wastebin changelog](https://raw.githubusercontent.com/matze/wastebin/3.7.2/CHANGELOG.md), [burn confirmation template](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/templates/burn-confirmation.html), [PrivateBin template](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/tpl/bootstrap5.php)).
- **[R] Use an editor plus progressively disclosed settings panel, a separate immutable view, explicit source/preview modes, file tabs, and clone/fork actions.** Wastebin supplies the compact editor/settings layout; Opengist and Pastefy supply multi-file workbench patterns; historical Haste and PrivateBin supply clone-to-edit semantics.
- **[R] Do not copy a surveyed Markdown or HTML renderer into an active-HTML path.** PrivateBin sanitizes Showdown output, Wastebin sanitizes Markdown, Pastefy sets Markdown-It `html: false` and sanitizes its HTML preview inside a sandbox without script permission, and Rustypaste forces text-like files to `text/plain` ([PrivateBin JavaScript](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/js/privatebin.js), [Wastebin README](https://raw.githubusercontent.com/matze/wastebin/3.7.2/README.md), [Pastefy Markdown viewer](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/previews/MarkdownViewer.vue), [Pastefy HTML viewer](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/previews/HTMLViewer.vue), [Rustypaste README](https://raw.githubusercontent.com/orhun/rustypaste/v0.18.1/README.md)).
- **[R] Reimplement interaction ideas rather than transplanting UI code.** Most projects use server templates or Vue, and Opengist is AGPL-3.0. Permissive licenses still require their notices and bundled dependencies have separate terms.

## Stack, license, and recency snapshot

| Product and surveyed release | Frontend and server stack | License evidence and direct-code posture | Release and repository recency as observed 2026-09-13 |
|---|---|---|---|
| PrivateBin 2.0.6 | **[V]** PHP server templates; Bootstrap 5.3.8 in the current official demo; jQuery-based project JavaScript; Showdown, DOMPurify, and code highlighting in the client ([template](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/tpl/bootstrap5.php), [JavaScript](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/js/privatebin.js), [demo](https://privatebin.net/)). | **[V]** Composer declares `zlib-acknowledgement`; inspected CSS/JS headers identify the zlib/libpng license ([composer.json](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/composer.json), [common CSS](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/css/common.css)). **[R]** Preserve the applicable notice and audit each copied file and bundled dependency. | **[V]** [2.0.6 released 2026-08-08](https://github.com/PrivateBin/PrivateBin/releases/tag/2.0.6); [default-branch commit dated 2026-09-12](https://github.com/PrivateBin/PrivateBin/commit/e5059f8c3373d1a2fb3683da870301ad825bf29e). Recent release and commit evidence. |
| Hastebin current service; historical Haste at commit `4e20ea0` | **[V]** The current `hastebin.com` redirects to Toptal’s Hastebin service. **[I]** Current markup contains Next.js metadata, but the current implementation stack is not verified from source. **[V]** Historical Haste used Node.js, jQuery 1.7, Highlight.js, and plain HTML/CSS/JS ([historical README](https://raw.githubusercontent.com/shykes/haste-server/4e20ea078f4d8d89fd863cfdaca820979af6b316/README.md), [historical HTML](https://raw.githubusercontent.com/shykes/haste-server/4e20ea078f4d8d89fd863cfdaca820979af6b316/static/index.html)). | **[U]** No verifiable current Toptal source repository or current license was found. Historical Haste is MIT, but it is not evidence for the current service. **[R]** Do not copy current-service code or assets without a verifiable license; historical MIT code can be reused only under its notice. | **[V]** Current service is live at [Toptal Hastebin](https://www.toptal.com/developers/hastebin). Expected [Toptal repository URL](https://github.com/toptal/haste-server) returned 404 and [Toptal repository search](https://api.github.com/search/repositories?q=haste+user%3Atoptal) returned no Haste repository. The surviving [historical commit is dated 2011-11-29](https://github.com/shykes/haste-server/commit/4e20ea078f4d8d89fd863cfdaca820979af6b316). Current release/commit recency is unknown. |
| MicroBin 2.1.0 | **[V]** Rust 1.74, Actix Web, Askama templates, vanilla JavaScript, and embedded Water.css ([Cargo.toml](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/Cargo.toml), [README](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/README.md)). | **[V]** BSD-3-Clause in the release manifest. **[R]** Direct reuse must preserve the copyright, conditions, disclaimer, and non-endorsement clause; browser and Rust dependencies remain separate. | **[V]** [v2.1.0 released 2026-01-10](https://github.com/szabodanika/microbin/releases/tag/v2.1.0); [default-branch commit dated 2026-09-08](https://github.com/szabodanika/microbin/commit/5268924116f87139dc83459893457d8f02ad1149). Recent commit evidence. |
| Wastebin 3.7.2 | **[V]** Rust server, Axum and SQLite per owned README, Askama templates, vanilla JavaScript/CSS, and Syntect/two-face highlighting ([README](https://raw.githubusercontent.com/matze/wastebin/3.7.2/README.md), [Cargo.toml](https://raw.githubusercontent.com/matze/wastebin/3.7.2/Cargo.toml)). | **[V]** MIT. **[R]** Code can be adapted with the MIT notice, but dependencies and icons/themes need their own review. | **[V]** [3.7.2 released 2026-08-10](https://github.com/matze/wastebin/releases/tag/3.7.2); [default-branch commit dated 2026-08-27](https://github.com/matze/wastebin/commit/751cd33f66e852557c305f57550933af70e25b6f). The [official demo](https://bin.bloerg.net/) identified itself as 3.7.2. |
| Rustypaste 0.18.1 | **[V]** Rust and Actix Web; primarily an HTTP/multipart service with an optional static HTML landing/upload form ([Cargo.toml](https://raw.githubusercontent.com/orhun/rustypaste/v0.18.1/Cargo.toml), [example form configuration](https://raw.githubusercontent.com/orhun/rustypaste/v0.18.1/examples/html_form.toml)). | **[V]** MIT. **[R]** Its server code is permissively reusable with the notice, but its optional example page is a minimal starting point, not a workbench component system. | **[V]** [v0.18.1 released 2026-09-07](https://github.com/orhun/rustypaste/releases/tag/v0.18.1); [default-branch commit dated 2026-09-10](https://github.com/orhun/rustypaste/commit/2de835af34a2dae1ebb399152c3e97721b36bed9). Recent release and commit evidence. |
| Opengist 1.15.2 | **[V]** Go and server templates; TypeScript/Vite; HTMX and Hyperscript; CodeMirror 6; Tailwind CSS 4 and Basecoat; Marked, DOMPurify, Highlight.js, KaTeX, and PDFObject ([package.json](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/package.json), [base layout](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/layouts/base.html)). | **[V]** AGPL-3.0 ([license](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/LICENSE)). **[R]** Interaction ideas can be independently implemented. Copying and modifying covered code into a network service needs an AGPL compliance plan, including corresponding-source obligations. | **[V]** [v1.15.2 released 2026-08-30](https://github.com/thomiceli/opengist/releases/tag/v1.15.2); [default-branch commit dated 2026-08-30](https://github.com/thomiceli/opengist/commit/5afef9ac76d2d69ba11a888bb7a095b1d14e7c9d). The [official demo](https://demo.opengist.io/) was live and redirected to `/-/all`. |
| Pastefy 7.2.6 | **[V]** Java service and Vue 3/TypeScript/Vite frontend; PrimeVue, Tailwind CSS 4, Pinia, Vue Router, CodeMirror, Markdown-It, DOMPurify, Mermaid, and multiple data-preview libraries ([README](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/README.md), [frontend package](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/package.json)). | **[V]** MIT ([license](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/LICENSE)). **[R]** Preserve the MIT notice for copied code and check each preview dependency. Its large Vue stack is evidence about interaction composition, not a template recommendation. | **[V]** [7.2.6 released 2026-06-01](https://github.com/interaapps/pastefy/releases/tag/7.2.6); [default-branch commit dated 2026-06-01](https://github.com/interaapps/pastefy/commit/3f2c11a4c9fcf79929dfd02c96cda28c1c54792e). The project-owned feature page and public app were live, although static extraction of the client-rendered app body was empty ([features](https://docs.pastefy.app/features/index.html), [app](https://pastefy.app/)). |

## Capability matrix

All cells are **[V]** unless marked **[I]** or **[U]**.

| Product | Create pattern | View, edit, and history | Password and view-once | Files, Markdown, and HTML |
|---|---|---|---|---|
| PrivateBin | Full-height textarea with Editor/Preview tabs; expiration, burn-after-reading, discussion, password, attachment, format, and Create controls live in a collapsible Bootstrap toolbar ([template](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/tpl/bootstrap5.php)). | Dedicated view offers New, Clone, Raw text, Save document, copy, delete, QR, and optional discussion. Clone creates a new document; no in-place edit or revision history was verified. | Browser-side encryption; optional password; explicit one-time pre-load modal, “This secret message can only be displayed once,” before download/decrypt. A revealed one-time paste shows a “FOR YOUR EYES ONLY” remaining-time warning ([JavaScript](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/js/privatebin.js)). | Optional encrypted attachments, drag/drop, and pasted images. Markdown is converted with Showdown then passed through DOMPurify; source-code and plaintext modes are separate. Active HTML is not the rendered-paste contract. |
| Historical Haste; current Hastebin where observable | One dominant textarea with Save. Historical implementation turns the editor into a locked highlighted view after saving ([historical JavaScript](https://raw.githubusercontent.com/shykes/haste-server/4e20ea078f4d8d89fd863cfdaca820979af6b316/static/application.js)). | Historical Duplicate & Edit copies the text into a new unsaved document. Ctrl+S, Ctrl+N, Ctrl+D, and Ctrl+T shortcuts are wired. No history. Current service visibly exposes Start a New Text and Save, but equivalence to historical behavior is **[U]**. | No password or one-shot behavior in historical source; current behavior is **[U]**. | Historical source is text-only with Highlight.js; no attachment or Markdown renderer. Current file/Markdown behavior is **[U]**. |
| MicroBin | Native form with a settings grid, expiration, a burn-count selector, syntax mode, five privacy levels, password, content, optional attachment, and Save ([create template](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/index.html)). | View exposes copy text/redirect/URL, raw content, QR, conditional Edit and Remove, read count/last read, and attachment download. Edit is an explicit “Editing upload” form and can demand the uploader password; a public/list page is not revision history ([view](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/upload.html), [edit](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/edit.html), [list](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/list.html)). | Password meaning changes by privacy mode: read-only gates modification, private gates access server-side, and secret sends already encrypted content from the browser. Burn After is a read counter with First, 10th, 100th, 1000th, and 10000th Read choices, not a dedicated binary view-once control ([guide](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/guide.html)). | One optional attachment. “HTML” is a syntax-highlighting selection and displayed content is escaped/highlighted; no Markdown preview was verified. It is not active HTML. |
| Wastebin | Full editor with title and a right settings rail; searchable language selection, expiration chips, burn-after, encryption, password reveal, counters, byte-limit progress, and a file-drop overlay ([create template](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/templates/index.html)). | View exposes copy URL/content, raw/formatted modes, wrapping, Markdown source/render toggle, QR, delete, and keyboard-help overlay. No edit/revision UI was verified ([paste template](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/templates/paste.html)). | Password entry has show/hide, Cancel, and Decrypt. One-time links first present a Cancel/Reveal interstitial. Owned strings say deletion happens “the moment they confirm” and the paste cannot be viewed again ([password template](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/templates/encrypted.html), [English strings](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/src/i18n.rs)). | Dropping a file loads its content into the editor; README says arbitrary file upload is not supported. Markdown supports GFM tables, task lists, and admonitions, but raw HTML is sanitized with Ammonia. |
| Rustypaste | Optional landing page uses separate native forms for URL, remote file URL, file, one-time file, and password-protected file; the main product remains an HTTP/multipart API ([example landing page](https://raw.githubusercontent.com/orhun/rustypaste/v0.18.1/examples/landing_page.html)). | Links return uploaded content. No rich edit, fork, or revision-history workbench was verified. | Password-protected files use Argon2id. The password cannot be changed, and protected uploads cannot be combined with one-shot or URL modes. One-shot files/URLs otherwise exist ([README](https://raw.githubusercontent.com/orhun/rustypaste/v0.18.1/README.md)). | File-first service with filesystem storage and no database. Text-like MIME types are forced to `text/plain; charset=utf-8` to prevent script execution. No rendered Markdown workbench was verified. |
| Opengist | Multi-file CodeMirror editor; Add file and drag/drop upload; title, custom URL, description, topics, expiration, and public/unlisted/private split-button in a sticky settings rail ([create](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/pages/create.html), [editor partial](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/partials/editor.html)). | Owners edit and save files; other signed-in users fork. View has per-file anchors, Raw, copy, download, repository clone/embed/ZIP actions. Git-backed revisions expose commit hashes and line diffs ([edit](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/pages/edit.html), [view](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/pages/gist.html), [header actions](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/partials/gist_header.html), [revisions](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/pages/revisions.html)). | Account authentication and private visibility exist. Paste-level password and view-once controls were not verified in the released create/view model. | Multiple text and binary files; Markdown, CSV, notebook, PDF and code views; raw files and ZIP. The Goldmark builder enables GFM and extensions but does not enable an unsafe raw-HTML renderer ([Markdown renderer](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/internal/render/markdown.go)). Active HTML is not a verified view mode. |
| Pastefy | Compact CodeMirror form; title/filename and visibility; progressive Settings panel for password/client encryption, expiry, folder, tags, and optional AI metadata; full-screen source/preview split; single paste can become a tabbed `MULTI_PASTE` ([create component](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/forms/CreatePaste.vue)). | Owners edit the same ID by `PUT`; fork copies content into a new draft and preserves `forked_from`; view offers copy, fork, edit, share, raw when unencrypted, download, tags, comments, and responsive multi-part tabs ([paste component](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/Paste.vue), [paste store](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/stores/current-paste.ts)). No revision history was verified. | Optional passphrase encrypts title/content in the browser. If encryption is enabled without a passphrase, an automatic fragment key is generated. The released `Paste` type has expiry but no burn/view-once field ([type](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/types/paste.ts)). | Multi-part tabs plus API/cURL file upload documented by the project. Rich preview router covers Markdown and many structured formats ([preview router](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/PastePreview.vue)). Markdown disables raw HTML. HTML is sanitized with DOMPurify and loaded into `<iframe sandbox="allow-same-origin">`, which does not grant scripts. |

## Product findings

### PrivateBin

**Verified facts**

- The [2.0.6 README](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/README.md) describes browser-side AES-GCM encryption, optional passwords, expiration and burn after reading, Markdown preview, syntax highlighting, optional upload/preview, QR, and Bootstrap 5 plus legacy templates. The decryption key remains in the URL fragment, while a password is not part of the URL.
- The released [Bootstrap 5 template](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/tpl/bootstrap5.php) uses labels for expiration, burn, discussion, format, dark mode, and the decrypt password. Icon-only password and modal-close buttons have `aria-label`; decorative SVGs use `aria-hidden`. Status, remaining-time, error, insecure-connection, and modern-browser notices use `role="alert"`. The textarea has `aria-label="Document text"`.
- The same template exposes Loading and Retry, a success alert with Copy link and Delete data, an insecure HTTP/WebCrypto warning, and FAQ links for stuck loading and browser/connection failures. This is the strongest surveyed general status/error pattern.
- The official [live demo](https://privatebin.net/) served version 2.0.6 with a responsive viewport and a Bootstrap collapsing navigation bar. [Common CSS](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/css/common.css) limits media previews to their container, uses a 70dvh editor, and shortens it on small/short screens.
- Markdown conversion is followed by DOMPurify; SVG attachment previews are also sanitized or downgraded to download-only. This is deliberate non-active content handling, not an active-HTML design.

**Inferences and unknowns**

- **[I]** Clone is a good immutable-document affordance because it separates reading an existing secret from composing a new one; no revision model is implied.
- **[I]** Role-based alerts improve semantics, but the inspected template contains no `aria-live` region and a reply textarea lacks an explicit accessible label. This source review is not a conformance audit.
- **[U]** No durable offline/online indicator was found. Retry and request-level errors are verified instead.

**Recommendations**

- **[R]** Adopt the one-time pre-load question, initial focus on the reveal action, explicit retry, and differentiated loading/success/error states.
- **[R]** Keep “password” and “link fragment key” distinct in help text. Do not import PrivateBin’s zero-knowledge architecture as an unstated assumption for a different server contract.
- **[R]** Do not reuse its Markdown renderer for active HTML; it removes or neutralizes the behavior that the frozen active-HTML contract requires.

### Hastebin and historical Haste

**Verified facts**

- [hastebin.com](https://hastebin.com/) redirected to [Toptal Hastebin](https://www.toptal.com/developers/hastebin), where the extracted live page exposed Start a New Text and Save. No current source link appeared in the owned page links.
- Both the expected [Toptal source URL](https://github.com/toptal/haste-server) and the earlier `seejohnrun/haste-server` location were unavailable. GitHub’s [repository search scoped to Toptal](https://api.github.com/search/repositories?q=haste+user%3Atoptal) returned no matching repository.
- The surviving [historical repository lineage](https://github.com/shykes/haste-server) is pinned here to [commit `4e20ea0`](https://github.com/shykes/haste-server/commit/4e20ea078f4d8d89fd863cfdaca820979af6b316). Its [application JavaScript](https://raw.githubusercontent.com/shykes/haste-server/4e20ea078f4d8d89fd863cfdaca820979af6b316/static/application.js) locks a saved document and implements Duplicate & Edit as a new draft. It binds Ctrl+S, Ctrl+N, Ctrl+D, and Ctrl+T.
- Historical load failure silently creates a new document and save has no error callback. [Historical HTML](https://raw.githubusercontent.com/shykes/haste-server/4e20ea078f4d8d89fd863cfdaca820979af6b316/static/index.html) uses icon-only `div` controls, although the displayed `<pre>` is focusable. [Historical CSS](https://raw.githubusercontent.com/shykes/haste-server/4e20ea078f4d8d89fd863cfdaca820979af6b316/static/application.css) reveals tool labels on hover, fixes tools to the top right, and has no responsive breakpoint; the HTML has no viewport meta.

**Inferences and unknowns**

- **[I]** Next.js metadata in the current live DOM suggests a current Next.js frontend, but without current source this remains an inference and is not a reuse basis.
- **[U]** Current license, source history, release cadence, password, view-once, file, Markdown, error, connection, accessibility, and responsive behavior are not established by a verifiable current repository.
- **[I]** Hover-only labels and non-semantic clickable `div`s make the historical toolbar a poor keyboard/touch/accessibility reference even though its spatial economy is recognizable.

**Recommendations**

- **[R]** Reuse the interaction idea “saved document becomes immutable; Duplicate & Edit starts a new draft,” not the historical DOM or hover-only toolbar.
- **[R]** Add semantic buttons, persistent accessible names, focus-visible treatment, and explicit failed-save/load states. The historical silent reset could discard a user’s understanding of what loaded.
- **[R]** Treat current Hastebin as a live service reference only. Do not represent the historical MIT source as the current Toptal implementation.

### MicroBin

**Verified facts**

- The [create template](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/index.html) uses native controls and attaches `?` links beside Expiration, Burn After, Syntax, Privacy, and Password. Each goes to the matching anchor in the [owned guide](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/guide.html). This is the clearest surveyed progressive help pattern.
- Burn After is explicitly a numeric access limit. “First Read” fits strict one-read intent; the higher counts do not. Privacy choices are Public, Unlisted, Read-only, Private, and Secret, with different password effects explained in the guide.
- The [view template](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/upload.html) puts copy/raw/QR/edit/remove actions beside the identifier and gates secret decryption with a labeled key input. The [edit template](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/edit.html) identifies the editing state, requests the password again, and can show “Incorrect password.”
- [Water.css](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/assets/water.css) constrains the body to 800px with horizontal padding, supports dark color preference, gives form controls visible focus shadows, allows code to scroll horizontally, and makes media responsive. The [list template](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/list.html) sets a 720px minimum table width, so a narrow viewport can require horizontal scrolling.
- The create Content label has no `for`, and the styled file action is an anchor with `role="button"` but no `href`. Those are source-level accessibility weaknesses.
- The repository names `https://pub.microbin.eu/` as a test server. It returned HTTP 522 during this access. That records one failed observation, not general downtime.

**Inferences and unknowns**

- **[I]** A single “First Read” checkbox or toggle is less error-prone for a frozen binary contract than exposing MicroBin’s entire counter list.
- **[U]** No per-paste revision history, accessible live copy confirmation, durable connection indicator, rendered Markdown, or active-HTML path was verified.
- **[I]** Its small native form is technically easy to reproduce, but the five privacy modes encode product-specific authorization/encryption semantics and should not be copied without their explanatory model.

**Recommendations**

- **[R]** Adopt the adjacent `?` help links and dedicated anchor targets, but keep a one-sentence consequence beside irreversible or security-sensitive controls so users need not leave the form.
- **[R]** Restrict view-once to one explicit choice. Do not expose 10th/100th/etc. reads if the contract is strictly one reveal.
- **[R]** Use actual `<button>` elements and fully associated labels. Announce copy and save results in a status region.

### Wastebin

**Verified facts**

- The [create template](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/templates/index.html) gives the editor most of the viewport and a compact settings rail. Expiry appears as radio chips; burn-after and encryption are switches with hints; language selection is searchable; password has show/hide; live line/character/byte counts and a byte-limit progress bar make constraints visible.
- The [paste template](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/templates/paste.html) includes explicit “Copied content” and “Copied URL” toast strings plus a keyboard-help overlay with `<kbd>` rows. Owned README commands cover raw, home, copy URL/content, QR, formatting, wrapping, Markdown source/render, and help.
- The [burn confirmation](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/templates/burn-confirmation.html) separates Cancel from Reveal. [English strings](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/src/i18n.rs) disclose at creation that the recipient will see a confirmation and deletion occurs on confirmation; the reveal screen repeats that it is permanent.
- [Version 3.7.2’s changelog](https://raw.githubusercontent.com/matze/wastebin/3.7.2/CHANGELOG.md) says it fixed a race condition that could leak a burned paste. Version 3.6.1 added confirmation before reveal, 3.6.0 added Markdown sanitization and source/render toggle, and 3.1.0 improved mobile layout and added a burned-paste toast.
- [Style source](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/src/style.css) changes the editor/panel split to a stacked column at 720px, sizes dialogs responsively, makes Markdown tables/images responsive, and supplies a `:focus-visible` accent outline. It globally removes `:focus` outlines and relies on `:focus-visible` plus field border changes; no reduced-motion rule was found in the inspected style.

**Inferences and unknowns**

- **[I]** This is the most complete surveyed strict-view-once interaction reference because it covers disclosure before sharing, confirmation before reveal, feedback after burn, and a documented concurrency correction.
- **[I]** The view-once UI still cannot establish atomicity. Only server-side state transition tests and storage semantics can do that.
- **[U]** No in-place edit/revision UI or persistent online/offline indicator was verified.

**Recommendations**

- **[R]** Adopt its consequence-first copy and confirmation sequence. The target sequence should be create -> show share warning -> recipient confirmation -> atomic reveal-and-consume -> terminal burned state.
- **[R]** Adopt the responsive editor/settings rail, live byte-limit feedback, visible copy toast, and discoverable shortcut overlay.
- **[R]** Do not adopt Ammonia-sanitized Markdown as the active-HTML executor. Keep source, safe Markdown preview, and active HTML as visibly separate modes.

### Rustypaste

**Verified facts**

- The [0.18.1 README](https://raw.githubusercontent.com/orhun/rustypaste/v0.18.1/README.md) describes files, URL shortening, one-shot files/URLs, password-protected files, automatic passwords, Argon2id, filesystem storage, and no database.
- It explicitly says protected files cannot be combined with one-shot or URL modes, and passwords cannot be changed. That is a direct contract conflict if password and view-once must coexist.
- It forces text-like MIME types to `text/plain; charset=utf-8` to avoid script execution. That directly conflicts with active HTML.
- The optional [example landing page](https://raw.githubusercontent.com/orhun/rustypaste/v0.18.1/examples/landing_page.html) separates upload modes into forms and discloses administrator removal plus default expiry. Its inputs have no labels, placeholders, or other accessible names in the inspected source.

**Inferences and unknowns**

- **[I]** Separate forms make mutually exclusive API modes unambiguous, but they fragment a document-oriented composition flow.
- **[U]** No official live demo, rich editor/view workbench, Markdown rendering, history, copy toast, request progress, retry, or connection UI was verified from the released project material.

**Recommendations**

- **[R]** Reuse its plain-language hosting/expiry disclosure and clear mode separation only where modes truly cannot combine.
- **[R]** Do not reuse the protected-versus-one-shot constraint or plaintext response policy for the frozen contract.
- **[R]** Build a labeled, semantic form and explicit upload progress/error state if its API model informs a workbench.

### Opengist

**Verified facts**

- The [1.15.2 README](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/README.md) describes Git-backed snippets, web/Git modification, public/unlisted/private visibility, Markdown/CSV, search, topics, embeds, revisions, likes, forks, raw files, and ZIP download.
- The [create template](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/pages/create.html) uses one column by default and an editor plus 20rem sticky settings rail at `lg`; labels are associated with metadata inputs; the upload zone is a `<label>` for a screen-reader-only multi-file input. The visibility menu has `aria-haspopup`, `aria-expanded`, `aria-controls`, `role="menu"`, and menu items.
- The [base layout](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/layouts/base.html) has a responsive viewport, a checkbox-controlled sidebar hidden above `md`, labeled sidebar toggle, semantic account/visibility menus, `role="alert"` for errors/warnings, and `role="status"` for informational messages. Search syntax help appears while the search group has focus.
- [Editor TypeScript](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/public/ts/editor.ts) configures CodeMirror line numbers, Tab indentation, Shift+Tab, Mod+/, filename-driven language loading, Markdown preview, indentation/wrap selectors, unsaved-change warning, add/delete file, and drag/drop upload. Upload failures are logged to the console rather than shown in the upload zone.
- [Main TypeScript](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/public/ts/main.ts) supplies a delayed HTMX page-progress bar and swaps HTTP error pages into view. The progress bar is `aria-hidden`.
- Copy buttons have `aria-label="Copy"` and temporarily replace the copy icon with a check for 1.2 seconds. No live text announcement accompanies the change. Notebook and PDF loaders have `role="status"` and accessible labels.

**Inferences and unknowns**

- **[I]** Git-backed file revisions, stable per-file raw/download URLs, file anchors, and line diffs are the strongest surveyed history/workbench model.
- **[I]** The delayed progress bar avoids visual flicker on fast page transitions, but because it is intentionally hidden from assistive technology it should not be the only feedback for a long operation.
- **[U]** Paste-level password, one-time reveal, active HTML, an upload-error message beside the failed file, reduced-motion behavior, and persistent connection state were not verified.

**Recommendations**

- **[R]** Adopt file tabs/anchors, filename-driven language selection, source/preview/raw/download separation, and commit-oriented history where documents are truly mutable.
- **[R]** Show asynchronous upload errors in a `role="alert"` near the file, not only in the console. Add textual copy confirmation in a polite status region.
- **[R]** Independently reimplement these ideas unless AGPL-3.0 is acceptable for the target distribution and network deployment.

### Pastefy

**Verified facts**

- Project-owned [feature documentation](https://docs.pastefy.app/features/index.html) lists raw/copy/fork, public/private/unlisted, client encryption, expiry, folders, full-screen mode, rich previews, API/cURL upload, QR, and embeds.
- The [create component](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/forms/CreatePaste.vue) progressively reveals settings behind a gear. It changes syntax mode from filename, estimates a title after paste, converts a paste to multi-part tabs, supports full-screen source plus preview, shows a loading state on submit, and disables submit with help text until content exists.
- Password and client encryption are connected: a supplied password forces encryption and removes Public from visibility choices. The [store](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/stores/current-paste.ts) encrypts title/content with CryptoJS in the browser. Without a supplied password, it creates a key using two `Math.random()` strings and later places that key in the URL fragment.
- The [view component](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/Paste.vue) uses responsive action placement, accessible labels on view action buttons, tooltips and keyboard shortcuts, copy checkmark feedback, file tabs with overflow, source/preview toggle, raw/download, fork, edit, share, delete confirmation, comments, and loading/error containers.
- Wrong password produces an empty decrypt result and returns without a visible error. Copy success changes an icon for two seconds but is not announced in a live region. The reusable [CopyButton](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/CopyButton.vue) logs copy errors to the console.
- [ErrorContainer](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/ErrorContainer.vue) displays an API exception in a PrimeVue error message; [LoadingContainer](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/LoadingContainer.vue) displays a spinner. These provide request-level feedback, not connection status.
- The [Markdown viewer](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/previews/MarkdownViewer.vue) explicitly sets `html: false`. The [HTML viewer](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/previews/HTMLViewer.vue) sanitizes with DOMPurify and uses a titled iframe sandbox that does not include `allow-scripts`.
- The [folder view](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/views/FolderView.vue) separates child folders from pastes; the [user home](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/views/UserHome.vue) combines folders, recent pastes, search, and desktop-only quick actions.

**Inferences and unknowns**

- **[I]** Multi-part tabs, folders, recent items, quick actions, comments, and rich preview routing make Pastefy the broadest document-workbench reference in the set, but also the least minimal.
- **[I]** Several create controls depend on placeholders or icons without explicit labels in the component source. The view toolbar is more accessible than the create form. The preview toggle is inside a container revealed only with `group-hover`, with no corresponding `group-focus-within` class; this is a keyboard/touch discoverability concern, not a full accessibility verdict.
- **[I]** `Math.random()` is not an appropriate key-generation mechanism to transplant into a security contract. A cryptographically secure generator is required.
- **[U]** No revision history, strict view-once state, durable online/offline indicator, or explicit reduced-motion treatment was verified.

**Recommendations**

- **[R]** Adopt multi-part tabs, folder/recent-paste hierarchy, owner edit versus fork, and extension-driven preview selection only if the workbench needs those capabilities.
- **[R]** Keep the settings disclosure, but place an explicit label and consequence text on password, encryption, expiry, and visibility. Show wrong-password, copy failure, and copy success as text in semantic status regions.
- **[R]** Do not reuse its generated-key implementation or safe HTML preview for active HTML. Active execution needs a separately named and isolated product path.

## Patterns suitable for a document workbench

1. **[R] Compose and consume in different states.** PrivateBin, Haste, Wastebin, and Rustypaste keep creation distinct from viewing. This reduces accidental mutation and makes security state legible.
2. **[R] Offer both edit and fork only when ownership makes the distinction real.** Opengist and Pastefy let owners edit while others fork. For immutable documents, use PrivateBin’s Clone or historical Haste’s Duplicate & Edit instead.
3. **[R] Use a dominant editor plus a compact, responsive settings rail.** Wastebin’s 720px stack and Opengist’s `lg` two-column grid preserve writing space. Security controls remain visible without becoming the main canvas.
4. **[R] Use progressive disclosure, but not for irreversible consequences.** Pastefy’s gear panel reduces initial density; MicroBin’s adjacent `?` links explain options. Password meaning and one-time deletion still need one sentence in the primary flow.
5. **[R] Make formats explicit.** Editor/Preview, Show code/Show preview, Raw, Download, and Markdown source/render switches prevent users from confusing stored source with a transformed view.
6. **[R] Treat multiple files as first-class documents.** Opengist provides named files, raw/download URLs, anchors, and revisions; Pastefy provides horizontal multi-part tabs. Preserve filenames and keep tabs scrollable on narrow screens.
7. **[R] Make operation state visible.** PrivateBin’s Loading/Retry/alert sequence, Wastebin’s copy/burn toasts, Opengist’s delayed navigation progress, and Pastefy’s button/spinner/error states cover different scopes. Use text plus semantics, not icon changes alone.
8. **[R] Provide discoverable keyboard help.** Wastebin’s help overlay is stronger than undocumented shortcuts. Tooltips may supplement but should not be the only path.
9. **[R] Make limits visible before submission.** Wastebin’s bytes/limit bar and Pastefy’s disabled-submit explanation prevent avoidable failures.
10. **[R] Preserve user input on failure.** Historical Haste’s silent fallback to a blank draft is the pattern to avoid. A failed load, decrypt, upload, or save needs an explicit state and a safe retry.

## Frozen-contract fit and conflicts

| Frozen requirement | Useful verified references | Conflicts or gaps | Recommendation |
|---|---|---|---|
| Password-gated documents | PrivateBin’s separate password prompt and fragment-key explanation; Wastebin’s labeled password form and show/hide control; MicroBin’s mode-specific guide; Pastefy’s browser encryption. | Rustypaste forbids protected plus one-shot. MicroBin’s password has three different meanings. Pastefy silently handles a wrong password and automatically generates a key with `Math.random()`. Opengist and historical Haste have no paste-level password evidence. | **[R]** Define one password meaning in primary UI copy. Allow it to coexist with view-once if the frozen contract requires that combination. Use a secure derivation/generator and show a specific, non-destructive error on failure. |
| Strict view-once | Wastebin and PrivateBin both put confirmation before reveal. Wastebin repeats the consequence at share and reveal time and records a race fix. MicroBin offers First Read. | MicroBin’s higher burn counts are not strict view-once. Rustypaste excludes password-protected one-shot files. Opengist and Pastefy expose expiry but no one-time field. A confirmation dialog by itself does not prevent concurrent reads. | **[R]** Use a binary View once control, recipient confirmation, and a terminal burned state. Implement one atomic server transition that grants at most one successful reveal, and test concurrent requests. |
| Active HTML | Pastefy distinguishes an HTML preview and titles its iframe; source/preview separation across PrivateBin, Wastebin, Opengist, and Pastefy is useful. | PrivateBin and Wastebin sanitize markup; MicroBin highlights/escapes HTML; Rustypaste forces plaintext; Opengist does not enable Goldmark unsafe HTML; Pastefy disables Markdown HTML, sanitizes HTML, and denies scripts in its iframe. Every verified path conflicts if copied unchanged. | **[R]** Keep Safe preview and Run active HTML as separate, unmistakably labeled actions. Do not weaken a safe renderer in place. Put active execution behind the isolation and warning model required by the frozen contract, with source/raw always recoverable. |

## Responsive and accessibility synthesis

**Verified strengths**

- PrivateBin and Opengist ship responsive viewport metadata and collapsing navigation. Wastebin stacks its editor/settings panel at 720px. Opengist changes to a sticky side rail at `lg`. Pastefy changes action orientation at `md`, disables full-screen affordance below `md`, and gives tabs horizontal overflow.
- PrivateBin uses many associated labels, accessible icon-button names, decorative SVG hiding, and alert roles. Wastebin uses semantic buttons, `aria-label`, `focus-visible`, responsive dialogs, and keyboard help. Opengist uses menu semantics, labeled loaders, labels for metadata, and a label-backed upload zone. Pastefy’s view actions generally have translated `aria-label`s.
- MicroBin’s Water.css provides visible form focus and dark preference with very little custom code.

**Verified or bounded weaknesses**

- Historical Haste uses clickable `div`s, hover-only disclosure, no viewport meta, and no responsive breakpoint.
- MicroBin’s Content label is unassociated, its styled file action is a link-role anchor without `href`, and its 720px list table can overflow.
- Rustypaste’s example inputs have no accessible names.
- Opengist’s copy checkmark and Pastefy’s copy checkmark are visual only in inspected source. Opengist file-upload failures and Pastefy copy failures go only to the console.
- Pastefy’s create form uses several placeholders/icon-only buttons without explicit labels in the component source; its view preview toggle is visually exposed on hover only.
- No explicit reduced-motion rule was identified in the inspected PrivateBin common CSS, MicroBin Water.css, Wastebin style, Opengist source reviewed, or Pastefy components reviewed. **[U]** This is not proof that every compiled dependency or deployment lacks such a rule.

**Recommendations**

- **[R]** Every icon-only control needs an accessible name; every input needs a programmatic label; every dynamic result needs appropriate `status` or `alert` semantics.
- **[R]** Do not hide essential actions only behind hover. Make copy/source/preview controls persistently available on touch and on keyboard focus.
- **[R]** Preserve horizontal scrolling for code and tabs, but stack settings and keep destructive actions reachable at narrow widths.
- **[R]** Add reduced-motion handling for spinners, progress bars, fades, and panel transitions while retaining non-motion state cues.

## Status, connection, and help-text patterns

| Product | Status and failure feedback | Help and disclosure |
|---|---|---|
| PrivateBin | **[V]** Loading indicator, Retry, success/status/error alerts, expiry/one-time warning, insecure HTTP/WebCrypto warning, and comment status. | **[V]** FAQ links appear next to browser, HTTPS, and stuck-loading errors; copy/keyboard hints and zero-knowledge explanation remain in the page. |
| Historical Haste | **[V]** No explicit save failure callback; load failure returns to a new document. Current behavior **[U]**. | **[V]** Historical toolbar labels appear on hover and keyboard shortcuts exist in code, with weak discoverability. |
| MicroBin | **[V]** Incorrect uploader password can be shown inline. Copy controls exist. **[U]** No dedicated connection/offline or general request status was verified. | **[V]** `?` links beside each setting lead to a focused guide section. |
| Wastebin | **[V]** Copy content/URL and burned-paste toast strings; visible byte-limit progress; terminal burned message. | **[V]** Short inline hints, a shortcut help overlay, and repeated one-time consequence copy. |
| Rustypaste | **[U]** No built-in rich progress/retry/connection UI in the optional page. HTTP responses remain the primary API feedback. | **[V]** The example page discloses administrator removal and default expiration. |
| Opengist | **[V]** Delayed page-progress bar, rendered HTTP error pages, alert/status containers, labeled notebook/PDF loaders. Upload errors are console-only. | **[V]** Search query examples appear on focus; menus expose labels and structured choices. No password/view-once help because those controls were not verified. |
| Pastefy | **[V]** Submit button loading, page spinner, API error message, copy checkmark, and delete confirmation. Wrong password and copy failure lack visible text. | **[V]** Tooltips disclose action names/shortcuts, disabled submit explains missing content, and an optional URL-detection message suggests a shortener. Security settings rely heavily on labels/placeholders with little consequence text. |

None of the inspected projects exposed a durable connection-state control comparable to “offline,” “reconnecting,” or “changes pending sync.” **[R]** For a workbench that can lose edits or upload state, add an explicit save/upload lifecycle: idle -> dirty -> saving/uploading -> saved, retryable failure, or offline. Do not conflate that lifecycle with a transient page-navigation spinner.

## Reuse decision table

This section is a product-engineering reading of the cited licenses, not legal advice.

| Source | What is suitable to reuse | What is not a drop-in reuse |
|---|---|---|
| PrivateBin, zlib/libpng family plus separately licensed dependencies | Confirmation flow, status hierarchy, clone/raw/download concepts; source code if the applicable notice and dependency terms are retained. | Zero-knowledge/fragment-key assumptions and sanitized Markdown do not automatically satisfy a different password or active-HTML contract. |
| Historical Haste, MIT | Immutable save plus Duplicate & Edit concept; small historical code pieces with MIT notice. | Current Toptal implementation has no verified source/license. Historical non-semantic controls, silent failure, and hover-only labels should not be copied. |
| MicroBin, BSD-3-Clause | Native form layout, contextual `?` guides, small Water.css-based composition; direct code with required notices and no endorsement. | Multi-level privacy meanings and read counters conflict with a simpler frozen security contract if copied unchanged. |
| Wastebin, MIT | One-time disclosure flow, responsive settings rail, byte-limit feedback, keyboard help, toasts; code with MIT notice. | Sanitized Markdown is not active HTML. UI alone does not provide atomic one-time reads. |
| Rustypaste, MIT | API/upload mode vocabulary, expiry/hosting disclosure, server code with MIT notice. | Protected and one-shot modes are intentionally incompatible; forced plaintext conflicts with active HTML; example form accessibility is insufficient. |
| Opengist, AGPL-3.0 | Independently reimplemented file/revision/workbench ideas. Direct use is possible only with an intentional AGPL compliance model. | Treating AGPL web code as a permissive component source is not justified. Its auth/visibility model does not supply password/view-once behavior. |
| Pastefy, MIT plus many dependencies | Multi-part/folder/preview interaction ideas; project code with MIT notice and dependency review. | Vue/PrimeVue implementation is not framework-neutral; `Math.random()` key generation and sanitized script-disabled HTML conflict with the security/active-HTML contract. |

## Limitations and unknowns

- The current Hastebin source, version, license, and release history could not be verified. Historical Haste evidence is labeled separately.
- MicroBin’s project-listed test server returned HTTP 522 during access, so live MicroBin behavior was not used to fill source gaps.
- Pastefy’s public app is client-rendered and yielded an empty static content extraction. Findings come from version-pinned source and owned documentation, not screenshots.
- Rustypaste’s released README did not identify an official public demo; demo behavior is unknown.
- Responsive and accessibility findings are source evidence, not cross-browser, screen-reader, keyboard, contrast, or WCAG certification results.
- Absence claims are limited to the cited release documentation, data models, and inspected create/view sources.

## Source table

| Product | Primary source | Evidence used | Accessed |
|---|---|---|---|
| PrivateBin | [Official repository](https://github.com/PrivateBin/PrivateBin) | Repository identity | 2026-09-13 |
| PrivateBin | [2.0.6 README](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/README.md) | Features, security model, templates | 2026-09-13 |
| PrivateBin | [2.0.6 composer.json](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/composer.json) | PHP requirement, declared license | 2026-09-13 |
| PrivateBin | [Bootstrap 5 template](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/tpl/bootstrap5.php) | Create/view controls, warnings, labels, alerts, confirmation | 2026-09-13 |
| PrivateBin | [Application JavaScript](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/js/privatebin.js) | Encryption/view lifecycle, Markdown sanitization, status, confirmation focus | 2026-09-13 |
| PrivateBin | [Common CSS](https://raw.githubusercontent.com/PrivateBin/PrivateBin/2.0.6/css/common.css) | Responsive editor/media/drop zone, file license header | 2026-09-13 |
| PrivateBin | [Owned project site](https://privatebin.info/) | Official demo link, project identity | 2026-09-13 |
| PrivateBin | [Official demo](https://privatebin.net/) | Live 2.0.6 controls, viewport, metadata | 2026-09-13 |
| PrivateBin | [Release 2.0.6](https://github.com/PrivateBin/PrivateBin/releases/tag/2.0.6) | Release date | 2026-09-13 |
| PrivateBin | [Default-branch commit `e5059f8`](https://github.com/PrivateBin/PrivateBin/commit/e5059f8c3373d1a2fb3683da870301ad825bf29e) | Commit recency | 2026-09-13 |
| Hastebin | [Original service URL](https://hastebin.com/) | Redirect to current owned service | 2026-09-13 |
| Hastebin | [Current Toptal service](https://www.toptal.com/developers/hastebin) | Current visible create controls and DOM metadata | 2026-09-13 |
| Hastebin | [Expected Toptal repository URL](https://github.com/toptal/haste-server) | Returned 404; current source gap | 2026-09-13 |
| Hastebin | [GitHub repository search for `haste user:toptal`](https://api.github.com/search/repositories?q=haste+user%3Atoptal) | No matching current Toptal repository | 2026-09-13 |
| Haste | [Historical repository](https://github.com/shykes/haste-server) | Historical lineage only | 2026-09-13 |
| Haste | [Historical commit `4e20ea0`](https://github.com/shykes/haste-server/commit/4e20ea078f4d8d89fd863cfdaca820979af6b316) | Pinned historical version/date | 2026-09-13 |
| Haste | [Historical README](https://raw.githubusercontent.com/shykes/haste-server/4e20ea078f4d8d89fd863cfdaca820979af6b316/README.md) | Node/storage/license | 2026-09-13 |
| Haste | [Historical HTML](https://raw.githubusercontent.com/shykes/haste-server/4e20ea078f4d8d89fd863cfdaca820979af6b316/static/index.html) | jQuery/Highlight.js, toolbar semantics, viewport absence | 2026-09-13 |
| Haste | [Historical JavaScript](https://raw.githubusercontent.com/shykes/haste-server/4e20ea078f4d8d89fd863cfdaca820979af6b316/static/application.js) | Save/lock, duplicate, shortcuts, failure handling | 2026-09-13 |
| Haste | [Historical CSS](https://raw.githubusercontent.com/shykes/haste-server/4e20ea078f4d8d89fd863cfdaca820979af6b316/static/application.css) | Full-screen editor, hover labels, lack of breakpoints | 2026-09-13 |
| MicroBin | [Official repository](https://github.com/szabodanika/microbin) | Repository identity | 2026-09-13 |
| MicroBin | [v2.1.0 README](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/README.md) | Stack, features, owned docs/demo links | 2026-09-13 |
| MicroBin | [v2.1.0 Cargo.toml](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/Cargo.toml) | Rust/Actix/Askama and BSD-3-Clause | 2026-09-13 |
| MicroBin | [Create template](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/index.html) | Create settings, burn counts, privacy/password, file and labels | 2026-09-13 |
| MicroBin | [View template](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/upload.html) | Copy/raw/QR/edit/remove/decrypt/download controls | 2026-09-13 |
| MicroBin | [Edit template](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/edit.html) | Editing state and password error | 2026-09-13 |
| MicroBin | [List template](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/list.html) | Public listing and narrow-screen table constraint | 2026-09-13 |
| MicroBin | [Owned guide template](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/guide.html) | Expiry, burn, syntax, password and privacy semantics | 2026-09-13 |
| MicroBin | [Embedded Water.css](https://raw.githubusercontent.com/szabodanika/microbin/v2.1.0/templates/assets/water.css) | Responsive/focus/dark preference evidence | 2026-09-13 |
| MicroBin | [Project-listed test server](https://pub.microbin.eu/) | HTTP 522 during access | 2026-09-13 |
| MicroBin | [Release v2.1.0](https://github.com/szabodanika/microbin/releases/tag/v2.1.0) | Release date | 2026-09-13 |
| MicroBin | [Default-branch commit `5268924`](https://github.com/szabodanika/microbin/commit/5268924116f87139dc83459893457d8f02ad1149) | Commit recency | 2026-09-13 |
| Wastebin | [Official repository](https://github.com/matze/wastebin) | Repository identity | 2026-09-13 |
| Wastebin | [3.7.2 README](https://raw.githubusercontent.com/matze/wastebin/3.7.2/README.md) | Stack, features, no arbitrary uploads, Markdown policy, commands | 2026-09-13 |
| Wastebin | [3.7.2 Cargo.toml](https://raw.githubusercontent.com/matze/wastebin/3.7.2/Cargo.toml) | Rust workspace/version/Askama | 2026-09-13 |
| Wastebin | [Create template](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/templates/index.html) | Editor/settings, counters, password, file drop, semantics | 2026-09-13 |
| Wastebin | [Paste template](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/templates/paste.html) | View actions, copy feedback, help overlay | 2026-09-13 |
| Wastebin | [Burn confirmation template](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/templates/burn-confirmation.html) | Cancel/reveal interstitial | 2026-09-13 |
| Wastebin | [Password template](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/templates/encrypted.html) | Password entry and show/hide | 2026-09-13 |
| Wastebin | [English UI strings](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/src/i18n.rs) | Share/reveal/burn consequence copy and toast strings | 2026-09-13 |
| Wastebin | [Style source](https://raw.githubusercontent.com/matze/wastebin/3.7.2/crates/wastebin_server/src/style.css) | Responsive breakpoint, focus, dialogs/media | 2026-09-13 |
| Wastebin | [3.7.2 changelog](https://raw.githubusercontent.com/matze/wastebin/3.7.2/CHANGELOG.md) | Burn race fix and interaction history | 2026-09-13 |
| Wastebin | [Official demo](https://bin.bloerg.net/) | Live version/viewport/theme controls | 2026-09-13 |
| Wastebin | [Release 3.7.2](https://github.com/matze/wastebin/releases/tag/3.7.2) | Release date | 2026-09-13 |
| Wastebin | [Default-branch commit `751cd33`](https://github.com/matze/wastebin/commit/751cd33f66e852557c305f57550933af70e25b6f) | Commit recency | 2026-09-13 |
| Rustypaste | [Official repository](https://github.com/orhun/rustypaste) | Repository identity | 2026-09-13 |
| Rustypaste | [v0.18.1 README](https://raw.githubusercontent.com/orhun/rustypaste/v0.18.1/README.md) | Features, password/one-shot incompatibility, MIME policy | 2026-09-13 |
| Rustypaste | [v0.18.1 Cargo.toml](https://raw.githubusercontent.com/orhun/rustypaste/v0.18.1/Cargo.toml) | Rust/Actix/MIT | 2026-09-13 |
| Rustypaste | [HTML form configuration](https://raw.githubusercontent.com/orhun/rustypaste/v0.18.1/examples/html_form.toml) | Optional landing form capability | 2026-09-13 |
| Rustypaste | [Example landing page](https://raw.githubusercontent.com/orhun/rustypaste/v0.18.1/examples/landing_page.html) | Separate forms, disclosure, accessibility gaps | 2026-09-13 |
| Rustypaste | [Release v0.18.1](https://github.com/orhun/rustypaste/releases/tag/v0.18.1) | Release date | 2026-09-13 |
| Rustypaste | [Default-branch commit `2de835a`](https://github.com/orhun/rustypaste/commit/2de835af34a2dae1ebb399152c3e97721b36bed9) | Commit recency | 2026-09-13 |
| Opengist | [Official repository](https://github.com/thomiceli/opengist) | Repository identity | 2026-09-13 |
| Opengist | [v1.15.2 README](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/README.md) | Git-backed features and workbench scope | 2026-09-13 |
| Opengist | [v1.15.2 package.json](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/package.json) | Frontend stack and dependencies | 2026-09-13 |
| Opengist | [AGPL-3.0 license](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/LICENSE) | Reuse terms | 2026-09-13 |
| Opengist | [Base layout](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/layouts/base.html) | Viewport, responsive navigation, menus, alerts/status, search help | 2026-09-13 |
| Opengist | [Create template](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/pages/create.html) | Multi-file editor, upload, settings rail, visibility menu | 2026-09-13 |
| Opengist | [Editor partial](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/partials/editor.html) | Filename/delete/preview/indent/wrap controls | 2026-09-13 |
| Opengist | [Edit template](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/pages/edit.html) | Owner file edit/save | 2026-09-13 |
| Opengist | [Gist view template](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/pages/gist.html) | File anchors, raw/copy/download, loaders and rendered views | 2026-09-13 |
| Opengist | [Gist header partial](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/partials/gist_header.html) | Fork/edit/embed/clone/ZIP/actions and copy state | 2026-09-13 |
| Opengist | [Revisions template](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/templates/pages/revisions.html) | Commit hashes and line diffs | 2026-09-13 |
| Opengist | [Editor TypeScript](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/public/ts/editor.ts) | CodeMirror, preview, shortcuts, upload behavior/errors | 2026-09-13 |
| Opengist | [Main TypeScript](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/public/ts/main.ts) | Navigation progress and HTTP error swap | 2026-09-13 |
| Opengist | [Markdown renderer](https://raw.githubusercontent.com/thomiceli/opengist/v1.15.2/internal/render/markdown.go) | GFM/extensions and no unsafe raw-HTML option | 2026-09-13 |
| Opengist | [Owned documentation](https://opengist.io/docs/) | Official documentation identity | 2026-09-13 |
| Opengist | [Official demo](https://demo.opengist.io/) | Live responsive all-gists route/navigation | 2026-09-13 |
| Opengist | [Release v1.15.2](https://github.com/thomiceli/opengist/releases/tag/v1.15.2) | Release date | 2026-09-13 |
| Opengist | [Default-branch commit `5afef9a`](https://github.com/thomiceli/opengist/commit/5afef9ac76d2d69ba11a888bb7a095b1d14e7c9d) | Commit recency | 2026-09-13 |
| Pastefy | [Official repository](https://github.com/interaapps/pastefy) | Repository identity | 2026-09-13 |
| Pastefy | [7.2.6 README](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/README.md) | Features, Java build, public app | 2026-09-13 |
| Pastefy | [Frontend package](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/package.json) | Vue/TypeScript/Vite and preview dependencies | 2026-09-13 |
| Pastefy | [MIT license](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/LICENSE) | Reuse terms | 2026-09-13 |
| Pastefy | [Owned feature documentation](https://docs.pastefy.app/features/index.html) | Paste management, encryption, folders, previews, sharing | 2026-09-13 |
| Pastefy | [Public app](https://pastefy.app/) | Official live endpoint; static body extraction empty | 2026-09-13 |
| Pastefy | [Create component](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/forms/CreatePaste.vue) | Create/edit form, progressive settings, responsive/full-screen preview | 2026-09-13 |
| Pastefy | [Paste view component](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/Paste.vue) | Password prompt, tabs, actions, shortcuts, copy/loading/error behavior | 2026-09-13 |
| Pastefy | [Current-paste store](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/stores/current-paste.ts) | Edit/fork state, encryption, generated fragment key | 2026-09-13 |
| Pastefy | [Paste type](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/types/paste.ts) | Visibility, expiry, multi-part data; no view-once field | 2026-09-13 |
| Pastefy | [CopyButton](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/CopyButton.vue) | Visual copy/loading feedback and console-only error | 2026-09-13 |
| Pastefy | [ErrorContainer](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/ErrorContainer.vue) | API error rendering | 2026-09-13 |
| Pastefy | [LoadingContainer](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/LoadingContainer.vue) | Spinner state | 2026-09-13 |
| Pastefy | [Preview router](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/PastePreview.vue) | Format-to-preview routing | 2026-09-13 |
| Pastefy | [Markdown viewer](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/previews/MarkdownViewer.vue) | Markdown-It with raw HTML disabled | 2026-09-13 |
| Pastefy | [HTML viewer](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/components/previews/HTMLViewer.vue) | DOMPurify and script-disabled sandbox | 2026-09-13 |
| Pastefy | [Folder view](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/views/FolderView.vue) | Folder and paste hierarchy, loading/error/delete | 2026-09-13 |
| Pastefy | [User home](https://raw.githubusercontent.com/interaapps/pastefy/7.2.6/frontend/src/views/UserHome.vue) | Recent pastes, folders, search, responsive quick actions | 2026-09-13 |
| Pastefy | [Release 7.2.6](https://github.com/interaapps/pastefy/releases/tag/7.2.6) | Release date | 2026-09-13 |
| Pastefy | [Default-branch commit `3f2c11a`](https://github.com/interaapps/pastefy/commit/3f2c11a4c9fcf79929dfd02c96cda28c1c54792e) | Commit recency | 2026-09-13 |
