import { readFile } from "node:fs/promises";
import { expect, test, type Request } from "@playwright/test";
import { createPaste } from "./helpers";

test("view-once main response retains only local actions and consumes the server copy", async ({ page, request }) => {
  const source = "# View-once preview\n\nExact local source";
  const { id } = await createPaste(request, { content: source, format: "markdown", viewOnce: true });
  const contentPaths = new Set([
    `/${id}`,
    `/raw/${id}`,
    `/html/${id}`,
    `/md/${id}`,
    `/file/${id}`,
    `/api/pastes/${id}`,
    `/api/pastes/${id}/read`,
  ]);
  const contentRequests: Array<{ method: string; path: string; resourceType: string }> = [];
  page.on("request", (browserRequest) => {
    const path = new URL(browserRequest.url()).pathname;
    if (contentPaths.has(path)) contentRequests.push({ method: browserRequest.method(), path, resourceType: browserRequest.resourceType() });
  });

  const mainResponse = await page.goto(`/${id}`);
  expect(mainResponse).not.toBeNull();
  expect(mainResponse!.status()).toBe(200);

  await expect(page.getByRole("region", { name: "Consumed" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(contentRequests).toEqual([{ method: "GET", path: `/${id}`, resourceType: "document" }]);

  const actions = page.getByRole("region", { name: "Local actions" });
  await expect(actions.getByRole("button")).toHaveText(["Copy", "Download", "Open HTML locally", "Wrap", "Source"]);
  await expect(page.locator("[data-safe-markdown]")).toContainText("View-once preview");

  await actions.getByRole("button", { name: "Wrap" }).click();
  await expect(actions.getByRole("button", { name: "Unwrap" })).toBeVisible();
  await actions.getByRole("button", { name: "Source" }).click();
  await expect(page.locator("[data-local-source]")).toHaveText(source);
  await expect(actions.getByRole("button", { name: "Preview" })).toBeVisible();

  for (const name of ["Edit", "History", "Settings", "Delete"]) {
    await expect(page.getByRole("tab", { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await expect(page.locator("[data-ordinary-paste-page]")).toHaveCount(0);
  await expect(page.locator("[data-server-controls]")).toHaveCount(0);
  await expect(page.locator('a[href*="/raw/"], a[href*="/html/"], a[href*="/md/"], a[href*="/file/"]')).toHaveCount(0);

  await actions.getByRole("button", { name: "Open HTML locally" }).click();
  await expect.poll(() => page.url()).toMatch(/^blob:/);
  expect(contentRequests).toEqual([{ method: "GET", path: `/${id}`, resourceType: "document" }]);

  const nextContentRead = await request.get(`/api/pastes/${id}/read`);
  expect(nextContentRead.status()).toBe(404);
});

test("view-once direct methods do not consume before the first valid raw GET", async ({ request }) => {
  const source = "direct view-once source";
  const password = "direct-view-once-password";
  const { id } = await createPaste(request, { content: source, password, viewOnce: true });

  for (const [path, allow] of [
    [`/${id}`, "GET,HEAD,POST"],
    [`/raw/${id}`, "GET,HEAD"],
    [`/html/${id}`, "GET,HEAD"],
    [`/md/${id}`, "GET,HEAD"],
    [`/file/${id}`, "GET,HEAD"],
  ] as const) {
    const response = await request.fetch(path, { method: "OPTIONS" });
    expect(response.status()).toBe(405);
    expect(response.headers()["allow"]).toBe(allow);
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  }

  const head = await request.head(`/raw/${id}?password=${password}`);
  expect(head.status()).toBe(200);
  expect(await head.body()).toHaveLength(0);

  const wrongPassword = await request.get(`/raw/${id}?password=wrong`);
  expect(wrongPassword.status()).toBe(403);

  const firstRead = await request.get(`/raw/${id}?password=${password}`);
  expect(firstRead.status()).toBe(200);
  expect(firstRead.headers()["content-type"]).toBe("text/plain; charset=utf-8");
  expect(await firstRead.text()).toBe(source);

  const consumed = await request.get(`/raw/${id}?password=${password}`);
  expect(consumed.status()).toBe(404);
});

test("API OPTIONS remains 204", async ({ request }) => {
  const response = await request.fetch("/api/pastes", { method: "OPTIONS" });
  expect(response.status()).toBe(204);
  expect(response.headers()["allow"]).toBe("POST,OPTIONS");
});

test("ip-trace OPTIONS remains the CORS response", async ({ request }) => {
  const response = await request.fetch("/ip-trace", { method: "OPTIONS" });
  expect(response.status()).toBe(200);
  expect(response.headers()["access-control-allow-origin"]).toBe("*");
  expect(response.headers()["access-control-allow-headers"]).toBe("*");
  expect(response.headers()["access-control-allow-methods"]).toBe("GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
});

test("MCP OPTIONS remains 204", async ({ request }) => {
  const response = await request.fetch("/mcp", { method: "OPTIONS" });
  expect(response.status()).toBe(204);
  expect(response.headers()["allow"]).toBe("POST,OPTIONS");
});

test("direct representations preserve exact source, safely render Markdown, and run top-level HTML", async ({ page, request }, testInfo) => {
  const externalHtml = await readFile(new URL("../fixtures/external.html", import.meta.url));
  const source = new TextDecoder().decode(externalHtml);
  const password = "active html+password";
  const { id } = await createPaste(request, {
    content: source,
    title: "external.html",
    format: "markdown",
    password,
  });
  const protectedQuery = "?password=active%20html%2bpassword";
  const baseURL = testInfo.project.use.baseURL;
  if (baseURL === undefined) throw new Error("Playwright baseURL is required for the active HTML origin check");
  const origin = new URL(baseURL).origin;
  const activeHtmlUrl = new URL(`/html/${id}${protectedQuery}`, baseURL).href;
  const expectedMarkerUrl = new URL("/ip-trace?active-html-marker=1", baseURL).href;

  const raw = await request.get(`/raw/${id}${protectedQuery}`);
  expect(raw.status()).toBe(200);
  expect(raw.headers()["content-type"]).toBe("text/plain; charset=utf-8");
  expect(raw.headers()["content-security-policy"]).toBeUndefined();
  expect(await raw.body()).toEqual(externalHtml);
  const rawPage = await page.context().newPage();
  const rawNavigation = await rawPage.goto(`/raw/${id}${protectedQuery}`);
  expect(rawNavigation?.status()).toBe(200);
  expect(await rawPage.evaluate(() => document.body.textContent)).toBe(source);
  await rawPage.close();

  const file = await request.get(`/file/${id}${protectedQuery}`);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toBe("application/octet-stream");
  expect(file.headers()["content-disposition"]).toBe(`attachment; filename="paste-${id}.txt"; filename*=UTF-8''external.html`);
  expect(await file.body()).toEqual(externalHtml);
  const filePage = await page.context().newPage();
  await filePage.goto(`/raw/${id}${protectedQuery}`);
  const downloadPromise = filePage.waitForEvent("download");
  await filePage.evaluate((href) => { const link = document.createElement("a"); link.href = href; link.click(); }, new URL(`/file/${id}${protectedQuery}`, baseURL).href);
  const download = await downloadPromise;
  expect(await readFile(await download.path())).toEqual(externalHtml);
  await filePage.close();

  const markdownPage = await page.context().newPage();
  const markdown = await markdownPage.goto(`/md/${id}${protectedQuery}`);
  expect(markdown).not.toBeNull();
  expect(markdown!.status()).toBe(200);
  expect(markdown!.headers()["content-security-policy"]).toBeTruthy();
  await expect(markdownPage.locator("[data-safe-markdown]")).toContainText("active-html-marker");
  await expect(markdownPage.locator("#active-html-marker")).toHaveCount(0);
  expect(await markdownPage.evaluate(() => (globalThis as Record<string, unknown>).__cfpbActiveHtmlMarker)).toBeUndefined();
  await markdownPage.close();

  const markerRequests: Request[] = [];
  page.on("request", (browserRequest) => {
    if (browserRequest.url() === expectedMarkerUrl) markerRequests.push(browserRequest);
  });
  await page.route((url) => url.origin !== origin, (route) => route.abort());
  let releaseTrace!: () => void;
  let notifyTraceFetched!: () => void;
  const traceDelivery = new Promise<void>((resolve) => { releaseTrace = resolve; });
  const realTraceFetched = new Promise<void>((resolve) => { notifyTraceFetched = resolve; });
  await page.route((url) => url.href === expectedMarkerUrl, async (route) => {
    const markerRequest = route.request();
    expect(markerRequest.method()).toBe("GET");
    expect(markerRequest.resourceType()).toBe("fetch");
    expect(markerRequest.isNavigationRequest()).toBe(false);
    expect(markerRequest.frame()).toBe(page.mainFrame());
    const response = await route.fetch({ maxRedirects: 0 });
    notifyTraceFetched();
    await traceDelivery;
    await route.fulfill({ response });
  });
  const traceRequest = page.waitForRequest((browserRequest) => browserRequest.url() === expectedMarkerUrl
    && browserRequest.method() === "GET"
    && browserRequest.resourceType() === "fetch"
    && !browserRequest.isNavigationRequest()
    && browserRequest.frame() === page.mainFrame());

  const activeHtml = await page.goto(activeHtmlUrl);
  expect(activeHtml).not.toBeNull();
  expect(activeHtml!.status()).toBe(200);
  expect(activeHtml!.url()).toBe(activeHtmlUrl);
  expect(activeHtml!.headers()["content-security-policy"]).toBeUndefined();
  expect(await activeHtml!.body()).toEqual(externalHtml);
  expect(await page.evaluate(() => location.search)).toBe(protectedQuery);

  const marker = page.locator("#active-html-marker");
  const expectedMarker = { origin, search: protectedQuery };
  await expect(marker).toHaveText(JSON.stringify(expectedMarker));
  expect(await page.evaluate(() => (globalThis as Record<string, unknown>).__cfpbActiveHtmlMarker)).toEqual(expectedMarker);
  expect(await page.evaluate(() => ({ topLevel: window.top === window, iframeCount: document.querySelectorAll("iframe").length, sandboxCount: document.querySelectorAll("[sandbox]").length }))).toEqual({ topLevel: true, iframeCount: 0, sandboxCount: 0 });

  const observedTrace = await traceRequest;
  expect(markerRequests).toEqual([observedTrace]);
  await realTraceFetched;
  await expect(marker).not.toHaveAttribute("data-fetch-status", "200");
  const traceResponse = page.waitForResponse((browserResponse) => browserResponse.request() === observedTrace);
  releaseTrace();
  expect((await traceResponse).status()).toBe(200);
  expect(markerRequests).toEqual([observedTrace]);
  await expect(marker).toHaveAttribute("data-fetch-status", "200");
});
