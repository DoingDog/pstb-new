import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page, type Worker } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createPaste, uniquePasteId } from "./helpers";

const axeTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const bannedVisibleCopy = /README\.md|Changes|Files|sample|workspace|dashboard|marketing/i;

async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(axeTags).analyze();
  expect(results.violations).toEqual([]);
}

async function openOrdinary(
  page: Page,
  request: APIRequestContext,
  overrides: Parameters<typeof createPaste>[1] = {},
): Promise<{ id: string; password: string }> {
  const paste = await createPaste(request, {
    content: "task-16 ordinary text",
    ...overrides,
  });
  await page.goto(`/${paste.id}${paste.password === "" ? "" : `?password=${encodeURIComponent(paste.password)}`}`);
  await expect(page.locator("[data-ordinary-paste-page]")).toBeVisible();
  return paste;
}

async function selectPasteTab(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name, exact: true }).click();
  await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
}

async function createRevision(request: APIRequestContext): Promise<string> {
  const { id } = await createPaste(request, { content: "before revision" });
  const resource = await request.get(`/api/pastes/${id}`);
  expect(resource.status()).toBe(200);
  const body = await resource.json() as { version: string };
  const update = await request.patch(`/api/pastes/${id}`, {
    data: { content: "after revision", version: body.version },
  });
  expect(update.status()).toBe(200);
  return id;
}

async function openHistoryDiff(page: Page, request: APIRequestContext): Promise<void> {
  const id = await createRevision(request);
  await page.goto(`/${id}`);
  await expect(page.locator("[data-ordinary-paste-page]")).toBeVisible();
  await selectPasteTab(page, "History");
  await expect(page.getByRole("button", { name: "Revision 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Revision 1", exact: true }).click();
  await expect(page.locator("[data-history-detail]")).toBeVisible();
}

function durationMilliseconds(value: string): number {
  return Math.max(...value.split(",").map((part) => {
    const duration = Number.parseFloat(part);
    return part.trim().endsWith("ms") ? duration : duration * 1_000;
  }));
}

async function expectNoMotion(page: Page, selector: string): Promise<void> {
  const durations = await page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.transitionDuration, style.transitionDelay, style.animationDuration, style.animationDelay];
  });
  expect(durations.map(durationMilliseconds)).toEqual([0, 0, 0, 0]);
}

async function expectLargeInteractiveTargets(page: Page, scope: ReturnType<Page["locator"]> = page.locator("body")): Promise<void> {
  const undersized = await scope.locator("button, input:not([type=hidden]), select, textarea, a[href], [role=tab]").evaluateAll((targets) =>
    targets
      .filter((target) => {
        const style = getComputedStyle(target);
        return target.getClientRects().length > 0 && style.visibility !== "hidden" && !target.closest("[hidden]");
      })
      .map((target) => {
        const input = target instanceof HTMLInputElement ? target : null;
        const label = input !== null && (input.type === "checkbox" || input.type === "radio")
          ? input.labels?.[0] ?? input.closest("label")
          : null;
        const hitArea = label ?? target;
        const box = hitArea.getBoundingClientRect();
        return {
          name: target.getAttribute("aria-label") ?? target.textContent?.trim() ?? target.tagName,
          tag: target.tagName,
          width: box.width,
          height: box.height,
        };
      })
      .filter(({ width, height }) => width < 44 || height < 44),
  );
  expect(undersized).toEqual([]);
}

async function expectLocalCodeScroller(page: Page, locator: ReturnType<Page["locator"]>): Promise<void> {
  const metrics = await locator.evaluate((region) => {
    const before = region.scrollLeft;
    region.scrollLeft = 64;
    const style = getComputedStyle(region);
    return {
      clientWidth: region.clientWidth,
      scrollWidth: region.scrollWidth,
      scrollLeft: region.scrollLeft,
      tabIndex: region.tabIndex,
      overflowX: style.overflowX,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      before,
    };
  });
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
  expect(metrics.scrollLeft).toBeGreaterThan(0);
  expect(metrics.tabIndex).toBe(0);
  expect(metrics.overflowX).toMatch(/auto|scroll/);
  expect(metrics.documentScrollWidth).toBe(metrics.documentClientWidth);
}

