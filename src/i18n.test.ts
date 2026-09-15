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
  it("checks recursive dictionary parity and terminal outcomes", () => {
    expect(() => assertDictionaryParity(dictionaries)).not.toThrow();
    const broken = structuredClone(dictionaries);
    delete (broken["zh-CN"].help as Partial<Record<string, string>>).autosync;
    expect(() => assertDictionaryParity(broken as never)).toThrow("dictionary keys do not match at help.autosync");
    expect(Object.keys(dictionaries.en.terminal).sort()).toEqual([
      "content-reconcile-terminal-current-kept",
      "reload-terminal-current-kept-choice",
      "reload-terminal-current-unchanged",
      "reload-terminal-response-display-failed",
      "reload-terminal-response-displayed",
      "use-consumed-response-display-failed",
      "use-consumed-response-displayed",
    ]);
  });

  it("keeps errors, statuses, and action outcomes closed and localized", () => {
    expect(Object.keys(dictionaries.en.errors).sort()).toEqual(Object.keys(dictionaries["zh-CN"].errors).sort());
    expect(Object.keys(dictionaries.en.actions).sort()).toEqual([
      "autosave",
      "content-reconcile",
      "copy",
      "create",
      "delete",
      "download",
      "history-list",
      "history-snapshot",
      "manual-save",
      "overwrite",
      "password-clear",
      "password-reconcile",
      "password-set",
      "reload-server",
      "retry-sync",
      "save-retry",
      "settings-expiration",
      "settings-format",
      "settings-reconcile",
      "settings-title",
      "settings-view-once",
      "use-consumed-response",
      "use-remote",
    ]);
    expect(dictionaries.en.errors).toMatchObject({
      NETWORK_ERROR: expect.any(String),
      MALFORMED_RESPONSE: expect.any(String),
      UNKNOWN_ERROR: expect.any(String),
    });
    expect(errorMessage("zh-CN", "an-unrecognized-server-message")).toBe(dictionaries["zh-CN"].errors.UNKNOWN_ERROR);
  });

  it("keeps explanatory copy out of labels", () => {
    for (const key of [
      "titleDescription",
      "formatDescription",
      "expirationDescription",
      "passwordDescription",
      "customIdDescription",
      "storedExactly",
      "viewOnceDescription",
    ]) {
      expect(dictionaries.en.labels).not.toHaveProperty(key);
      expect(dictionaries["zh-CN"].labels).not.toHaveProperty(key);
    }
    expect(dictionaries.en.help).toMatchObject({
      contentStorage: expect.any(String),
      contentLimit: expect.any(String),
      format: expect.any(String),
      expiration: expect.any(String),
      relativeExpiration: expect.any(String),
      password: expect.any(String),
      passwordUrl: expect.any(String),
      viewOnce: expect.any(String),
      activeHtml: expect.any(String),
      markdownNormalization: expect.any(String),
      autosave: expect.any(String),
      autosync: expect.any(String),
      largeDiff: expect.any(String),
    });
    expect(dictionaries.en.validation.deleteDescription).toBe("Delete this paste permanently.");
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
