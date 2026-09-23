import * as React from "react";

export function useOverflowFocus<T extends HTMLElement>(enabled: boolean, content: unknown): { ref: React.RefCallback<T>; tabIndex: undefined } {
  const [element, setElement] = React.useState<T | null>(null);
  const ref = React.useCallback((node: T | null) => setElement(node), []);

  React.useLayoutEffect(() => {
    if (element === null) return;
    const update = () => {
      const overflowing = enabled && element.scrollWidth > element.clientWidth;
      if (overflowing) {
        element.style.overflowX = "auto";
        element.tabIndex = 0;
      } else {
        element.style.removeProperty("overflow-x");
        element.removeAttribute("tabindex");
      }
    };
    const resize = new ResizeObserver(update);
    const contentChanges = new MutationObserver(update);
    update();
    resize.observe(element);
    contentChanges.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      resize.disconnect();
      contentChanges.disconnect();
    };
  }, [content, element, enabled]);

  return { ref, tabIndex: undefined };
}
