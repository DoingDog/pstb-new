import { expect, test, type Frame, type Page, type Request, type Response } from "@playwright/test";
import { createPaste, uniquePasteId } from "./helpers";

function apiResponse(page: Page, method: string, pathname: string): Promise<Response> {
  return page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname === pathname);
}

async function saveContent(page: Page, id: string, content: string): Promise<Response> {
  const response = apiResponse(page, "PATCH", `/api/pastes/${id}`);
  await page.getByRole("textbox", { name: "Content", exact: true }).fill(content);
  return response;
}

async function expectSaved(page: Page): Promise<void> {
  await expect(page.locator('[data-operation-record="autosave"]')).toContainText("Saved");
}

test.describe.configure({ mode: "serial" });

test("creates, protects, edits, recovers, manages, and deletes a paste", async ({ page, context }) => {
  test.setTimeout(90_000);

  const id = uniquePasteId();
  const password = `${uniquePasteId()}&=+?/%#[]`;
  const changedPassword = `${uniquePasteId()}!$`;
  const title = `Journey ${id}`;
  const initialContent = `# initial ${id}`;
  const debounceContent = `# debounce ${id}`;
  const remoteContent = `# remote ${id}`;
  const localConflictContent = `# local ${id}`;
  const historyContents = [1, 2, 3, 4].map((revision) => `# history ${revision} ${id}`);
  const encodedPassword = new URLSearchParams({ password }).toString();
  const pastePath = `/${id}`;
  const apiPath = `/api/pastes/${id}`;

  await page.goto("/");
  await expect(page.locator("#app main")).toBeVisible();
  await expect(page.locator("#source-data")).toHaveCount(0);

  await page.getByRole("textbox", { name: "Content", exact: true }).fill(initialContent);
  await page.getByLabel("Title").fill(title);
  await page.locator("#create-format").selectOption("markdown");
  await page.locator("#create-password").fill(password);
  await page.getByLabel("Custom ID").fill(id);

  const resourceGets: string[] = [];
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (request.method() === "GET" && (target.pathname === pastePath || target.pathname === apiPath)) resourceGets.push(target.pathname);
  });
  const created = apiResponse(page, "POST", "/api/pastes");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  expect((await created).status()).toBe(201);
  await expect(page.getByLabel(id)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  await page.waitForTimeout(100);
  expect(resourceGets).toEqual([]);

  const resultView = page.getByRole("link", { name: "View", exact: true });
  const protectedHref = await resultView.getAttribute("href");
  expect(protectedHref).not.toBeNull();
  const protectedView = new URL(protectedHref!, page.url());
  expect(protectedView.searchParams.getAll("password")).toEqual([password]);
  expect(protectedView.search).toBe(`?${encodedPassword}`);
  const credentialFreeView = new URL(protectedView);
  credentialFreeView.searchParams.delete("password");
  expect(credentialFreeView.pathname).toBe(pastePath);
  expect(credentialFreeView.search).toBe("");

  await page.goto(credentialFreeView.toString());
  await expect(page.getByRole("heading", { name: "Password required" })).toBeVisible();
  const passwordForm = page.locator("form");
  await passwordForm.getByLabel("Password").fill(password);
  const submittedPassword = page.waitForResponse((response) => response.request().method() === "POST"
    && response.request().resourceType() === "document"
    && new URL(response.url()).pathname === pastePath);
  await passwordForm.getByRole("button", { name: "Continue", exact: true }).click();
  expect((await submittedPassword).status()).toBe(302);
  await page.waitForURL((url) => url.pathname === pastePath && url.search === `?${encodedPassword}`);
  expect(new URL(page.url()).searchParams.getAll("password")).toEqual([password]);
  await page.reload();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  await page.getByRole("tab", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Content", exact: true });
  await expect(editor).toHaveValue(initialContent);
  const isFirstDebouncedPatch = (request: Request) => request.method() === "PATCH"
    && new URL(request.url()).pathname === apiPath
    && request.postDataJSON().content === debounceContent;
  const firstPatch = page.waitForRequest(isFirstDebouncedPatch);
  await editor.evaluate((element) => {
    element.addEventListener("input", (event) => {
      (element as HTMLTextAreaElement & { e2eInputEventAt?: number }).e2eInputEventAt = performance.timeOrigin + event.timeStamp;
    }, { once: true });
  });
  await editor.fill(debounceContent);
  const inputEventAt = await editor.evaluate((element) => {
    const eventAt = (element as HTMLTextAreaElement & { e2eInputEventAt?: number }).e2eInputEventAt;
    if (eventAt === undefined) throw new Error("Content input event was not observed");
    return eventAt;
  });
  const firstRequest = await firstPatch;
  const firstResponse = await firstRequest.response();
  if (firstResponse === null) throw new Error("First debounced PATCH did not receive a response");
  expect(firstResponse.status()).toBe(200);
  const debounceElapsed = firstRequest.timing().startTime - inputEventAt;
  const debounceTolerance = 250; // Allows Windows scheduler variance without admitting a two-second debounce.
  expect(debounceElapsed).toBeGreaterThanOrEqual(1_000);
  expect(debounceElapsed).toBeLessThanOrEqual(1_000 + debounceTolerance);
  await expectSaved(page);
  await page.reload();
  await page.getByRole("tab", { name: "Edit", exact: true }).click();
  await expect(editor).toHaveValue(debounceContent);

  // 另一浏览器写入期间保留此页面的旧版本，使下一次保存稳定复现冲突。
  const syncUrl = `**${apiPath}*`;
  await page.route(syncUrl, (route) => route.request().method() === "GET" ? route.abort("failed") : route.continue());
  const rival = await context.newPage();
  await rival.goto(`${pastePath}?${encodedPassword}`);
  await rival.getByRole("tab", { name: "Edit", exact: true }).click();
  const remoteSave = await saveContent(rival, id, remoteContent);
  expect(remoteSave.status()).toBe(200);
  await expectSaved(rival);

  const conflictSave = await saveContent(page, id, localConflictContent);
  expect(conflictSave.status()).toBe(409);
  await page.unroute(syncUrl);
  await expect(editor).toHaveValue(localConflictContent);
  await expect(page.locator('[data-operation-record="autosave"]')).toContainText("Conflict");
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Overwriting", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Reload", exact: true }).click();
  const reloadDialog = page.getByRole("dialog");
  await expect(reloadDialog).toBeVisible();
  const reloaded = apiResponse(page, "GET", apiPath);
  await reloadDialog.getByRole("button", { name: "Reload", exact: true }).click();
  expect((await reloaded).status()).toBe(200);
  await expect(editor).toHaveValue(remoteContent);

  for (const content of historyContents) {
    const saved = await saveContent(page, id, content);
    expect(saved.status()).toBe(200);
    await expectSaved(page);
  }

  await page.getByRole("tab", { name: "History", exact: true }).click();
  const history = page.getByLabel("History");
  const revisionButtons = history.locator('[data-history-list="true"] button');
  await expect(revisionButtons).toHaveCount(3);
  await expect(revisionButtons).toHaveText(["Revision 6", "Revision 5", "Revision 4"]);
  const latestRevision = apiResponse(page, "GET", `${apiPath}/history/6`);
  await revisionButtons.nth(0).click();
  expect((await latestRevision).status()).toBe(200);
  const selectedRevision = page.locator('section[data-history-detail="true"]');
  await page.getByRole("tab", { name: "Full snapshot", exact: true }).click();
  await expect(selectedRevision).toContainText(historyContents[2]!);
  await page.getByRole("tab", { name: "Unified diff", exact: true }).click();
  await expect(selectedRevision).toContainText(`-${historyContents[2]!}`);
  await expect(selectedRevision).toContainText(`+${historyContents[3]!}`);

  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  const settings = page.getByLabel("Settings");
  const titleOutcome = settings.locator('[data-settings-action-result="succeeded"]').filter({ hasText: "Title saved" });
  const formatOutcome = settings.locator('[data-settings-action-result="succeeded"]').filter({ hasText: "Format saved" });
  const expirationOutcome = settings.locator('[data-settings-action-result="succeeded"]').filter({ hasText: "Expiration saved" });
  await settings.getByLabel("Title").fill(`${title} changed`);
  const savedTitle = apiResponse(page, "PATCH", `${apiPath}/settings`);
  await settings.getByRole("button", { name: "Save title", exact: true }).click();
  expect((await savedTitle).status()).toBe(200);
  await expect(titleOutcome).toBeVisible();

  await expect(settings.getByLabel("Format")).toHaveValue("markdown");
  await settings.getByLabel("Format").selectOption("text");
  await expect(titleOutcome).toBeVisible();
  const savedFormat = apiResponse(page, "PATCH", `${apiPath}/settings`);
  await settings.getByRole("button", { name: "Save format", exact: true }).click();
  expect((await savedFormat).status()).toBe(200);
  await expect(formatOutcome).toBeVisible();
  await expect.soft(titleOutcome).toBeVisible();

  await settings.getByLabel("Expiration").selectOption("60");
  await expect(formatOutcome).toBeVisible();
  const savedExpiration = apiResponse(page, "PATCH", `${apiPath}/settings`);
  await settings.getByRole("button", { name: "Save expiration", exact: true }).click();
  expect((await savedExpiration).status()).toBe(200);
  await expect(expirationOutcome).toBeVisible();
  await expect.soft(formatOutcome).toBeVisible();

  const passwordPanel = page.locator('section[aria-label="Password"]');
  await passwordPanel.locator('input[name="currentPassword"]').fill(password);
  await passwordPanel.locator('input[name="newPassword"]').fill(changedPassword);
  const changed = apiResponse(page, "PUT", `${apiPath}/password`);
  await passwordPanel.getByRole("button", { name: "Change password", exact: true }).click();
  expect((await changed).status()).toBe(200);
  await expect(passwordPanel.locator('[data-password-result="succeeded"]')).toContainText("Password saved");
  expect(new URL(page.url()).search).toBe(`?${new URLSearchParams({ password: changedPassword }).toString()}`);
  await page.reload();
  await expect(page.getByRole("heading", { name: `${title} changed` })).toBeVisible();

  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  const refreshedSettings = page.getByLabel("Settings");
  await expect(refreshedSettings.getByLabel("Format")).toHaveValue("text");
  await expect(refreshedSettings.getByLabel("Expiration")).toHaveValue("60");
  const refreshedPasswordPanel = page.locator('section[aria-label="Password"]');
  await refreshedPasswordPanel.locator('input[name="currentPassword"]').fill(changedPassword);
  const cleared = apiResponse(page, "DELETE", `${apiPath}/password`);
  await refreshedPasswordPanel.getByRole("button", { name: "Clear password", exact: true }).click();
  expect((await cleared).status()).toBe(200);
  await expect(refreshedPasswordPanel.locator('[data-password-result="succeeded"]')).toContainText("Password cleared");
  expect(new URL(page.url()).search).toBe("");
  await page.reload();
  await expect(page.getByRole("heading", { name: `${title} changed` })).toBeVisible();

  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete" });
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(deleteDialog).toContainText("Delete this paste permanently.");
  await page.locator("#app").evaluate((app) => {
    (window as Window & { e2eAppBeforeDelete?: Element }).e2eAppBeforeDelete = app;
  });
  const mainFrameDocumentRequests: Request[] = [];
  const mainFrameNavigations: string[] = [];
  const observeMainFrameDocumentRequest = (request: Request) => {
    if (request.frame() === page.mainFrame() && request.resourceType() === "document") mainFrameDocumentRequests.push(request);
  };
  const observeMainFrameNavigation = (frame: Frame) => {
    if (frame === page.mainFrame() && mainFrameDocumentRequests.some((request) => request.url() === frame.url())) mainFrameNavigations.push(frame.url());
  };
  page.on("request", observeMainFrameDocumentRequest);
  page.on("framenavigated", observeMainFrameNavigation);
  const deleteOutcome = page.locator('[data-operation-record="last-action"]').filter({ hasText: "Deleted" });
  const deleted = apiResponse(page, "DELETE", apiPath);
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  expect((await deleted).status()).toBe(204);
  await expect(deleteOutcome).toBeVisible();
  await expect(page.locator("#workbench-sidebar-trigger")).toHaveAttribute("aria-expanded", "false");
  expect(await page.locator("#app").evaluate((app) => app === (window as Window & { e2eAppBeforeDelete?: Element }).e2eAppBeforeDelete)).toBe(true);
  expect(mainFrameDocumentRequests).toHaveLength(0);
  expect(mainFrameNavigations).toHaveLength(0);
  const deletedUrl = new URL(page.url());
  expect(deletedUrl.pathname).toBe("/");
  expect(deletedUrl.search).toBe("");
  expect(deletedUrl.hash).toBe("");
  page.off("request", observeMainFrameDocumentRequest);
  page.off("framenavigated", observeMainFrameNavigation);
  await page.reload();
  await expect(deleteOutcome).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Create a paste" })).toBeVisible();
  await expect(page.locator("#app main")).toBeVisible();
  await expect(page.locator("#source-data")).toHaveCount(0);

  await rival.close();
});

