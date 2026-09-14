export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export interface ThemeSnapshot {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

export interface ThemeController {
  snapshot(): ThemeSnapshot;
  setPreference(preference: ThemePreference): void;
  dispose(): void;
}

type ThemeRoot = {
  dataset: { theme?: string };
  style: { colorScheme: string };
};

type ThemeMediaQueryList = {
  readonly matches: boolean;
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
};

function resolvedTheme(preference: ThemePreference, media: ThemeMediaQueryList): ResolvedTheme {
  return preference === "system" ? (media.matches ? "dark" : "light") : preference;
}

export function createThemeController(
  root: ThemeRoot,
  media: ThemeMediaQueryList,
  onThemeChange?: (theme: ResolvedTheme) => void,
): ThemeController {
  let preference: ThemePreference = "system";
  let resolved = resolvedTheme(preference, media);
  let disposed = false;

  const apply = (theme: ResolvedTheme): void => {
    resolved = theme;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    onThemeChange?.(theme);
  };
  const change = (event: { matches: boolean }): void => {
    if (disposed || preference !== "system") return;
    apply(event.matches ? "dark" : "light");
  };

  media.addEventListener("change", change);
  apply(resolved);

  return {
    snapshot(): ThemeSnapshot {
      return { preference, resolved };
    },
    setPreference(next: ThemePreference): void {
      if (disposed) return;
      preference = next;
      apply(resolvedTheme(preference, media));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      media.removeEventListener("change", change);
    },
  };
}
