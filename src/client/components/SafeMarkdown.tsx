import type { TrustedMarkdownHtml } from "../bootstrap";
import { useOverflowFocus } from "./useOverflowFocus";

export interface SafeMarkdownProps {
  html: TrustedMarkdownHtml;
  wrap?: boolean;
}

export function SafeMarkdown({ html, wrap = false }: SafeMarkdownProps) {
  const overflow = useOverflowFocus(true, html);
  return <article ref={overflow.ref} data-safe-markdown="true" className={wrap ? "min-w-0 max-w-full break-words [&_pre]:max-w-full [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_code]:whitespace-pre-wrap [&_code]:break-words" : "min-w-0 max-w-full [&_pre]:min-w-full [&_pre]:w-max [&_pre]:whitespace-pre"} tabIndex={overflow.tabIndex} dangerouslySetInnerHTML={{ __html: html }} />;
}
