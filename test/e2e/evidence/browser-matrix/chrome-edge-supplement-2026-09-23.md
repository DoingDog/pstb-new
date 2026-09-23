# Chrome and Edge browser assertion supplement, 2026-09-23

The existing six branded-browser pass receipts are immutable. Their Chrome and Edge citations to the earlier versions of `test/e2e/create-password.spec.ts` and `test/e2e/view-once-representations.spec.ts` do **not** establish a browser reload after the first autosave or browser navigation/download for raw and file representations. The earlier raw/file checks used Playwright's HTTP request context. Do not read these older receipts as if they ran the assertions added later.

After adding `page.reload()` plus persisted editor content verification at `test/e2e/create-password.spec.ts:119-121`, browser navigation to `/raw/:id` at `test/e2e/view-once-representations.spec.ts:134-138`, and a browser-initiated `/file/:id` download with exact-byte verification at `test/e2e/view-once-representations.spec.ts:145-151`, the two focused E2E files were run headed, with one worker and zero retries, against the signed executable paths recorded in the corresponding `*-capture.json` files:

| Browser | Captured executable version | Focused result |
| --- | --- | --- |
| Google Chrome current | 154.0.8037.58 | 7/7 passed |
| Google Chrome previous | 153.0.8010.53 | 7/7 passed |
| Microsoft Edge current | 153.0.4234.48 | 7/7 passed |
| Microsoft Edge previous | 152.0.4191.96 | 7/7 passed |

Each run used `CFPB_BRANDED_EXECUTABLE=<captured path> npx playwright test --config .superpowers/sdd/2026-09-13-cloudflare-pastebin-rewrite/branded-playwright.config.mjs test/e2e/create-password.spec.ts test/e2e/view-once-representations.spec.ts`. These four supplementary runs tested the final product code before an unrelated `act` timing correction in `App.browser.test.tsx`; they are separate from, and do not alter, the original signed browser-matrix receipts. Firefox's original independent WebDriver script already navigated raw in the browser, fetched file in the browser, and refreshed after autosave; Safari remains unavailable on Windows.
