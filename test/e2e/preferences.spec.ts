import { expect, test } from "@playwright/test";
import { createPaste } from "./helpers";

test("remembers wrap, language, and theme across paste pages", async ({ page, request }) => {
  const first = await createPaste(request, { content: "# first", format: "markdown" });
  const second = await createPaste(request);
  const consumed = await createPaste(request, { viewOnce: true });
  try {
    await page.goto(`/${first.id}`);
    await page.getByRole("button", { name: "Wrap", exact: true }).click();
    await page.locator("#document-locale").selectOption("zh-CN");
    await page.locator("#document-theme").selectOption("dark");
    expect(await page.evaluate(() => ({
      wrap: localStorage.getItem("cf-pastebin:wrap"),
      locale: localStorage.getItem("cf-pastebin:locale"),
      theme: localStorage.getItem("cf-pastebin:theme"),
    }))).toEqual({ wrap: "true", locale: "zh-CN", theme: "dark" });

    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("#document-theme")).toHaveValue("dark");
    await page.goto(`/${second.id}`);
    await expect(page.getByRole("button", { name: "取消自动换行" })).toBeVisible();
    await page.goto(`/md/${first.id}`);
    await expect(page.getByRole("button", { name: "取消自动换行" })).toBeVisible();
    await expect(page.locator("#document-locale")).toHaveValue("zh-CN");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.goto(`/${consumed.id}`);
    await expect(page.getByRole("button", { name: "取消自动换行" })).toBeVisible();
  } finally {
    await request.delete(`/api/pastes/${first.id}`);
    await request.delete(`/api/pastes/${second.id}`);
    await request.delete(`/api/pastes/${consumed.id}`);
  }
});
