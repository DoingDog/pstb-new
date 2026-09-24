# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Node.js >=22.12.0; install pinned dependencies with `npm ci`. There is no lint script.
- `npm run build`: Vite client build followed by `tsc --noEmit`; `npm run typecheck` performs the same build and type check. The build regenerates `src/generated/assets.ts`, `dist/assets` and `dist/client-assets-manifest.json`.
- `npm run dev:local`: local Wrangler server on port 8787; build first so its static assets exist.
- After building, `npx vitest run --project node src/pastes.test.ts` runs one Node unit test file; `npx vitest run --project workers src/http.test.ts` runs Worker tests with the Cloudflare Vitest plugin and local Wrangler config.
- `npm test` runs all Vitest projects, including Chromium browser component tests with touch/accessibility cases. `npm run smoke` additionally tests a local Wrangler server on port 8787 via a Windows PowerShell script.
- `npx playwright test test/e2e/create-password.spec.ts --project=chromium` selects one Chromium E2E file; unfiltered `npm run test:e2e` runs the configured browser/device matrix.

## Architecture and data flow

- `src/index.ts` sends `/mcp` to `src/mcp.ts`; all other requests go to the Hono routes in `src/http.ts`. Both interfaces use `PasteService` in `src/pastes.ts` for validation, authorization and the sole `env.PASTE_DB` KV access.
- Each paste stores its exact text at KV key `<id>`, schema-2 metadata at `__cfpb:meta:<id>`, and up to three prior content revisions at `__cfpb:rev:<id>:0..2`. The main value carries a KV metadata marker; `PasteService` checks it against the sibling metadata and can read legacy attached-metadata entries, migrating them on mutation. Expiration is applied to all related keys. A successful content-bearing view-once read prepares the response, then deletes these keys before returning it.
- `isVacant` permits overwriting a meta-only orphan only when strict schema-2 parsing succeeds and the latest of `createdAt`, `updatedAt` and `currentSavedAt` is at least 120 seconds old, with no main key, revision key or `__cfpb:pending:<id>`. This age comes from metadata timestamps, not a reliable KV last-write time. `deleteFive` first writes `__cfpb:pending:<id>` with a 120-second TTL, then deletes the main key, three revision keys (concurrently), and metadata in that order; a visible pending key blocks same-ID creation for roughly two minutes after deletion. Cross-region KV reads are eventually consistent and writes lack atomic conditional operations, so races and data loss remain possible; this does not guarantee global safety or atomic view-once consumption.
- `src/render.ts` emits a small HTML shell with inert bootstrap/source nodes and asset paths from `src/generated/assets.ts`. `src/client/bootstrap.ts` extracts the data; `src/client/App.tsx` lazily loads React pages. The ordinary paste branch uses `src/client/hooks/use-paste-page.ts`, `autosave.ts` and `paste-sync.ts` for edits and conditional ETag polling. `/md/:id` has a read-only React page; `/raw`, `/html` and `/file` return direct representations.
- `scripts/build.mjs` validates the Vite asset manifest and enforces the exact `wrangler.jsonc` production contract. Current config keeps Worker `cf-pastebin-new`, binding `PASTE_DB` to `cd0ebbaba15e486a8e1071bb21e31a9f`, the single custom domain `n.awsl.app`, and `workers_dev`/`preview_urls` disabled. Preserve those existing bindings and route for deployment; older design documents contain superseded domain values.
- Protected paste credentials are plaintext in KV metadata; browser representation URLs may carry `?password=`. `/html/:id` serves paste HTML as executable same-origin content, and `/ip-trace` echoes request headers/body. Treat these behaviors as part of the current interface when changing routing or access paths.
