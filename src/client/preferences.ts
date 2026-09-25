import * as React from "react";

export function storedOption<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.find((option) => option === value) ?? fallback;
  } catch {
    return fallback;
  }
}

export function storeOption(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 禁用存储时仍允许在当前页面切换设置。
  }
}

export function useStoredWrap() {
  const [wrap, setWrap] = React.useState(() => storedOption("cf-pastebin:wrap", ["true", "false"], "false") === "true");
  const setStoredWrap = (next: boolean) => {
    setWrap(next);
    storeOption("cf-pastebin:wrap", String(next));
  };
  return [wrap, setStoredWrap] as const;
}
