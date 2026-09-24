# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Node.js >=22.12.0; install pinned dependencies with `npm ci`. There is no lint script.
- `npm run build`: Vite client build followed by `tsc --noEmit`; `npm run typecheck` performs the same build and type check. The build regenerates `src/generated/assets.ts`, `dist/assets` and `dist/client-assets-manifest.json`.
- `npm run dev:local`: local Wrangler server on port 8787; build first so its static assets exist.
- `npm run test -- --project node src/pastes.test.ts`: one Node unit test file (the npm script builds the client first). `npm run test -- --project workers src/http.test.ts`: Worker tests using the Cloudflare Vitest plugin and the Wrangler config. `npm test`: all Vitest projects, including browser component tests configured for Chromium.
- `npm run smoke`: Windows PowerShell script that builds, runs Vitest, then tests a local Wrangler server and cleans up port 8787.
- `npx playwright test --project=chromium test/e2e/create-password.spec.ts`: one Chromium E2E file. `npm run test:e2e` runs every configured browser/device project; use `--project=chromium` for Chromium-only runs.

## Architecture and data flow

- `src/index.ts` sends `/mcp` to `src/mcp.ts`; all other requests go to the Hono routes in `src/http.ts`. Both interfaces use `PasteService` in `src/pastes.ts` for validation, authorization and the sole `env.PASTE_DB` KV access.
- Each paste stores its exact text at KV key `<id>`, schema-2 metadata at `__cfpb:meta:<id>`, and up to three prior content revisions at `__cfpb:rev:<id>:0..2`. The main value carries a KV metadata marker; `PasteService` checks it against the sibling metadata and can read legacy attached-metadata entries, migrating them on mutation. Expiration is applied to all related keys. A successful content-bearing view-once read prepares the response, then deletes these keys before returning it; KV's eventual consistency does not provide an atomic cross-region consume or custom-ID reservation.
- `src/render.ts` emits a small HTML shell with inert bootstrap/source nodes and asset paths from `src/generated/assets.ts`. `src/client/bootstrap.ts` extracts the data; `src/client/App.tsx` lazily loads React pages. The ordinary paste branch uses `src/client/hooks/use-paste-page.ts`, `autosave.ts` and `paste-sync.ts` for edits and conditional ETag polling. `/md/:id` has a read-only React page; `/raw`, `/html` and `/file` return direct representations.
- `scripts/build.mjs` validates the Vite asset manifest and enforces the exact `wrangler.jsonc` production contract. Current config keeps Worker `cf-pastebin-new`, binding `PASTE_DB` to `cd0ebbaba15e486a8e1071bb21e31a9f`, the single custom domain `n.awsl.app`, and `workers_dev`/`preview_urls` disabled. Preserve those existing bindings and route for deployment; older design documents contain superseded domain values.
- Protected paste credentials are plaintext in KV metadata; browser representation URLs may carry `?password=`. `/html/:id` serves paste HTML as executable same-origin content, and `/ip-trace` echoes request headers/body. Treat these behaviors as part of the current interface when changing routing or access paths.
