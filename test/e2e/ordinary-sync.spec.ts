import { createHash } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Page,
  type Request,
  type Response,
  type Route,
} from "@playwright/test";
import { createPaste } from "./helpers";

type Resource = { id: string; version: string };
type RequestRecord = { method: string; path: string; headers: Record<string, string> };

type Traffic = {
  assets: RequestRecord[];
  business: RequestRecord[];
  maxOpenResourceReads: number;
  openResourceReads: Set<Request>;
};

const clockStart = new Date("2026-09-22T00:00:00.000Z");
const clockPauseAt = new Date("2026-09-22T00:00:01.000Z");

function resourcePath(id: string): string {
  return `/api/pastes/${id}`;
}

function isHashedAsset(path: string): boolean {
  return /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:css|js)$/.test(path);
}

function watchTraffic(page: Page, id: string): Traffic {
  const traffic: Traffic = {
    assets: [],
    business: [],
    maxOpenResourceReads: 0,
    openResourceReads: new Set(),
  };
  const trackEnd = (request: Request) => traffic.openResourceReads.delete(request);

  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    const record = { method: request.method(), path, headers: request.headers() };
    if (isHashedAsset(path)) traffic.assets.push(record);
    else traffic.business.push(record);
    if (request.method() === "GET" && path === resourcePath(id)) {
      traffic.openResourceReads.add(request);
      traffic.maxOpenResourceReads = Math.max(traffic.maxOpenResourceReads, traffic.openResourceReads.size);
    }
  });
  page.on("requestfinished", trackEnd);
  page.on("requestfailed", trackEnd);
  return traffic;
}

function resourceReads(traffic: Traffic, id: string): RequestRecord[] {
  return traffic.business.filter((request) => request.method === "GET" && request.path === resourcePath(id));
}

function waitForResourceResponse(page: Page, id: string): Promise<Response> {
  return page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === resourcePath(id));
}

async function expectConditionalResourceResponse(response: Response, etag: string): Promise<void> {
  expect(response.headers()["etag"]).toBe(etag);
  const headers = response.headers();
  const normalized304 = response.status() === 200
    && headers["content-type"] === undefined
    && headers["content-length"] === undefined
    && headers.trailer === undefined
    && (await response.body()).byteLength === 0;
  const cached304 = response.status() === 200
    && headers["content-type"] === undefined
    && headers["content-length"] === undefined
    && headers.trailer === undefined
    && headers["content-encoding"] === "gzip"
    && `"sha256-${createHash("sha256").update(await response.body()).digest("base64url")}"` === etag;
  expect(headers["cache-control"]).toBe(response.status() === 304 || normalized304 || cached304 ? "no-store" : "no-store, no-transform");
  if (response.status() === 304 || normalized304 || cached304) return;

  expect(response.status()).toBe(200);
}

async function waitForUnchangedAutosync(page: Page): Promise<void> {
  await expect(page.locator('[data-operation-record="autosync"]')).toContainText("Unchanged");
}

async function waitForNewUnchangedAutosync(page: Page, previous: string): Promise<void> {
  await expect.poll(async () => page.locator('[data-operation-record="autosync"]').evaluate((record, old) => {
    const checkedAt = record.querySelector("time")?.getAttribute("datetime");
    return record.querySelector("dd > span")?.textContent === "Unchanged" && checkedAt !== null && checkedAt !== undefined && checkedAt !== old;
  }, previous)).toBe(true);
}

async function loadResource(request: APIRequestContext, id: string): Promise<Resource> {
  const response = await request.get(resourcePath(id));
  expect(response.status()).toBe(200);
  const resource = await response.json() as Resource;
  expect(resource.id).toBe(id);
  return resource;
}

async function mutateContent(request: APIRequestContext, id: string, content: string): Promise<void> {
  const resource = await loadResource(request, id);
  const response = await request.patch(resourcePath(id), { data: { content, version: resource.version } });
  expect(response.status()).toBe(200);
}

