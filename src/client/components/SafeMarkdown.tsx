import type { TrustedMarkdownHtml } from "../bootstrap";

export interface SafeMarkdownProps {
  html: TrustedMarkdownHtml;
}

export function SafeMarkdown({ html }: SafeMarkdownProps) {
  return <article data-safe-markdown="true" dangerouslySetInnerHTML={{ __html: html }} />;
}