async function expectWrappedCode(page: Page, locator: ReturnType<Page["locator"]>): Promise<void> {
  await expect(locator).not.toHaveAttribute("tabindex");
  await expect(locator.locator("pre")).toHaveCSS("white-space", "pre-wrap");
  const metrics = await locator.evaluate((region) => ({
    regionWidth: region.getBoundingClientRect().width,
    preWidth: region.querySelector("pre")?.getBoundingClientRect().width ?? 0,
    documentScrollWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.preWidth).toBeLessThanOrEqual(metrics.regionWidth);
  expect(metrics.documentScrollWidth).toBe(metrics.documentClientWidth);
}

function graphEvents(page: Page) {
  const requests: string[] = [];
  const workers: Worker[] = [];
  let requestStart = 0;
  let workerStart = 0;
  page.on("request", (request) => requests.push(request.url()));
  page.on("worker", (worker) => workers.push(worker));

  const pending = () => ({
    requests: requests.slice(requestStart),
    workers: workers.slice(workerStart).map((worker) => worker.url()),
  });

  return {
    pending,
    take() {
      const events = pending();
      requestStart = requests.length;
      workerStart = workers.length;
      return events;
    },
  };
}

type ClientAssetsManifest = {
  groups: { crepe: string[]; markdown: string[]; diff: string[] };
};

type GraphAssetGroups = {
  crepe: ReadonlySet<string>;
  markdown: ReadonlySet<string>;
  diff: ReadonlySet<string>;
  lazy: ReadonlySet<string>;
};

async function loadGraphAssetGroups(): Promise<GraphAssetGroups> {
  const manifest = JSON.parse(await readFile(new URL("../../dist/client-assets-manifest.json", import.meta.url), "utf8")) as ClientAssetsManifest;
  return {
    crepe: new Set(manifest.groups.crepe),
    markdown: new Set(manifest.groups.markdown),
    diff: new Set(manifest.groups.diff),
    lazy: new Set([...manifest.groups.crepe, ...manifest.groups.markdown, ...manifest.groups.diff]),
  };
}

function graphAssets(events: { requests: readonly string[]; workers: readonly string[] }, groups: GraphAssetGroups) {
  const requestPaths = events.requests.map((url) => new URL(url).pathname.slice(1));
  const workerPaths = events.workers.map((url) => new URL(url).pathname.slice(1));
  return {
    lazyRequests: requestPaths.filter((path) => groups.lazy.has(path)),
    crepeRequests: requestPaths.filter((path) => groups.crepe.has(path)),
    markdownRequests: requestPaths.filter((path) => groups.markdown.has(path)),
    diffRequests: requestPaths.filter((path) => groups.diff.has(path)),
    diffWorkers: workerPaths.filter((path) => groups.diff.has(path)),
    unexpectedWorkers: workerPaths.filter((path) => !groups.diff.has(path)),
  };
}

test.describe("accessibility branches", () => {
  test("runs Axe after the settled create branch", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Create a paste", exact: true })).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("runs Axe after the settled password branch", async ({ page, request }) => {
    const { id } = await createPaste(request, { password: uniquePasteId() });
    await page.goto(`/${id}`);
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("runs Axe after the settled inline create-conflict branch", async ({ page, request }) => {
    const { id } = await createPaste(request);
    await page.goto("/");
    await page.locator("#create-content").fill("duplicate creation");
    await page.locator("#create-custom-id").fill(id);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("already in use");
    await expectNoAxeViolations(page);
  });

  test("runs Axe after the settled ordinary text branch", async ({ page, request }) => {
    await openOrdinary(page, request, { content: "ordinary text" });
    await expectNoAxeViolations(page);
  });

  test("runs Axe after the settled ordinary Markdown branch", async ({ page, request }) => {
    await openOrdinary(page, request, { content: "# ordinary Markdown", format: "markdown" });
    await expectNoAxeViolations(page);
  });

  test("runs Axe after the settled armed-view-once branch", async ({ page, request }) => {
    await openOrdinary(page, request);
    await selectPasteTab(page, "Settings");
    await page.getByRole("checkbox", { name: "View once", exact: true }).check();
    await page.getByRole("button", { name: "Save view once", exact: true }).click();
    await expect(page.locator('[aria-label="Armed view-once"]')).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("runs Axe after the settled consumed-text branch", async ({ page, request }) => {
    const { id } = await createPaste(request, { content: "consumed text", viewOnce: true });
    await page.goto(`/${id}`);
    await expect(page.locator('[aria-label="Consumed"]')).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("runs Axe after the settled consumed-Markdown branch", async ({ page, request }) => {
    const { id } = await createPaste(request, { content: "# consumed Markdown", format: "markdown", viewOnce: true });
    await page.goto(`/${id}`);
    await expect(page.locator('[aria-label="Consumed"]')).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("runs Axe after the real not-found ErrorPage route settles", async ({ page }) => {
    const response = await page.goto(`/${uniquePasteId()}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("runs Axe on a real 400 BAD_REQUEST ErrorPage rather than only the 404 branch", async ({ page, request }) => {
    const { id } = await createPaste(request);
    const response = await page.goto(`/${id}%`);
    expect(response?.status()).toBe(400);
    await expect(page.getByRole("heading", { name: "400", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("request is malformed");
    await expectNoAxeViolations(page);
  });

  test("shows the 400 AMBIGUOUS_PASSWORD error page for a duplicate password query", async ({ page, request }) => {
    const { id } = await createPaste(request);
    const response = await page.goto(`/${id}?password=one&password=two`);
    expect(response?.status()).toBe(400);
    await expect(page.getByRole("heading", { name: "400", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("The password is ambiguous");
  });

  test("mounts the lazy ordinary route before controlling autosync time on every engine", async ({ page, request }) => {
    const { id } = await createPaste(request, { content: "lazy route clock" });
    await page.goto(`/${id}`);
    await expect(page.locator("[data-ordinary-paste-page]")).toBeVisible();
    await page.clock.install({ time: new Date("2026-09-23T00:00:00.000Z") });
    await page.clock.pauseAt(new Date("2026-09-23T00:00:01.000Z"));
    const poll = page.waitForResponse((response) => response.request().method() === "GET"
      && new URL(response.url()).pathname === `/api/pastes/${id}`);
    await page.clock.fastForward(3_000);
    expect((await poll).status()).toBe(200);
    await expect(page.locator('[data-operation-record="autosync"]')).toContainText("Unchanged");
  });

  test("runs Axe after ordinary autosync transitions to local not-found", async ({ page, request }) => {
    const source = "terminal-source".repeat(200);
    const { id } = await createPaste(request, { content: source });
    await page.goto(`/${id}`);
    await expect(page.locator("[data-ordinary-paste-page]")).toBeVisible();
    await page.clock.install({ time: new Date("2026-09-23T00:00:00.000Z") });
    await page.clock.pauseAt(new Date("2026-09-23T00:00:01.000Z"));

    const resource = await request.get(`/api/pastes/${id}`);
    expect(resource.status()).toBe(200);
    const { version } = await resource.json() as { version: string };
    const deleted = await request.delete(`/api/pastes/${id}`, { data: { version } });
    expect(deleted.status()).toBe(204);

    const notFoundResponse = page.waitForResponse((response) => response.request().method() === "GET"
      && new URL(response.url()).pathname === `/api/pastes/${id}`
      && response.status() === 404);
    const localOnlyPage = page.waitForResponse((response) => /^\/assets\/LocalOnlyPastePage-[A-Za-z0-9_-]+\.js$/u.test(new URL(response.url()).pathname));
    await page.clock.fastForward(3_000);
    await notFoundResponse;
    await localOnlyPage;
    await page.clock.runFor(300);

    await expect(page.locator('section[aria-label="Not found"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: "404", exact: true })).toHaveCount(0);
    await page.clock.resume();
    await expectNoAxeViolations(page);

    const plaintext = page.locator("[data-local-view]");
    await expectLocalCodeScroller(page, plaintext);
    await page.getByRole("button", { name: "Source", exact: true }).click();
    const sourceView = page.locator("[data-local-source]");
    await expectLocalCodeScroller(page, sourceView);
    await page.getByRole("button", { name: "Wrap", exact: true }).click();
    await expect(sourceView).not.toHaveAttribute("tabindex");
    await expect(sourceView).toHaveCSS("white-space", "pre-wrap");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(plaintext).not.toHaveAttribute("tabindex");
    await expect(plaintext).toHaveCSS("white-space", "pre-wrap");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => document.documentElement.clientWidth));
  });

  test("runs Axe after the settled delete-uncertain branch", async ({ page, request }) => {
    const { id } = await openOrdinary(page, request);
    await page.route(`**/api/pastes/${id}`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      await route.fetch();
      await route.abort("failed");
    });
    await selectPasteTab(page, "Settings");
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.locator('[aria-label="Delete uncertain"]')).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("runs Axe after the settled read-only Markdown branch", async ({ page, request }) => {
    const { id } = await createPaste(request, { content: "# read-only Markdown", format: "markdown" });
    await page.goto(`/md/${id}`);
    await expect(page.locator("[data-safe-markdown]")).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

test("supports Tabs Arrow, Home, End, and normal Tab behavior", async ({ page, request }) => {
  await openOrdinary(page, request);
  const tabs = page.getByRole("tab");
  const names = await tabs.allTextContents();
  await tabs.nth(0).focus();
  await page.keyboard.press("End");
  await expect(tabs.nth(names.length - 1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).not.toHaveAttribute("role", "tab");
});

test("opens HelpTrigger by hover, focus, click, Escape, and outside interaction", async ({ page }) => {
  await page.goto("/");
  const help = page.getByRole("button", { name: "Help: Content", exact: true });
  await help.hover();
  await expect(page.getByRole("tooltip")).toContainText("10 MiB");
  await page.getByRole("heading", { name: "Create a paste", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toBeHidden();

  await help.focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await help.click();
  await page.getByRole("heading", { name: "Create a paste", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  await expect(help).toBeFocused();

  await help.click();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.getByRole("heading", { name: "Create a paste", exact: true }).click();
  await expect(page.getByRole("tooltip")).toBeHidden();
});

test("opens and closes HelpTrigger by touch or keyboard activation", async ({ page }, testInfo) => {
  await page.goto("/");
  const help = page.getByRole("button", { name: "Help: Content", exact: true });
  if (testInfo.project.name === "mobile-320") {
    await help.tap();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await help.tap();
  } else {
    await help.click();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.keyboard.press("Escape");
    await help.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await expect(page.getByRole("tooltip")).toBeHidden();
});

test("traps Dialog focus, closes with Escape, and returns focus", async ({ page, request }) => {
  await openOrdinary(page, request);
  await selectPasteTab(page, "Settings");
  const trigger = page.getByRole("button", { name: "Delete", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("traps Sheet focus on mobile and toggles the desktop sidebar", async ({ page }, testInfo) => {
  await page.goto("/");
  const trigger = page.locator("#workbench-sidebar-trigger");
  if (testInfo.project.name === "mobile-320") {
    await expect(page.locator('[data-slot="sidebar"][data-state]')).toHaveCount(0);
    await trigger.click();
    const sheet = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(sheet.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();
  } else {
    const sidebar = page.locator('[data-slot="sidebar"][data-state]');
    const hiddenContent = sidebar.locator('[data-slot="sidebar-inner"]');
    const rail = sidebar.locator('[data-sidebar="rail"]');
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
    await trigger.click();
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
    await expect(hiddenContent).toHaveAttribute("aria-hidden", "true");
    await expect(hiddenContent).toHaveAttribute("inert", "");
    const railBox = await rail.boundingBox();
    expect(railBox).not.toBeNull();
    expect(railBox!.width).toBeGreaterThanOrEqual(44);
    expect(railBox!.x).toBeGreaterThanOrEqual(0);
    expect(railBox!.x + railBox!.width).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
    await rail.click();
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
    await expect(hiddenContent).not.toHaveAttribute("aria-hidden");
    await expect(hiddenContent).not.toHaveAttribute("inert");
  }
});

test("keeps every settled branch interactive target at least 44 by 44 CSS pixels", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create a paste", exact: true })).toBeVisible();
  await expectLargeInteractiveTargets(page);

  await openOrdinary(page, request);
  await expectLargeInteractiveTargets(page);

  await selectPasteTab(page, "Settings");
  await expect(page.getByRole("region", { name: "Settings", exact: true })).toBeVisible();
  await expectLargeInteractiveTargets(page);

  await selectPasteTab(page, "History");
  await expect(page.locator("[data-history-list]")).toBeVisible();
  await expectLargeInteractiveTargets(page);

  await openHistoryDiff(page, request);
  await expectLargeInteractiveTargets(page);

  const consumed = await createPaste(request, { content: "consumed target fixture", viewOnce: true });
  await page.goto(`/${consumed.id}`);
  await expect(page.locator('[aria-label="Consumed"]')).toBeVisible();
  await expectLargeInteractiveTargets(page);

  await page.goto(`/${uniquePasteId()}`);
  await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
  await expectLargeInteractiveTargets(page);
});

test("keeps long Markdown code reachable locally at 320 CSS pixels", async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const source = `\`\`\`text\n${"long-code ".repeat(120)}\n\`\`\``;

  await openOrdinary(page, request, { content: source, format: "markdown" });
  let markdown = page.locator("[data-safe-markdown]");
  await expect(markdown).toBeVisible();
  await expectLocalCodeScroller(page, markdown);
  await page.getByRole("button", { name: "Wrap", exact: true }).click();
  await expectWrappedCode(page, markdown);
  await page.getByRole("button", { name: "Unwrap", exact: true }).click();

  await selectPasteTab(page, "Markdown");
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  markdown = page.locator("[data-safe-markdown]");
  await expect(markdown).toBeVisible();
  await expectLocalCodeScroller(page, markdown);
  await page.getByRole("button", { name: "Wrap", exact: true }).click();
  await expectWrappedCode(page, markdown);

  const readOnly = await createPaste(request, { content: source, format: "markdown" });
  await page.goto(`/md/${readOnly.id}`);
  markdown = page.locator("[data-safe-markdown]");
  await expect(markdown).toBeVisible();
  await expectLocalCodeScroller(page, markdown);
  await page.getByRole("button", { name: "Wrap", exact: true }).click();
  await expectWrappedCode(page, markdown);

  const consumed = await createPaste(request, { content: source, format: "markdown", viewOnce: true });
  await page.goto(`/${consumed.id}`);
  markdown = page.locator("[data-safe-markdown]");
  await expect(markdown).toBeVisible();
  await expectLocalCodeScroller(page, markdown);
  await page.getByRole("button", { name: "Wrap", exact: true }).click();
  await expectWrappedCode(page, markdown);
});

test("keeps wrapped unbroken Markdown and wide tables reachable at 320 CSS pixels", async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await openOrdinary(page, request, { content: "unbroken".repeat(200), format: "markdown" });
  let markdown = page.locator("[data-safe-markdown]");
  await page.getByRole("button", { name: "Wrap", exact: true }).click();
  await expect(markdown).not.toHaveAttribute("tabindex");
  const wrappedText = await markdown.evaluate((article) => ({
    clientWidth: article.clientWidth,
    scrollWidth: article.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
  }));
  expect(wrappedText.scrollWidth).toBeLessThanOrEqual(wrappedText.clientWidth);
  expect(wrappedText.documentScrollWidth).toBe(wrappedText.documentClientWidth);

  const columns = Array.from({ length: 20 }, (_, index) => `column ${index + 1}`);
  const table = `| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n| ${columns.join(" | ")} |`;
  await openOrdinary(page, request, { content: table, format: "markdown" });
  markdown = page.locator("[data-safe-markdown]");
  await expect(markdown.locator("table")).toBeVisible();
  await page.getByRole("button", { name: "Wrap", exact: true }).click();
  await expectLocalCodeScroller(page, markdown);
});

test("keeps the 320 CSS pixel document unscrolled horizontally and the editor full-width", async ({ page, request }, testInfo) => {
  await openOrdinary(page, request);
  await selectPasteTab(page, "Edit");
  const metrics = await page.locator("textarea").evaluate((editor) => {
    const editorBox = editor.getBoundingClientRect();
    const parentBox = editor.parentElement!.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      editorWidth: editorBox.width,
      parentWidth: parentBox.width,
    };
  });
  expect(metrics.scrollWidth).toBe(metrics.clientWidth);
  expect(metrics.editorWidth).toBe(metrics.parentWidth);
  if (testInfo.project.name === "mobile-320") expect(metrics.clientWidth).toBe(320);
});

test("keeps the focused Settings tab visible in a local scroller at 320 CSS pixels", async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await openOrdinary(page, request);
  const tabs = page.getByRole("tab");
  await tabs.first().focus();
  await page.keyboard.press("End");
  const settings = page.getByRole("tab", { name: "Settings", exact: true });
  await expect(settings).toBeFocused();
  await expect(settings).toHaveAttribute("aria-selected", "true");

  const metrics = await settings.evaluate((target) => {
    const list = target.closest<HTMLElement>("[role=tablist]");
    if (list === null) throw new Error("tablist is missing");
    const targetBox = target.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    return {
      listClientWidth: list.clientWidth,
      listScrollWidth: list.scrollWidth,
      listScrollLeft: list.scrollLeft,
      targetLeft: targetBox.left,
      targetRight: targetBox.right,
      listLeft: listBox.left,
      listRight: listBox.right,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(metrics.listScrollWidth).toBeGreaterThan(metrics.listClientWidth);
  expect(metrics.listScrollLeft).toBeGreaterThan(0);
  expect(metrics.targetLeft).toBeGreaterThanOrEqual(metrics.listLeft);
  expect(metrics.targetRight).toBeLessThanOrEqual(metrics.listRight);
  expect(metrics.documentScrollWidth).toBe(metrics.documentClientWidth);
});

test("reflows without horizontal overflow at the 200 percent zoom viewport equivalent", async ({ page, request }) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await openOrdinary(page, request);
  await selectPasteTab(page, "Edit");
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.scrollWidth).toBe(metrics.clientWidth);
});

test("removes computed animation and transition duration for reduced motion", async ({ page, request }, testInfo) => {
  await openOrdinary(page, request);
  if (testInfo.project.name !== "reduced-motion") {
    await expect(page.locator('[data-slot="sidebar-trigger"]')).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(false);
    return;
  }
  await expectNoMotion(page, '[data-slot="sidebar-trigger"]');
  await selectPasteTab(page, "Settings");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expectNoMotion(page, '[data-slot="dialog-content"]');
});

test("renders unified differences with text prefixes, not color alone", async ({ page, request }) => {
  await openHistoryDiff(page, request);
  const diff = page.locator("[data-history-detail] pre");
  await expect(diff).toContainText("-before revision");
  await expect(diff).toContainText("+after revision");
  await expect(diff).not.toHaveAttribute("tabindex");
});

test("focuses mobile History Back and restores the revision that opened detail", async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await openHistoryDiff(page, request);
  const back = page.getByRole("button", { name: "Back", exact: true });
  await expect(back).toBeFocused();
  await back.click();
  await expect(page.getByRole("button", { name: "Revision 1", exact: true })).toBeFocused();
});

test("switches English and zh-CN document copy", async ({ page }) => {
  await page.goto("/");
  const locale = page.locator("#document-locale");
  await locale.selectOption("zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByText("主题", { exact: true })).toBeVisible();
  await locale.selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByText("Theme", { exact: true })).toBeVisible();
});

test("applies system, light, and dark themes only to the document without storage writes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    const writes: string[] = [];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function patchedSetItem(key: string, value: string): void {
      writes.push(`${this === localStorage ? "local" : "session"}:${key}:${value}`);
      setItem.call(this, key, value);
    };
    Object.defineProperty(window, "__task16StorageWrites", { value: writes });
  });
  await page.goto("/");
  const theme = page.locator("#document-theme");
  await theme.selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await theme.selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const result = await page.evaluate(() => ({
    writes: (window as typeof window & { __task16StorageWrites: string[] }).__task16StorageWrites,
    themedDescendants: document.querySelectorAll("body [data-theme]").length,
  }));
  expect(result.writes).toEqual([]);
  expect(result.themedDescendants).toBe(0);
});

test("loads derived graph resources only when their user-visible surface is opened", async ({ page, request, browser }) => {
  const groups = await loadGraphAssetGroups();
  const graph = graphEvents(page);
  const { id } = await createPaste(request, { content: "# graph fixture", format: "markdown" });
  await page.goto(`/${id}`);
  await expect(page.locator("[data-ordinary-paste-page]")).toBeVisible();
  const afterInitial = graphAssets(graph.take(), groups);
  expect(afterInitial.lazyRequests).toEqual([]);
  expect(afterInitial.diffWorkers).toEqual([]);
  expect(afterInitial.unexpectedWorkers).toEqual([]);

  await selectPasteTab(page, "Markdown");
  await page.getByRole("tab", { name: "Visual", exact: true }).click();
  await expect(page.locator("[data-markdown-visual-host]")).toBeVisible();
  await expect.poll(() => graphAssets(graph.pending(), groups).crepeRequests.length).toBeGreaterThan(0);
  const afterVisual = graphAssets(graph.take(), groups);
  expect(afterVisual.lazyRequests.every((path) => groups.crepe.has(path))).toBe(true);
  expect(afterVisual.diffWorkers).toEqual([]);
  expect(afterVisual.unexpectedWorkers).toEqual([]);

  const previewBrowser = await browser.browserType().launch();
  const previewContext = await previewBrowser.newContext();
  const previewPage = await previewContext.newPage();
  const previewGraph = graphEvents(previewPage);
  try {
    const previewId = (await createPaste(request, { content: "# preview fixture", format: "markdown" })).id;
    await previewPage.goto(`http://127.0.0.1:8787/${previewId}`);
    await expect(previewPage.locator("[data-ordinary-paste-page]")).toBeVisible();
    await selectPasteTab(previewPage, "Markdown");
    await previewPage.locator("textarea").fill("# client preview fixture");
    await previewPage.getByRole("tab", { name: "Preview", exact: true }).click();
    await expect(previewPage.locator("[data-safe-markdown]")).toBeVisible();
    await expect.poll(() => graphAssets(previewGraph.pending(), groups).markdownRequests.length).toBeGreaterThan(0);
    const afterPreview = graphAssets(previewGraph.take(), groups);
    expect(afterPreview.lazyRequests.every((path) => groups.markdown.has(path))).toBe(true);
    expect(afterPreview.diffWorkers).toEqual([]);
    expect(afterPreview.unexpectedWorkers).toEqual([]);
  } finally {
    await previewBrowser.close();
  }

  const preHistoryProbe = new URL(`/api/pastes/${id}?graph-probe=pre-history`, page.url()).href;
  await page.evaluate(async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fetch(url, { cache: "no-store" });
  }, preHistoryProbe);

  const beforeHistoryEvents = graph.take();
  expect(beforeHistoryEvents.requests).toContain(preHistoryProbe);
  const beforeHistory = graphAssets(beforeHistoryEvents, groups);
  expect(beforeHistory.lazyRequests.every((path) => groups.crepe.has(path))).toBe(true);
  expect(beforeHistory.diffRequests).toEqual([]);
  expect(beforeHistory.diffWorkers).toEqual([]);
  expect(beforeHistory.unexpectedWorkers).toEqual([]);

  await openHistoryDiff(page, request);
  await expect(page.locator("[data-history-detail] pre")).toBeVisible();
  await expect.poll(() => graphAssets(graph.pending(), groups).diffWorkers.length).toBeGreaterThan(0);
  const afterDiff = graphAssets(graph.take(), groups);
  expect(afterDiff.diffRequests.length).toBeGreaterThan(0);
  expect(afterDiff.lazyRequests.every((path) => groups.diff.has(path))).toBe(true);
  expect(afterDiff.diffWorkers.every((path) => groups.diff.has(path))).toBe(true);
  expect([...new Set([...afterDiff.diffRequests, ...afterDiff.diffWorkers])].sort()).toEqual([...groups.diff].sort());
  expect(afterDiff.unexpectedWorkers).toEqual([]);
});

test("keeps Help copy closed, does not issue status-only requests, and confines credentials", async ({ page, request }) => {
  const password = uniquePasteId();
  const { id } = await createPaste(request, { content: "credential-safe source", password });
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.addInitScript(() => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { writes.push(value); } },
    });
    Object.defineProperty(window, "__task16ClipboardWrites", { value: writes });
  });
  await page.goto(`/${id}?password=${encodeURIComponent(password)}`);
  await expect(page.locator("[data-ordinary-paste-page]")).toBeVisible();
  const visible = await page.locator("body").innerText();
  expect(visible).not.toMatch(bannedVisibleCopy);
  expect(await page.getByRole("tooltip").count()).toBe(0);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.locator('[data-operation-record="last-action"]')).toContainText("Copied");

  const credentialLocations = await page.evaluate((secret) => {
    const hrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .map((anchor) => ({ text: anchor.textContent?.trim() ?? "", href: anchor.href }))
      .filter(({ href }) => href.includes(secret));
    const documentWithoutRepresentationHrefs = document.documentElement.cloneNode(true) as HTMLElement;
    documentWithoutRepresentationHrefs.querySelectorAll("a[href]").forEach((anchor) => anchor.removeAttribute("href"));
    return {
      hrefs,
      locationContainsSecret: location.href.includes(secret),
      plaintextOutsideRepresentationHrefs: documentWithoutRepresentationHrefs.outerHTML.includes(secret),
    };
  }, password);
  expect(credentialLocations.locationContainsSecret).toBe(true);
  expect(credentialLocations.hrefs.map(({ text }) => text).sort()).toEqual(["File", "HTML", "Markdown", "Raw"]);
  expect(credentialLocations.hrefs.every(({ href }) => href.includes(`password=${encodeURIComponent(password)}`))).toBe(true);
  expect(credentialLocations.plaintextOutsideRepresentationHrefs).toBe(false);
  const clipboardWrites = await page.evaluate(() => (window as typeof window & { __task16ClipboardWrites: string[] }).__task16ClipboardWrites);
  expect(clipboardWrites).toEqual(["credential-safe source"]);
  expect(clipboardWrites.join("\n")).not.toContain(password);
  expect(requests.some((url) => /\/(?:api\/)?status(?:[/?#]|$)/.test(new URL(url).pathname))).toBe(false);
});
