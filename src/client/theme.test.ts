import { describe, expect, it } from "vitest";

import { createThemeController } from "./theme";

type ThemeListener = (event: { matches: boolean }) => void;

function themeMedia(initial: boolean) {
  let matches = initial;
  const listeners: ThemeListener[] = [];

  return {
    media: {
      get matches(): boolean {
        return matches;
      },
      addEventListener(_type: "change", listener: ThemeListener): void {
        listeners.push(listener);
      },
      removeEventListener(_type: "change", listener: ThemeListener): void {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    },
    emit(next: boolean): void {
      matches = next;
      for (const listener of [...listeners]) listener({ matches });
    },
    setMatches(next: boolean): void {
      matches = next;
    },
    listenerCount(): number {
      return listeners.length;
    },
  };
}

describe("createThemeController", () => {
  it("uses the system preference initially and follows media changes", () => {
    const root: { dataset: { theme?: string }; style: { colorScheme: string } } = { dataset: {}, style: { colorScheme: "" } };
    const media = themeMedia(true);
    const controller = createThemeController(root, media.media);

    expect(controller.snapshot()).toEqual({ preference: "system", resolved: "dark" });
    expect(root).toEqual({ dataset: { theme: "dark" }, style: { colorScheme: "dark" } });
    expect(media.listenerCount()).toBe(1);

    media.emit(false);

    expect(controller.snapshot()).toEqual({ preference: "system", resolved: "light" });
    expect(root).toEqual({ dataset: { theme: "light" }, style: { colorScheme: "light" } });
  });

  it("ignores media changes while an explicit preference is active", () => {
    const root: { dataset: { theme?: string }; style: { colorScheme: string } } = { dataset: {}, style: { colorScheme: "" } };
    const media = themeMedia(false);
    const controller = createThemeController(root, media.media);

    controller.setPreference("dark");
    media.emit(false);
    expect(controller.snapshot()).toEqual({ preference: "dark", resolved: "dark" });
    expect(root.dataset.theme).toBe("dark");

    controller.setPreference("light");
    media.emit(true);
    expect(controller.snapshot()).toEqual({ preference: "light", resolved: "light" });
    expect(root.dataset.theme).toBe("light");
  });

  it("reads the current media result immediately when restored to system", () => {
    const root: { dataset: { theme?: string }; style: { colorScheme: string } } = { dataset: {}, style: { colorScheme: "" } };
    const media = themeMedia(true);
    const controller = createThemeController(root, media.media);

    controller.setPreference("light");
    media.setMatches(false);
    controller.setPreference("system");

    expect(controller.snapshot()).toEqual({ preference: "system", resolved: "light" });
    expect(root).toEqual({ dataset: { theme: "light" }, style: { colorScheme: "light" } });
    expect(media.listenerCount()).toBe(1);
  });

  it("installs and removes one listener for each mounted controller", () => {
    const root: { dataset: { theme?: string }; style: { colorScheme: string } } = { dataset: {}, style: { colorScheme: "" } };
    const media = themeMedia(false);

    const first = createThemeController(root, media.media);
    expect(media.listenerCount()).toBe(1);
    first.dispose();
    first.dispose();
    expect(media.listenerCount()).toBe(0);

    const second = createThemeController(root, media.media);
    expect(media.listenerCount()).toBe(1);
    second.dispose();
    expect(media.listenerCount()).toBe(0);
  });
});