test("keeps the same gap between settings rows and the password row", async ({ page, request }) => {
  const { id } = await createPaste(request);
  try {
    await page.goto(`/${id}`);
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    const gaps = await page.locator('[data-settings-row]').evaluateAll((rows) => rows.slice(1).map((row, index) =>
      Math.round(row.getBoundingClientRect().top - rows[index]!.getBoundingClientRect().bottom)));
    expect(gaps).toEqual([8, 8, 8, 8, 8]);
  } finally {
    await request.delete(`/api/pastes/${id}`);
  }
});

test("the paste breadcrumb returns to the create page", async ({ page, request }) => {
  const { id } = await createPaste(request);
  try {
    await page.goto(`/${id}`);
    await page.locator("#document-locale").selectOption("zh-CN");
    const home = page.getByRole("navigation", { name: "breadcrumb" }).getByRole("link", { name: "剪贴板", exact: true });
    await expect(home).toHaveAttribute("href", "/");
    await home.click();
    await expect(page).toHaveURL("http://127.0.0.1:8787/");
    await expect(page.getByRole("heading", { name: "创建剪贴板" })).toBeVisible();
  } finally {
    await request.delete(`/api/pastes/${id}`);
  }
});

test("keeps an unsaved create draft when the home breadcrumb is clicked", async ({ page }) => {
  await page.goto("/");
  const content = page.getByRole("textbox", { name: "Content", exact: true });
  await content.fill("unsaved draft");
  await expect(page.getByRole("navigation", { name: "breadcrumb" }).locator('a[href="/"]')).toHaveCount(0);
  await expect(content).toHaveValue("unsaved draft");
});

test("remembers each paste's outer and Markdown tabs without duplicating representation links", async ({ page, request }) => {
  const first = await createPaste(request, { content: "# first", format: "markdown" });
  const second = await createPaste(request, { content: "second" });
  try {
    await page.goto(`/${first.id}`);
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(page.locator('section[data-ordinary-paste-page="true"] nav[aria-label="Representations"]')).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("tab", { name: "Settings", exact: true })).toHaveAttribute("aria-selected", "true");

    await page.getByRole("tab", { name: "Markdown", exact: true }).first().click();
    await page.getByRole("tab", { name: "Preview", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("tab", { name: "Markdown", exact: true }).first()).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute("aria-selected", "true");

    await page.goto(`/${second.id}`);
    await expect(page.getByRole("tab", { name: "View", exact: true })).toHaveAttribute("aria-selected", "true");
  } finally {
    await request.delete(`/api/pastes/${first.id}`);
    await request.delete(`/api/pastes/${second.id}`);
  }
});