async function recreatePaste(request: APIRequestContext, id: string, content: string, viewOnce = false): Promise<void> {
  const resource = await loadResource(request, id);
  const deleted = await request.delete(resourcePath(id), { data: { version: resource.version } });
  expect(deleted.status()).toBe(204);
  await createPaste(request, { customId: id, content, viewOnce });
}

async function openWriter(context: BrowserContext): Promise<Page> {
  const writer = await context.newPage();
  await writer.goto("/");
  return writer;
}

async function openOrdinary(page: Page, id: string, source: string): Promise<void> {
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockPauseAt);
  await page.goto(`/${id}`);
  await page.waitForLoadState("networkidle");
  await page.clock.runFor(300);
  await expect(page.locator("[data-plain-view]")).toHaveText(source);
}

async function fulfillFetchedResponse(route: Route, response: APIResponse): Promise<void> {
  const body = await response.body();
  const headers = response.headers();
  delete headers["content-encoding"];
  delete headers["content-length"];
  await route.fulfill({ response, headers, body });
}

async function releaseFirstResourceDelivery(page: Page, id: string): Promise<{ release(): void; discard(): void; fetched: Promise<APIResponse>; delivered: Promise<void> }> {
  let firstResourceRead = true;
  let discarded = false;
  let release!: () => void;
  let fetchedResolve!: (response: APIResponse) => void;
  let deliveredResolve!: () => void;
  const deliveryGate = new Promise<void>((resolve) => { release = resolve; });
  const fetched = new Promise<APIResponse>((resolve) => { fetchedResolve = resolve; });
  const delivered = new Promise<void>((resolve) => { deliveredResolve = resolve; });

  await page.route(`**${resourcePath(id)}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const hold = firstResourceRead;
    firstResourceRead = false;
    if (!hold && route.request().headers()["if-none-match"] !== undefined) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    if (hold) {
      fetchedResolve(response);
      await deliveryGate;
    }
    try {
      if (!(hold && discarded)) await fulfillFetchedResponse(route, response);
    } finally {
      if (hold) deliveredResolve();
    }
  });
  return { release, discard() { discarded = true; release(); }, fetched, delivered };
}

test("ordinary sync uses sequential conditional resource reads and applies a real remote mutation", async ({ page, context, request }) => {
  const initial = "ordinary-sync-initial";
  const remote = "ordinary-sync-remote";
  const { id } = await createPaste(request, { content: initial });
  const writer = await openWriter(context);
  const traffic = watchTraffic(page, id);

  await openOrdinary(page, id, initial);
  await page.route(`**${resourcePath(id)}`, async (route) => {
    if (route.request().headers()["if-none-match"] !== undefined) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await fulfillFetchedResponse(route, response);
  });

  const initialResponse = waitForResourceResponse(page, id);
  await page.clock.fastForward(3_000);
  const initialRead = await initialResponse;
  expect(initialRead.status()).toBe(200);
  expect(initialRead.headers()["etag"]).toMatch(/^"sha256-[A-Za-z0-9_-]+"$/);
  expect(resourceReads(traffic, id)[0]?.headers["if-none-match"]).toBeUndefined();
  await waitForUnchangedAutosync(page);

  await page.clock.fastForward(2_999);
  expect(resourceReads(traffic, id)).toHaveLength(1);
  const conditionalResponse = waitForResourceResponse(page, id);
  await page.clock.fastForward(1);
  const conditionalRead = await conditionalResponse;
  const readsAfterConditional = resourceReads(traffic, id);
  expect(readsAfterConditional).toHaveLength(2);
  expect(readsAfterConditional.at(-1)?.headers["if-none-match"]).toBe(initialRead.headers()["etag"]);
  await expectConditionalResourceResponse(conditionalRead, initialRead.headers()["etag"]!);
  expect(traffic.maxOpenResourceReads).toBe(1);

  await mutateContent(writer.request, id, remote);
  const remoteResponse = waitForResourceResponse(page, id);
  await page.clock.fastForward(3_000);
  const remoteRead = await remoteResponse;
  expect(remoteRead.status()).toBe(200);
  await expect(page.locator("[data-plain-view]")).toHaveText(remote);
  await expect(page.locator('[data-operation-record="autosync"]')).toContainText("Remote changes applied");
  const autosyncTime = page.locator('[data-operation-record="autosync"] time');
  const appliedAt = await autosyncTime.getAttribute("datetime");
  expect(appliedAt).not.toBeNull();

  const resetResponse = waitForResourceResponse(page, id);
  await page.clock.fastForward(3_000);
  const resetRead = await resetResponse;
  expect(resetRead.request().headers()["if-none-match"]).toBe(remoteRead.headers()["etag"]);
  await expectConditionalResourceResponse(resetRead, remoteRead.headers()["etag"]!);
  await waitForNewUnchangedAutosync(page, appliedAt!);
  const firstCheckedAt = await autosyncTime.getAttribute("datetime");
  const secondUnchanged = waitForResourceResponse(page, id);
  await page.clock.fastForward(3_000);
  await expectConditionalResourceResponse(await secondUnchanged, remoteRead.headers()["etag"]!);
  await waitForNewUnchangedAutosync(page, firstCheckedAt!);
  const reads = resourceReads(traffic, id);
  expect(reads.at(-1)?.headers["if-none-match"]).toBe(remoteRead.headers()["etag"]);
  expect(traffic.maxOpenResourceReads).toBe(1);
  expect(traffic.assets.every((asset) => isHashedAsset(asset.path))).toBe(true);

  await writer.close();
});

test("ordinary Edit keeps IME preedit and autosaves the committed Chinese text", async ({ page, request }) => {
  const { id } = await createPaste(request, { content: "first" });
  await openOrdinary(page, id, "first");
  await page.getByRole("tab", { name: "Edit" }).click();

  const preedit = await page.evaluate(() => {
    const textarea = document.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    setter.call(textarea, "first中");
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    return textarea.value;
  });
  expect(preedit).toBe("first中");

  await page.evaluate(() => {
    const textarea = document.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, "first中文");
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: false }));
  });
  await expect(page.getByRole("textbox", { name: "Content" })).toHaveValue("first中文");
  const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === resourcePath(id));
  await page.clock.runFor(1_100);
  expect((await saved).status()).toBe(200);
  await expect.poll(async () => (await (await request.get(resourcePath(id))).json() as { content: string }).content).toBe("first中文");
});

test("Markdown Visual composition pauses remote sync and resumes after commit", async ({ page, request }) => {
  const { id } = await createPaste(request, { content: "first\n", format: "markdown" });
  const traffic = watchTraffic(page, id);
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockPauseAt);
  await page.goto(`/${id}`);
  await page.waitForLoadState("networkidle");
  await page.clock.runFor(300);
  await page.getByRole("tab", { name: "Markdown" }).click();
  await page.getByRole("tab", { name: "Visual" }).click();
  await expect(page.locator(".ProseMirror")).toBeVisible();

  await page.evaluate(() => document.querySelector(".ProseMirror")!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await page.clock.fastForward(3_000);
  expect(resourceReads(traffic, id)).toHaveLength(0);
  await page.evaluate(() => document.querySelector(".ProseMirror")!.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await page.clock.runFor(50);
  const resumed = waitForResourceResponse(page, id);
  await page.clock.fastForward(3_000);
  expect((await resumed).status()).toBe(200);
});

test("ordinary Edit resumes autosave after a mobile IME omits compositionend", async ({ page, request }) => {
  const { id } = await createPaste(request, { content: "first" });
  await openOrdinary(page, id, "first");
  await page.getByRole("tab", { name: "Edit" }).click();
  await page.evaluate(() => {
    const textarea = document.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    textarea.focus();
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    setter.call(textarea, "中文");
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    textarea.blur();
  });
  const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === resourcePath(id));
  await page.clock.runFor(1_100);
  expect((await saved).status()).toBe(200);
  await expect.poll(async () => (await (await request.get(resourcePath(id))).json() as { content: string }).content).toBe("中文");
});

test("ordinary sync holds a real resource response without overlap and resumes from settlement", async ({ page, request }) => {
  const { id } = await createPaste(request, { content: "ordinary-sync-held" });
  const traffic = watchTraffic(page, id);
  await openOrdinary(page, id, "ordinary-sync-held");
  const delayed = await releaseFirstResourceDelivery(page, id);

  await page.clock.fastForward(3_000);
  expect((await delayed.fetched).status()).toBe(200);
  expect(resourceReads(traffic, id)).toHaveLength(1);
  await page.clock.fastForward(6_000);
  expect(resourceReads(traffic, id)).toHaveLength(1);
  expect(traffic.maxOpenResourceReads).toBe(1);

  const deliveredResponse = waitForResourceResponse(page, id);
  delayed.release();
  const delivered = await deliveredResponse;
  expect(delivered.status()).toBe(200);
  await delayed.delivered;
  await waitForUnchangedAutosync(page);

  await page.clock.fastForward(2_999);
  expect(resourceReads(traffic, id)).toHaveLength(1);
  const nextResponse = waitForResourceResponse(page, id);
  await page.clock.fastForward(1);
  await expectConditionalResourceResponse(await nextResponse, delivered.headers()["etag"]!);
  expect(resourceReads(traffic, id)).toHaveLength(2);
  expect(traffic.maxOpenResourceReads).toBe(1);
});

test("a dirty edit cancels the current cadence before its resource read", async ({ page, request }) => {
  const { id } = await createPaste(request, { content: "ordinary-sync-dirty" });
  const traffic = watchTraffic(page, id);
  await openOrdinary(page, id, "ordinary-sync-dirty");

  const initialResponse = waitForResourceResponse(page, id);
  await page.clock.fastForward(3_000);
  const initialRead = await initialResponse;
  expect(initialRead.status()).toBe(200);
  await waitForUnchangedAutosync(page);

  await page.clock.fastForward(2_999);
  await page.getByRole("tab", { name: "Edit" }).click();
  await page.getByLabel("Content").fill("ordinary-sync-local-draft");
  await expect(page.locator('[data-operation-record="autosync"]')).toContainText("Paused for local changes");

  await page.clock.fastForward(1);
  expect(resourceReads(traffic, id)).toHaveLength(1);
  expect(traffic.maxOpenResourceReads).toBe(1);
});

test("offline pauses ordinary sync and online resumes one non-overlapping resource read", async ({ page, context, request }) => {
  const { id } = await createPaste(request, { content: "ordinary-sync-offline" });
  const traffic = watchTraffic(page, id);
  await openOrdinary(page, id, "ordinary-sync-offline");

  const initialResponse = waitForResourceResponse(page, id);
  await page.clock.fastForward(3_000);
  const initialRead = await initialResponse;
  expect(initialRead.status()).toBe(200);
  await waitForUnchangedAutosync(page);

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.locator('[data-operation-record="autosync"]')).toContainText("Paused offline");
  await page.clock.fastForward(9_000);
  expect(resourceReads(traffic, id)).toHaveLength(1);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator('[data-operation-record="autosync"]')).toContainText("Waiting");
  const resumed = waitForResourceResponse(page, id);
  await page.clock.fastForward(3_000);
  await expectConditionalResourceResponse(await resumed, initialRead.headers()["etag"]!);
  expect(resourceReads(traffic, id)).toHaveLength(2);
  expect(traffic.maxOpenResourceReads).toBe(1);
});

test("a real replacement generation presents candidate choices that preserve the chosen source", async ({ page, context, request }) => {
  const current = "ordinary-sync-current";
  const replacement = "ordinary-sync-replacement";
  const { id } = await createPaste(request, { content: current });
  const writer = await openWriter(context);
  const traffic = watchTraffic(page, id);
  await openOrdinary(page, id, current);

  await recreatePaste(writer.request, id, replacement);
  const candidateResponse = waitForResourceResponse(page, id);
  await page.clock.fastForward(3_000);
  expect((await candidateResponse).status()).toBe(200);
  await expect(page.locator("[data-sync-candidate]")).toBeVisible();
  await expect(page.locator("[data-plain-view]")).toHaveText(current);

  await page.getByRole("button", { name: "Keep current" }).click();
  await expect(page.locator("[data-sync-candidate]")).toHaveCount(0);
  await expect(page.locator("[data-plain-view]")).toHaveText(current);

  const candidateAgain = waitForResourceResponse(page, id);
  await page.clock.fastForward(3_000);
  expect((await candidateAgain).status()).toBe(200);
  await expect(page.locator("[data-sync-candidate]")).toBeVisible();
  await page.getByRole("button", { name: "Use remote" }).click();
  await expect(page.locator("[data-plain-view]")).toHaveText(replacement);
  expect(traffic.maxOpenResourceReads).toBe(1);

  await writer.close();
});

test("real activity extends the five-minute active window and inactivity stops business traffic at its deadline", async ({ page, request }) => {
  const { id } = await createPaste(request, { content: "ordinary-sync-activity" });
  const traffic = watchTraffic(page, id);
  await openOrdinary(page, id, "ordinary-sync-activity");

  const beforeActivity = waitForResourceResponse(page, id);
  await page.clock.fastForward(299_000);
  const initialRead = await beforeActivity;
  expect(initialRead.status()).toBe(200);
  await waitForUnchangedAutosync(page);

  await page.getByRole("tab", { name: "Settings" }).click();
  const title = page.locator('input[name="title"]');
  await title.fill("ordinary-sync-activity");
  await title.fill("");
  await expect(page.locator('[data-operation-record="autosync"]')).toContainText("Waiting");

  await page.clock.fastForward(1_000);
  await expect(page.locator('[data-operation-record="autosync"]')).not.toContainText("Inactive");
  const beforeExtendedDeadline = waitForResourceResponse(page, id);
  await page.clock.fastForward(298_999);
  await expectConditionalResourceResponse(await beforeExtendedDeadline, initialRead.headers()["etag"]!);
  await page.clock.fastForward(1);
  await expect(page.locator('[data-operation-record="autosync"]')).toContainText("Inactive");

  const businessAtDeadline = traffic.business.length;
  await page.clock.fastForward(6_000);
  expect(traffic.business).toHaveLength(businessAtDeadline);
});

test("an edit aborts a delayed view-once autosync response without falsely consuming the paste", async ({ page, context, request }) => {
  const current = "ordinary-sync-poll-edit-current";
  const local = "ordinary-sync-poll-edit-local";
  const { id } = await createPaste(request, { content: current });
  const writer = await openWriter(context);
  const traffic = watchTraffic(page, id);
  await openOrdinary(page, id, current);
  await recreatePaste(writer.request, id, "ordinary-sync-poll-edit-remote", true);
  const delayed = await releaseFirstResourceDelivery(page, id);

  await page.clock.fastForward(3_000);
  const fetched = await delayed.fetched;
  expect(fetched.status()).toBe(200);
  expect((await fetched.json() as { viewOnce: boolean }).viewOnce).toBe(true);
  expect(resourceReads(traffic, id)).toHaveLength(1);
  const aborted = page.waitForEvent("requestfailed", { predicate: (read) => read.method() === "GET" && new URL(read.url()).pathname === resourcePath(id) });
  await page.getByRole("tab", { name: "Edit" }).click();
  await page.getByLabel("Content").fill(local);
  await aborted;
  delayed.discard();
  await delayed.delivered;
  await page.clock.runFor(300);

  await expect(page.locator('section[aria-label="Consumed"]')).toHaveCount(0);
  await expect(page.locator("[data-ordinary-paste-page]")).toBeVisible();
  await expect(page.getByLabel("Content")).toHaveValue(local);
  await page.clock.fastForward(6_000);
  expect(resourceReads(traffic, id)).toHaveLength(1);
  await expect(page.locator('section[aria-label="Consumed"]')).toHaveCount(0);
  await expect(page.getByLabel("Content")).toHaveValue(local);
  expect(traffic.maxOpenResourceReads).toBe(1);
  await writer.close();
});

test("a delete aborts a delayed view-once autosync response before browser delivery", async ({ page, context, request }) => {
  const current = "ordinary-sync-poll-mutation-current";
  const { id } = await createPaste(request, { content: current });
  const writer = await openWriter(context);
  const traffic = watchTraffic(page, id);
  await openOrdinary(page, id, current);
  await recreatePaste(writer.request, id, "ordinary-sync-poll-mutation-remote", true);
  const delayed = await releaseFirstResourceDelivery(page, id);
  let releaseMutation!: () => void;
  let fetchedMutation!: (response: APIResponse) => void;
  const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
  const mutationFetched = new Promise<APIResponse>((resolve) => { fetchedMutation = resolve; });
  await page.route(`**${resourcePath(id)}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const response = await route.fetch();
    fetchedMutation(response);
    await mutationGate;
    await fulfillFetchedResponse(route, response);
  });

  try {
    await page.clock.fastForward(3_000);
    const fetched = await delayed.fetched;
    expect(fetched.status()).toBe(200);
    expect((await fetched.json() as { viewOnce: boolean }).viewOnce).toBe(true);
    expect(resourceReads(traffic, id)).toHaveLength(1);
    await page.getByRole("tab", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const aborted = page.waitForEvent("requestfailed", {
      predicate: (read) => read.method() === "GET" && new URL(read.url()).pathname === resourcePath(id),
      timeout: 5_000,
    });
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    expect((await mutationFetched).status()).toBe(404);
    await aborted;
    delayed.discard();
    await delayed.delivered;
    const localOnlyPage = page.waitForResponse((response) => /^\/assets\/LocalOnlyPastePage-[A-Za-z0-9_-]+\.js$/u.test(new URL(response.url()).pathname));
    releaseMutation();
    await localOnlyPage;
    await page.clock.runFor(300);

    await expect(page.locator('section[aria-label="Not found"]')).toBeVisible();
    await expect(page.locator('section[aria-label="Consumed"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Source" }).click();
    await expect(page.locator("[data-local-source]")).toHaveText(current);
    const businessAtTerminal = traffic.business.length;
    await page.clock.fastForward(6_000);
    expect(traffic.business).toHaveLength(businessAtTerminal);
    expect(traffic.maxOpenResourceReads).toBe(1);
  } finally {
    delayed.discard();
    releaseMutation();
    await writer.close();
  }
});

test("the active deadline aborts a delayed view-once autosync response without falsely consuming the paste", async ({ page, context, request }) => {
  const current = "ordinary-sync-poll-deadline-current";
  const { id } = await createPaste(request, { content: current });
  const writer = await openWriter(context);
  const traffic = watchTraffic(page, id);
  await openOrdinary(page, id, current);
  await recreatePaste(writer.request, id, "ordinary-sync-poll-deadline-remote", true);
  const delayed = await releaseFirstResourceDelivery(page, id);

  await page.clock.fastForward(3_000);
  const fetched = await delayed.fetched;
  expect(fetched.status()).toBe(200);
  expect((await fetched.json() as { viewOnce: boolean }).viewOnce).toBe(true);
  expect(resourceReads(traffic, id)).toHaveLength(1);
  const aborted = page.waitForEvent("requestfailed", { predicate: (read) => read.method() === "GET" && new URL(read.url()).pathname === resourcePath(id) });
  await page.clock.fastForward(300_000);
  await expect(page.locator('[data-operation-record="autosync"]')).toContainText("Inactive");
  await aborted;
  delayed.discard();
  await delayed.delivered;
  await page.clock.runFor(300);

  await expect(page.locator('section[aria-label="Consumed"]')).toHaveCount(0);
  await expect(page.locator("[data-ordinary-paste-page]")).toBeVisible();
  await expect(page.locator("[data-plain-view]")).toHaveText(current);
  await page.clock.fastForward(6_000);
  expect(resourceReads(traffic, id)).toHaveLength(1);
  await expect(page.locator('[data-operation-record="autosync"]')).toContainText("Inactive");
  await expect(page.locator("[data-plain-view]")).toHaveText(current);
  expect(traffic.maxOpenResourceReads).toBe(1);
  await writer.close();
});

test("a delayed view-once Reload response after a local edit enters terminal local-only state without further business traffic", async ({ page, context, request }) => {
  const current = "ordinary-sync-view-once-current";
  const local = "ordinary-sync-view-once-local";
  const responseSource = "ordinary-sync-view-once-response";
  const { id } = await createPaste(request, { content: current });
  const writer = await openWriter(context);
  const traffic = watchTraffic(page, id);
  await openOrdinary(page, id, current);
  await recreatePaste(writer.request, id, responseSource, true);

  await page.getByRole("tab", { name: "Settings" }).click();
  const settings = page.getByLabel("Settings");
  await settings.getByLabel("Title").fill("ordinary-sync-view-once-title");
  await settings.getByRole("button", { name: "Save title", exact: true }).click();
  const reload = page.locator('[data-settings-result="conflict"]').getByRole("button", { name: "Reload", exact: true });
  await expect(reload).toBeVisible();
  await reload.click();
  const delayed = await releaseFirstResourceDelivery(page, id);
  const reloadDialog = page.getByRole("dialog");
  await expect(reloadDialog).toBeVisible();
  await reloadDialog.getByRole("button", { name: "Reload", exact: true }).click();
  expect((await delayed.fetched).status()).toBe(200);

  const deliveredResponse = waitForResourceResponse(page, id);
  const localOnlyPage = page.waitForResponse((response) => /^\/assets\/LocalOnlyPastePage-[A-Za-z0-9_-]+\.js$/u.test(new URL(response.url()).pathname));
  await page.getByRole("tab", { name: "Edit" }).click();
  await page.getByLabel("Content").fill(local);
  delayed.release();
  expect((await deliveredResponse).status()).toBe(200);
  await delayed.delivered;
  await localOnlyPage;
  await page.clock.runFor(300);

  await expect(page.locator('section[aria-label="Consumed"]')).toBeVisible();
  await page.getByRole("button", { name: "Source" }).click();
  await expect(page.locator("[data-local-source]")).toHaveText(local);
  const businessAtTerminal = traffic.business.length;
  await page.clock.fastForward(6_000);
  expect(traffic.business).toHaveLength(businessAtTerminal);

  await writer.close();
});

test("a delayed view-once Reload response across the active deadline enters terminal local-only state", async ({ page, context, request }) => {
  const current = "ordinary-sync-view-once-deadline-current";
  const responseSource = "ordinary-sync-view-once-deadline-response";
  const { id } = await createPaste(request, { content: current });
  const writer = await openWriter(context);
  const traffic = watchTraffic(page, id);
  await openOrdinary(page, id, current);
  await recreatePaste(writer.request, id, responseSource, true);

  await page.getByRole("tab", { name: "Settings" }).click();
  const settings = page.getByLabel("Settings");
  await settings.getByLabel("Title").fill("ordinary-sync-view-once-deadline-title");
  await settings.getByRole("button", { name: "Save title", exact: true }).click();
  const reload = page.locator('[data-settings-result="conflict"]').getByRole("button", { name: "Reload", exact: true });
  await expect(reload).toBeVisible();
  await reload.click();
  const delayed = await releaseFirstResourceDelivery(page, id);
  const reloadDialog = page.getByRole("dialog");
  await expect(reloadDialog).toBeVisible();
  await reloadDialog.getByRole("button", { name: "Reload", exact: true }).click();
  expect((await delayed.fetched).status()).toBe(200);

  const deliveredResponse = waitForResourceResponse(page, id);
  const localOnlyPage = page.waitForResponse((response) => /^\/assets\/LocalOnlyPastePage-[A-Za-z0-9_-]+\.js$/u.test(new URL(response.url()).pathname));
  await page.clock.fastForward(300_000);
  delayed.release();
  expect((await deliveredResponse).status()).toBe(200);
  await delayed.delivered;
  await localOnlyPage;
  await page.clock.runFor(300);

  await expect(page.locator('section[aria-label="Consumed"]')).toBeVisible();
  const businessAtTerminal = traffic.business.length;
  await page.clock.fastForward(6_000);
  expect(traffic.business).toHaveLength(businessAtTerminal);

  await writer.close();
});
