import { describe, expect, it, vi } from "vitest";
import {
  assertDictionaryParity,
  dictionaries,
  errorMessage,
  formatDate,
  resolveBrowserLocale,
  resolveServerLocale,
} from "./i18n";

describe("i18n", () => {
  it("keeps English and Simplified Chinese dictionary keys in parity at runtime", () => {
    expect(() => assertDictionaryParity(dictionaries)).not.toThrow();

    expect(() => assertDictionaryParity({
      en: { create: "Create" },
      "zh-CN": { paste: "粘贴内容" },
    } as never)).toThrow("dictionary keys do not match");
  });

  it("pairs every displayed error with a localized recovery action and normalizes unknown codes", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      for (const message of Object.values(dictionaries[locale].errors)) {
        expect(message).toMatch(locale === "en" ? /\.\s+\S/ : /。\S/);
      }
    }

    expect(dictionaries.en.errors.METHOD_NOT_ALLOWED).toBe("Method not allowed. Return to the create page.");
    expect(errorMessage("zh-CN", "UNKNOWN_ERROR")).toBe(dictionaries["zh-CN"].errors.INTERNAL_ERROR);
    expect(dictionaries["zh-CN"].labels).toMatchObject({
      create: "创建剪贴板",
      submit: "创建剪贴板",
      delete: "删除剪贴板",
      paste: "剪贴板",
    });
  });

  it("selects the first supported browser language and falls back to the document locale", () => {
    expect(resolveBrowserLocale(["fr-FR", "zh-Hant-TW", "en-US"], "en")).toBe("zh-CN");
    expect(resolveBrowserLocale(["invalid locale", "en-GB", "zh"], "zh-CN")).toBe("en");
    expect(resolveBrowserLocale(["de-DE", "*"], "zh-CN")).toBe("zh-CN");
    expect(resolveBrowserLocale(undefined, "en")).toBe("en");
    expect(resolveBrowserLocale([], "fr")).toBe("en");
  });

  it("uses only a valid first Accept-Language range for the server locale", () => {
    expect(resolveServerLocale("zh-Hant-TW, en;q=0.8")).toBe("zh-CN");
    expect(resolveServerLocale("en-US, zh-CN;q=0.8")).toBe("en");
    expect(resolveServerLocale("zhar, en")).toBe("en");
  });

  it("formats displayed dates with the selected locale and medium date and time styles", () => {
    const format = vi.fn(() => "formatted date");
    class DateTimeFormat {
      readonly format = format;
    }
    const dateTimeFormat = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(DateTimeFormat as unknown as typeof Intl.DateTimeFormat);

    expect(formatDate("zh-CN", "2026-09-13T00:00:00.000Z")).toBe("formatted date");
    expect(dateTimeFormat).toHaveBeenCalledWith("zh-CN", { dateStyle: "medium", timeStyle: "medium" });
    expect(format).toHaveBeenCalledWith(new Date("2026-09-13T00:00:00.000Z"));
  });
});
